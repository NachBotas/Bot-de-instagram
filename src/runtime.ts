import { promises as fs } from "node:fs";
import path from "node:path";
import { buildApp, log, type App } from "./app.js";
import type { AppConfig } from "./config.js";
import { ConsultasStore, type Consulta } from "./consultas.js";
import { Gasto } from "./gasto.js";
import { DryRunManyChat, ManyChatApi } from "./integrations/manychat.js";
import { MediaPublica, sintetizarElevenLabs } from "./integrations/voz.js";
import { AjustesStore, aConfig, fusionarSecretos, AjustesSchema, type Ajustes } from "./settings.js";
import { FileLeadStore, MemoryLeadStore, type Lead } from "./store.js";

export interface Chequeo {
  ok: boolean;
  detalle: string;
  at: string;
}

export interface Alerta {
  texto: string;
  at: string;
}

interface Prueba {
  app: App;
  salida: string[];
}

export interface CuentaOpciones {
  id: string;
  /** Dirección pública de la app (túnel o nube), si hay. */
  urlBase: () => string | undefined;
  media: MediaPublica;
}

const HORA = 3_600_000;

/**
 * Una cuenta de Instagram con su bot: ajustes, conversaciones, consultas,
 * gasto y chequeos de conexión. El panel habla con esto.
 */
export class Runtime {
  ajustes!: Ajustes;
  app!: App;
  readonly id: string;
  readonly consultas: ConsultasStore;
  readonly ajustesStore: AjustesStore;
  readonly gasto: Gasto;
  chequeos: { claude?: Chequeo; manychat?: Chequeo; audios?: Chequeo; voz?: Chequeo } = {};
  /** Avisos generales (errores repetidos, tope de gasto…), los más nuevos primero. */
  alertas: Alerta[] = [];
  private prueba?: Prueba;
  private timerSeguimientos?: NodeJS.Timeout;
  private respaldoEnviado = new Map<string, number>();
  private topeAvisado = "";

  private constructor(
    readonly base: AppConfig,
    private readonly opts: CuentaOpciones,
  ) {
    this.id = opts.id;
    this.consultas = new ConsultasStore(base.DATA_DIR);
    this.ajustesStore = new AjustesStore(base.DATA_DIR);
    this.gasto = new Gasto(base.DATA_DIR);
  }

  static async start(base: AppConfig, opts: CuentaOpciones): Promise<Runtime> {
    const rt = new Runtime(base, opts);
    rt.ajustes = await rt.ajustesStore.load(base);
    rt.app = await rt.build();
    rt.programarSeguimientos();
    const pendientes = await rt.app.engine.resumePending();
    if (pendientes) log(`↩️  [${opts.id}] Retomando ${pendientes} conversación(es) con mensajes sin responder`);
    return rt;
  }

  get nombre(): string {
    return this.ajustes.manychat.pagina || this.id;
  }

  get config(): AppConfig {
    return aConfig(this.base, this.ajustes);
  }

  private automatizaciones() {
    return this.ajustes.automatizaciones.map((x) => ({
      clave: x.clave,
      flow_ns: x.flow_ns,
      descripcion: x.descripcion || x.nombre,
      cuando_usar: x.cuando_usar || "cuando sea útil para el lead",
    }));
  }

  private build(): Promise<App> {
    const a = this.ajustes;
    return buildApp(this.config, {
      store: this.app?.store ?? new FileLeadStore(this.base.DATA_DIR),
      business: a.negocio,
      automations: this.automatizaciones(),
      guion: a.guion,
      reglas: a.reglas,
      flowAviso: a.avisos.flowAviso || undefined,
      registrarAviso: async ({ tipo, lead, texto }) => {
        await this.agregarConsulta(tipo, lead, texto);
        log(`🔔 ${tipo === "consulta" ? "Consulta" : "Derivación"} de ${lead.username ?? lead.subscriberId}: ${texto}`);
      },
      onUsage: (modelo, uso) => {
        this.gasto
          .registrar(modelo, uso)
          .then(() => this.revisarTope())
          .catch(() => undefined);
      },
      onTranscripcion: () => void this.gasto.registrarAudio().catch(() => undefined),
      engineExtra: {
        excluirTags: a.excluir.tags,
        horario: { ...a.horario, zona: a.agenda.zonaHoraria },
        demora: { minSeg: a.comportamiento.demoraMinSeg, maxSeg: a.comportamiento.demoraMaxSeg },
        onError: (lead, err) => this.alError(lead, err),
        voz:
          a.voz.modo !== "nunca" && a.voz.elevenlabsKey && a.voz.vozId
            ? { modo: a.voz.modo, sintetizar: (texto) => this.notaDeVoz(texto) }
            : undefined,
      },
    });
  }

