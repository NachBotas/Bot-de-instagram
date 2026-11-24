import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { correrAnalisis } from "./analytics/run.js";
import { log } from "./app.js";
import { config } from "./config.js";
import { ManyChatApi } from "./integrations/manychat.js";
import { explicarError, type Runtime } from "./runtime.js";
import { enmascarar } from "./settings.js";
import { registrarEtapa } from "./store.js";

const PANEL_DIR = fileURLToPath(new URL("../panel", import.meta.url));

const TAGS_NECESARIOS = ["bot_pausado"];
const CAMPOS_NECESARIOS: [string, string][] = [
  ["setter_etapa", "Etapa del lead según el bot setter"],
  ["setter_resumen", "Resumen del lead para el closer"],
  ["setter_email", "Email que dio el lead"],
  ["setter_llamada", "Fecha y hora de la llamada agendada"],
];

/**
 * Panel de control. Por defecto escucha solo en esta compu (127.0.0.1), así que
 * el túnel de ManyChat no lo expone.
 */
export function crearPanel(rt: Runtime) {
  const app = express();
  const esLocal = ["127.0.0.1", "localhost", "::1"].includes(config.PANEL_HOST);

  // Protección: en modo local solo aceptamos el host "localhost" (evita que otra web lo use desde tu navegador).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (esLocal) {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
        res.status(403).send("Acceso no permitido");
        return;
      }
    }
    if (config.PANEL_PASSWORD) {
      const [, b64] = (req.headers.authorization ?? "").split(" ");
      const pass = b64 ? Buffer.from(b64, "base64").toString().split(":").slice(1).join(":") : "";
      if (pass !== config.PANEL_PASSWORD) {
        res.set("WWW-Authenticate", 'Basic realm="Setter"').status(401).send("Contraseña requerida");
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
  app.use("/api", express.json({ limit: "2mb" }));

  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response) => {
      fn(req, res).catch((err) => {
        log("❌ Error en el panel", err instanceof Error ? err.message : err);
        res.status(500).json({ error: explicarError(err) });
      });
    };

  // ---------------------------------------------------------------- estado general

  app.get(
    "/api/estado",
    wrap(async (_req, res) => {
      const a = rt.ajustes;
      const consultas = await rt.consultas.list();
      const leads = await rt.app.store.list();
      const hoy = new Date().toISOString().slice(0, 10);
      res.json({
        botActivo: a.botActivo,
        pagina: a.manychat.pagina,
        advertencias: rt.app.warnings,
        chequeos: rt.chequeos,
        tunel: rt.tunel,
        webhook: { url: rt.urlPublica, secreto: a.webhookSecret, puertoLocal: config.PORT },
        configurado: {
          claude: !!a.claude.apiKey || !!process.env.ANTHROPIC_API_KEY,
          manychat: !!a.manychat.apiKey,
          // La plantilla sin completar no cuenta.
          negocio: a.negocio.trim().length > 50 && !a.negocio.includes("[Tu nombre o marca]"),
          audios: a.audios.proveedor !== "none" && !!a.audios.claves[a.audios.proveedor as "groq" | "openai" | "deepgram"],
          agenda: a.agenda.modo !== "ninguna",
          automatizaciones: a.automatizaciones.length,
          tunel: !!a.tunel.authtoken,
        },
        numeros: {
          conversaciones: leads.length,
          activasHoy: leads.filter((l) => (l.lastUserAt ?? "").startsWith(hoy)).length,
          agendadas: leads.filter((l) => l.etapa === "agendado").length,
          consultasPendientes: consultas.filter((c) => c.estado === "pendiente").length,
        },
      });
    }),
  );

  app.post(
    "/api/bot",
    wrap(async (req, res) => {
      await rt.setBotActivo(!!req.body?.activo);
      res.json({ ok: true, botActivo: rt.ajustes.botActivo });
    }),
  );

  // ---------------------------------------------------------------- ajustes

  app.get("/api/ajustes", (_req, res) => {
    res.json(enmascarar(rt.ajustes));
  });

  app.put(
    "/api/ajustes",
    wrap(async (req, res) => {
      const nuevo = await rt.guardarAjustes(req.body);
      res.json({ ok: true, ajustes: enmascarar(nuevo), advertencias: rt.app.warnings });
    }),
  );

  app.get(
    "/api/plantilla-negocio",
    wrap(async (_req, res) => {
      res.type("text/plain").send(await fs.readFile(config.BUSINESS_FILE, "utf8").catch(() => ""));
    }),
  );

  // ---------------------------------------------------------------- pruebas de conexión

  app.post("/api/probar/claude", wrap(async (_req, res) => void res.json(await rt.probarClaude())));
  app.post("/api/probar/manychat", wrap(async (_req, res) => void res.json(await rt.probarManychat())));
  app.post(
    "/api/probar/audio",
    express.raw({ type: ["audio/*", "video/*", "application/octet-stream"], limit: "25mb" }),
    wrap(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ ok: false, texto: "No llegó ningún audio." });
        return;
      }
      res.json(await rt.probarAudio(req.body, req.header("content-type") ?? "audio/mpeg"));
    }),
  );
  app.post(
    "/api/probar/chat",
    wrap(async (req, res) => {
      const texto = String(req.body?.texto ?? "").trim();
      if (!texto) {
        res.status(400).json({ error: "Escribí un mensaje" });
        return;
      }
      res.json(await rt.probarChat(String(req.body?.sesion ?? "1"), texto));
    }),
  );

  // ---------------------------------------------------------------- túnel

  app.post(
    "/api/tunel",
    wrap(async (req, res) => {
      if (req.body?.activo) await rt.iniciarTunel().catch(() => undefined);
      else await rt.detenerTunel();
      res.json({ tunel: rt.tunel, url: rt.urlPublica });
    }),
  );

  // ---------------------------------------------------------------- ManyChat

  const manychat = () => {
    if (!rt.ajustes.manychat.apiKey) throw new Error("Primero conectá ManyChat con tu API key.");
    return new ManyChatApi(rt.ajustes.manychat.apiKey);
  };

  app.get(
    "/api/manychat/flows",
    wrap(async (_req, res) => {
      res.json(await manychat().getFlows());
    }),
  );

  /** Crea en ManyChat los tags y campos que usa el bot (los que ya existen se dejan como están). */
  app.post(
    "/api/manychat/preparar",
    wrap(async (_req, res) => {
      const mc = manychat();
      const [tags, campos] = await Promise.all([mc.getTags(), mc.getCustomFields()]);
      const creados: string[] = [];
      const existentes: string[] = [];
      for (const t of TAGS_NECESARIOS) {
        if (tags.includes(t)) existentes.push(`tag ${t}`);
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
    wrap(async (_req, res) => {
      const leads = await rt.app.store.list();
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
    wrap(async (req, res) => {
      const l = await rt.app.store.get(String(req.params.id));
      if (!l) {
        res.status(404).json({ error: "No existe" });
        return;
      }
      const { history, pending, ...resto } = l;
      res.json(resto);
    }),
  );

  app.post(
    "/api/conversaciones/:id/pausa",
    wrap(async (req, res) => {
      const pausar = !!req.body?.pausar;
      const l = await rt.app.engine.updateLead(String(req.params.id), (lead) => {
        lead.paused = pausar;
        if (!pausar && lead.etapa === "humano") registrarEtapa(lead, "conversando");
      });
      if (!l) {
        res.status(404).json({ error: "No existe" });
        return;
      }
      const mc = rt.app.manychat;
      await (pausar ? mc.addTag(l.subscriberId, config.PAUSE_TAG) : mc.removeTag(l.subscriberId, config.PAUSE_TAG)).catch(() => undefined);
      res.json({ ok: true, pausado: l.paused });
    }),
  );

  // ---------------------------------------------------------------- consultas (cuando el bot no sabe algo)

  app.get(
    "/api/consultas",
    wrap(async (_req, res) => {
      const items = await rt.consultas.list();
      res.json(items.reverse());
    }),
  );

  app.post(
    "/api/consultas/:id/responder",
    wrap(async (req, res) => {
      const respuesta = String(req.body?.respuesta ?? "").trim();
      const enviar = req.body?.enviar !== false;
      const guardar = !!req.body?.guardar;
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

  app.post(
    "/api/consultas/:id/descartar",
    wrap(async (req, res) => {
      const c = await rt.consultas.resolve(String(req.params.id), "descartada");
      res.json({ ok: !!c });
    }),
  );

  // ---------------------------------------------------------------- análisis

  app.post(
    "/api/analisis",
    wrap(async (req, res) => {
      const dias = Number(req.body?.dias);
      const r = await correrAnalisis({
        store: rt.app.store,
        client: rt.app.client,
        model: rt.ajustes.claude.modelo,
        dataDir: config.DATA_DIR,
        negocio: rt.ajustes.negocio,
        dias: dias > 0 ? dias : undefined,
        recomendaciones: req.body?.ia !== false,
      });
      res.json({ markdown: r.markdown });
    }),
  );

  return app;
}
