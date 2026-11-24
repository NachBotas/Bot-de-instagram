import type Anthropic from "@anthropic-ai/sdk";
import { toBubbles, typingDelayMs } from "./agent/bubbles.js";
import type { Setter } from "./agent/setter.js";
import type { InboundMessage } from "./inbound.js";
import type { ManyChatClient } from "./integrations/manychat.js";
import { asClaudeImageType, downloadMedia, looksLikeAttachmentUrl } from "./integrations/media.js";
import type { Transcriber } from "./integrations/transcription.js";
import { minutosHastaAbrir, type Horario } from "./horario.js";
import { registrarEtapa, type Lead, type LeadStore, type PendingInput } from "./store.js";

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
  /** Tags de ManyChat cuyos contactos el bot ignora (clientes, amigos…). */
  excluirTags?: string[];
  /** Horario de atención: fuera de horario, los mensajes esperan. */
  horario?: Horario & { zona: string };
  /** Demora extra al azar antes de responder (segundos). */
  demora?: { minSeg: number; maxSeg: number };
  /** Se llama si falla Claude o el envío por ManyChat. */
  onError?: (lead: Lead, err: unknown) => Promise<void>;
  /** Responder con notas de voz. `sintetizar` devuelve la URL pública del audio. */
  voz?: { modo: "nunca" | "si_audio" | "siempre"; sintetizar: (texto: string) => Promise<string> };
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const HOUR = 60 * 60 * 1000;
const MAX_TIMER = 2 ** 31 - 1;

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

  constructor(private o: EngineOptions) {
    this.sleep = o.sleep ?? defaultSleep;
  }

  /** Cambia la configuración en caliente (desde el panel) sin perder las conversaciones en curso. */
  reconfigure(o: EngineOptions): void {
    this.o = o;
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
    this.schedule(msg.subscriberId, this.o.debounceMs + this.demoraAlAzar());
  }

  /** Demora "humana" al azar entre el mínimo y el máximo configurados. */
  private demoraAlAzar(): number {
    const d = this.o.demora;
    if (!d || d.maxSeg <= 0) return 0;
    const min = Math.min(d.minSeg, d.maxSeg);
    const r = (this.o.random ?? Math.random)();
    return Math.round((min + r * (d.maxSeg - min)) * 1000);
  }

  private schedule(id: string, delay = this.o.debounceMs): void {
    clearTimeout(this.timers.get(id));
    const t = setTimeout(() => {
      this.timers.delete(id);
      this.flush(id).catch((err) => this.o.log(`❌ Error procesando ${id}`, err instanceof Error ? err.message : err));
    }, Math.min(delay, MAX_TIMER));
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

  /** ¿El bot tiene que quedarse callado con este lead? (pausa manual/temporal, tag de pausa o tag excluido) */
  private async isPaused(lead: Lead): Promise<boolean> {
    if (lead.paused && lead.pausadoHasta && Date.parse(lead.pausadoHasta) <= Date.now()) {
      // Terminó la pausa temporal: el bot vuelve a responder.
      lead.paused = false;
      lead.pausadoHasta = undefined;
      await this.o.manychat.removeTag(lead.subscriberId, this.o.pauseTag).catch(() => undefined);
    }
    if (lead.paused) return true;
    try {
      const tags = await this.o.manychat.getSubscriberTags(lead.subscriberId);
      if (tags) lead.tags = tags;
      const bloqueo = [this.o.pauseTag, ...(this.o.excluirTags ?? [])].map((t) => t.toLowerCase());
      return !!tags?.some((t) => bloqueo.includes(t.toLowerCase()));
    } catch (err) {
      this.o.log("⚠️  No pude leer los tags del contacto (sigo igual)", err instanceof Error ? err.message : err);
      return false;
    }
  }

  private async process(id: string): Promise<void> {
    const lead = await this.o.store.get(id);
    if (!lead || lead.pending.length === 0) return;

    if (await this.isPaused(lead)) {
      this.o.log(`⏸️  ${id} está en pausa o excluido; no respondo`);
      lead.pending = [];
      await this.o.store.save(lead);
      return;
    }

    // Fuera del horario de atención: los mensajes quedan esperando hasta que abra.
    if (this.o.horario?.activo) {
      const faltan = minutosHastaAbrir(new Date(), this.o.horario, this.o.horario.zona);
      if (faltan > 0) {
        this.o.log(`🌙 Fuera de horario: respondo a ${id} en ${faltan} min`);
        this.schedule(id, faltan * 60_000 + this.demoraAlAzar());
        return;
      }
    }

    const batch = lead.pending;
    lead.pending = [];
    const { blocks, huboAudio } = await this.toBlocks(batch);
    if (lead.etapa === "nuevo") registrarEtapa(lead, "conversando");
    lead.turnos.push({ de: "lead", at: batch[batch.length - 1]!.receivedAt, texto: blocksToText(blocks) });
    await this.responderYEnviar(lead, blocks, { huboAudio });
  }

  /** Corre Claude y manda la respuesta. Si algo falla, avisa (onError) y relanza el error. */
  private async responderYEnviar(lead: Lead, blocks: Block[], opts: { huboAudio?: boolean; seguimiento?: boolean; now?: Date } = {}): Promise<boolean> {
    let reply;
    try {
      reply = await this.o.setter.respond(lead, blocks, opts.now);
    } catch (err) {
      await this.o.store.save(lead);
      await this.o.onError?.(lead, err).catch(() => undefined);
      throw err;
    }
    await this.o.store.save(lead);

    if (reply.refused) {
      await this.o.manychat.addTag(lead.subscriberId, "setter_revisar").catch(() => undefined);
      return false;
    }
    try {
      return await this.send(lead, reply.text, opts);
    } catch (err) {
      await this.o.onError?.(lead, err).catch(() => undefined);
      throw err;
    }
  }

  /** Reintenta responder el último mensaje del lead (por ejemplo, después de un error). */
  async reintentar(id: string): Promise<boolean> {
    let ok = false;
    await this.withLock(id, async () => {
      const lead = await this.o.store.get(id);
      if (!lead) return;
      ok = await this.responderYEnviar(lead, [
        { type: "text", text: "[EVENTO DEL SISTEMA: hubo un problema técnico y el lead quedó sin respuesta. Respondé ahora a lo último que escribió, sin mencionar el problema.]" },
      ]);
    });
    return ok;
  }

  private async send(lead: Lead, text: string, opts: { seguimiento?: boolean; huboAudio?: boolean } = {}): Promise<boolean> {
    const bubbles = toBubbles(text, this.o.maxBubbles);
    if (bubbles.length === 0) return false;

    // Nota de voz: si está activado y la respuesta no tiene links (los links tienen que ir escritos).
    const voz = this.o.voz;
    const usarVoz = voz && (voz.modo === "siempre" || (voz.modo === "si_audio" && opts.huboAudio)) && !/https?:\/\//.test(text);
    let comoAudio = false;
    if (usarVoz) {
      try {
        const url = await voz.sintetizar(bubbles.join(" "));
        await this.o.manychat.sendAudio(lead.subscriberId, url);
        comoAudio = true;
      } catch (err) {
        this.o.log("⚠️  No pude mandar la nota de voz; mando texto", err instanceof Error ? err.message : err);
      }
    }
    if (!comoAudio) {
      for (let i = 0; i < bubbles.length; i++) {
        if (i > 0) await this.sleep(typingDelayMs(bubbles[i]!, this.o.typingDelayMs));
        await this.o.manychat.sendText(lead.subscriberId, [bubbles[i]!]);
      }
    }
    const fresh = (await this.o.store.get(lead.subscriberId)) ?? lead;
    fresh.lastBotAt = new Date().toISOString();
    fresh.turnos.push({
      de: "bot",
      at: fresh.lastBotAt,
      texto: (comoAudio ? "🎙️ " : "") + bubbles.join("\n\n"),
      etapa: fresh.etapa,
      ...(opts.seguimiento ? { seguimiento: true } : {}),
    });
    await this.o.store.save(fresh);
    return true;
  }

  /** Convierte la tanda de mensajes en bloques para Claude (texto, transcripción de audios, imágenes). */
  async toBlocks(batch: PendingInput[]): Promise<{ blocks: Block[]; huboAudio: boolean }> {
    let huboAudio = false;
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
          if (media.kind === "audio") huboAudio = true;
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
    return { blocks, huboAudio };
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
        l.followupsSent += 1;
        const enviado = await this.responderYEnviar(
          l,
          [
            {
              type: "text",
              text: `[EVENTO DEL SISTEMA: el lead no respondió hace ${hours} h. Escribile un seguimiento corto y natural (1 burbuja) retomando donde quedó la charla, sin presionar ni repetir lo último que dijiste. Si ya no tiene sentido escribirle, respondé con una cadena vacía.]`,
            },
          ],
          { seguimiento: true, now },
        );
        if (enviado) sent++;
      });
    }
    return sent;
  }
}

/** Texto legible de lo que mandó el lead (para el registro de la charla). */
function blocksToText(blocks: Block[]): string {
  return blocks
    .map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[imagen]" : `[${b.type}]`))
    .filter((t) => t !== "[El lead mandó la imagen de arriba]")
    .join("\n");
}
