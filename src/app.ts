import Anthropic from "@anthropic-ai/sdk";
import { loadAutomations, loadBusiness } from "./agent/automations.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { Setter } from "./agent/setter.js";
import { buildTools, type ToolDeps } from "./agent/tools.js";
import { bookingMode, type AppConfig } from "./config.js";
import { Engine } from "./engine.js";
import { CalComClient } from "./integrations/calendar.js";
import { DryRunManyChat, ManyChatApi, type ManyChatClient } from "./integrations/manychat.js";
import { createTranscriber } from "./integrations/transcription.js";
import { FileLeadStore, type LeadStore } from "./store.js";

export function log(msg: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  if (extra === undefined) console.log(`${ts} ${msg}`);
  else console.log(`${ts} ${msg}`, typeof extra === "string" ? extra : JSON.stringify(extra));
}

export interface App {
  engine: Engine;
  store: LeadStore;
  manychat: ManyChatClient;
  mode: ReturnType<typeof bookingMode>;
}

export async function buildApp(
  cfg: AppConfig,
  overrides: { store?: LeadStore; manychat?: ManyChatClient; logger?: typeof log; fetchImpl?: typeof fetch } = {},
): Promise<App> {
  const logger = overrides.logger ?? log;

  let manychat = overrides.manychat;
  if (!manychat) {
    if (cfg.MANYCHAT_DRY_RUN || !cfg.MANYCHAT_API_KEY) {
      if (!cfg.MANYCHAT_DRY_RUN) logger("⚠️  Falta MANYCHAT_API_KEY: los mensajes se imprimen en consola en vez de enviarse");
      manychat = new DryRunManyChat((l) => logger(l));
    } else {
      manychat = new ManyChatApi(cfg.MANYCHAT_API_KEY);
    }
  }

  const mode = bookingMode(cfg);
  const calendar =
    mode === "calcom" ? new CalComClient(cfg.CAL_API_KEY!, Number(cfg.CAL_EVENT_TYPE_ID), fetch) : undefined;

  const [business, automations] = await Promise.all([loadBusiness(cfg.BUSINESS_FILE), loadAutomations(cfg.AUTOMATIONS_FILE)]);

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
    log: logger,
  };

  const setter = new Setter({
    // Sin argumentos: toma ANTHROPIC_API_KEY (u otra credencial configurada) del entorno.
    client: new Anthropic(),
    model: cfg.CLAUDE_MODEL,
    effort: cfg.CLAUDE_EFFORT,
    systemPrompt: buildSystemPrompt({ business, automations, bookingMode: mode, businessTimezone: cfg.BUSINESS_TIMEZONE }),
    tools: buildTools({ bookingMode: mode, automations }),
    toolDeps,
    businessTimezone: cfg.BUSINESS_TIMEZONE,
    log: logger,
  });

  const transcriber = createTranscriber({
    provider: cfg.TRANSCRIPTION_PROVIDER,
    language: cfg.TRANSCRIPTION_LANGUAGE,
    openaiKey: cfg.OPENAI_API_KEY,
    groqKey: cfg.GROQ_API_KEY,
    deepgramKey: cfg.DEEPGRAM_API_KEY,
  });

  const store = overrides.store ?? new FileLeadStore(cfg.DATA_DIR);

  const engine = new Engine({
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
  });

  return { engine, store, manychat, mode };
}
