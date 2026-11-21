import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { fallbackParams } from "../agent/setter.js";
import type { Etapa, Lead } from "../store.js";

/**
 * Análisis de cuellos de botella: para cada mensaje que mandó el bot, mira si
 * el lead respondió o se fue. Agrupa los mensajes por tipo (qué le estaba
 * pidiendo el bot) y calcula en cuáles se cae más gente.
 */

export const CATEGORIAS = {
  saludo: "Primer mensaje / saludo / conexión inicial",
  situacion: "Pregunta por la situación actual (a qué se dedica, cómo está hoy)",
  objetivo: "Pregunta por el objetivo o lo que quiere lograr",
  dolor: "Pregunta por el obstáculo, problema o lo que ya probó",
  urgencia: "Pregunta por la urgencia o para cuándo lo quiere resolver",
  presupuesto: "Pregunta por presupuesto, inversión o capacidad de pago",
  decisor: "Pregunta si decide solo o con alguien más",
  propuesta_llamada: "Propone tener una llamada / invita a agendar",
  horarios: "Ofrece horarios concretos para la llamada",
  pedido_datos: "Pide email, teléfono, nombre completo o zona horaria",
  link_agenda: "Manda el link de la agenda",
  objecion: "Responde una objeción o duda (precio, tiempo, confianza)",
  info_oferta: "Explica la oferta, el programa o cómo funciona",
  recurso: "Ofrece o envía un recurso, video o testimonio",
  confirmacion: "Confirma la llamada agendada / despedida / cierre",
  otra: "Ninguna de las anteriores",
} as const;

export type Categoria = keyof typeof CATEGORIAS | "seguimiento";

export const ETIQUETAS: Record<Categoria, string> = {
  saludo: "Saludo inicial",
  situacion: "Pregunta situación actual",
  objetivo: "Pregunta objetivo",
  dolor: "Pregunta dolor / obstáculo",
  urgencia: "Pregunta urgencia",
  presupuesto: "Pregunta presupuesto",
  decisor: "Pregunta quién decide",
  propuesta_llamada: "Propuesta de llamada",
  horarios: "Oferta de horarios",
  pedido_datos: "Pedido de email / datos",
  link_agenda: "Envío del link de agenda",
  objecion: "Respuesta a objeción",
  info_oferta: "Explicación de la oferta",
  recurso: "Envío de recurso",
  confirmacion: "Confirmación / cierre",
  otra: "Otra",
  seguimiento: "Seguimiento (no respondía)",
};

export type Resultado = "respondio" | "sin_respuesta" | "pendiente";

export interface Punto {
  leadId: string;
  at: string;
  texto: string;
  /** Lo último que había dicho el lead antes de este mensaje. */
  previoLead?: string;
  etapa?: Etapa;
  seguimiento: boolean;
  resultado: Resultado;
  demoraMin?: number;
  /** Clave para cachear la clasificación (mismo texto → misma categoría). */
  hash: string;
}

const ETAPAS_CERRADAS: Etapa[] = ["agendado", "humano"];

export function hashTexto(texto: string): string {
  return createHash("sha1").update(texto.trim().toLowerCase()).digest("hex").slice(0, 16);
}

/**
 * Convierte las conversaciones en "puntos de contacto": cada mensaje del bot y
 * qué pasó después. No cuenta los mensajes mandados cuando la conversación ya
 * estaba cerrada (llamada agendada o derivada a humano).
 */
