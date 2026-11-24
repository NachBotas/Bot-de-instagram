import { buildApp, log, type App } from "./app.js";
import type { AppConfig } from "./config.js";
import { ConsultasStore } from "./consultas.js";
import { DryRunManyChat, ManyChatApi } from "./integrations/manychat.js";
import { AjustesStore, aConfig, fusionarSecretos, AjustesSchema, type Ajustes } from "./settings.js";
import { MemoryLeadStore } from "./store.js";

export interface Chequeo {
  ok: boolean;
  detalle: string;
  at: string;
}

interface Tunel {
  url?: string;
  error?: string;
  iniciando?: boolean;
}

interface Prueba {
  app: App;
  salida: string[];
}

/**
 * Todo lo que está vivo mientras corre la app: ajustes, el bot, el túnel y los
 * chequeos de conexión. El panel habla con esto.
 */
export class Runtime {
  ajustes!: Ajustes;
  app!: App;
  readonly consultas: ConsultasStore;
  readonly ajustesStore: AjustesStore;
  tunel: Tunel = {};
  chequeos: { claude?: Chequeo; manychat?: Chequeo; audios?: Chequeo } = {};
  private prueba?: Prueba;
  private timerSeguimientos?: NodeJS.Timeout;
  private ngrokListener?: { close(): Promise<void>; url(): string | null };

  private constructor(readonly base: AppConfig) {
    this.consultas = new ConsultasStore(base.DATA_DIR);
    this.ajustesStore = new AjustesStore(base.DATA_DIR);
  }

  static async start(base: AppConfig): Promise<Runtime> {
    const rt = new Runtime(base);
    rt.ajustes = await rt.ajustesStore.load(base);
    rt.app = await rt.build();
    rt.programarSeguimientos();
    const pendientes = await rt.app.engine.resumePending();
    if (pendientes) log(`↩️  Retomando ${pendientes} conversación(es) con mensajes sin responder`);
    if (rt.ajustes.tunel.activo) await rt.iniciarTunel().catch(() => undefined);
    return rt;
  }

  get config(): AppConfig {
    return aConfig(this.base, this.ajustes);
  }

  private build(): Promise<App> {
    const a = this.ajustes;
    return buildApp(this.config, {
      store: this.app?.store,
      business: a.negocio,
      automations: a.automatizaciones.map((x) => ({
        clave: x.clave,
        flow_ns: x.flow_ns,
        descripcion: x.descripcion || x.nombre,
        cuando_usar: x.cuando_usar || "cuando sea útil para el lead",
      })),
      guion: a.guion,
      reglas: a.reglas,
      flowAviso: a.avisos.flowAviso || undefined,
      registrarAviso: async ({ tipo, lead, texto }) => {
        const ultimo = [...lead.turnos].reverse().find((t) => t.de === "lead");
        await this.consultas.add({
          tipo,
          leadId: lead.subscriberId,
          nombre: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || undefined,
          username: lead.username,
          texto,
          ultimoMensaje: ultimo?.texto,
        });
        log(`🔔 ${tipo === "consulta" ? "Consulta" : "Derivación"} de ${lead.username ?? lead.subscriberId}: ${texto}`);
      },
    });
  }

  /** Reconstruye el bot con los ajustes actuales, sin cortar las conversaciones en curso. */
  async reload(): Promise<void> {
    const next = await this.build();
    if (this.app) {
      this.app.engine.reconfigure(next.engineOptions);
      this.app = { ...next, engine: this.app.engine };
    } else {
      this.app = next;
    }
    this.prueba = undefined;
    this.programarSeguimientos();
  }

  async guardarAjustes(datos: unknown): Promise<Ajustes> {
    const nuevo = fusionarSecretos(AjustesSchema.parse(datos), this.ajustes);
    // Lo que no se edita desde el formulario general se conserva.
    nuevo.botActivo = this.ajustes.botActivo;
    nuevo.webhookSecret = this.ajustes.webhookSecret;
    const cambioTunel =
      nuevo.tunel.authtoken !== this.ajustes.tunel.authtoken || nuevo.tunel.dominio !== this.ajustes.tunel.dominio;
    const cambioManychat = nuevo.manychat.apiKey !== this.ajustes.manychat.apiKey;
    const cambioClaude = nuevo.claude.apiKey !== this.ajustes.claude.apiKey;
    this.ajustes = nuevo;
    await this.ajustesStore.save(nuevo);
    await this.reload();
    if (cambioManychat) delete this.chequeos.manychat;
    if (cambioClaude) delete this.chequeos.claude;
    if (cambioTunel && this.tunel.url) {
      await this.detenerTunel(false);
      await this.iniciarTunel().catch(() => undefined);
    }
    return nuevo;
  }