  private async agregarConsulta(tipo: Consulta["tipo"], lead: Lead, texto: string): Promise<void> {
    const ultimo = [...lead.turnos].reverse().find((t) => t.de === "lead");
    await this.consultas.add({
      tipo,
      leadId: lead.subscriberId,
      nombre: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || undefined,
      username: lead.username,
      texto,
      ultimoMensaje: ultimo?.texto,
    });
  }

  private alertar(texto: string): void {
    if (this.alertas[0]?.texto === texto) {
      this.alertas[0].at = new Date().toISOString();
      return;
    }
    this.alertas.unshift({ texto, at: new Date().toISOString() });
    this.alertas = this.alertas.slice(0, 10);
  }

  /**
   * Algo falló respondiendo a un lead (Claude sin saldo, ManyChat caído…):
   * queda en la bandeja para reintentar, se avisa en el panel y, si está
   * activado, se le manda al lead un mensaje de "ya te respondo".
   */
  private async alError(lead: Lead, err: unknown): Promise<void> {
    const motivo = explicarError(err);
    log(`❌ [${this.id}] No pude responder a ${lead.username ?? lead.subscriberId}: ${motivo}`);
    this.alertar(`El bot no pudo responder: ${motivo}`);
    const pendientes = await this.consultas.list();
    if (!pendientes.some((c) => c.tipo === "error" && c.leadId === lead.subscriberId && c.estado === "pendiente")) {
      await this.agregarConsulta("error", lead, motivo);
    }
    const e = this.ajustes.errores;
    const ultimo = this.respaldoEnviado.get(lead.subscriberId) ?? 0;
    if (e.enviarRespaldo && e.mensajeRespaldo.trim() && Date.now() - ultimo > 6 * HORA) {
      this.respaldoEnviado.set(lead.subscriberId, Date.now());
      await this.app.manychat.sendText(lead.subscriberId, [e.mensajeRespaldo.trim()]).catch(() => undefined);
    }
  }

  private async revisarTope(): Promise<void> {
    const tope = this.ajustes.gasto.topeMensualUsd;
    if (!tope) return;
    const r = await this.gasto.resumen();
    if (r.usdMes >= tope && this.topeAvisado !== r.mes) {
      this.topeAvisado = r.mes;
      this.alertar(`El gasto de Claude de este mes ya pasó tu tope de USD ${tope} (va USD ${r.usdMes.toFixed(2)}). El bot sigue respondiendo.`);
    }
  }

  /** Genera la nota de voz, la publica en /media y devuelve su URL. */
  private async notaDeVoz(texto: string): Promise<string> {
    const base = this.opts.urlBase();
    if (!base) throw new Error("No hay dirección pública: abrí la conexión con internet o subí el bot a la nube");
    const mp3 = await sintetizarElevenLabs(texto, { apiKey: this.ajustes.voz.elevenlabsKey, vozId: this.ajustes.voz.vozId });
    const nombre = await this.opts.media.guardar(mp3, "mp3");
    return `${base}/media/${nombre}`;
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
    nuevo.tunel = this.ajustes.tunel;
    const cambioManychat = nuevo.manychat.apiKey !== this.ajustes.manychat.apiKey;
    const cambioClaude = nuevo.claude.apiKey !== this.ajustes.claude.apiKey || nuevo.claude.modelo !== this.ajustes.claude.modelo;
    this.ajustes = nuevo;
    await this.ajustesStore.save(nuevo);
    await this.reload();
    if (cambioManychat) delete this.chequeos.manychat;
    if (cambioClaude) delete this.chequeos.claude;
    return nuevo;
  }

