/**
 * Agenda de llamadas.
 *
 *  - Modo "calcom": el bot consulta horarios libres y reserva la llamada él mismo
 *    usando la API v2 de Cal.com (https://cal.com/docs/api-reference/v2).
 *  - Modo "link": el bot manda tu link de Calendly / Cal.com / TidyCal / etc.
 *    con el nombre, email e id del contacto precargados.
 */

export interface Slot {
  /** ISO 8601 con offset, ej. 2026-11-24T15:00:00.000-03:00 */
  start: string;
}

export interface BookingInput {
  start: string;
  name: string;
  email: string;
  timeZone: string;
  phone?: string;
  notes?: string;
  subscriberId: string;
}

export interface BookingResult {
  uid?: string;
  start: string;
  meetingUrl?: string;
}

export class CalComClient {
  private readonly base = "https://api.cal.com/v2";

  constructor(
    private readonly apiKey: string,
    private readonly eventTypeId: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getSlots(fromIso: string, toIso: string, timeZone: string): Promise<Slot[]> {
    const qs = new URLSearchParams({
      eventTypeId: String(this.eventTypeId),
      start: fromIso,
      end: toIso,
      timeZone,
    });
    const res = await this.fetchImpl(`${this.base}/slots?${qs}`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, "cal-api-version": "2024-09-04" },
    });
    const json = (await res.json()) as { status?: string; data?: Record<string, { start: string }[]>; error?: unknown };
    if (!res.ok || json.status !== "success" || !json.data) {
      throw new Error(`Cal.com slots falló (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
    }
    return Object.keys(json.data)
      .sort()
      .flatMap((day) => json.data![day]!.map((s) => ({ start: s.start })));
  }

  async book(input: BookingInput): Promise<BookingResult> {
    const body = {
      start: new Date(input.start).toISOString(),
      eventTypeId: this.eventTypeId,
      attendee: {
        name: input.name,
        email: input.email,
        timeZone: input.timeZone,
        language: "es",
        ...(input.phone ? { phoneNumber: input.phone } : {}),
      },
      ...(input.notes ? { bookingFieldsResponses: { notes: input.notes } } : {}),
      metadata: { subscriber_id: input.subscriberId, source: "instagram_setter_bot" },
    };
    const res = await this.fetchImpl(`${this.base}/bookings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "cal-api-version": "2024-08-13",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      status?: string;
      data?: { uid?: string; start?: string; meetingUrl?: string; location?: string };
      error?: { message?: string };
    };
    if (!res.ok || json.status !== "success" || !json.data) {
      throw new Error(json.error?.message ?? `Cal.com booking falló (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
    }
    const loc = json.data.location;
    return {
      uid: json.data.uid,
      start: json.data.start ?? body.start,
      meetingUrl: json.data.meetingUrl ?? (loc && /^https?:\/\//.test(loc) ? loc : undefined),
    };
  }
}

/**
 * Arma el link de agenda con datos precargados. Calendly y Cal.com aceptan
 * ?name= y ?email=; el subscriber_id viaja en utm_content (Calendly lo devuelve
 * en su webhook) y en metadata[subscriber_id] (Cal.com lo devuelve en el suyo).
 */
export function buildBookingLink(base: string, data: { name?: string; email?: string; subscriberId: string }): string {
  const url = new URL(base);
  if (data.name) url.searchParams.set("name", data.name);
  if (data.email) url.searchParams.set("email", data.email);
  url.searchParams.set("utm_source", "instagram");
  url.searchParams.set("utm_medium", "setter_bot");
  url.searchParams.set("utm_content", data.subscriberId);
  url.searchParams.set("metadata[subscriber_id]", data.subscriberId);
  return url.toString();
}

/** Formatea un horario para mostrárselo al lead: "martes 24/11 15:00". */
export function formatSlot(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("es-AR", {
    timeZone,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(d).replace(",", "");
}

/** Elige pocos horarios bien repartidos para no abrumar al lead (máx. `max`, a lo sumo 2 por día). */
export function pickSpreadSlots(slots: Slot[], timeZone: string, max = 6): Slot[] {
  const dayKey = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const byDay = new Map<string, Slot[]>();
  for (const s of slots) {
    const k = dayKey(s.start);
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }
  const picked: Slot[] = [];
  for (const [, daySlots] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (picked.length >= max) break;
    const first = daySlots[0]!;
    picked.push(first);
    if (daySlots.length > 2 && picked.length < max) picked.push(daySlots[Math.floor(daySlots.length * 0.66)]!);
  }
  return picked.slice(0, max);
}