  async setBotActivo(activo: boolean): Promise<void> {
    this.ajustes.botActivo = activo;
    await this.ajustesStore.save(this.ajustes);
    this.programarSeguimientos();
    log(activo ? "▶️  Bot ACTIVADO" : "⏸️  Bot DESACTIVADO");
  }

  private programarSeguimientos(): void {
    clearInterval(this.timerSeguimientos);
    if (!this.ajustes.botActivo || !this.ajustes.seguimientos.activo) return;
    this.timerSeguimientos = setInterval(() => {
      this.app.engine
        .runFollowups()
        .then((n) => n && log(`🔁 ${n} seguimiento(s) enviados`))
        .catch((err) => log("❌ Error en seguimientos", err instanceof Error ? err.message : err));
    }, 15 * 60 * 1000);
    this.timerSeguimientos.unref();
  }

  // ------------------------------------------------------------ chequeos

  async probarClaude(): Promise<Chequeo> {
    try {
      const m = await this.app.client.models.retrieve(this.ajustes.claude.modelo);
      this.chequeos.claude = { ok: true, detalle: `Conectado (${m.display_name ?? m.id})`, at: new Date().toISOString() };
    } catch (err) {
      this.chequeos.claude = { ok: false, detalle: explicarError(err), at: new Date().toISOString() };
    }
    return this.chequeos.claude;
  }

  async probarManychat(): Promise<Chequeo> {
    const key = this.ajustes.manychat.apiKey;
    if (!key) {
      this.chequeos.manychat = { ok: false, detalle: "Falta la API key", at: new Date().toISOString() };
      return this.chequeos.manychat;
    }
    try {
      const info = await new ManyChatApi(key).getPageInfo();
      this.chequeos.manychat = { ok: true, detalle: `Conectado a ${info.name ?? "tu cuenta"}`, at: new Date().toISOString() };
      if (info.name && info.name !== this.ajustes.manychat.pagina) {
        this.ajustes.manychat.pagina = info.name;
        await this.ajustesStore.save(this.ajustes);
      }
    } catch (err) {
      this.chequeos.manychat = { ok: false, detalle: explicarError(err), at: new Date().toISOString() };
    }
    return this.chequeos.manychat;
  }

  async probarAudio(audio: Buffer, mime: string): Promise<{ ok: boolean; texto: string }> {
    if (!this.app.transcriber.enabled) return { ok: false, texto: "Elegí un proveedor y cargá su API key primero." };
    try {
      const texto = await this.app.transcriber.transcribe(audio, mime);
      this.chequeos.audios = { ok: true, detalle: "Transcripción funcionando", at: new Date().toISOString() };
      return { ok: true, texto: texto || "(no se detectó voz en el audio)" };
    } catch (err) {
      this.chequeos.audios = { ok: false, detalle: explicarError(err), at: new Date().toISOString() };
      return { ok: false, texto: explicarError(err) };
    }
  }

  // ------------------------------------------------------------ chat de prueba