export function extraerPuntos(leads: Lead[], opts: { now?: Date; ventanaHoras?: number; desde?: Date } = {}): Punto[] {
  const now = opts.now ?? new Date();
  const ventanaMs = (opts.ventanaHoras ?? 24) * 60 * 60 * 1000;
  const puntos: Punto[] = [];

  for (const lead of leads) {
    const turnos = lead.turnos ?? [];
    let previoLead: string | undefined;
    for (let i = 0; i < turnos.length; i++) {
      const t = turnos[i]!;
      if (t.de === "lead") {
        previoLead = t.texto;
        continue;
      }
      if (opts.desde && Date.parse(t.at) < opts.desde.getTime()) continue;
      if (t.etapa && ETAPAS_CERRADAS.includes(t.etapa)) continue;

      const siguiente = turnos[i + 1];
      const sentAt = Date.parse(t.at);
      let resultado: Resultado;
      let demoraMin: number | undefined;
      if (siguiente?.de === "lead" && Date.parse(siguiente.at) - sentAt <= ventanaMs) {
        resultado = "respondio";
        demoraMin = Math.max(0, Math.round((Date.parse(siguiente.at) - sentAt) / 60000));
      } else if (siguiente || now.getTime() - sentAt >= ventanaMs) {
        // Respondió tarde, recibió un seguimiento porque no contestaba, o pasó la ventana sin respuesta.
        resultado = "sin_respuesta";
      } else {
        resultado = "pendiente";
      }
      puntos.push({
        leadId: lead.subscriberId,
        at: t.at,
        texto: t.texto,
        previoLead,
        etapa: t.etapa,
        seguimiento: !!t.seguimiento,
        resultado,
        demoraMin,
        hash: hashTexto(t.texto),
      });
    }
  }
  return puntos;
}

// ---------------------------------------------------------------- clasificación

export class CacheCategorias {
  private data: Record<string, Categoria> = {};
  constructor(private readonly file: string) {}

  async load(): Promise<this> {
    try {
      this.data = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      this.data = {};
    }
    return this;
  }
  get(hash: string): Categoria | undefined {
    return this.data[hash];
  }
  set(hash: string, c: Categoria) {
    this.data[hash] = c;
  }
  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 1), "utf8");
  }
}

const ClasificacionSchema = z.object({
  clasificaciones: z.array(
    z.object({
      id: z.number().int(),
      categoria: z.enum(Object.keys(CATEGORIAS) as [keyof typeof CATEGORIAS, ...(keyof typeof CATEGORIAS)[]]),
    }),
  ),
});

/** Clasifica con Claude los mensajes que todavía no tienen categoría. Los resultados se guardan en caché. */
export async function clasificar(
  puntos: Punto[],
  cache: CacheCategorias,
  client: Anthropic,
  model: string,
  log: (m: string) => void = () => undefined,
): Promise<number> {
  const unicos = new Map<string, Punto>();
  for (const p of puntos) {
    if (p.seguimiento || cache.get(p.hash) || unicos.has(p.hash)) continue;
    unicos.set(p.hash, p);
  }
  const lista = [...unicos.values()];
  const LOTE = 40;
  const guia = Object.entries(CATEGORIAS)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  for (let i = 0; i < lista.length; i += LOTE) {
    const lote = lista.slice(i, i + LOTE);
    log(`Clasificando mensajes ${i + 1}-${i + lote.length} de ${lista.length}…`);
    const items = lote
      .map(
        (p, j) =>
          `<mensaje id="${j}">\n<lead_antes>${(p.previoLead ?? "(nada, es el primer mensaje)").slice(0, 400)}</lead_antes>\n<bot>${p.texto.slice(0, 1200)}</bot>\n</mensaje>`,
      )
      .join("\n");
    const res = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      ...fallbackParams(model),
      output_config: { effort: "low", format: betaZodOutputFormat(ClasificacionSchema) },
      messages: [
        {
          role: "user",
          content: `Estos son mensajes que un setter de ventas mandó por DM de Instagram. Clasificá cada mensaje del bot según lo que le pide o propone al lead al final del mensaje (eso es lo que el lead tiene que responder). Si el mensaje hace varias cosas, elegí la que corresponde a la última pregunta o pedido.

Categorías:
${guia}

${items}

Devolvé una clasificación por cada id.`,
        },
      ],
    });
    const out = res.parsed_output;
    if (res.stop_reason === "refusal" || !out) throw new Error("No se pudo leer la clasificación de Claude");
    for (const c of out.clasificaciones) {
      const p = lote[c.id];
      if (p) cache.set(p.hash, c.categoria);
    }
  }
  if (lista.length) await cache.save();
  return lista.length;
}