  async setBotActivo(activo: boolean): Promise<void> {
    this.ajustes.botActivo = activo;
    await this.ajustesStore.save(this.ajustes);
    this.programarSeguimientos();
    log(activo ? `▶️  [${this.id}] Bot ACTIVADO` : `⏸️  [${this.id}] Bot DESACTIVADO`);
  }

  private programarSeguimientos(): void {
    clearInterval(this.timerSeguimientos);
    if (!this.ajustes.botActivo || !this.ajustes.seguimientos.activo) return;
    this.timerSeguimientos = setInterval(() => {
      this.app.engine
        .runFollowups()
        .then((n) => n && log(`🔁 [${this.id}] ${n} seguimiento(s) enviados`))
        .catch((err) => log("❌ Error en seguimientos", err instanceof Error ? err.message : err));
    }, 15 * 60 * 1000);
    this.timerSeguimientos.unref();
  }

  detener(): void {
    clearInterval(this.timerSeguimientos);
  }

  // ------------------------------------------------------------ direcciones públicas

  get urlWebhook(): string | undefined {
    const base = this.opts.urlBase();
    return base ? `${base}/webhook/manychat/${this.id}` : undefined;
  }

  get urlAgenda(): string | undefined {
    const base = this.opts.urlBase();
    return base ? `${base}/webhook/agenda/${this.id}?secret=${encodeURIComponent(this.ajustes.webhookSecret)}` : undefined;
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

  /** Genera una nota de voz de prueba (devuelve el mp3 para escucharlo en el panel). */
  async probarVoz(texto: string): Promise<Buffer> {
    try {
      const mp3 = await sintetizarElevenLabs(texto, { apiKey: this.ajustes.voz.elevenlabsKey, vozId: this.ajustes.voz.vozId });
      this.chequeos.voz = { ok: true, detalle: "Voz funcionando", at: new Date().toISOString() };
      return mp3;
    } catch (err) {
      this.chequeos.voz = { ok: false, detalle: explicarError(err), at: new Date().toISOString() };
      throw err;
    }
  }

  // ------------------------------------------------------------ Calendly

  /**
   * Conecta Calendly por API: crea un webhook para que Calendly avise cada vez que
   * alguien agenda. Requiere un plan pago de Calendly y la dirección pública de la app.
   */
  async conectarCalendly(token: string): Promise<string> {
    const url = this.urlAgenda;
    if (!url) throw new Error("Primero abrí la conexión con internet (o subí el bot a la nube): Calendly necesita una dirección pública.");
    const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const me = await fetch("https://api.calendly.com/users/me", { headers: h });
    if (me.status === 401) throw new Error("El token de Calendly no es válido.");
    if (!me.ok) throw new Error(`Calendly respondió ${me.status}`);
    const { resource } = (await me.json()) as { resource: { uri: string; current_organization: string } };
    const res = await fetch("https://api.calendly.com/webhook_subscriptions", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ url, events: ["invitee.created"], organization: resource.current_organization, user: resource.uri, scope: "user" }),
    });
    const json = (await res.json().catch(() => ({}))) as { resource?: { uri?: string }; message?: string; title?: string };
    if (res.status === 409) {
      // Ya existía un webhook para esta dirección: está todo bien.
    } else if (res.status === 403) {
      throw new Error("Tu plan de Calendly no permite webhooks: hace falta un plan pago (Standard o superior).");
    } else if (!res.ok) {
      throw new Error(json.message ?? json.title ?? `Calendly respondió ${res.status}`);
    }
    this.ajustes.agenda.calendlyToken = token;
    this.ajustes.agenda.calendlyWebhook = json.resource?.uri ?? "existente";
    await this.ajustesStore.save(this.ajustes);
    return "Calendly conectado: cada vez que alguien agende, el bot se va a enterar.";
  }

  // ------------------------------------------------------------ respaldo

  /** Todo lo de esta cuenta en un solo JSON (incluye las claves: guardalo en un lugar seguro). */
  async exportar(): Promise<Record<string, unknown>> {
    return {
      tipo: "setter-respaldo",
      version: 1,
      cuenta: this.id,
      fecha: new Date().toISOString(),
      ajustes: this.ajustes,
      leads: await this.app.store.list(),
      consultas: await this.consultas.list(),
      gasto: JSON.parse(await fs.readFile(path.join(this.base.DATA_DIR, "gasto.json"), "utf8").catch(() => "{}")),
    };
  }

  /** Reemplaza los datos de esta cuenta con los de un respaldo. */
  async importar(r: Record<string, unknown>): Promise<{ leads: number }> {
    if (r?.tipo !== "setter-respaldo") throw new Error("Ese archivo no es un respaldo del setter.");
    const ajustes = AjustesSchema.parse(r.ajustes);
    const dir = this.base.DATA_DIR;
    const leads = Array.isArray(r.leads) ? (r.leads as Lead[]) : [];
    await fs.rm(path.join(dir, "leads"), { recursive: true, force: true });
    const store = new FileLeadStore(dir);
    for (const l of leads) if (l?.subscriberId) await store.save(l);
    await fs.writeFile(path.join(dir, "consultas.json"), JSON.stringify(Array.isArray(r.consultas) ? r.consultas : []), "utf8");
    await fs.writeFile(path.join(dir, "gasto.json"), JSON.stringify(r.gasto ?? {}), "utf8");
    this.ajustes = ajustes;
    await this.ajustesStore.save(ajustes);
    this.app = undefined as unknown as App;
    await this.reload();
    return { leads: leads.length };
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
          automations: this.automatizaciones(),
          guion: this.ajustes.guion,
          reglas: this.ajustes.reglas,
          flowAviso: this.ajustes.avisos.flowAviso || undefined,
          registrarAviso: async ({ tipo, texto: t }) => {
            salida.push(`🔔 (prueba) ${tipo === "consulta" ? "Consulta al equipo" : "Derivación"}: ${t}`);
          },
          onUsage: (modelo, uso) => void this.gasto.registrar(modelo, uso).catch(() => undefined),
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
}

