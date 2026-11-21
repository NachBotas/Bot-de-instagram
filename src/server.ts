import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { buildApp, log } from "./app.js";
import { config } from "./config.js";
import { parseInbound } from "./inbound.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Acepta el secreto en el header X-Webhook-Secret o en ?secret= (ManyChat permite ambos). */
function requireSecret(secret: string | undefined, header = "x-webhook-secret") {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!secret) return next();
    const given = req.header(header) ?? (typeof req.query.secret === "string" ? req.query.secret : "");
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

async function main() {
  if (!config.WEBHOOK_SECRET) log("⚠️  WEBHOOK_SECRET no está definido: cualquiera podría llamar al webhook");
  const app = await buildApp(config);
  const { engine, store, manychat } = app;
  log(`🤖 Setter listo. Modelo ${config.CLAUDE_MODEL} · agenda: ${app.mode} · audios: ${config.TRANSCRIPTION_PROVIDER}`);

  const server = express();
  server.use(express.json({ limit: "1mb" }));

  server.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  /**
   * Webhook que llama el "External Request" de ManyChat por cada mensaje del lead.
   * Respondemos al instante (ManyChat corta a los 10 s) y el bot contesta por la API.
   */
  server.post("/webhook/manychat", requireSecret(config.WEBHOOK_SECRET), (req, res) => {
    const msg = parseInbound(req.body);
    if ("error" in msg) {
      log(`⚠️  Webhook ignorado: ${msg.error}`, req.body);
      res.status(400).json({ error: msg.error });
      return;
    }
    log(`📩 ${msg.subscriberId} (${msg.username ?? msg.firstName ?? "?"}): ${msg.text ?? ""}${msg.mediaUrl ? " [adjunto]" : ""}`);
    // Formato Dynamic Block v2 vacío: ManyChat no manda nada extra y sigue el flow.
    res.json({ version: "v2", content: { type: "instagram", messages: [] } });
    engine.receive(msg).catch((err) => log("❌ Error guardando el mensaje", err instanceof Error ? err.stack : err));
  });

  /**
   * Webhook de la agenda (modo link): Calendly "invitee.created" o Cal.com "BOOKING_CREATED".
   * Marca al lead como agendado y, si está configurado, dispara el flow de confirmación.
   */
  server.post("/webhook/agenda", requireSecret(config.WEBHOOK_SECRET), async (req, res) => {
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
    const lead = await engine.updateLead(String(subscriberId), (l) => {
      prev = l.etapa;
      l.booking = { ...l.booking, start };
      if (email) l.email = email;
      l.etapa = "agendado";
    });
    if (!lead) {
      res.status(200).json({ ok: false, reason: "lead desconocido" });
      return;
    }
    try {
      if (prev !== "nuevo" && prev !== "agendado") await manychat.removeTag(lead.subscriberId, `setter_${prev}`);
      await manychat.addTag(lead.subscriberId, "setter_agendado");
      if (start) await manychat.setCustomField(lead.subscriberId, "setter_llamada", start);
      if (config.FLOW_BOOKED_NS) await manychat.sendFlow(lead.subscriberId, config.FLOW_BOOKED_NS);
    } catch (err) {
      log("⚠️  No pude actualizar ManyChat tras la reserva", err instanceof Error ? err.message : err);
    }
    log(`📅 ${lead.subscriberId} agendó para ${start ?? "?"}`);
    res.json({ ok: true });
  });

  // ---- Panel mínimo de administración (Authorization: Bearer ADMIN_TOKEN) ----
  if (config.ADMIN_TOKEN) {
    server.get("/admin/leads", requireAdmin, async (_req, res) => {
      const leads = await store.list();
      res.json(
        leads
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map(({ history, pending, ...rest }) => ({ ...rest, mensajes: history.length, pendientes: pending.length })),
      );
    });
    server.get("/admin/leads/:id", requireAdmin, async (req, res) => {
      const lead = await store.get(String(req.params.id));
      if (!lead) res.status(404).json({ error: "no existe" });
      else res.json(lead);
    });
    server.post("/admin/leads/:id/pause", requireAdmin, async (req, res) => {
      const lead = await engine.updateLead(String(req.params.id), (l) => {
        l.paused = true;
      });
      if (!lead) {
        res.status(404).json({ error: "no existe" });
        return;
      }
      await manychat.addTag(lead.subscriberId, config.PAUSE_TAG).catch(() => undefined);
      res.json({ ok: true });
    });
    server.post("/admin/leads/:id/resume", requireAdmin, async (req, res) => {
      const lead = await engine.updateLead(String(req.params.id), (l) => {
        l.paused = false;
        if (l.etapa === "humano") l.etapa = "conversando";
      });
      if (!lead) {
        res.status(404).json({ error: "no existe" });
        return;
      }
      await manychat.removeTag(lead.subscriberId, config.PAUSE_TAG).catch(() => undefined);
      res.json({ ok: true });
    });
    server.delete("/admin/leads/:id", requireAdmin, async (req, res) => {
      await store.delete(String(req.params.id));
      res.json({ ok: true });
    });
  }

  server.listen(config.PORT, () => log(`🚀 Escuchando en el puerto ${config.PORT} → POST /webhook/manychat`));

  const resumed = await engine.resumePending();
  if (resumed) log(`↩️  Retomando ${resumed} conversación(es) con mensajes sin responder`);

  if (config.FOLLOWUP_ENABLED) {
    const tick = () =>
      engine
        .runFollowups()
        .then((n) => n && log(`🔁 ${n} seguimiento(s) enviados`))
        .catch((err) => log("❌ Error en seguimientos", err instanceof Error ? err.stack : err));
    setInterval(tick, 15 * 60 * 1000).unref();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
