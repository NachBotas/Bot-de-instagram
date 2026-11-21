import { promises as fs } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

export type Etapa =
  | "nuevo"
  | "conversando"
  | "calificado"
  | "no_calificado"
  | "link_enviado"
  | "agendado"
  | "humano";

/** Un mensaje entrante del lead que todavía no se procesó (se juntan durante el debounce). */
export interface PendingInput {
  text?: string;
  mediaUrl?: string;
  receivedAt: string;
}

/** Registro simple de la charla (lo que se mandó y cuándo), para medir dónde se cae la gente. */
export interface Turno {
  de: "lead" | "bot";
  at: string;
  texto: string;
  /** Etapa del lead cuando el bot mandó este mensaje. */
  etapa?: Etapa;
  /** El bot escribió solo porque el lead no respondía. */
  seguimiento?: boolean;
}

export interface Lead {
  subscriberId: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  etapa: Etapa;
  /** Datos de calificación que el bot va recolectando (objetivo, situación, presupuesto, etc.). */
  perfil: Record<string, string>;
  email?: string;
  telefono?: string;
  timezone?: string;
  tags: string[];
  /** Historial completo con Claude (incluye tool_use / tool_result). Solo se agrega, nunca se edita. */
  history: Anthropic.Beta.BetaMessageParam[];
  pending: PendingInput[];
  turnos: Turno[];
  /** Cuándo llegó a cada etapa (para el embudo). */
  hitos: { etapa: Etapa; at: string }[];
  booking?: { start?: string; uid?: string; link?: string; meetingUrl?: string };
  paused: boolean;
  lastUserAt?: string;
  lastBotAt?: string;
  followupsSent: number;
  createdAt: string;
  updatedAt: string;
}

export function newLead(subscriberId: string): Lead {
  const now = new Date().toISOString();
  return {
    subscriberId,
    etapa: "nuevo",
    perfil: {},
    tags: [],
    history: [],
    pending: [],
    turnos: [],
    hitos: [],
    paused: false,
    followupsSent: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Cambia la etapa y deja registrado cuándo pasó. Devuelve la etapa anterior. */
export function registrarEtapa(lead: Lead, etapa: Etapa, at = new Date()): Etapa {
  const prev = lead.etapa;
  if (prev !== etapa) {
    lead.etapa = etapa;
    lead.hitos.push({ etapa, at: at.toISOString() });
  }
  return prev;
}

export interface LeadStore {
  get(id: string): Promise<Lead | undefined>;
  getOrCreate(id: string): Promise<Lead>;
  save(lead: Lead): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<Lead[]>;
}

/** Guarda cada lead como un archivo JSON. Simple y suficiente para miles de leads. */
export class FileLeadStore implements LeadStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!safe) throw new Error("subscriber_id inválido");
    return path.join(this.dir, "leads", `${safe}.json`);
  }

  async get(id: string): Promise<Lead | undefined> {
    try {
      const raw = await fs.readFile(this.file(id), "utf8");
      return { ...newLead(id), ...(JSON.parse(raw) as Lead) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async getOrCreate(id: string): Promise<Lead> {
    return (await this.get(id)) ?? newLead(id);
  }

  async save(lead: Lead): Promise<void> {
    lead.updatedAt = new Date().toISOString();
    const file = this.file(lead.subscriberId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(lead, null, 2), "utf8");
    await fs.rename(tmp, file);
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.file(id), { force: true });
  }

  async list(): Promise<Lead[]> {
    const dir = path.join(this.dir, "leads");
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const leads: Lead[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const lead = await this.get(name.slice(0, -5));
      if (lead) leads.push(lead);
    }
    return leads;
  }
}

/** Store en memoria, para tests y para el simulador local. */
export class MemoryLeadStore implements LeadStore {
  private readonly leads = new Map<string, Lead>();
  async get(id: string) {
    const l = this.leads.get(id);
    return l ? structuredClone(l) : undefined;
  }
  async getOrCreate(id: string) {
    return (await this.get(id)) ?? newLead(id);
  }
  async save(lead: Lead) {
    lead.updatedAt = new Date().toISOString();
    this.leads.set(lead.subscriberId, structuredClone(lead));
  }
  async delete(id: string) {
    this.leads.delete(id);
  }
  async list() {
    return [...this.leads.values()].map((l) => structuredClone(l));
  }
}
