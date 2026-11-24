import Anthropic from "@anthropic-ai/sdk";
import type { Lead } from "../store.js";
import { buildContextHeader } from "./prompt.js";
import { executeTool, type ToolDeps } from "./tools.js";

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaTool = Anthropic.Beta.BetaTool;

const MAX_ITERATIONS = 8;

/** Modelos que aceptan `fallbacks: "default"` (reintento automático en otro modelo si el primero declina). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-2", "claude-fable-5-1", "claude-sonnet-5-5"]);

/** Parámetros para que, si el modelo declina, la API reintente sola con otro modelo. */
export function fallbackParams(model: string) {
  return FALLBACK_MODELS.has(model)
    ? { betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[], fallbacks: "default" as const }
    : {};
}

export interface SetterOptions {
  client: Anthropic;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  systemPrompt: string;
  tools: BetaTool[];
  toolDeps: ToolDeps;
  businessTimezone: string;
  log: (msg: string, extra?: unknown) => void;
  /** Se llama con los tokens de cada respuesta de Claude (para el contador de gasto). */
  onUsage?: (modelo: string, uso: Anthropic.Beta.BetaUsage) => void;
}

export interface SetterReply {
  /** Texto final para el lead (vacío = no responder). */
  text: string;
  refused: boolean;
  toolsUsed: string[];
}

export class Setter {
  constructor(private readonly opts: SetterOptions) {}

  /**
   * Agrega al historial lo que mandó el lead y corre el loop con Claude hasta
   * tener una respuesta final. El historial solo se agrega (nunca se reescribe),
   * así el caché y el razonamiento previo de Claude siguen siendo válidos.
   */
  async respond(lead: Lead, userBlocks: BetaContentBlockParam[], now = new Date()): Promise<SetterReply> {
    const header = buildContextHeader({
      now,
      timeZone: lead.timezone ?? this.opts.businessTimezone,
      firstName: lead.firstName,
      username: lead.username,
      etapa: lead.etapa,
      perfil: lead.perfil,
      email: lead.email,
      booking: lead.booking,
    });
    const userMessage: BetaMessageParam = { role: "user", content: [{ type: "text", text: header }, ...userBlocks] };
    const working: BetaMessageParam[] = [...lead.history, userMessage];
    const toolsUsed: string[] = [];

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const response = await this.call(working);
        try {
          this.opts.onUsage?.(response.model, response.usage);
        } catch {
          /* el contador nunca frena la respuesta */
        }
        working.push({ role: "assistant", content: response.content });

        if (response.stop_reason === "refusal") {
          this.opts.log("🚫 Claude declinó responder", response.stop_details);
          lead.history = working;
          return { text: "", refused: true, toolsUsed };
        }
        if (response.stop_reason === "pause_turn") continue;

        const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (response.stop_reason === "tool_use" && toolUses.length > 0) {
          const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            toolsUsed.push(tu.name);
            let outcome;
            try {
              outcome = await executeTool(tu.name, tu.input, lead, this.opts.toolDeps);
            } catch (err) {
              outcome = { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }
            this.opts.log(`🔧 ${tu.name}`, { input: tu.input, result: outcome.content.slice(0, 300) });
            results.push({ type: "tool_result", tool_use_id: tu.id, content: outcome.content, is_error: outcome.isError });
          }
          working.push({ role: "user", content: results });
          continue;
        }

        // end_turn / max_tokens / stop_sequence: la respuesta final es el texto.
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n\n")
          .trim();
        lead.history = working;
        return { text, refused: false, toolsUsed };
      }

      // Demasiadas vueltas con herramientas: cerramos el turno sin responder para no mandar cualquier cosa.
      this.opts.log("⚠️  Se alcanzó el máximo de iteraciones con herramientas");
      lead.history = closeDanglingToolUse(working);
      return { text: "", refused: false, toolsUsed };
    } catch (err) {
      // No perdemos lo que dijo el lead: queda en el historial (dos turnos "user" seguidos son válidos).
      lead.history = [...lead.history, userMessage];
      throw err;
    }
  }

  private async call(messages: BetaMessageParam[]) {
    const { client, model, effort, systemPrompt, tools } = this.opts;
    return client.beta.messages.create({
      model,
      max_tokens: 16000,
      ...fallbackParams(model),
      output_config: { effort },
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      tools,
      cache_control: { type: "ephemeral" },
      messages,
    });
  }
}

/** Si el último turno del asistente pidió herramientas sin resultado, agrega resultados vacíos para que el historial siga siendo válido. */
function closeDanglingToolUse(messages: BetaMessageParam[]): BetaMessageParam[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || typeof last.content === "string") return messages;
  const pending = last.content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlockParam[];
  if (pending.length === 0) return messages;
  return [
    ...messages,
    {
      role: "user",
      content: pending.map((tu) => ({
        type: "tool_result" as const,
        tool_use_id: tu.id,
        content: "Cancelado: demasiadas herramientas en un solo turno.",
        is_error: true,
      })),
    },
  ];
}