export function categoriaDe(p: Punto, cache: CacheCategorias): Categoria {
  if (p.seguimiento) return "seguimiento";
  return cache.get(p.hash) ?? "otra";
}

// ---------------------------------------------------------------- estadísticas

export interface StatCategoria {
  categoria: Categoria;
  etiqueta: string;
  enviados: number;
  respondidos: number;
  sinRespuesta: number;
  pendientes: number;
  /** % de los que no respondieron (sobre los que ya tienen resultado). */
  tasaAbandono: number;
  demoraMedianaMin?: number;
  /** Menos de 5 casos con resultado: el porcentaje todavía no es confiable. */
  pocosDatos: boolean;
}

export interface Estadisticas {
  periodo: { desde?: string; hasta: string };
  leads: number;
  leadsConConversacion: number;
  mensajesBot: number;
  tasaRespuestaGeneral: number;
  porCategoria: StatCategoria[];
  /** Cuántos leads llegaron a cada etapa. */
  embudo: { etapa: string; leads: number; pct: number }[];
  /** Dónde se quedó cada lead que dejó de responder (su último mensaje del bot sin respuesta). */
  ultimoMensajeAntesDeIrse: { categoria: Categoria; etiqueta: string; leads: number; pct: number }[];
}

const mediana = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1]! + s[m]!) / 2);
};

const RANGO_EMBUDO: Partial<Record<Etapa, number>> = { conversando: 1, calificado: 2, link_enviado: 3, agendado: 4 };