  /** Chat de prueba desde el panel: usa la configuración real, pero no manda nada a Instagram ni guarda leads. */
  async probarChat(sesion: string, texto: string): Promise<{ mensajes: string[]; acciones: string[] }> {
    if (!this.prueba) {
      const salida: string[] = [];
      const app = await buildApp(
        { ...this.config, DEBOUNCE_SECONDS: 0, TYPING_DELAY_MS: 0 },
        {
          store: new MemoryLeadStore(),
          manychat: new DryRunManyChat((l) => salida.push(l)),
          logger: (m) => {
            if (m.startsWith("🔧")) salida.push(m);
          },
          business: this.ajustes.negocio,
          automations: this.ajustes.automatizaciones.map((x) => ({
            clave: x.clave,
            flow_ns: x.flow_ns,
            descripcion: x.descripcion || x.nombre,
            cuando_usar: x.cuando_usar || "cuando sea útil para el lead",
          })),
          guion: this.ajustes.guion,
          reglas: this.ajustes.reglas,
          flowAviso: this.ajustes.avisos.flowAviso || undefined,
          registrarAviso: async ({ tipo, texto: t }) => {
            salida.push(`🔔 (prueba) ${tipo === "consulta" ? "Consulta al equipo" : "Derivación"}: ${t}`);
          },
        },
      );
      this.prueba = { app, salida };
    }
    const { app, salida } = this.prueba;
    const desde = salida.length;
    const id = `prueba_${sesion}`;
    await app.engine.receive({ subscriberId: id, firstName: "Prueba", username: "usuario_de_prueba", text: texto });
    await app.engine.flush(id);
    const nuevas = salida.slice(desde);
    const nombreFlow = (ns: string) => this.ajustes.automatizaciones.find((a) => a.flow_ns === ns)?.nombre ?? ns;
    // Acciones en lenguaje simple (las técnicas, como escribir campos o quitar tags, no se muestran).
    const HERRAMIENTAS: Record<string, string> = {
      actualizar_lead: "📝 Guardó datos del lead",
      ver_horarios_disponibles: "📅 Consultó los horarios libres",
      agendar_llamada: "📅 Agendó la llamada",
      enviar_link_agenda: "📅 Generó el link de agenda",
    };
    const acciones: string[] = [];
    for (const l of nuevas) {
      if (l.includes("💬")) continue;
      const tool = l.match(/^🔧 (\w+)/)?.[1];
      if (tool) {
        if (HERRAMIENTAS[tool]) acciones.push(HERRAMIENTAS[tool]);
        continue;
      }
      const flow = l.match(/dispara flow (\S+)/)?.[1];
      if (flow) acciones.push(`⚡ Disparó la automatización "${nombreFlow(flow)}"`);
      else if (/\+tag (\S+)/.test(l)) acciones.push(`🏷️ Etiqueta: ${l.match(/\+tag (\S+)/)![1]}`);
      else if (l.startsWith("🔔")) acciones.push(l.replace("(prueba) ", ""));
    }
    return {
      mensajes: nuevas.filter((l) => l.includes("💬")).map((l) => l.replace(/^\[ManyChat → [^\]]+\] 💬 /, "")),
      acciones,
    };
  }

  // ------------------------------------------------------------ túnel (ngrok)

  /** Abre el túnel para que ManyChat pueda llegar a esta compu. */
  async iniciarTunel(): Promise<Tunel> {
    const { authtoken, dominio } = this.ajustes.tunel;
    if (!authtoken) {
      this.tunel = { error: "Falta el authtoken de ngrok (mirá el tutorial en la sección Conexión)." };
      throw new Error(this.tunel.error);
    }
    this.tunel = { iniciando: true };
    try {
      const ngrok = await import("@ngrok/ngrok");
      this.ngrokListener = await ngrok.forward({
        addr: this.base.PORT,
        authtoken,
        ...(dominio.trim() ? { domain: dominio.trim().replace(/^https?:\/\//, "").replace(/\/$/, "") } : {}),
      });
      this.tunel = { url: this.ngrokListener.url() ?? undefined };
      if (!this.ajustes.tunel.activo) {
        this.ajustes.tunel.activo = true;
        await this.ajustesStore.save(this.ajustes);
      }
      log(`🌐 Túnel abierto: ${this.tunel.url}`);
      return this.tunel;
    } catch (err) {
      this.tunel = { error: explicarError(err) };
      log("❌ No se pudo abrir el túnel", this.tunel.error);
      throw err;
    }
  }

  async detenerTunel(guardar = true): Promise<void> {
    await this.ngrokListener?.close().catch(() => undefined);
    this.ngrokListener = undefined;
    this.tunel = {};
    if (guardar) {
      this.ajustes.tunel.activo = false;
      await this.ajustesStore.save(this.ajustes);
    }
  }

  /** URL pública del webhook (túnel o PUBLIC_BASE_URL si está en un servidor). */
  get urlPublica(): string | undefined {
    const base = this.tunel.url ?? this.base.PUBLIC_BASE_URL;
    return base ? `${base.replace(/\/$/, "")}/webhook/manychat` : undefined;
  }
}

/** Traduce errores técnicos a algo entendible. */
export function explicarError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  if (status === 401 || /401|invalid x-api-key|unauthorized|authentication/i.test(msg)) return "La API key no es válida.";
  if (status === 403) return "La API key no tiene permiso para esto.";
  if (status === 404 && /model/i.test(msg)) return "Ese modelo no existe o tu cuenta no tiene acceso.";
  if (status === 429) return "Demasiadas solicitudes o sin saldo: revisá tu cuenta.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(msg)) return "No hay conexión con el servicio (¿internet?).";
  if (/ERR_NGROK_4018|authtoken/i.test(msg)) return "El authtoken de ngrok no es válido.";
  if (/failed to connect session|tcp connection/i.test(msg)) return "No pude conectarme a ngrok. Revisá tu internet, o si un antivirus o la red de tu trabajo lo bloquea.";
  if (/ERR_NGROK_108|already online|limited to 1 simultaneous/i.test(msg)) return "ngrok ya está abierto en otra compu o programa con esta cuenta. Cerralo y probá de nuevo.";
  if (/ERR_NGROK_(313|320|326)|domain/i.test(msg)) return "Ese dominio de ngrok no es tuyo o está mal escrito. Copialo de dashboard.ngrok.com → Domains.";
  return msg.slice(0, 300);
}
