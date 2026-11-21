/**
 * Detección y descarga de adjuntos (audios, imágenes, videos) que ManyChat manda
 * como URL en {{last_input_text}} cuando el lead envía un archivo por DM.
 */

const MAX_BYTES = 25 * 1024 * 1024; // límite de Whisper y razonable para todo lo demás

const ATTACHMENT_HOSTS = [
  "lookaside.fbsbx.com",
  "fbsbx.com",
  "fbcdn.net",
  "cdninstagram.com",
  "manychat.com",
  "manybot-files",
];

export type MediaKind = "audio" | "image" | "video" | "other";

export interface DownloadedMedia {
  kind: MediaKind;
  mimeType: string;
  data: Buffer;
  url: string;
}

/** ¿El texto entrante es en realidad la URL de un adjunto? */
export function looksLikeAttachmentUrl(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return false;
  try {
    const host = new URL(t).hostname;
    if (ATTACHMENT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`) || host.includes(h))) return true;
    return /\.(mp3|m4a|mp4|aac|ogg|oga|opus|wav|webm|jpe?g|png|gif|webp|mov)(\?|$)/i.test(t);
  } catch {
    return false;
  }
}

export function kindFromMime(mime: string, url = ""): MediaKind {
  const m = mime.toLowerCase();
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) {
    // Las notas de voz de Instagram a veces llegan como video/mp4 sin imagen.
    if (/audio|voice|clip/i.test(url)) return "audio";
    return "video";
  }
  if (/\.(mp3|m4a|aac|ogg|oga|opus|wav)(\?|$)/i.test(url)) return "audio";
  if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) return "image";
  if (/\.(mp4|mov|webm)(\?|$)/i.test(url)) return "video";
  return "other";
}

export async function downloadMedia(url: string, fetchImpl: typeof fetch = fetch): Promise<DownloadedMedia> {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`No se pudo descargar el adjunto (${res.status})`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new Error("El adjunto es demasiado grande");
  const data = Buffer.from(await res.arrayBuffer());
  if (data.byteLength > MAX_BYTES) throw new Error("El adjunto es demasiado grande");
  const mimeType = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
  return { kind: kindFromMime(mimeType, url), mimeType, data, url };
}

/** Tipos de imagen que acepta Claude. */
export const CLAUDE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type ClaudeImageType = (typeof CLAUDE_IMAGE_TYPES)[number];

export function asClaudeImageType(mime: string): ClaudeImageType | undefined {
  const m = mime === "image/jpg" ? "image/jpeg" : mime;
  return (CLAUDE_IMAGE_TYPES as readonly string[]).includes(m) ? (m as ClaudeImageType) : undefined;
}
