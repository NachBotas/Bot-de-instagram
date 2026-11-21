import type Anthropic from "@anthropic-ai/sdk";
import { toBubbles, typingDelayMs } from "./agent/bubbles.js";
import type { Setter } from "./agent/setter.js";
import type { InboundMessage } from "./inbound.js";
import type { ManyChatClient } from "./integrations/manychat.js";
import { asClaudeImageType, downloadMedia, looksLikeAttachmentUrl } from "./integrations/media.js";
import type { Transcriber } from "./integrations/transcription.js";
import type { Lead, LeadStore, PendingInput } from "./store.js";

type Block = Anthropic.Beta.BetaContentBlockParam;

export interface EngineOptions {
  store: LeadStore;
  setter: Setter;
  manychat: ManyChatClient;
  transcriber: Transcriber;
  debounceMs: number;
  typingDelayMs: number;
  maxBubbles: number;
  pauseTag: string;
  followup: { enabled: boolean; afterHours: number; max: number };
  log: (msg: string, extra?: unknown) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const HOUR = 60 * 60 * 1000;

/**
 * Orquesta la conversación:
 *  - Junta los mensajes que el lead manda seguidos (debounce) y responde una sola vez.
 *  - Procesa un lead a la vez (si llegan mensajes mientras responde, se encolan).
 *  - Transcribe audios y le pasa imágenes a Claude.
 *  - Manda la respuesta en burbujas por ManyChat.
 */
export class Engine {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: EngineOptions) {
    this.sleep = o.sleep ?? defaultSleep;
  }

  /** Recibe un mensaje del webhook. Responde rápido; el procesamiento sigue en segundo plano. */
  async receive(msg: InboundMessage): Promise<void> {
    await this.withLock(msg.subscriberId, async () => {
      const lead = await this.o.store.getOrCreate(msg.subscriberId);
      lead.firstName = msg.firstName ?? lead.firstName;
      lead.lastName = msg.lastName ?? lead.lastName;
      lead.username = msg.username ?? lead.username;
      const pending: PendingInput = { receivedAt: new Date().toISOString() };
      if (msg.mediaUrl) pending.mediaUrl = msg.mediaUrl;
      if (msg.text && looksLikeAttachmentUrl(msg.text) && !msg.mediaUrl) pending.mediaUrl = msg.text;
      else if (msg.text) pending.text = msg.text;
      lead.pending.push(pending);
      lead.lastUserAt = pending.receivedAt;
      lead.followupsSent = 0;
      await this.o.store.save(lead);
    });
    this.schedule(msg.subscriberId);
  }

  private schedule(id: string, delay = this.o.debounceMs): void {
    clearTimeout(this.timers.get(id));
    const t = setTimeout(() => {
      this.timers.delete(id);
      this.flush(id).catch((err) => this.o.log(`❌ Error procesando ${id}`, err instanceof Error ? err.stack : err));
    }, delay);
    t.unref?.();
    this.timers.set(id, t);
  }

  /** Procesa ya todo lo pendiente de un lead (lo usa el debounce y el simulador). */
  async flush(id: string): Promise<void> {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    await this.withLock(id, () => this.process(id));
  }

  /** Modifica un lead de forma segura (sin pisar una respuesta en curso). */
  async updateLead(id: string, fn: (lead: Lead) => void | Promise<void>): Promise<Lead | undefined> {
    let result: Lead | undefined;
    await this.withLock(id, async () => {
      const lead = await this.o.store.get(id);
      if (!lead) return;
      await fn(lead);
      await this.o.store.save(lead);
      result = lead;
    });
    return result;
  }

  /** Al arrancar: retoma leads que quedaron con mensajes sin responder (ej. por un reinicio). */
  async resumePending(): Promise<number> {
    const leads = await this.o.store.list();
    let n = 0;
    for (const l of leads) {
      if (l.pending.length > 0) {
        this.schedule(l.subscriberId, 1000 + n * 500);
        n++;
      }
    }
    return n;
  }

  private async withLock(id: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.catch(() => undefined);
    this.locks.set(id, settled);
    try {
      await run;
    } finally {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    }
  }

  private async isPaused(lead: Lead): Promise<boolean> {
    if (lead.paused) return true;
    try {
      const tags = await this.o.manychat.getSubscriberTags(lead.subscriberId);
      if (tags) lead.tags = tags;
      return !!tags?.includes(this.o.pauseTag);
    } catch (err) {
      this.o.log("⚠️  No pude leer los tags del contacto (sigo igual)", err instanceof Error ? err.message : err);
      return false;
    }
  }

