import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { Setter } from "../src/agent/setter.js";
import { buildTools, type ToolDeps } from "../src/agent/tools.js";
import { Engine, type EngineOptions } from "../src/engine.js";
import { costoUsd, Gasto } from "../src/gasto.js";
import { minutosHastaAbrir } from "../src/horario.js";
import { DryRunManyChat } from "../src/integrations/manychat.js";
import { MemoryLeadStore } from "../src/store.js";
import { firmarSesion, leerSesion, Usuarios } from "../src/usuarios.js";

const dir = () => mkdtempSync(path.join(tmpdir(), "setter-"));

describe("horario de atención", () => {
  const h = { activo: true, dias: [1, 2, 3, 4, 5], desde: "09:00", hasta: "21:00" };
  it("abierto, antes de abrir y fin de semana", () => {
    expect(minutosHastaAbrir(new Date("2026-11-23T10:00:00Z"), h, "UTC")).toBe(0); // lunes 10:00
    expect(minutosHastaAbrir(new Date("2026-11-23T08:00:00Z"), h, "UTC")).toBe(60); // lunes 8:00
    // viernes 22:00 → lunes 9:00 = 59 h
    expect(minutosHastaAbrir(new Date("2026-11-27T22:00:00Z"), h, "UTC")).toBe(59 * 60);
  });
  it("respeta la zona horaria y los horarios que cruzan la medianoche", () => {
    // 12:00 UTC = 09:00 en Buenos Aires (lunes)
    expect(minutosHastaAbrir(new Date("2026-11-23T12:00:00Z"), h, "America/Argentina/Buenos_Aires")).toBe(0);
    const noche = { activo: true, dias: [5], desde: "20:00", hasta: "02:00" };
    expect(minutosHastaAbrir(new Date("2026-11-28T01:00:00Z"), noche, "UTC")).toBe(0); // sábado 1:00 = viernes a la noche
    expect(minutosHastaAbrir(new Date("2026-11-28T03:00:00Z"), noche, "UTC")).toBeGreaterThan(0);
  });
  it("apagado = siempre abierto", () => {
    expect(minutosHastaAbrir(new Date(), { ...h, activo: false }, "UTC")).toBe(0);
  });
});

