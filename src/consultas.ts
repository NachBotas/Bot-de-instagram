import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Bandeja de avisos para el equipo: preguntas que el bot no supo responder
 * y conversaciones que derivó a una persona.
 */
export interface Consulta {
  id: string;
  tipo: "consulta" | "derivacion";
  leadId: string;
  nombre?: string;
  username?: string;
  /** La pregunta del lead (o el motivo de la derivación). */
  texto: string;
  /** Lo último que escribió el lead, para tener contexto. */
  ultimoMensaje?: string;
  creada: string;
  estado: "pendiente" | "respondida" | "descartada";
  respuesta?: string;
  resuelta?: string;
}

export class ConsultasStore {
  private readonly file: string;
  private cola: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "consultas.json");
  }

  async list(): Promise<Consulta[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as Consulta[];
    } catch {
      return [];
    }
  }

  /** Las escrituras van en fila para no pisarse. */
  private update<T>(fn: (items: Consulta[]) => T): Promise<T> {
    const run = this.cola.then(async () => {
      const items = await this.list();
      const out = fn(items);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(items.slice(-500), null, 2), "utf8");
      return out;
    });
    this.cola = run.catch(() => undefined);
    return run;
  }

  add(c: Omit<Consulta, "id" | "creada" | "estado">): Promise<Consulta> {
    return this.update((items) => {
      const nueva: Consulta = { ...c, id: randomUUID().slice(0, 8), creada: new Date().toISOString(), estado: "pendiente" };
      items.push(nueva);
      return nueva;
    });
  }

  resolve(id: string, estado: "respondida" | "descartada", respuesta?: string): Promise<Consulta | undefined> {
    return this.update((items) => {
      const c = items.find((x) => x.id === id);
      if (!c) return undefined;
      c.estado = estado;
      c.respuesta = respuesta;
      c.resuelta = new Date().toISOString();
      return c;
    });
  }
}
