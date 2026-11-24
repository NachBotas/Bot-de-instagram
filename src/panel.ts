import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { correrAnalisis } from "./analytics/run.js";
import { log } from "./app.js";
import { config } from "./config.js";
import { minutosHastaAbrir } from "./horario.js";
import { ManyChatApi } from "./integrations/manychat.js";
import type { Plataforma } from "./plataforma.js";
import { explicarError, type Runtime } from "./runtime.js";
import { enmascarar } from "./settings.js";
import { registrarEtapa } from "./store.js";
import {
  DURACION_SESION_SEG,
  firmarSesion,
  leerSesion,
  nivel,
  publico,
  puedeVerCuenta,
  ROLES,
  type Rol,
  type UsuarioPublico,
} from "./usuarios.js";

const PANEL_DIR = fileURLToPath(new URL("../panel", import.meta.url));
const COOKIE = "setter_sesion";

const TAGS_NECESARIOS = ["bot_pausado"];
const CAMPOS_NECESARIOS: [string, string][] = [
  ["setter_etapa", "Etapa del lead según el bot setter"],
  ["setter_resumen", "Resumen del lead para el closer"],
  ["setter_email", "Email que dio el lead"],
  ["setter_llamada", "Fecha y hora de la llamada agendada"],
];

/** Usuario implícito cuando el panel está en tu compu y todavía no creaste el equipo. */
const LOCAL_ADMIN: UsuarioPublico = { usuario: "local", nombre: "Vos", rol: "admin", cuentas: ["*"], creado: "" };

interface Locals {
  usuario: UsuarioPublico;
  rt: Runtime;
}
const L = (res: Response) => res.locals as Locals;

