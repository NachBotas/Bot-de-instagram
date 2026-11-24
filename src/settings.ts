import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadAutomations } from "./agent/automations.js";
import type { AppConfig } from "./config.js";

/**
 * Ajustes que se editan desde el panel. Se guardan en data/ajustes.json.
 * La primera vez se arman con lo que haya en .env y en config/.
 */

const AutomatizacionSchema = z.object({
  clave: z.string().regex(/^[a-z0-9_]+$/),
  flow_ns: z.string().min(1),
  nombre: z.string().default(""),
  carpeta: z.string().default(""),
  descripcion: z.string().default(""),
  cuando_usar: z.string().default(""),
});

export const AjustesSchema = z.object({
  botActivo: z.boolean().default(false),
  claude: z
    .object({
      apiKey: z.string().default(""),
      modelo: z.string().default("claude-opus-5-5"),
      esfuerzo: z.enum(["low", "medium", "high"]).default("low"),
    })
    .prefault({}),
  manychat: z.object({ apiKey: z.string().default(""), pagina: z.string().default("") }).prefault({}),
  audios: z
    .object({
      proveedor: z.enum(["groq", "openai", "deepgram", "none"]).default("none"),
      claves: z.object({ groq: z.string().default(""), openai: z.string().default(""), deepgram: z.string().default("") }).prefault({}),
      idioma: z.string().default("es"),
    })
    .prefault({}),
  agenda: z
    .object({
      modo: z.enum(["link", "calcom", "ninguna"]).default("ninguna"),
      link: z.string().default(""),
      calApiKey: z.string().default(""),
      calEventTypeId: z.string().default(""),
      zonaHoraria: z.string().default("America/Argentina/Buenos_Aires"),
      flowConfirmacion: z.string().default(""),
    })
    .prefault({}),
  negocio: z.string().default(""),
  automatizaciones: z.array(AutomatizacionSchema).default([]),
  avisos: z
    .object({
      /** Flow de ManyChat que se dispara cuando el bot necesita ayuda (ponele una acción "Notify Admin"). */
      flowAviso: z.string().default(""),
      flowAvisoNombre: z.string().default(""),
      webhookUrl: z.string().default(""),
    })
    .prefault({}),
  seguimientos: z
    .object({ activo: z.boolean().default(false), horas: z.number().min(1).max(22).default(6), max: z.number().int().min(0).max(3).default(1) })
    .prefault({}),
  comportamiento: z
    .object({
      esperaSeg: z.number().min(0).max(60).default(7),
      pausaMs: z.number().min(0).max(10000).default(1500),
      maxBurbujas: z.number().int().min(1).max(6).default(4),
    })
    .prefault({}),
  tunel: z
    .object({ activo: z.boolean().default(false), authtoken: z.string().default(""), dominio: z.string().default("") })
    .prefault({}),
  webhookSecret: z.string().default(""),
});

export type Ajustes = z.infer<typeof AjustesSchema>;
export type AutomatizacionAjuste = z.infer<typeof AutomatizacionSchema>;

/** Campos que son claves secretas: nunca se devuelven completos al navegador. */
export const CAMPOS_SECRETOS = [
  "claude.apiKey",
  "manychat.apiKey",
  "audios.claves.groq",
  "audios.claves.openai",
  "audios.claves.deepgram",
  "agenda.calApiKey",
  "tunel.authtoken",
] as const;

const get = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], o);
const set = (o: unknown, p: string, v: unknown) => {
  const ks = p.split(".");
  const last = ks.pop()!;
  const parent = ks.reduce<Record<string, unknown>>((a, k) => a[k] as Record<string, unknown>, o as Record<string, unknown>);
  parent[last] = v;
};

/** Reemplaza las claves por "••••1234" para mostrarlas en el panel. */
export function enmascarar(a: Ajustes): Ajustes {
  const copia = structuredClone(a);
  for (const campo of CAMPOS_SECRETOS) {
    const v = get(copia, campo);
    if (typeof v === "string" && v) set(copia, campo, `••••${v.slice(-4)}`);
  }
  return copia;
}

/** Al guardar desde el panel: si una clave viene enmascarada, se conserva la que ya estaba. */
export function fusionarSecretos(nuevo: Ajustes, actual: Ajustes): Ajustes {
  for (const campo of CAMPOS_SECRETOS) {
    const v = get(nuevo, campo);
    if (typeof v === "string" && v.startsWith("••••")) set(nuevo, campo, get(actual, campo));
  }
  return nuevo;
}

