import { exec } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { correrAnalisis } from "./analytics/run.js";
import { log } from "./app.js";
import { config } from "./config.js";
import { parseInbound } from "./inbound.js";
import { crearPanel } from "./panel.js";
import { Plataforma } from "./plataforma.js";
import type { Runtime } from "./runtime.js";
import { registrarEtapa } from "./store.js";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Acepta el secreto de la cuenta en el header X-Webhook-Secret o en ?secret= (ManyChat permite ambos). */
function secretoValido(req: Request, rt: Runtime): boolean {
  const secret = rt.ajustes.webhookSecret;
  if (!secret) return true;
  const given = req.header("x-webhook-secret") ?? (typeof req.query.secret === "string" ? req.query.secret : "");
  return !!given && safeEqual(given, secret);
}

/** Rutas públicas: lo que llaman ManyChat y la agenda, y las notas de voz. Esto es lo que expone el túnel. */
function rutasPublicas(app: Express, p: Plataforma) {
  const cuentaDe = (req: Request) => (req.params.cuenta ? p.cuenta(String(req.params.cuenta)) : p.principal);

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  /** Notas de voz que manda el bot (ManyChat las descarga de acá). */
  app.get("/media/:archivo", (req, res) => {
    const ruta = p.media.ruta(String(req.params.archivo));
    if (!ruta) {
      res.status(404).end();
      return;
    }
    res.sendFile(ruta, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" } }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  /**
   * Webhook que llama el "External Request" de ManyChat por cada mensaje del lead.
   * Respondemos al instante (ManyChat corta a los 10 s) y el bot contesta por la API.
   */
  const manychat = (req: Request, res: Response) => {
    const rt = cuentaDe(req);
    if (!rt) {
      res.status(404).json({ error: "cuenta desconocida" });
      return;
    }
    if (!secretoValido(req, rt)) {
      res.status(401).json({ error: "no autorizado" });
      return;
    }
    // Formato Dynamic Block v2 vacío: ManyChat no manda nada extra y sigue el flow.
    const vacio = { version: "v2", content: { type: "instagram", messages: [] } };
    if (!rt.ajustes.botActivo) {
      log(`⏸️  [${rt.id}] Mensaje recibido con el bot apagado: no respondo`);
      res.json(vacio);
      return;
    }
    const msg = parseInbound(req.body);
    if ("error" in msg) {
      log(`⚠️  [${rt.id}] Webhook ignorado: ${msg.error}`);
      res.status(400).json({ error: msg.error });
      return;
    }
    log(`📩 [${rt.id}] ${msg.username ?? msg.firstName ?? msg.subscriberId}: ${msg.text ?? ""}${msg.mediaUrl ? " [adjunto]" : ""}`);
    res.json(vacio);
    rt.app.engine.receive(msg).catch((err) => log("❌ Error guardando el mensaje", err instanceof Error ? err.message : err));
  };
  app.post("/webhook/manychat", manychat);
  app.post("/webhook/manychat/:cuenta", manychat);

  /**
   * Webhook de la agenda: Calendly "invitee.created" o Cal.com "BOOKING_CREATED".
   * Marca al lead como agendado y, si está configurado, dispara el flow de confirmación.
   */
  const agenda = async (req: Request, res: Response) => {
    const rt = cuentaDe(req);
    if (!rt) {
      res.status(404).json({ error: "cuenta desconocida" });
      return;
    }
    if (!secretoValido(req, rt)) {
      res.status(401).json({ error: "no autorizado" });
      return;
    }
    const b = req.body ?? {};
    const pl = b.payload ?? {};
    const subscriberId: string | undefined =
      pl.tracking?.utm_content ?? pl.metadata?.subscriber_id ?? pl.responses?.subscriber_id ?? b.subscriber_id;
    const start: string | undefined = pl.scheduled_event?.start_time ?? pl.startTime ?? b.start;
    const email: string | undefined = pl.email ?? pl.attendees?.[0]?.email ?? b.email;
    if (!subscriberId) {
      res.status(200).json({ ok: false, reason: "sin subscriber_id (¿el link no se generó con el bot?)" });
      return;
    }
    let prev = "nuevo";
    const lead = await rt.app.engine.updateLead(String(subscriberId), (l) => {
      prev = l.etapa;
      l.booking = { ...l.booking, start };
      if (email) l.email = email;
      registrarEtapa(l, "agendado");
    });
    if (!lead) {
      res.status(200).json({ ok: false, reason: "lead desconocido" });
      return;
    }
    const mc = rt.app.manychat;
    try {
      if (prev !== "nuevo" && prev !== "agendado") await mc.removeTag(lead.subscriberId, `setter_${prev}`);
      await mc.addTag(lead.subscriberId, "setter_agendado");
      if (start) await mc.setCustomField(lead.subscriberId, "setter_llamada", start);
      const flow = rt.config.FLOW_BOOKED_NS;
      if (flow) await mc.sendFlow(lead.subscriberId, flow);
    } catch (err) {
      log("⚠️  No pude actualizar ManyChat tras la reserva", err instanceof Error ? err.message : err);
    }
    log(`📅 [${rt.id}] ${lead.username ?? lead.subscriberId} agendó para ${start ?? "?"}`);
    res.json({ ok: true });
  };
  app.post("/webhook/agenda", agenda);
  app.post("/webhook/agenda/:cuenta", agenda);

  // ---- API remota de solo lectura (Authorization: Bearer ADMIN_TOKEN), para integraciones ----
  if (config.ADMIN_TOKEN) {
    const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
      const auth = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      if (auth && safeEqual(auth, config.ADMIN_TOKEN!)) return next();
      res.status(401).json({ error: "no autorizado" });
    };
    app.get("/admin/:cuenta/leads", requireAdmin, async (req, res) => {
      const rt = p.cuenta(String(req.params.cuenta));
      if (!rt) return void res.status(404).json({ error: "cuenta desconocida" });
      const leads = await rt.app.store.list();
      res.json(leads.map(({ history, pending, ...rest }) => ({ ...rest, mensajes: history.length, pendientes: pending.length })));
    });
    app.get("/admin/:cuenta/analisis", requireAdmin, async (req, res) => {
      const rt = p.cuenta(String(req.params.cuenta));
      if (!rt) return void res.status(404).json({ error: "cuenta desconocida" });
      const dias = Number(req.query.dias);
      const r = await correrAnalisis({
        store: rt.app.store,
        client: rt.app.client,
        model: rt.ajustes.claude.modelo,
        dataDir: rt.base.DATA_DIR,
        negocio: rt.ajustes.negocio,
        dias: dias > 0 ? dias : undefined,
        recomendaciones: req.query.ia !== "0",
      });
      res.type("text/markdown").send(r.markdown);
    });
  }
}

function abrirNavegador(url: string) {
  const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => undefined);
}

async function main() {
  const p = await Plataforma.start(config);

  if (p.esNube) {
    // Nube: todo en un solo puerto, con inicio de sesión obligatorio.
    if (!(await p.usuarios.hayUsuarios())) {
      throw new Error("En la nube tenés que definir PANEL_PASSWORD (la contraseña del usuario 'admin').");
    }
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json({ limit: "2mb" }));
    rutasPublicas(app, p);
    app.use(crearPanel(p, { local: false }));
    app.listen(config.PORT, () => {
      log(`☁️  Setter en la nube escuchando en el puerto ${config.PORT}`);
      log(`🖥️  Panel: ${p.urlBase() ?? "(tu dirección pública)"}`);
    });
    return;
  }

  // En la compu: webhooks en un puerto (el que expone el túnel) y el panel en otro, solo para esta compu.
  const esLocal = ["127.0.0.1", "localhost", "::1"].includes(config.PANEL_HOST);
  if (!esLocal && !(await p.usuarios.hayUsuarios())) {
    throw new Error("Si el panel se abre fuera de esta compu (PANEL_HOST) tenés que definir PANEL_PASSWORD.");
  }
  const panelUrl = `http://${esLocal ? "localhost" : config.PANEL_HOST}:${config.PANEL_PORT}`;

  // Si la app ya estaba abierta (doble clic dos veces), abrimos ese panel en vez de fallar.
  const yaAbierta = (err: NodeJS.ErrnoException, que: string) => {
    if (err.code !== "EADDRINUSE") throw err;
    console.log(`\nEl setter ya está abierto en otra ventana (o algo más usa el puerto ${que}).`);
    console.log(`Abriendo el panel: ${panelUrl}\n`);
    abrirNavegador(panelUrl);
    setTimeout(() => process.exit(0), 1500);
  };

  const publico = express();
  publico.use(express.json({ limit: "1mb" }));
  rutasPublicas(publico, p);
  publico
    .listen(config.PORT, () => log(`📡 Webhooks escuchando en el puerto ${config.PORT}`))
    .on("error", (e: NodeJS.ErrnoException) => yaAbierta(e, "de los webhooks"));

  const panel = express();
  panel.use(crearPanel(p, { local: esLocal }));
  panel
    .listen(config.PANEL_PORT, config.PANEL_HOST, () => {
      log(`🖥️  Panel de control: ${panelUrl}`);
      for (const c of p.lista()) log(`${c.botActivo ? "▶️ " : "⏸️ "} ${c.nombre}: bot ${c.botActivo ? "ACTIVO" : "apagado"}`);
      if (process.argv.includes("--abrir")) abrirNavegador(panelUrl);
    })
    .on("error", (e: NodeJS.ErrnoException) => yaAbierta(e, "del panel"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
