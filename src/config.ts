import "dotenv/config";
import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "si", "sí", "yes"].includes(v.toLowerCase())));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().finite());

const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const EnvSchema = z.object({
  PORT: num(3000),
  PUBLIC_BASE_URL: optStr,

  // Seguridad
  WEBHOOK_SECRET: optStr,
  ADMIN_TOKEN: optStr,

  // Claude
  ANTHROPIC_API_KEY: optStr,
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),

  // ManyChat
  MANYCHAT_API_KEY: optStr,
  MANYCHAT_DRY_RUN: bool(false),
  PAUSE_TAG: z.string().default("bot_pausado"),

  // Transcripción de audios
  TRANSCRIPTION_PROVIDER: z.enum(["openai", "groq", "deepgram", "none"]).default("none"),
  OPENAI_API_KEY: optStr,
  GROQ_API_KEY: optStr,
  DEEPGRAM_API_KEY: optStr,
  TRANSCRIPTION_LANGUAGE: z.string().default("es"),

  // Agenda
  BUSINESS_TIMEZONE: z.string().default("America/Argentina/Buenos_Aires"),
  CAL_API_KEY: optStr,
  CAL_EVENT_TYPE_ID: optStr,
  BOOKING_LINK: optStr,
  FLOW_BOOKED_NS: optStr,

  // Comportamiento
  DEBOUNCE_SECONDS: num(7),
  TYPING_DELAY_MS: num(1500),
  MAX_BUBBLES: num(4),
  FOLLOWUP_ENABLED: bool(false),
  FOLLOWUP_AFTER_HOURS: num(6),
  FOLLOWUP_MAX: num(1),
  HANDOFF_WEBHOOK_URL: optStr,

  // Archivos
  DATA_DIR: z.string().default("./data"),
  BUSINESS_FILE: z.string().default("./config/negocio.md"),
  AUTOMATIONS_FILE: z.string().default("./config/automatizaciones.json"),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuración inválida en .env:\n${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();

export type BookingMode = "calcom" | "link" | "none";

export function bookingMode(cfg: AppConfig = config): BookingMode {
  if (cfg.CAL_API_KEY && cfg.CAL_EVENT_TYPE_ID) return "calcom";
  if (cfg.BOOKING_LINK) return "link";
  return "none";
}
