import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { LeadStore } from "../store.js";
import {
  CacheCategorias,
  calcularEstadisticas,
  clasificar,
  extraerPuntos,
  recomendar,
  renderReporte,
  type Estadisticas,
} from "./analisis.js";

export interface AnalisisOpciones {
  store: LeadStore;
  client: Anthropic;
  model: string;
  dataDir: string;
  negocio: string;
  /** Solo mira los mensajes de los últimos N días (por defecto, todo). */
  dias?: number;
  /** Pedirle a Claude recomendaciones además de los números. */
  recomendaciones?: boolean;
  log?: (m: string) => void;
}

export interface AnalisisResultado {
  stats: Estadisticas;
  recomendaciones?: string;
  advertencias: string[];
  markdown: string;
}

export async function correrAnalisis(o: AnalisisOpciones): Promise<AnalisisResultado> {
  const log = o.log ?? (() => undefined);
  const hasta = new Date();
  const desde = o.dias ? new Date(hasta.getTime() - o.dias * 24 * 60 * 60 * 1000) : undefined;
  const advertencias: string[] = [];

  const leads = await o.store.list();
  const puntos = extraerPuntos(leads, { now: hasta, desde });
  const cache = await new CacheCategorias(path.join(o.dataDir, "analytics", "categorias.json")).load();

  try {
    const nuevos = await clasificar(puntos, cache, o.client, o.model, log);
    if (nuevos) log(`${nuevos} mensajes nuevos clasificados`);
  } catch (err) {
    advertencias.push(
      `No pude clasificar los mensajes con Claude (${err instanceof Error ? err.message : String(err)}). Los que no estaban clasificados aparecen como "Otra".`,
    );
  }

  const stats = calcularEstadisticas(leads, puntos, cache, { desde, hasta });

  let recomendaciones: string | undefined;
  if (o.recomendaciones !== false) {
    try {
      log("Pidiendo recomendaciones a Claude…");
      recomendaciones = await recomendar(stats, puntos, cache, o.client, o.model, o.negocio);
    } catch (err) {
      advertencias.push(`No pude generar recomendaciones (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  let markdown = renderReporte(stats, recomendaciones);
  if (advertencias.length) markdown += `\n---\n${advertencias.map((a) => `> ${a}`).join("\n")}\n`;
  return { stats, recomendaciones, advertencias, markdown };
}