export class AjustesStore {
  readonly file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, "ajustes.json");
  }

  async load(base: AppConfig): Promise<Ajustes> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8"));
      const a = AjustesSchema.parse(raw);
      if (!a.webhookSecret) {
        a.webhookSecret = base.WEBHOOK_SECRET ?? randomBytes(18).toString("base64url");
        await this.save(a);
      }
      return a;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`data/ajustes.json está dañado: ${(err as Error).message}`);
      const a = await desdeEnv(base);
      await this.save(a);
      return a;
    }
  }

  async save(a: Ajustes): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(a, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }
}

/** Primera vez: arma los ajustes con lo que haya en .env y en config/. */
async function desdeEnv(c: AppConfig): Promise<Ajustes> {
  const negocio = await fs.readFile(c.BUSINESS_FILE, "utf8").catch(() => "");
  const autos = (await loadAutomations(c.AUTOMATIONS_FILE).catch(() => [])).filter((x) => !/^content0+_/.test(x.flow_ns));
  return AjustesSchema.parse({
    claude: { apiKey: c.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "", modelo: c.CLAUDE_MODEL, esfuerzo: ["low", "medium", "high"].includes(c.CLAUDE_EFFORT) ? c.CLAUDE_EFFORT : "low" },
    manychat: { apiKey: c.MANYCHAT_API_KEY ?? "" },
    audios: {
      proveedor: c.TRANSCRIPTION_PROVIDER,
      claves: { groq: c.GROQ_API_KEY ?? "", openai: c.OPENAI_API_KEY ?? "", deepgram: c.DEEPGRAM_API_KEY ?? "" },
      idioma: c.TRANSCRIPTION_LANGUAGE,
    },
    agenda: {
      modo: c.CAL_API_KEY && c.CAL_EVENT_TYPE_ID ? "calcom" : c.BOOKING_LINK ? "link" : "ninguna",
      link: c.BOOKING_LINK ?? "",
      calApiKey: c.CAL_API_KEY ?? "",
      calEventTypeId: c.CAL_EVENT_TYPE_ID ?? "",
      zonaHoraria: c.BUSINESS_TIMEZONE,
      flowConfirmacion: c.FLOW_BOOKED_NS ?? "",
    },
    negocio,
    automatizaciones: autos.map((x) => ({ ...x, nombre: x.clave })),
    avisos: { webhookUrl: c.HANDOFF_WEBHOOK_URL ?? "" },
    seguimientos: { activo: c.FOLLOWUP_ENABLED, horas: c.FOLLOWUP_AFTER_HOURS, max: c.FOLLOWUP_MAX },
    comportamiento: { esperaSeg: c.DEBOUNCE_SECONDS, pausaMs: c.TYPING_DELAY_MS, maxBurbujas: c.MAX_BUBBLES },
    webhookSecret: c.WEBHOOK_SECRET ?? randomBytes(18).toString("base64url"),
  });
}

/** Traduce los ajustes del panel a la configuración que usa el motor del bot. */
export function aConfig(base: AppConfig, a: Ajustes): AppConfig {
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  return {
    ...base,
    WEBHOOK_SECRET: a.webhookSecret,
    ANTHROPIC_API_KEY: opt(a.claude.apiKey),
    CLAUDE_MODEL: a.claude.modelo,
    CLAUDE_EFFORT: a.claude.esfuerzo,
    MANYCHAT_API_KEY: opt(a.manychat.apiKey),
    TRANSCRIPTION_PROVIDER: a.audios.proveedor,
    GROQ_API_KEY: opt(a.audios.claves.groq),
    OPENAI_API_KEY: opt(a.audios.claves.openai),
    DEEPGRAM_API_KEY: opt(a.audios.claves.deepgram),
    TRANSCRIPTION_LANGUAGE: a.audios.idioma,
    BUSINESS_TIMEZONE: a.agenda.zonaHoraria,
    CAL_API_KEY: a.agenda.modo === "calcom" ? opt(a.agenda.calApiKey) : undefined,
    CAL_EVENT_TYPE_ID: a.agenda.modo === "calcom" ? opt(a.agenda.calEventTypeId) : undefined,
    BOOKING_LINK: a.agenda.modo === "link" ? opt(a.agenda.link) : undefined,
    FLOW_BOOKED_NS: opt(a.agenda.flowConfirmacion),
    DEBOUNCE_SECONDS: a.comportamiento.esperaSeg,
    TYPING_DELAY_MS: a.comportamiento.pausaMs,
    MAX_BUBBLES: a.comportamiento.maxBurbujas,
    FOLLOWUP_ENABLED: a.seguimientos.activo,
    FOLLOWUP_AFTER_HOURS: a.seguimientos.horas,
    FOLLOWUP_MAX: a.seguimientos.max,
    HANDOFF_WEBHOOK_URL: opt(a.avisos.webhookUrl),
  };
}
