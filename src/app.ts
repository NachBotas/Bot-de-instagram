import Anthropic from "@anthropic-ai/sdk";
import { loadAutomations, loadBusiness, type Automation } from "./agent/automations.js";
import { buildSystemPrompt, type Guion, type Regla } from "./agent/prompt.js";
import { Setter } from "./agent/setter.js";
import { buildTools, type ToolDeps } from "./agent/tools.js";
import { bookingMode, type AppConfig } from "./config.js";
import { Engine, type EngineOptions } from "./engine.js";
import type { Uso } from "./gasto.js";
import { CalComClient } from "./integrations/calendar.js";
import { DryRunManyChat, ManyChatApi, type ManyChatClient } from "./integrations/manychat.js";
import { createTranscriber, type Transcriber } from "./integrations/transcription.js";
import { FileLeadStore, type LeadStore } from "./store.js";

export function log(msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  if (extra === undefined) console.log(`${ts} ${msg}`);
  else console.log(`${ts} ${msg}`, typeof extra === "string" ? extra : JSON.stringify(extra));
}

export interface App {
  engine: Engine;
  engineOptions: EngineOptions;
  store: LeadStore;
  manychat: ManyChatClient;
  client: Anthropic;
  transcriber: Transcriber;
  mode: ReturnType<typeof bookingMode>;
  /** Problemas de configuración que no impiden arrancar (se muestran en el panel). */
  warnings: string[];
}

export interface BuildOverrides {
  store?: LeadStore;
  manychat?: ManyChatClient;
  logger?: typeof log;
  fetchImpl?: typeof fetch;
  /** Texto del negocio y automatizaciones (si no se pasan, se leen de config/). */
  business?: string;
  automations?: Automation[];
  /** Guion fijo de preguntas (si está activo, reemplaza el método de venta libre). */
  guion?: Guion;
  /** Reglas "si el lead dice X → hacé Y". */
  reglas?: Regla[];
  /** Flow de ManyChat para avisarle al equipo. */
  flowAviso?: string;
  registrarAviso?: ToolDeps["registrarAviso"];
  /** Tokens de cada respuesta de Claude (contador de gasto). */
  onUsage?: (modelo: string, uso: Uso) => void;
  /** Se llama cada vez que se transcribe un audio. */
  onTranscripcion?: () => void;
  /** Opciones extra del motor: horario, exclusiones, errores, voz… */
  engineExtra?: Partial<EngineOptions>;
}

export async function buildApp(cfg: AppConfig, overrides: BuildOverrides = {}): Promise<App> {
  const logger = overrides.logger ?? log;
  const warnings: string[] = [];

  let manychat = overrides.manychat;
  if (!manychat) {
    if (cfg.MANYCHAT_DRY_RUN || !cfg.MANYCHAT_API_KEY) {
      if (!cfg.MANYCHAT_DRY_RUN) warnings.push("Falta conectar ManyChat: las respuestas no se van a enviar.");
      manychat = new DryRunManyChat((l) => logger(l));
    } else {
      manychat = new ManyChatApi(cfg.MANYCHAT_API_KEY);
    }
  }

  const mode = bookingMode(cfg);
  const calendar = mode === "calcom" ? new CalComClient(cfg.CAL_API_KEY!, Number(cfg.CAL_EVENT_TYPE_ID), fetch) : undefined;

  const business = overrides.business ?? (await loadBusiness(cfg.BUSINESS_FILE));
  const automations = overrides.automations ?? (await loadAutomations(cfg.AUTOMATIONS_FILE));
  if (!business.trim()) warnings.push("Todavía no cargaste la información de tu negocio.");

  const toolDeps: ToolDeps = {
    manychat,
    bookingMode: mode,
    calendar,
    bookingLink: cfg.BOOKING_LINK,
    businessTimezone: cfg.BUSINESS_TIMEZONE,
    automations,
    pauseTag: cfg.PAUSE_TAG,
    flowBookedNs: cfg.FLOW_BOOKED_NS,
    handoffWebhookUrl: cfg.HANDOFF_WEBHOOK_URL,
    flowAviso: overrides.flowAviso,
    registrarAviso: overrides.registrarAviso,
    log: logger,
  };

  // Sin API key explícita, el SDK la toma del entorno (ANTHROPIC_API_KEY u otra credencial configurada).
  const client = new Anthropic(cfg.ANTHROPIC_API_KEY ? { apiKey: cfg.ANTHROPIC_API_KEY } : {});
  if (!cfg.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY) warnings.push("Falta la API key de Claude: el bot no puede responder.");

  const setter = new Setter({
    client,
    model: cfg.CLAUDE_MODEL,
    effort: cfg.CLAUDE_EFFORT,
    systemPrompt: buildSystemPrompt({ business, automations, bookingMode: mode, businessTimezone: cfg.BUSINESS_TIMEZONE, guion: overrides.guion, reglas: overrides.reglas }),
    tools: buildTools({ bookingMode: mode, automations }),
    toolDeps,
    businessTimezone: cfg.BUSINESS_TIMEZONE,
    log: logger,
    onUsage: overrides.onUsage,
  });

  let transcriber: Transcriber;
  try {
    transcriber = createTranscriber({
      provider: cfg.TRANSCRIPTION_PROVIDER,
      language: cfg.TRANSCRIPTION_LANGUAGE,
      openaiKey: cfg.OPENAI_API_KEY,
      groqKey: cfg.GROQ_API_KEY,
      deepgramKey: cfg.DEEPGRAM_API_KEY,
    });
  } catch (err) {
    warnings.push(`Audios desactivados: ${(err as Error).message}`);
    transcriber = createTranscriber({ provider: "none", language: cfg.TRANSCRIPTION_LANGUAGE });
  }

  if (overrides.onTranscripcion && transcriber.enabled) {
    const base = transcriber;
    const contar = overrides.onTranscripcion;
    transcriber = {
      enabled: true,
      transcribe: async (audio, mime) => {
        const t = await base.transcribe(audio, mime);
        contar();
        return t;
      },
    };
  }

  const store = overrides.store ?? new FileLeadStore(cfg.DATA_DIR);

  const engineOptions: EngineOptions = {
    store,
    setter,
    manychat,
    transcriber,
    debounceMs: cfg.DEBOUNCE_SECONDS * 1000,
    typingDelayMs: cfg.TYPING_DELAY_MS,
    maxBubbles: cfg.MAX_BUBBLES,
    pauseTag: cfg.PAUSE_TAG,
    followup: { enabled: cfg.FOLLOWUP_ENABLED, afterHours: cfg.FOLLOWUP_AFTER_HOURS, max: cfg.FOLLOWUP_MAX },
    log: logger,
    fetchImpl: overrides.fetchImpl,
    ...overrides.engineExtra,
  };

  return { engine: new Engine(engineOptions), engineOptions, store, manychat, client, transcriber, mode, warnings };
}
