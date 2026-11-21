import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { Setter } from "../src/agent/setter.js";
import { buildTools, type ToolDeps } from "../src/agent/tools.js";
import { Engine } from "../src/engine.js";
import { DryRunManyChat } from "../src/integrations/manychat.js";
import type { Transcriber } from "../src/integrations/transcription.js";
import { MemoryLeadStore } from "../src/store.js";

type Msg = Anthropic.Beta.BetaMessage;

/** Cliente falso de Claude: devuelve respuestas preparadas y guarda lo que recibió. */
function fakeClaude(responses: Partial<Msg>[]) {
  const calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
          calls.push(structuredClone(params));
          const r = responses.shift();
          if (!r) throw new Error("sin más respuestas");
          return { id: "msg", type: "message", role: "assistant", model: params.model, usage: {}, ...r } as Msg;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

function setup(responses: Partial<Msg>[], transcriber?: Transcriber) {
  const sent: string[] = [];
  const manychat = new DryRunManyChat((l) => sent.push(l));
  const store = new MemoryLeadStore();
  const { client, calls } = fakeClaude(responses);
  const toolDeps: ToolDeps = {
    manychat,
    bookingMode: "link",
    bookingLink: "https://calendly.com/yo/llamada",
    businessTimezone: "America/Argentina/Buenos_Aires",
    automations: [],
    pauseTag: "bot_pausado",
    log: () => undefined,
  };
  const setter = new Setter({
    client,
    model: "claude-opus-5-5",
    effort: "low",
    systemPrompt: "sos un setter",
    tools: buildTools(toolDeps),
    toolDeps,
    businessTimezone: "America/Argentina/Buenos_Aires",
    log: () => undefined,
  });
  const audioFetch: typeof fetch = async () =>
    new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mp4" } });
  const engine = new Engine({
    store,
    setter,
    manychat,
    transcriber: transcriber ?? { enabled: false, transcribe: async () => "" },
    debounceMs: 60_000,
    typingDelayMs: 0,
    maxBubbles: 4,
    pauseTag: "bot_pausado",
    followup: { enabled: true, afterHours: 6, max: 1 },
    log: () => undefined,
    fetchImpl: audioFetch,
    sleep: async () => undefined,
  });
  return { engine, store, calls, sent };
}

describe("Engine + Setter", () => {
  it("junta mensajes seguidos en una sola respuesta, usa herramientas y responde en burbujas", async () => {
    const { engine, store, calls, sent } = setup([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "actualizar_lead",
            input: { datos: [{ campo: "situacion", valor: "coach con 3 clientes" }] },
          } as Anthropic.Beta.BetaToolUseBlock,
        ],
      },
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Buenísimo Ana!\n\n¿Y a cuántos clientes te gustaría llegar?" } as Anthropic.Beta.BetaTextBlock],
      },
    ]);

    await engine.receive({ subscriberId: "s1", firstName: "Ana", text: "hola" });
    await engine.receive({ subscriberId: "s1", text: "soy coach y tengo 3 clientes" });
    await engine.flush("s1");

    expect(calls).toHaveLength(2);
    const firstUser = calls[0]!.messages[0]!;
    const text = JSON.stringify(firstUser.content);
    expect(text).toContain("hola\\nsoy coach y tengo 3 clientes");
    expect(text).toContain("Contexto interno");
    // Fallbacks y caché activados
    expect(calls[0]).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"], cache_control: { type: "ephemeral" } });
    // El resultado de la herramienta volvió a Claude
    expect(JSON.stringify(calls[1]!.messages.at(-1))).toContain("tool_result");

    expect(sent.filter((l) => l.includes("💬"))).toEqual([
      "[ManyChat → s1] 💬 Buenísimo Ana!",
      "[ManyChat → s1] 💬 ¿Y a cuántos clientes te gustaría llegar?",
    ]);
    const lead = (await store.get("s1"))!;
    expect(lead.perfil.situacion).toBe("coach con 3 clientes");
    expect(lead.pending).toHaveLength(0);
    expect(lead.history).toHaveLength(4); // user, assistant(tool_use), user(tool_result), assistant(text)
  });

  it("transcribe audios antes de mandarlos a Claude", async () => {
    const { engine, calls } = setup(
      [{ stop_reason: "end_turn", content: [{ type: "text", text: "Te entiendo" } as Anthropic.Beta.BetaTextBlock] }],
      { enabled: true, transcribe: async () => "quiero escalar mi negocio" },
    );
    await engine.receive({ subscriberId: "s2", text: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1" });
    await engine.flush("s2");
    expect(JSON.stringify(calls[0]!.messages[0]!.content)).toContain("[Audio del lead, transcripción]: quiero escalar mi negocio");
  });

  it("no responde si el lead está pausado", async () => {
    const { engine, store, calls } = setup([]);
    await engine.receive({ subscriberId: "s3", text: "hola" });
    await engine.updateLead("s3", (l) => {
      l.paused = true;
    });
    await engine.flush("s3");
    expect(calls).toHaveLength(0);
    expect((await store.get("s3"))!.pending).toHaveLength(0);
  });

  it("si Claude falla, el mensaje del lead queda en el historial", async () => {
    const { engine, store } = setup([]);
    await engine.receive({ subscriberId: "s4", text: "hola" });
    await expect(engine.flush("s4")).rejects.toThrow();
    const lead = (await store.get("s4"))!;
    expect(lead.history).toHaveLength(1);
    expect(lead.history[0]!.role).toBe("user");
  });

  it("manda un seguimiento si el lead dejó de responder", async () => {
    const { engine, store, calls, sent } = setup([
      { stop_reason: "end_turn", content: [{ type: "text", text: "Hola!" } as Anthropic.Beta.BetaTextBlock] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "¿Pudiste pensarlo?" } as Anthropic.Beta.BetaTextBlock] },
    ]);
    await engine.receive({ subscriberId: "s5", text: "info" });
    await engine.flush("s5");
    const later = new Date(Date.now() + 7 * 60 * 60 * 1000);
    expect(await engine.runFollowups(later)).toBe(1);
    expect(JSON.stringify(calls[1]!.messages.at(-1))).toContain("EVENTO DEL SISTEMA");
    expect(sent.at(-1)).toContain("¿Pudiste pensarlo?");
    expect(await engine.runFollowups(new Date(later.getTime() + 7 * 60 * 60 * 1000))).toBe(0);
    expect((await store.get("s5"))!.followupsSent).toBe(1);
  });
});