describe("gasto", () => {
  it("calcula el costo según el modelo", () => {
    expect(costoUsd("claude-opus-5-5", { input_tokens: 1_000_000 })).toBeCloseTo(4);
    expect(costoUsd("claude-haiku-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(0.6);
    expect(costoUsd("claude-sonnet-5-5", { cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(2.5);
  });
  it("acumula por mes y por día", async () => {
    const g = new Gasto(dir());
    const hoy = new Date("2026-11-24T15:00:00Z");
    await g.registrar("claude-haiku-5-5", { input_tokens: 2_000_000 }, hoy);
    await g.registrar("claude-haiku-5-5", { output_tokens: 2_000_000 }, hoy);
    await g.registrarAudio(hoy);
    const r = await g.resumen(hoy);
    expect(r.usdMes).toBeCloseTo(1.2);
    expect(r.usdHoy).toBeCloseTo(1.2);
    expect(r.respuestas).toBe(2);
    expect(r.audios).toBe(1);
  });
});

describe("equipo", () => {
  it("crea usuarios, verifica contraseñas y protege al último admin", async () => {
    const u = new Usuarios(dir());
    await u.crear({ usuario: "Nacho", rol: "admin", cuentas: ["*"], clave: "supersecreta" });
    await u.crear({ usuario: "sofi", rol: "agente", cuentas: ["a"], clave: "otraclave1" });
    expect(await u.verificar("nacho", "supersecreta")).toBeTruthy();
    expect(await u.verificar("nacho", "mal")).toBeUndefined();
    expect(await u.verificar("nadie", "x")).toBeUndefined();
    await expect(u.crear({ usuario: "x", rol: "agente", cuentas: [], clave: "12345678" })).rejects.toThrow();
    await expect(u.crear({ usuario: "pepe", rol: "agente", cuentas: [], clave: "corta" })).rejects.toThrow();
    await expect(u.borrar("nacho")).rejects.toThrow(/administrador/);
    await expect(u.actualizar("nacho", { rol: "agente" })).rejects.toThrow(/administrador/);
  });
  it("las sesiones firmadas no se pueden falsificar y vencen", () => {
    const t = firmarSesion("nacho", "secreto", 1000);
    expect(leerSesion(t, "secreto", 2000)).toBe("nacho");
    expect(leerSesion(t, "otro", 2000)).toBeUndefined();
    const [, firma] = t.split(".");
    const falso = `${Buffer.from(JSON.stringify({ u: "admin", exp: 9e15 })).toString("base64url")}.${firma}`;
    expect(leerSesion(falso, "secreto", 2000)).toBeUndefined();
    expect(leerSesion(t, "secreto", 1000 + 31 * 86_400_000)).toBeUndefined();
  });
});

// ------------------------------------------------------------------ motor

class ManyChatPrueba extends DryRunManyChat {
  constructor(
    readonly salida: string[],
    private readonly tags: string[] = [],
  ) {
    super((l) => salida.push(l));
  }
  override async getSubscriberTags() {
    return this.tags;
  }
}

function motor(opts: { tags?: string[]; respuestas?: string[]; fallar?: boolean; extra?: Partial<EngineOptions> } = {}) {
  const salida: string[] = [];
  const manychat = new ManyChatPrueba(salida, opts.tags);
  const llamadas: unknown[] = [];
  const respuestas = [...(opts.respuestas ?? ["Hola!"])];
  const client = {
    beta: {
      messages: {
        create: async (params: unknown) => {
          llamadas.push(params);
          if (opts.fallar) throw new Error("credit balance is too low");
          return { stop_reason: "end_turn", content: [{ type: "text", text: respuestas.shift() ?? "ok" }], model: "claude-haiku-5-5", usage: {} };
        },
      },
    },
  } as unknown as Anthropic;
  const toolDeps: ToolDeps = { manychat, bookingMode: "none", businessTimezone: "UTC", automations: [], pauseTag: "bot_pausado", log: () => undefined };
  const setter = new Setter({ client, model: "claude-haiku-5-5", effort: "low", systemPrompt: "s", tools: buildTools(toolDeps), toolDeps, businessTimezone: "UTC", log: () => undefined });
  const store = new MemoryLeadStore();
  const engine = new Engine({
    store,
    setter,
    manychat,
    transcriber: { enabled: true, transcribe: async () => "quiero info" },
    debounceMs: 60_000,
    typingDelayMs: 0,
    maxBubbles: 4,
    pauseTag: "bot_pausado",
    followup: { enabled: false, afterHours: 6, max: 1 },
    log: () => undefined,
    sleep: async () => undefined,
    fetchImpl: async () => new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mp4" } }),
    ...opts.extra,
  });
  return { engine, store, salida, llamadas };
}

describe("motor: exclusiones, pausas, errores y voz", () => {
  it("no le responde a contactos con un tag excluido", async () => {
    const { engine, llamadas, salida } = motor({ tags: ["Cliente"], extra: { excluirTags: ["cliente"] } });
    await engine.receive({ subscriberId: "1", text: "hola" });
    await engine.flush("1");
    expect(llamadas).toHaveLength(0);
    expect(salida.filter((l) => l.includes("💬"))).toHaveLength(0);
  });

  it("la pausa temporal vence sola", async () => {
    const { engine, llamadas } = motor();
    await engine.receive({ subscriberId: "2", text: "hola" });
    await engine.updateLead("2", (l) => {
      l.paused = true;
      l.pausadoHasta = new Date(Date.now() - 1000).toISOString();
    });
    await engine.flush("2");
    expect(llamadas).toHaveLength(1);
  });

  it("fuera de horario no responde (espera)", async () => {
    // Solo abre un día que no es hoy: ahora está cerrado.
    const otroDia = (new Date().getUTCDay() + 3) % 7;
    const { engine, llamadas, store } = motor({
      extra: { horario: { activo: true, dias: [otroDia], desde: "09:00", hasta: "10:00", zona: "UTC" } },
    });
    await engine.receive({ subscriberId: "3", text: "hola" });
    await engine.flush("3");
    expect(llamadas).toHaveLength(0);
    expect((await store.get("3"))!.pending).toHaveLength(1);
  });

  it("si Claude falla avisa con onError", async () => {
    const errores: string[] = [];
    const { engine } = motor({ fallar: true, extra: { onError: async (_l, e) => void errores.push((e as Error).message) } });
    await engine.receive({ subscriberId: "4", text: "hola" });
    await expect(engine.flush("4")).rejects.toThrow();
    expect(errores).toEqual(["credit balance is too low"]);
  });

  it("reintentar responde después de un error", async () => {
    const { engine, salida } = motor({ respuestas: ["Perdón la demora!"] });
    await engine.receive({ subscriberId: "5", text: "hola" });
    await engine.updateLead("5", (l) => void (l.pending = []));
    expect(await engine.reintentar("5")).toBe(true);
    expect(salida.some((l) => l.includes("Perdón la demora!"))).toBe(true);
  });

  it("responde con nota de voz cuando el lead manda un audio", async () => {
    const { engine, salida } = motor({
      respuestas: ["Te cuento cómo funciona"],
      extra: { voz: { modo: "si_audio", sintetizar: async () => "https://x/media/a.mp3" } },
    });
    await engine.receive({ subscriberId: "6", mediaUrl: "https://lookaside.fbsbx.com/audio" });
    await engine.flush("6");
    expect(salida.some((l) => l.includes("🎙️ nota de voz https://x/media/a.mp3"))).toBe(true);
    expect(salida.some((l) => l.includes("💬"))).toBe(false);
  });

  it("los links siempre van por escrito aunque esté la voz activada", async () => {
    const { engine, salida } = motor({
      respuestas: ["Agendá acá: https://calendly.com/x"],
      extra: { voz: { modo: "siempre", sintetizar: async () => "https://x/a.mp3" } },
    });
    await engine.receive({ subscriberId: "7", text: "dale" });
    await engine.flush("7");
    expect(salida.some((l) => l.includes("💬 Agendá acá"))).toBe(true);
    expect(salida.some((l) => l.includes("🎙️"))).toBe(false);
  });
});
