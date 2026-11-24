import { exec } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { correrAnalisis } from "./analytics/run.js";
import { log } from "./app.js";
import { config } from "./config.js";
import { parseInbound } from "./inbound.js";
import { crearPanel } from "./panel.js";
import { Runtime } from "./runtime.js";
import { registrarEtapa } from "./store.js";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Acepta el secreto en el header X-Webhook-Secret o en ?secret= (ManyChat permite ambos). */
function requireSecret(getSecret: () => string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    const secret = getSecret();
    if (!secret) return next();
    const given = req.header("x-webhook-secret") ?? (typeof req.query.secret === "string" ? req.query.secret : "");
    if (given && safeEqual(given, secret)) return next();
    res.status(401).json({ error: "no autorizado" });
  };
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = config.ADMIN_TOKEN;
  const auth = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (token && auth && safeEqual(auth, token)) return next();
  res.status(401).json({ error: "no autorizado" });
}

/** Servidor público: lo que llama ManyChat (y la agenda). Esto es lo que expone el túnel. */
function crearServidorWebhooks(rt: Runtime) {
  const server = express();
  server.use(express.json({ limit: "1mb" }));
  const secret = requireSecret(() => rt.ajustes.webhookSecret);

  server.get("/health", (_req, res) => {
    res.json({ ok: true, botActivo: rt.ajustes.botActivo });
  });

  /**
   * Webhook que llama el "External Request" de ManyChat por cada mensaje del lead.
   * Respondemos al instante (ManyChat corta a los 10 s) y el bot contesta por la API.
   */
  server.post("/webhook/manychat", secret, (req, res) => {
    // Formato Dynamic Block v2 vacío: ManyChat no manda nada extra y sigue el flow.
    const vacio = { version: "v2", content: { type: "instagram", messages: [] } };
    if (!rt.ajustes.botActivo) {
      log("⏸️  Mensaje recibido con el bot apagado: no respondo");
      res.json(vacio);
      return;
    }
    const msg = parseInbound(req.body);
    if ("error" in msg) {
      log(`⚠️  Webhook ignorado: ${msg.error}`, req.body);
      res.status(400).json({ error: msg.error });
      return;
    }
    log(`📩 ${msg.subscriberId} (${msg.username ?? msg.firstName ?? "?"}): ${msg.text ?? ""}${msg.mediaUrl ? " [adjunto]" : ""}`);
    res.json(vacio);
    rt.app.engine.receive(msg).catch((err) => log("❌ Error guardando el mensaje", err instanceof Error ? err.stack : err));
  });

  /**
   * Webhook de la agenda (modo link): Calendly "invitee.created" o Cal.com "BOOKING_CREATED".
   * Marca al lead como agendado y, si está configurado, dispara el flow de confirmación.
   */
  server.post("/webhook/agenda", secret, async (req, res) => {
    const b = req.body ?? {};
    const p = b.payload ?? {};
    const subscriberId: string | undefined =
      p.tracking?.utm_content ?? p.metadata?.subscriber_id ?? p.responses?.subscriber_id ?? b.subscriber_id;
    const start: string | undefined = p.scheduled_event?.start_time ?? p.startTime ?? b.start;
    const email: string | undefined = p.email ?? p.attendees?.[0]?.email ?? b.email;
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
    const manychat = rt.app.manychat;
    try {
      if (prev !== "nuevo" && prev !== "agendado") await manychat.removeTag(lead.subscriberId, `setter_${prev}`);
      await manychat.addTag(lead.subscriberId, "setter_agendado");
      if (start) await manychat.setCustomField(lead.subscriberId, "setter_llamada", start);
      const flow = rt.config.FLOW_BOOKED_NS;
      if (flow) await manychat.sendFlow(lead.subscriberId, flow);
    } catch (err) {
      log("⚠️  No pude actualizar ManyChat tras la reserva", err instanceof Error ? err.message : err);
    }
    log(`📅 ${lead.subscriberId} agendó para ${start ?? "?"}`);
    res.json({ ok: true });
  });

  // ---- API de administración remota (Authorization: Bearer ADMIN_TOKEN), para servidores en la nube ----
  if (config.ADMIN_TOKEN) {
    server.get("/admin/leads", requireAdmin, async (_req, res) => {
      const leads = await rt.app.store.list();
      res.json(
        leads
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map(({ history, pending, ...rest }) => ({ ...rest, mensajes: history.length, pendientes: pending.length })),
      );
    });
    server.get("/admin/analisis", requireAdmin, async (req, res) => {
      const dias = Number(req.query.dias);
      const result = await correrAnalisis({
        store: rt.app.store,
        client: rt.app.client,
        model: rt.ajustes.claude.modelo,
        dataDir: config.DATA_DIR,
        negocio: rt.ajustes.negocio,
        dias: dias > 0 ? dias : undefined,
        recomendaciones: req.query.ia !== "0",
      });
      if (req.query.formato === "md") res.type("text/markdown").send(result.markdown);
      else res.json(result);
    });
  }

  return server;
}

function abrirNavegador(url: string) {
  const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => undefined);
}

async function main() {
  const rt = await Runtime.start(config);

  const esLocal = ["127.0.0.1", "localhost", "::1"].includes(config.PANEL_HOST);
  if (!esLocal && !config.PANEL_PASSWORD) {
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

  crearServidorWebhooks(rt)
    .listen(config.PORT, () => log(`📡 Webhooks escuchando en el puerto ${config.PORT}`))
    .on("error", (e: NodeJS.ErrnoException) => yaAbierta(e, "de los webhooks"));

  crearPanel(rt)
    .listen(config.PANEL_PORT, config.PANEL_HOST, () => {
      log(`🖥️  Panel de control: ${panelUrl}`);
      log(rt.ajustes.botActivo ? "▶️  El bot está ACTIVO" : "⏸️  El bot está apagado: activalo desde el panel");
      if (process.argv.includes("--abrir")) abrirNavegador(panelUrl);
    })
    .on("error", (e: NodeJS.ErrnoException) => yaAbierta(e, "del panel"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