export function calcularEstadisticas(
  leads: Lead[],
  puntos: Punto[],
  cache: CacheCategorias,
  periodo: { desde?: Date; hasta?: Date } = {},
): Estadisticas {
  const grupos = new Map<Categoria, Punto[]>();
  for (const p of puntos) {
    const c = categoriaDe(p, cache);
    grupos.set(c, [...(grupos.get(c) ?? []), p]);
  }

  const porCategoria: StatCategoria[] = [...grupos.entries()].map(([categoria, ps]) => {
    const respondidos = ps.filter((p) => p.resultado === "respondio").length;
    const sinRespuesta = ps.filter((p) => p.resultado === "sin_respuesta").length;
    const conResultado = respondidos + sinRespuesta;
    return {
      categoria,
      etiqueta: ETIQUETAS[categoria],
      enviados: ps.length,
      respondidos,
      sinRespuesta,
      pendientes: ps.length - conResultado,
      tasaAbandono: conResultado ? Math.round((sinRespuesta / conResultado) * 100) : 0,
      demoraMedianaMin: mediana(ps.filter((p) => p.demoraMin !== undefined).map((p) => p.demoraMin!)),
      pocosDatos: conResultado < 5,
    };
  });
  porCategoria.sort((a, b) => Number(a.pocosDatos) - Number(b.pocosDatos) || b.tasaAbandono - a.tasaAbandono || b.enviados - a.enviados);

  const conResultado = puntos.filter((p) => p.resultado !== "pendiente");
  const tasaRespuestaGeneral = conResultado.length
    ? Math.round((conResultado.filter((p) => p.resultado === "respondio").length / conResultado.length) * 100)
    : 0;

  // Embudo: un lead "llegó" a una etapa si pasó por ella o por una posterior.
  const conCharla = leads.filter((l) => (l.turnos ?? []).length > 0);
  const maxRango = (l: Lead) =>
    Math.max(0, RANGO_EMBUDO[l.etapa] ?? 0, ...(l.hitos ?? []).map((h) => RANGO_EMBUDO[h.etapa] ?? 0));
  const usaLink = conCharla.some((l) => (l.hitos ?? []).some((h) => h.etapa === "link_enviado") || l.etapa === "link_enviado");
  const etapasEmbudo: [string, number][] = [
    ["Empezó a conversar", 1],
    ["Calificado", 2],
    ...(usaLink ? ([["Recibió el link", 3]] as [string, number][]) : []),
    ["Agendó llamada", 4],
  ];
  const embudo = etapasEmbudo.map(([etapa, rango]) => {
    const n = conCharla.filter((l) => maxRango(l) >= rango).length;
    return { etapa, leads: n, pct: conCharla.length ? Math.round((n / conCharla.length) * 100) : 0 };
  });

  // Último mensaje del bot sin respuesta de cada lead que se fue.
  const ultimos = new Map<string, Punto>();
  for (const p of puntos) {
    if (p.resultado === "pendiente") continue;
    const prev = ultimos.get(p.leadId);
    if (!prev || p.at > prev.at) ultimos.set(p.leadId, p);
  }
  const seFueron = [...ultimos.values()].filter((p) => p.resultado === "sin_respuesta");
  // Si el último fue un seguimiento ignorado, lo que cuenta es el mensaje anterior que dejó sin responder.
  const motivo = (p: Punto): Punto => {
    if (!p.seguimiento) return p;
    const delLead = puntos.filter((x) => x.leadId === p.leadId && !x.seguimiento && x.at < p.at);
    return delLead.length ? delLead[delLead.length - 1]! : p;
  };
  const conteo = new Map<Categoria, number>();
  for (const p of seFueron) {
    const c = categoriaDe(motivo(p), cache);
    conteo.set(c, (conteo.get(c) ?? 0) + 1);
  }
  const ultimoMensajeAntesDeIrse = [...conteo.entries()]
    .map(([categoria, n]) => ({
      categoria,
      etiqueta: ETIQUETAS[categoria],
      leads: n,
      pct: seFueron.length ? Math.round((n / seFueron.length) * 100) : 0,
    }))
    .sort((a, b) => b.leads - a.leads);

  return {
    periodo: { desde: periodo.desde?.toISOString(), hasta: (periodo.hasta ?? new Date()).toISOString() },
    leads: leads.length,
    leadsConConversacion: conCharla.length,
    mensajesBot: puntos.length,
    tasaRespuestaGeneral,
    porCategoria,
    embudo,
    ultimoMensajeAntesDeIrse,
  };
}

// ---------------------------------------------------------------- recomendaciones