function leerCookie(req: Request, nombre: string): string | undefined {
  for (const parte of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = parte.trim().split("=");
    if (k === nombre) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/**
 * Panel de control. En tu compu escucha solo en 127.0.0.1 (el túnel de ManyChat
 * no lo expone). En la nube va en el mismo puerto que los webhooks, con login.
 */
export function crearPanel(p: Plataforma, opts: { local: boolean }): Router {
  const app = express.Router();

  // ---------------------------------------------------------------- protecciones generales
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (opts.local) {
      // En modo local solo aceptamos "localhost" (evita que otra web lo use desde tu navegador).
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
        res.status(403).send("Acceso no permitido");
        return;
      }
    }
    // Las acciones exigen un header propio: un sitio externo no puede mandarlo sin permiso del navegador.
    if (req.method !== "GET" && req.path.startsWith("/api/") && req.header("x-panel") !== "1") {
      res.status(403).json({ error: "solicitud no permitida" });
      return;
    }
    next();
  });

  app.use(express.static(PANEL_DIR));
  app.use("/api/respaldo", express.json({ limit: "50mb" }));
  app.use("/api", express.json({ limit: "2mb" }));

  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response) => {
      fn(req, res).catch((err) => {
        log("❌ Error en el panel", err instanceof Error ? err.message : err);
        if (!res.headersSent) res.status(400).json({ error: explicarError(err) });
      });
    };

  // ---------------------------------------------------------------- sesión

  const ponerCookie = (req: Request, res: Response, usuario: string) => {
    const seguro = req.secure || req.header("x-forwarded-proto") === "https";
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${firmarSesion(usuario, p.datos.secretoSesion)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DURACION_SESION_SEG}${seguro ? "; Secure" : ""}`,
    );
  };

  async function usuarioActual(req: Request): Promise<UsuarioPublico | undefined> {
    if (!(await p.usuarios.hayUsuarios())) return opts.local ? LOCAL_ADMIN : undefined;
    const nombre = leerSesion(leerCookie(req, COOKIE), p.datos.secretoSesion);
    const u = nombre ? await p.usuarios.get(nombre) : undefined;
    return u ? publico(u) : undefined;
  }

  const cuentasDe = (u: UsuarioPublico) => p.lista().filter((c) => puedeVerCuenta(u, c.id));

  app.get(
    "/api/sesion",
    wrap(async (req, res) => {
      const u = await usuarioActual(req);
      res.json({
        auth: await p.usuarios.hayUsuarios(),
        usuario: u ?? null,
        cuentas: u ? cuentasDe(u) : [],
        nube: p.esNube,
      });
    }),
  );

  const intentos = new Map<string, { n: number; desde: number }>();
  app.post(
    "/api/login",
    wrap(async (req, res) => {
      const ip = req.ip ?? "?";
      const i = intentos.get(ip);
      if (i && i.n >= 10 && Date.now() - i.desde < 15 * 60_000) {
        res.status(429).json({ error: "Demasiados intentos. Probá de nuevo en 15 minutos." });
        return;
      }
      const u = await p.usuarios.verificar(String(req.body?.usuario ?? ""), String(req.body?.clave ?? ""));
      if (!u) {
        intentos.set(ip, i && Date.now() - i.desde < 15 * 60_000 ? { n: i.n + 1, desde: i.desde } : { n: 1, desde: Date.now() });
        res.status(401).json({ error: "Usuario o contraseña incorrectos." });
        return;
      }
      intentos.delete(ip);
      ponerCookie(req, res, u.usuario);
      log(`👤 Entró ${u.usuario}`);
      res.json({ ok: true });
    }),
  );

  app.post("/api/logout", (_req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- autenticación y cuenta activa

  app.use("/api", async (req: Request, res: Response, next: NextFunction) => {
    const u = await usuarioActual(req);
    if (!u) {
      res.status(401).json({ error: "Iniciá sesión", login: true });
      return;
    }
    L(res).usuario = u;
    const pedida = req.header("x-cuenta") ?? (typeof req.query.cuenta === "string" ? req.query.cuenta : undefined);
    const visibles = cuentasDe(u);
    const id = pedida && visibles.some((c) => c.id === pedida) ? pedida : visibles[0]?.id;
    const rt = p.cuenta(id);
    if (rt) L(res).rt = rt;
    next();
  });

  /** Exige un rol mínimo (agente < editor < admin) y, si hace falta, una cuenta. */
  const rol =
    (minimo: Rol, conCuenta = true) =>
    (_req: Request, res: Response, next: NextFunction) => {
      if (nivel(L(res).usuario.rol) < nivel(minimo)) {
        res.status(403).json({ error: "Tu usuario no tiene permiso para esto." });
        return;
      }
      if (conCuenta && !L(res).rt) {
        res.status(403).json({ error: "No tenés acceso a ninguna cuenta." });
        return;
      }
      next();
    };
  const agente = rol("agente");
  const editor = rol("editor");
  const admin = rol("admin", false);

  // ---------------------------------------------------------------- estado general

  app.get(
    "/api/estado",
    agente,
    wrap(async (_req, res) => {
      const rt = L(res).rt;
      const a = rt.ajustes;
      const consultas = await rt.consultas.list();
      const leads = await rt.app.store.list();
      const hoy = new Date().toISOString().slice(0, 10);
      const semana = Date.now() - 7 * 86_400_000;
      const mes = hoy.slice(0, 7);
      const agendo = (l: (typeof leads)[number]) => l.hitos?.find((h) => h.etapa === "agendado")?.at;
      const gasto = await rt.gasto.resumen();
      res.json({
        cuenta: rt.id,
        botActivo: a.botActivo,
        pagina: a.manychat.pagina,
        advertencias: rt.app.warnings,
        alertas: rt.alertas,
        chequeos: rt.chequeos,
        nube: p.esNube,
        tunel: p.tunel,
        webhook: { url: rt.urlWebhook, secreto: a.webhookSecret, agenda: rt.urlAgenda },
        horario: a.horario.activo ? { abierto: minutosHastaAbrir(new Date(), a.horario, a.agenda.zonaHoraria) === 0 } : null,
        gasto: { usdMes: gasto.usdMes, usdHoy: gasto.usdHoy, tope: a.gasto.topeMensualUsd },
        configurado: {
          claude: !!a.claude.apiKey || !!process.env.ANTHROPIC_API_KEY,
          manychat: !!a.manychat.apiKey,
          negocio: a.negocio.trim().length > 50 && !a.negocio.includes("[Tu nombre o marca]"),
          audios: a.audios.proveedor !== "none" && !!a.audios.claves[a.audios.proveedor as "groq" | "openai" | "deepgram"],
          agenda: a.agenda.modo !== "ninguna",
          automatizaciones: a.automatizaciones.length,
          guion: a.guion.activo && a.guion.preguntas.some((x) => x.trim()),
          tunel: p.esNube || !!p.datos.tunel.authtoken,
          calendly: !!a.agenda.calendlyWebhook,
          agendaModo: a.agenda.modo,
        },
        numeros: {
          conversaciones: leads.length,
          activasHoy: leads.filter((l) => (l.lastUserAt ?? "").startsWith(hoy)).length,
          agendadas: leads.filter((l) => l.etapa === "agendado").length,
          agendadasSemana: leads.filter((l) => Date.parse(agendo(l) ?? "") >= semana).length,
          agendadasMes: leads.filter((l) => (agendo(l) ?? "").startsWith(mes)).length,
          consultasPendientes: consultas.filter((c) => c.estado === "pendiente").length,
        },
      });
    }),
  );

  app.get(
    "/api/gasto",
    agente,
    wrap(async (_req, res) => {
      res.json(await L(res).rt.gasto.resumen());
    }),
  );

  app.post(
    "/api/bot",
    editor,
    wrap(async (req, res) => {
      await L(res).rt.setBotActivo(!!req.body?.activo);
      res.json({ ok: true, botActivo: L(res).rt.ajustes.botActivo });
    }),
  );

  // ---------------------------------------------------------------- ajustes

  app.get("/api/ajustes", editor, (_req, res) => {
    res.json(enmascarar(L(res).rt.ajustes));
  });

  app.put(
    "/api/ajustes",
    editor,
    wrap(async (req, res) => {
      const nuevo = await L(res).rt.guardarAjustes(req.body);
      res.json({ ok: true, ajustes: enmascarar(nuevo), advertencias: L(res).rt.app.warnings });
    }),
  );

  app.get(
    "/api/plantilla-negocio",
    editor,
    wrap(async (_req, res) => {
      res.type("text/plain").send(await fs.readFile(config.BUSINESS_FILE, "utf8").catch(() => ""));
    }),
  );

  // ---------------------------------------------------------------- pruebas de conexión

  app.post("/api/probar/claude", editor, wrap(async (_req, res) => void res.json(await L(res).rt.probarClaude())));
  app.post("/api/probar/manychat", editor, wrap(async (_req, res) => void res.json(await L(res).rt.probarManychat())));
  app.post(
    "/api/probar/audio",
    editor,
    express.raw({ type: ["audio/*", "video/*", "application/octet-stream"], limit: "25mb" }),
    wrap(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ ok: false, texto: "No llegó ningún audio." });
        return;
      }
      res.json(await L(res).rt.probarAudio(req.body, req.header("content-type") ?? "audio/mpeg"));
    }),
  );
  app.post(
    "/api/probar/voz",
    editor,
    wrap(async (req, res) => {
      const mp3 = await L(res).rt.probarVoz(String(req.body?.texto || "Hola! Así suena tu voz en las respuestas del bot."));
      res.type("audio/mpeg").send(mp3);
    }),
  );
  app.post(
    "/api/probar/chat",
    editor,
    wrap(async (req, res) => {
      const texto = String(req.body?.texto ?? "").trim();
      if (!texto) {
        res.status(400).json({ error: "Escribí un mensaje" });
        return;
      }
      res.json(await L(res).rt.probarChat(String(req.body?.sesion ?? "1"), texto));
    }),
  );

  // ---------------------------------------------------------------- conexión a internet (túnel)

  app.get("/api/tunel", admin, (_req, res) => {
    res.json({ authtoken: p.datos.tunel.authtoken ? `••••${p.datos.tunel.authtoken.slice(-4)}` : "", dominio: p.datos.tunel.dominio, estado: p.tunel });
  });
  app.put(
    "/api/tunel",
    admin,
    wrap(async (req, res) => {
      const token = typeof req.body?.authtoken === "string" && req.body.authtoken.trim() ? req.body.authtoken.trim() : undefined;
      await p.guardarTunel(token, String(req.body?.dominio ?? "").trim());
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/tunel",
    admin,
    wrap(async (req, res) => {
      if (p.esNube) {
        res.status(400).json({ error: "En la nube no hace falta el túnel." });
        return;
      }
      if (req.body?.activo) await p.iniciarTunel().catch(() => undefined);
      else await p.detenerTunel();
      res.json({ tunel: p.tunel });
    }),
  );

  // ---------------------------------------------------------------- ManyChat

  const manychat = (res: Response) => {
    const key = L(res).rt.ajustes.manychat.apiKey;
    if (!key) throw new Error("Primero conectá ManyChat con tu API key.");
    return new ManyChatApi(key);
  };

  app.get(
    "/api/manychat/flows",
    editor,
    wrap(async (_req, res) => {
      res.json(await manychat(res).getFlows());
    }),
  );

  /** Crea en ManyChat los tags y campos que usa el bot (los que ya existen se dejan como están). */
  app.post(
    "/api/manychat/preparar",
    editor,
    wrap(async (_req, res) => {
      const mc = manychat(res);
      const [tags, campos] = await Promise.all([mc.getTags(), mc.getCustomFields()]);
      const creados: string[] = [];
      const existentes: string[] = [];
      for (const t of [...TAGS_NECESARIOS, ...L(res).rt.ajustes.excluir.tags]) {
        if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) existentes.push(`tag ${t}`);
        else {
          await mc.createTag(t);
          creados.push(`tag ${t}`);
        }
      }
      for (const [nombre, desc] of CAMPOS_NECESARIOS) {
        if (campos.includes(nombre)) existentes.push(`campo ${nombre}`);
        else {
          await mc.createCustomField(nombre, desc);
          creados.push(`campo ${nombre}`);
        }
      }
      res.json({ creados, existentes });
    }),
  );

  // ---------------------------------------------------------------- conversaciones

  app.get(
    "/api/conversaciones",
    agente,
    wrap(async (_req, res) => {
      const leads = await L(res).rt.app.store.list();
      res.json(
        leads
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 300)
          .map((l) => {
            const ultimo = l.turnos[l.turnos.length - 1];
            return {
              id: l.subscriberId,
              nombre: [l.firstName, l.lastName].filter(Boolean).join(" ") || undefined,
              username: l.username,
              etapa: l.etapa,
              pausado: l.paused,
              ultimo: ultimo ? { de: ultimo.de, texto: ultimo.texto.slice(0, 140), at: ultimo.at } : undefined,
              actualizado: l.updatedAt,
            };
          }),
      );
    }),
  );

  app.get(
    "/api/conversaciones/:id",
    agente,
    wrap(async (req, res) => {
      const l = await L(res).rt.app.store.get(String(req.params.id));
      if (!l) {
        res.status(404).json({ error: "No existe" });
        return;
      }
      const { history, pending, ...resto } = l;
      res.json(resto);
    }),
  );

  /** Pausa el bot para un lead: para siempre o por unas horas (después vuelve solo). */
  app.post(
    "/api/conversaciones/:id/pausa",
    agente,
    wrap(async (req, res) => {
      const pausar = !!req.body?.pausar;
      const horas = Number(req.body?.horas);
      const rt = L(res).rt;
      const l = await rt.app.engine.updateLead(String(req.params.id), (lead) => {
        lead.paused = pausar;
        lead.pausadoHasta = pausar && horas > 0 ? new Date(Date.now() + horas * 3_600_000).toISOString() : undefined;
        if (!pausar && lead.etapa === "humano") registrarEtapa(lead, "conversando");
      });
      if (!l) {
        res.status(404).json({ error: "No existe" });
        return;
      }
      const mc = rt.app.manychat;
      await (pausar ? mc.addTag(l.subscriberId, config.PAUSE_TAG) : mc.removeTag(l.subscriberId, config.PAUSE_TAG)).catch(() => undefined);
      res.json({ ok: true, pausado: l.paused, hasta: l.pausadoHasta });
    }),
  );

  // ---------------------------------------------------------------- consultas (no sabe, pidió una persona, error)

  app.get(
    "/api/consultas",
    agente,
    wrap(async (_req, res) => {
      const items = await L(res).rt.consultas.list();
      res.json(items.reverse());
    }),
  );

  app.post(
    "/api/consultas/:id/responder",
    agente,
    wrap(async (req, res) => {
      const rt = L(res).rt;
      const respuesta = String(req.body?.respuesta ?? "").trim();
      const enviar = req.body?.enviar !== false;
      // Guardar en la info del negocio cambia la configuración: solo editores o admins.
      const guardar = !!req.body?.guardar && nivel(L(res).usuario.rol) >= nivel("editor");
      const reactivar = !!req.body?.reactivar;
      if (!respuesta) {
        res.status(400).json({ error: "Escribí la respuesta" });
        return;
      }
      const c = (await rt.consultas.list()).find((x) => x.id === req.params.id);
      if (!c) {
        res.status(404).json({ error: "No existe" });
        return;
      }

      if (enviar) await rt.app.manychat.sendText(c.leadId, [respuesta]);
      await rt.app.engine.updateLead(c.leadId, (lead) => {
        const ahora = new Date().toISOString();
        if (enviar) {
          lead.turnos.push({ de: "bot", at: ahora, texto: respuesta, etapa: lead.etapa });
          lead.lastBotAt = ahora;
        }
        // El bot se entera de la respuesta para no contradecirla ni repetirla.
        lead.history.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `[EVENTO DEL SISTEMA: el equipo respondió la consulta "${c.texto}": "${respuesta}".${
                enviar ? " Ese mensaje ya se le envió al lead, no lo repitas." : " Usá esta información si el lead vuelve a preguntar."
              }]`,
            },
          ],
        });
        if (reactivar) {
          lead.paused = false;
          lead.pausadoHasta = undefined;
          if (lead.etapa === "humano") registrarEtapa(lead, "conversando");
        }
      });
      if (reactivar) await rt.app.manychat.removeTag(c.leadId, config.PAUSE_TAG).catch(() => undefined);

      if (guardar && c.tipo === "consulta") {
        const a = structuredClone(rt.ajustes);
        const titulo = "## Respuestas del equipo";
        if (!a.negocio.includes(titulo)) a.negocio = `${a.negocio.trimEnd()}\n\n${titulo}\n`;
        a.negocio = `${a.negocio.trimEnd()}\n- ${c.texto} → ${respuesta}\n`;
        await rt.guardarAjustes(a);
      }
      await rt.consultas.resolve(c.id, "respondida", respuesta);
      res.json({ ok: true });
    }),
  );

  /** Después de un error: el bot vuelve a intentar responderle al lead. */
  app.post(
    "/api/consultas/:id/reintentar",
    agente,
    wrap(async (req, res) => {
      const rt = L(res).rt;
      const c = (await rt.consultas.list()).find((x) => x.id === req.params.id);
      if (!c) {
        res.status(404).json({ error: "No existe" });
        return;
      }
      const ok = await rt.app.engine.reintentar(c.leadId);
      if (ok) await rt.consultas.resolve(c.id, "respondida", "(el bot respondió al reintentar)");
      res.json({ ok });
    }),
  );

  app.post(
    "/api/consultas/:id/descartar",
    agente,
    wrap(async (req, res) => {
      const c = await L(res).rt.consultas.resolve(String(req.params.id), "descartada");
      res.json({ ok: !!c });
    }),
  );

  // ---------------------------------------------------------------- análisis y agenda

  app.post(
    "/api/analisis",
    editor,
    wrap(async (req, res) => {
      const rt = L(res).rt;
      const dias = Number(req.body?.dias);
      const r = await correrAnalisis({
        store: rt.app.store,
        client: rt.app.client,
        model: rt.ajustes.claude.modelo,
        dataDir: rt.base.DATA_DIR,
        negocio: rt.ajustes.negocio,
        dias: dias > 0 ? dias : undefined,
        recomendaciones: req.body?.ia !== false,
      });
      res.json({ markdown: r.markdown });
    }),
  );

  app.post(
    "/api/calendly",
    editor,
    wrap(async (req, res) => {
      const token = String(req.body?.token ?? "").trim() || L(res).rt.ajustes.agenda.calendlyToken;
      if (!token) {
        res.status(400).json({ error: "Pegá tu token de Calendly." });
        return;
      }
      res.json({ ok: true, mensaje: await L(res).rt.conectarCalendly(token) });
    }),
  );

  // ---------------------------------------------------------------- respaldo

  app.get(
    "/api/respaldo",
    rol("admin"),
    wrap(async (_req, res) => {
      const rt = L(res).rt;
      const fecha = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Disposition", `attachment; filename="respaldo-setter-${rt.id}-${fecha}.json"`);
      res.json(await rt.exportar());
    }),
  );

  app.post(
    "/api/respaldo",
    rol("admin"),
    wrap(async (req, res) => {
      const r = await L(res).rt.importar(req.body);
      res.json({ ok: true, ...r });
    }),
  );

  // ---------------------------------------------------------------- cuentas

  app.get("/api/cuentas", (_req, res) => {
    res.json(cuentasDe(L(res).usuario));
  });
  app.post(
    "/api/cuentas",
    admin,
    wrap(async (req, res) => {
      const c = await p.crearCuenta(String(req.body?.nombre ?? ""));
      res.json({ ok: true, cuenta: c });
    }),
  );
  app.put(
    "/api/cuentas/:id",
    admin,
    wrap(async (req, res) => {
      await p.renombrarCuenta(String(req.params.id), String(req.body?.nombre ?? ""));
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/cuentas/:id",
    admin,
    wrap(async (req, res) => {
      await p.borrarCuenta(String(req.params.id));
      res.json({ ok: true });
    }),
  );

  // ---------------------------------------------------------------- equipo

  app.get(
    "/api/equipo",
    admin,
    wrap(async (_req, res) => {
      res.json((await p.usuarios.list()).map(publico));
    }),
  );

  app.post(
    "/api/equipo",
    admin,
    wrap(async (req, res) => {
      const b = req.body ?? {};
      const primero = !(await p.usuarios.hayUsuarios());
      const rolNuevo: Rol = primero ? "admin" : ROLES.includes(b.rol) ? b.rol : "agente";
      const u = await p.usuarios.crear({
        usuario: String(b.usuario ?? ""),
        nombre: String(b.nombre ?? ""),
        rol: rolNuevo,
        cuentas: Array.isArray(b.cuentas) ? b.cuentas.map(String) : ["*"],
        clave: String(b.clave ?? ""),
      });
      // El primer usuario es el administrador: le iniciamos sesión para que no quede afuera.
      if (primero) ponerCookie(req, res, u.usuario);
      res.json({ ok: true, usuario: publico(u), primero });
    }),
  );

  app.put(
    "/api/equipo/:usuario",
    admin,
    wrap(async (req, res) => {
      const b = req.body ?? {};
      const u = await p.usuarios.actualizar(String(req.params.usuario), {
        nombre: typeof b.nombre === "string" ? b.nombre : undefined,
        rol: ROLES.includes(b.rol) ? b.rol : undefined,
        cuentas: Array.isArray(b.cuentas) ? b.cuentas.map(String) : undefined,
        clave: typeof b.clave === "string" && b.clave ? b.clave : undefined,
      });
      res.json({ ok: true, usuario: publico(u) });
    }),
  );

  app.delete(
    "/api/equipo/:usuario",
    admin,
    wrap(async (req, res) => {
      if (req.params.usuario === L(res).usuario.usuario) {
        res.status(400).json({ error: "No podés borrar tu propio usuario." });
        return;
      }
      await p.usuarios.borrar(String(req.params.usuario));
      res.json({ ok: true });
    }),
  );

  /** Cualquier usuario puede cambiar su propia contraseña. */
  app.post(
    "/api/mi-clave",
    wrap(async (req, res) => {
      const yo = L(res).usuario;
      if (yo.usuario === LOCAL_ADMIN.usuario) {
        res.status(400).json({ error: "Primero creá tu usuario en Equipo." });
        return;
      }
      const ok = await p.usuarios.verificar(yo.usuario, String(req.body?.actual ?? ""));
      if (!ok) {
        res.status(400).json({ error: "La contraseña actual no es correcta." });
        return;
      }
      await p.usuarios.actualizar(yo.usuario, { clave: String(req.body?.nueva ?? "") });
      res.json({ ok: true });
    }),
  );

  return app;
}
