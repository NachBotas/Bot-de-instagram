const IG_MAX_CHARS = 1000; // límite de Instagram por mensaje

/** Saca el markdown que Instagram no renderiza (negritas, títulos, viñetas). */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|\s)\*(\S.*?\S|\S)\*(?=\s|$|[.,!?])/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1: $2");
}

function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "), window.lastIndexOf("\n"));
    const at = cut > max * 0.4 ? cut + 1 : window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Convierte la respuesta de Claude en burbujas de chat: cada párrafo (separado
 * por línea en blanco) es un mensaje. Si hay más de `maxBubbles`, junta el resto
 * en el último.
 */
export function toBubbles(text: string, maxBubbles = 4): string[] {
  const clean = stripMarkdown(text).replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  let parts = clean
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > maxBubbles) {
    parts = [...parts.slice(0, maxBubbles - 1), parts.slice(maxBubbles - 1).join("\n\n")];
  }
  return parts.flatMap((p) => splitLong(p, IG_MAX_CHARS));
}

/** Pausa entre burbujas para que se sienta como alguien escribiendo. */
export function typingDelayMs(text: string, base: number): number {
  if (base <= 0) return 0;
  return Math.min(base + text.length * 25, base * 3);
}