/** Le pasa a Claude los números y ejemplos reales de los peores puntos, y le pide qué cambiar. */
export async function recomendar(
  stats: Estadisticas,
  puntos: Punto[],
  cache: CacheCategorias,
  client: Anthropic,
  model: string,
  negocio: string,
): Promise<string> {
  const peores = stats.porCategoria.filter((c) => !c.pocosDatos && c.sinRespuesta > 0).slice(0, 3);
  if (peores.length === 0) {
    return "Todavía no hay suficientes conversaciones para detectar cuellos de botella con confianza (hacen falta al menos 5 casos por tipo de mensaje).";
  }

  const ejemplos = peores
    .map((c) => {
      const ps = puntos.filter((p) => categoriaDe(p, cache) === c.categoria);
      const fmt = (p: Punto) => `  - Lead antes: "${(p.previoLead ?? "-").slice(0, 200)}"\n    Bot: "${p.texto.slice(0, 500)}"`;
      const perdidos = ps.filter((p) => p.resultado === "sin_respuesta").slice(-6).map(fmt).join("\n");
      const ganados = ps.filter((p) => p.resultado === "respondio").slice(-3).map(fmt).join("\n");
      return `## ${c.etiqueta} — ${c.tasaAbandono}% no responde (${c.sinRespuesta} de ${c.respondidos + c.sinRespuesta})
Ejemplos donde el lead NO respondió:
${perdidos || "  (ninguno)"}
Ejemplos donde SÍ respondió:
${ganados || "  (ninguno)"}`;
    })
    .join("\n\n");

  const tabla = stats.porCategoria
    .map((c) => `- ${c.etiqueta}: ${c.enviados} enviados, ${c.tasaAbandono}% sin respuesta${c.pocosDatos ? " (pocos datos)" : ""}`)
    .join("\n");
  const embudo = stats.embudo.map((e) => `- ${e.etapa}: ${e.leads} (${e.pct}%)`).join("\n");

  const res = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    ...fallbackParams(model),
    output_config: { effort: "medium" },
    messages: [
      {
        role: "user",
        content: `Sos un experto en ventas por DM (appointment setting). Analizá el rendimiento de un setter automático de Instagram y decime dónde se está perdiendo gente y qué cambiar.

<negocio>
${negocio.slice(0, 6000)}
</negocio>

<numeros>
Tasa de respuesta general: ${stats.tasaRespuestaGeneral}%
Embudo:
${embudo}
Tasa de abandono por tipo de mensaje:
${tabla}
</numeros>

<peores_puntos>
${ejemplos}
</peores_puntos>

Escribí un informe corto en español rioplatense, en markdown, para el dueño del negocio (no es técnico):
1. "Dónde se cae la gente": los 1-3 cuellos de botella principales, con el número que lo muestra.
2. Para cada uno: por qué creés que pasa, mirando los ejemplos reales (largo del mensaje, tono, momento en que se pregunta, si se pide demasiado de golpe, etc.), y 1-2 versiones mejoradas del mensaje listas para usar.
3. Un cambio concreto para hacer en el guion o en config/negocio.md.
No inventes números que no estén arriba. Si los datos son pocos, decilo.`,
      },
    ],
  });
  if (res.stop_reason === "refusal") return "Claude no pudo generar las recomendaciones para estos datos.";
  return res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------- reporte

export function renderReporte(stats: Estadisticas, recomendaciones?: string): string {
  const fecha = (iso?: string) => (iso ? iso.slice(0, 10) : "el inicio");
  const fila = (c: StatCategoria) =>
    `| ${c.etiqueta} | ${c.enviados} | ${c.respondidos} | ${c.sinRespuesta} | **${c.tasaAbandono}%**${c.pocosDatos ? " ⚠️" : ""} | ${
      c.demoraMedianaMin === undefined ? "-" : c.demoraMedianaMin < 60 ? `${c.demoraMedianaMin} min` : `${Math.round(c.demoraMedianaMin / 60)} h`
    } |`;

  return `# Cuellos de botella del setter

Período: ${fecha(stats.periodo.desde)} → ${fecha(stats.periodo.hasta)} · ${stats.leadsConConversacion} conversaciones · ${stats.mensajesBot} mensajes del bot · **${stats.tasaRespuestaGeneral}%** de respuesta general

## Embudo

| Etapa | Leads | % |
|---|---|---|
${stats.embudo.map((e) => `| ${e.etapa} | ${e.leads} | ${e.pct}% |`).join("\n")}

## Dónde se quedó la gente que dejó de responder

${
  stats.ultimoMensajeAntesDeIrse.length
    ? stats.ultimoMensajeAntesDeIrse.map((u) => `- **${u.etiqueta}**: ${u.leads} leads (${u.pct}%)`).join("\n")
    : "Nadie dejó de responder todavía (o no pasaron 24 h)."
}

## Respuesta por tipo de mensaje

| Mensaje del bot | Enviados | Respondieron | No respondieron | Abandono | Demora típica |
|---|---|---|---|---|---|
${stats.porCategoria.map(fila).join("\n")}

⚠️ = menos de 5 casos, el porcentaje todavía no es confiable. "No respondieron" = sin respuesta en 24 h.
${recomendaciones ? `\n## Recomendaciones\n\n${recomendaciones}\n` : ""}`;
}
