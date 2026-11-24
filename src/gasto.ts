import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Registra lo que se gasta en Claude con cada respuesta (según los tokens que
 * informa la API) y lo suma por mes y por día. Los precios son los de lista
 * en USD por millón de tokens; el total es una estimación muy cercana a la factura.
 */

const PRECIOS: Record<string, { entrada: number; salida: number; lecturaCache: number }> = {
  "claude-haiku-5-5": { entrada: 0.1, salida: 0.5, lecturaCache: 0.01 },
  "claude-sonnet-5-5": { entrada: 2, salida: 10, lecturaCache: 0.1 },
  "claude-sonnet-5": { entrada: 2, salida: 10, lecturaCache: 0.2 },
  "claude-opus-5-5": { entrada: 4, salida: 20, lecturaCache: 0.2 },
  "claude-opus-5": { entrada: 5, salida: 25, lecturaCache: 0.5 },
  "claude-opus-4-8": { entrada: 5, salida: 25, lecturaCache: 0.5 },
  "claude-fable-5-2": { entrada: 8, salida: 40, lecturaCache: 0.2 },
};
const POR_DEFECTO = { entrada: 5, salida: 25, lecturaCache: 0.5 };

export interface Uso {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function costoUsd(modelo: string, u: Uso): number {
  const p = PRECIOS[modelo] ?? PRECIOS[modelo.replace(/-\d{8}$/, "")] ?? POR_DEFECTO;
  const m = 1_000_000;
  return (
    ((u.input_tokens ?? 0) * p.entrada +
      (u.output_tokens ?? 0) * p.salida +
      (u.cache_creation_input_tokens ?? 0) * p.entrada * 1.25 +
      (u.cache_read_input_tokens ?? 0) * p.lecturaCache) /
    m
  );
}

interface Mes {
  usd: number;
  respuestas: number;
  audios: number;
  porDia: Record<string, number>;
  porModelo: Record<string, number>;
}

export interface ResumenGasto {
  mes: string;
  usdMes: number;
  usdHoy: number;
  respuestas: number;
  audios: number;
  porModelo: Record<string, number>;
  ultimosDias: { dia: string; usd: number }[];
}

export class Gasto {
  private datos: Record<string, Mes> = {};
  private cargado = false;
  private cola: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "gasto.json");
  }

  private async cargar() {
    if (this.cargado) return;
    try {
      this.datos = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      this.datos = {};
    }
    this.cargado = true;
  }

  private mes(fecha: Date): Mes {
    const k = fecha.toISOString().slice(0, 7);
    return (this.datos[k] ??= { usd: 0, respuestas: 0, audios: 0, porDia: {}, porModelo: {} });
  }

  private guardar(fn: () => void): Promise<void> {
    const run = this.cola.then(async () => {
      await this.cargar();
      fn();
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.datos), "utf8");
    });
    this.cola = run.catch(() => undefined);
    return run;
  }

  /** Suma una llamada a Claude. */
  registrar(modelo: string, uso: Uso, ahora = new Date()): Promise<void> {
    const usd = costoUsd(modelo, uso);
    return this.guardar(() => {
      const m = this.mes(ahora);
      const dia = ahora.toISOString().slice(0, 10);
      m.usd += usd;
      m.respuestas += 1;
      m.porDia[dia] = (m.porDia[dia] ?? 0) + usd;
      m.porModelo[modelo] = (m.porModelo[modelo] ?? 0) + usd;
    });
  }

  registrarAudio(ahora = new Date()): Promise<void> {
    return this.guardar(() => {
      this.mes(ahora).audios += 1;
    });
  }

  async resumen(ahora = new Date()): Promise<ResumenGasto> {
    await this.cola;
    await this.cargar();
    const k = ahora.toISOString().slice(0, 7);
    const m = this.datos[k] ?? { usd: 0, respuestas: 0, audios: 0, porDia: {}, porModelo: {} };
    const ultimosDias = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(ahora.getTime() - (13 - i) * 86_400_000).toISOString().slice(0, 10);
      return { dia: d, usd: this.datos[d.slice(0, 7)]?.porDia[d] ?? 0 };
    });
    return {
      mes: k,
      usdMes: m.usd,
      usdHoy: m.porDia[ahora.toISOString().slice(0, 10)] ?? 0,
      respuestas: m.respuestas,
      audios: m.audios,
      porModelo: m.porModelo,
      ultimosDias,
    };
  }
}