/** Traduce errores técnicos a algo entendible. */
export function explicarError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  if (/credit balance|insufficient.*credit|billing/i.test(msg)) return "Tu cuenta de Claude se quedó sin saldo: cargá crédito en platform.claude.com → Billing.";
  if (status === 401 || /401|invalid x-api-key|unauthorized|authentication/i.test(msg)) return "La API key no es válida.";
  if (status === 403) return "La API key no tiene permiso para esto.";
  if (status === 404 && /model/i.test(msg)) return "Ese modelo no existe o tu cuenta no tiene acceso.";
  if (status === 429) return "Demasiadas solicitudes o sin saldo: revisá tu cuenta.";
  if (status === 529 || /overloaded/i.test(msg)) return "Claude está saturado en este momento; se puede reintentar en unos minutos.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(msg)) return "No hay conexión con el servicio (¿internet?).";
  if (/ManyChat/i.test(msg)) return `ManyChat dio un error: ${msg.replace(/^ManyChat\s+/, "").slice(0, 200)}`;
  if (/ERR_NGROK_4018|authtoken/i.test(msg)) return "El authtoken de ngrok no es válido.";
  if (/failed to connect session|tcp connection/i.test(msg)) return "No pude conectarme a ngrok. Revisá tu internet, o si un antivirus o la red de tu trabajo lo bloquea.";
  if (/ERR_NGROK_108|already online|limited to 1 simultaneous/i.test(msg)) return "ngrok ya está abierto en otra compu o programa con esta cuenta. Cerralo y probá de nuevo.";
  if (/ERR_NGROK_(313|320|326)|domain/i.test(msg)) return "Ese dominio de ngrok no es tuyo o está mal escrito. Copialo de dashboard.ngrok.com → Domains.";
  return msg.slice(0, 300);
}
