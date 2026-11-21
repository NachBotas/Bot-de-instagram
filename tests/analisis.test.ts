import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  CacheCategorias,
  calcularEstadisticas,
  clasificar,
  extraerPuntos,
  hashTexto,
  renderReporte,
} from "../src/analytics/analisis.js";
import { newLead, type Lead, type Turno } from "../src/store.js";

const T0 = Date.parse("2026-11-01T12:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const NOW = new Date(T0 + 10 * 24 * 60 * 60_000);

const SALUDO = "Hola! Gracias por escribir. ¿A qué te dedicás?";
const OBJETIVO = "Buenísimo. ¿Y qué te gustaría lograr en los próximos meses?";
const PRESUPUESTO = "Perfecto. ¿Estás en un momento donde podrías invertir en ayuda profesional?";
const LLAMADA = "Te propongo una llamada de 30 min para armarte un plan. ¿Te sirve?";

function lead(id: string, turnos: Turno[], etapa: Lead["etapa"] = "conversando"): Lead {
  return { ...newLead(id), etapa, turnos };
}

/** Conversación que avanza hasta `hasta` y ahí el lead deja de responder (o agenda). */
function charla(id: string, pasos: string[], seVaEn: number | null): Lead {
  const turnos: Turno[] = [{ de: "lead", at: at(0), texto: "hola" }];
  let m = 1;
  pasos.forEach((texto, i) => {
    turnos.push({ de: "bot", at: at(m), texto, etapa: "conversando" });
    m += 5;
    if (seVaEn !== i) {
      turnos.push({ de: "lead", at: at(m), texto: "respuesta" });
      m += 5;
    }
  });
  return lead(id, seVaEn === null ? turnos : turnos.slice(0, turnos.findIndex((t) => t.texto === pasos[seVaEn]) + 1));
}

function cacheCon(map: Record<string, string>): CacheCategorias {
  const c = new CacheCategorias(path.join(mkdtempSync(path.join(tmpdir(), "an-")), "c.json"));
  for (const [texto, cat] of Object.entries(map)) c.set(hashTexto(texto), cat as never);
  return c;
}

describe("extraerPuntos", () => {
  it("marca respondido, sin respuesta y pendiente", () => {
    const l = lead("a", [
      { de: "lead", at: at(0), texto: "hola" },
      { de: "bot", at: at(1), texto: SALUDO, etapa: "conversando" },
      { de: "lead", at: at(11), texto: "soy coach" },
      { de: "bot", at: at(12), texto: OBJETIVO, etapa: "conversando" },
      { de: "bot", at: at(12 + 7 * 60), texto: "¿Pudiste verlo?", etapa: "conversando", seguimiento: true },
    ]);
    const ps = extraerPuntos([l], { now: new Date(T0 + 8 * 60 * 60_000) });
    expect(ps.map((p) => p.resultado)).toEqual(["respondio", "sin_respuesta", "pendiente"]);
    expect(ps[0]!.demoraMin).toBe(10);
    expect(ps[1]!.previoLead).toBe("soy coach");
  });

  it("no cuenta mensajes después de agendar", () => {
    const l = lead("b", [
      { de: "lead", at: at(0), texto: "listo agendé" },
      { de: "bot", at: at(1), texto: "Genial, nos vemos!", etapa: "agendado" },
    ]);
    expect(extraerPuntos([l], { now: NOW })).toHaveLength(0);
  });
});

describe("calcularEstadisticas", () => {
  const leads = [
    // 6 leads se van en la pregunta de presupuesto, 2 llegan a la llamada y agendan
    ...Array.from({ length: 6 }, (_, i) => charla(`p${i}`, [SALUDO, OBJETIVO, PRESUPUESTO], 2)),
    ...Array.from({ length: 2 }, (_, i) => ({
      ...charla(`ok${i}`, [SALUDO, OBJETIVO, PRESUPUESTO, LLAMADA], null),
      etapa: "agendado" as const,
      hitos: [
        { etapa: "calificado" as const, at: at(30) },
        { etapa: "agendado" as const, at: at(40) },
      ],
    })),
    // 1 lead se va en el saludo
    charla("s0", [SALUDO], 0),
  ];
  const cache = cacheCon({ [SALUDO]: "saludo", [OBJETIVO]: "objetivo", [PRESUPUESTO]: "presupuesto", [LLAMADA]: "propuesta_llamada" });
  const stats = calcularEstadisticas(leads, extraerPuntos(leads, { now: NOW }), cache);

  it("detecta la pregunta donde más se cae la gente", () => {
    const top = stats.porCategoria[0]!;
    expect(top.categoria).toBe("presupuesto");
    expect(top.tasaAbandono).toBe(75); // 6 de 8
    expect(stats.ultimoMensajeAntesDeIrse[0]).toMatchObject({ categoria: "presupuesto", leads: 6 });
  });

  it("arma el embudo", () => {
    expect(stats.embudo.map((e) => [e.etapa, e.leads])).toEqual([
      ["Empezó a conversar", 9],
      ["Calificado", 2],
      ["Agendó llamada", 2],
    ]);
  });

  it("marca las categorías con pocos datos", () => {
    expect(stats.porCategoria.find((c) => c.categoria === "propuesta_llamada")!.pocosDatos).toBe(true);
  });

  it("renderiza el reporte", () => {
    const md = renderReporte(stats, "Cambiá la pregunta de presupuesto.");
    expect(md).toContain("| Pregunta presupuesto | 8 | 2 | 6 | **75%** |");
    expect(md).toContain("Cambiá la pregunta de presupuesto.");
  });
});

describe("clasificar", () => {
  it("clasifica solo mensajes nuevos y únicos, y usa la caché", async () => {
    const leads = [charla("x", [SALUDO, OBJETIVO], 1), charla("y", [SALUDO, OBJETIVO], 1)];
    const puntos = extraerPuntos(leads, { now: NOW });
    const calls: string[] = [];
    const client = {
      beta: {
        messages: {
          parse: async (params: { messages: { content: string }[] }) => {
            calls.push(params.messages[0]!.content);
            return {
              stop_reason: "end_turn",
              parsed_output: { clasificaciones: [{ id: 0, categoria: "saludo" }, { id: 1, categoria: "objetivo" }] },
            };
          },
        },
      },
    } as unknown as Anthropic;
    const cache = cacheCon({});
    expect(await clasificar(puntos, cache, client, "claude-opus-5-5")).toBe(2);
    expect(cache.get(hashTexto(SALUDO))).toBe("saludo");
    expect(cache.get(hashTexto(OBJETIVO))).toBe("objetivo");
    expect(await clasificar(puntos, cache, client, "claude-opus-5-5")).toBe(0);
    expect(calls).toHaveLength(1);
  });
});