  private async process(id: string): Promise<void> {
    const lead = await this.o.store.get(id);
    if (!lead || lead.pending.length === 0) return;

    if (await this.isPaused(lead)) {
      this.o.log(`⏸️  ${id} está en pausa (atiende un humano); no respondo`);
      lead.pending = [];
      await this.o.store.save(lead);
      return;
    }

    const batch = lead.pending;
    lead.pending = [];
    const blocks = await this.toBlocks(batch);
    if (lead.etapa === "nuevo") lead.etapa = "conversando";

    let reply;
    try {
      reply = await this.o.setter.respond(lead, blocks);
    } catch (err) {
      await this.o.store.save(lead);
      throw err;
    }
    await this.o.store.save(lead);

    if (reply.refused) {
      await this.o.manychat.addTag(id, "setter_revisar").catch(() => undefined);
      return;
    }
    await this.send(lead, reply.text);
  }

  private async send(lead: Lead, text: string): Promise<void> {
    const bubbles = toBubbles(text, this.o.maxBubbles);
    if (bubbles.length === 0) return;
    for (let i = 0; i < bubbles.length; i++) {
      if (i > 0) await this.sleep(typingDelayMs(bubbles[i]!, this.o.typingDelayMs));
      await this.o.manychat.sendText(lead.subscriberId, [bubbles[i]!]);
    }
    const fresh = (await this.o.store.get(lead.subscriberId)) ?? lead;
    fresh.lastBotAt = new Date().toISOString();
    await this.o.store.save(fresh);
  }

  /** Convierte la tanda de mensajes en bloques para Claude (texto, transcripción de audios, imágenes). */
  async toBlocks(batch: PendingInput[]): Promise<Block[]> {
    const blocks: Block[] = [];
    const texts: string[] = [];
    const flushText = () => {
      if (texts.length) blocks.push({ type: "text", text: texts.splice(0).join("\n") });
    };

    for (const p of batch) {
      if (p.text) texts.push(p.text);
      if (!p.mediaUrl) continue;
      try {
        const media = await downloadMedia(p.mediaUrl, this.o.fetchImpl);
        if (media.kind === "audio" || media.kind === "video") {
          if (!this.o.transcriber.enabled) {
            texts.push(`[El lead mandó ${media.kind === "audio" ? "un audio" : "un video"}, pero la transcripción no está activada]`);
            continue;
          }
          const transcript = await this.o.transcriber.transcribe(media.data, media.mimeType);
          texts.push(
            transcript
              ? `[${media.kind === "audio" ? "Audio" : "Video"} del lead, transcripción]: ${transcript}`
              : `[El lead mandó un ${media.kind === "audio" ? "audio" : "video"} sin voz entendible]`,
          );
        } else if (media.kind === "image") {
          const mediaType = asClaudeImageType(media.mimeType);
          if (!mediaType) {
            texts.push("[El lead mandó una imagen en un formato que no puedo ver]");
            continue;
          }
          flushText();
          blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: media.data.toString("base64") } });
          texts.push("[El lead mandó la imagen de arriba]");
        } else {
          texts.push("[El lead mandó un archivo adjunto]");
        }
      } catch (err) {
        this.o.log("⚠️  No pude procesar el adjunto", err instanceof Error ? err.message : err);
        texts.push("[El lead mandó un adjunto (audio o imagen) que no se pudo abrir]");
      }
    }
    flushText();
    if (blocks.length === 0) blocks.push({ type: "text", text: "[mensaje vacío]" });
    return blocks;
  }

  /**
   * Seguimientos: si el lead dejó de responder, el bot le escribe una vez más.
   * Solo dentro de las 23 h desde su último mensaje (ventana de 24 h de Instagram).
   */
  async runFollowups(now = new Date()): Promise<number> {
    const f = this.o.followup;
    if (!f.enabled) return 0;
    let sent = 0;
    for (const lead of await this.o.store.list()) {
      if (lead.paused || lead.pending.length > 0) continue;
      if (["agendado", "no_calificado", "humano"].includes(lead.etapa)) continue;
      if (lead.followupsSent >= f.max || !lead.lastUserAt || !lead.lastBotAt) continue;
      const lastUser = Date.parse(lead.lastUserAt);
      const lastBot = Date.parse(lead.lastBotAt);
      if (lastBot < lastUser) continue; // el último en hablar fue el lead
      if (now.getTime() - lastBot < f.afterHours * HOUR) continue;
      if (now.getTime() - lastUser > 23 * HOUR) continue;

      await this.withLock(lead.subscriberId, async () => {
        const l = await this.o.store.get(lead.subscriberId);
        if (!l || l.pending.length > 0 || (await this.isPaused(l))) return;
        const hours = Math.round((now.getTime() - lastBot) / HOUR);
        const reply = await this.o.setter.respond(
          l,
          [
            {
              type: "text",
              text: `[EVENTO DEL SISTEMA: el lead no respondió hace ${hours} h. Escribile un seguimiento corto y natural (1 burbuja) retomando donde quedó la charla, sin presionar ni repetir lo último que dijiste. Si ya no tiene sentido escribirle, respondé con una cadena vacía.]`,
            },
          ],
          now,
        );
        l.followupsSent += 1;
        await this.o.store.save(l);
        if (!reply.refused && reply.text) {
          await this.send(l, reply.text);
          sent++;
        }
      });
    }
    return sent;
  }
}
