/** Horario de atención del bot. */
export interface Horario {
  activo: boolean;
  /** 0 = domingo … 6 = sábado */
  dias: number[];
  desde: string; // "09:00"
  hasta: string; // "21:00"
}

const aMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Día de la semana y minuto del día en una zona horaria. */
function ahoraEn(now: Date, zona: string): { dia: number; min: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zona, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dia = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hora = Number(get("hour")) % 24;
  return { dia, min: hora * 60 + Number(get("minute")) };
}

/**
 * Minutos que faltan para que abra (0 si ya está abierto o si el horario está apagado).
 * Si "hasta" es menor que "desde", el horario cruza la medianoche (ej. 20:00 a 02:00).
 */
export function minutosHastaAbrir(now: Date, h: Horario, zona: string): number {
  if (!h.activo || h.dias.length === 0) return 0;
  const { dia, min } = ahoraEn(now, zona);
  const desde = aMin(h.desde);
  const hasta = aMin(h.hasta);
  const abierto = (d: number, m: number) => {
    if (desde < hasta) return h.dias.includes(d) && m >= desde && m < hasta;
    // Cruza la medianoche: la parte de la madrugada pertenece al día anterior.
    return (h.dias.includes(d) && m >= desde) || (h.dias.includes((d + 6) % 7) && m < hasta);
  };
  if (abierto(dia, min)) return 0;
  // Buscamos la próxima apertura minuto a minuto por hora (como mucho 8 días).
  for (let paso = 1; paso <= 8 * 24 * 60; paso++) {
    const m = (min + paso) % 1440;
    const d = (dia + Math.floor((min + paso) / 1440)) % 7;
    if (abierto(d, m)) return paso;
  }
  return 0;
}
