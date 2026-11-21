import { z } from "zod";

/**
 * Lo que manda el "External Request" de ManyChat. Acepta dos formas:
 *  1) Body JSON armado a mano (ver README):
 *     { "subscriber_id": "{{user_id}}", "first_name": "{{first_name}}",
 *       "username": "{{ig_username}}", "text": "{{last_input_text}}" }
 *  2) La opción "Full Contact Data" de ManyChat, que manda el contacto completo
 *     ({ id, first_name, last_name, ig_username, last_input_text, ... }).
 */
const InboundSchema = z
  .object({
    subscriber_id: z.union([z.string(), z.number()]).optional(),
    contact_id: z.union([z.string(), z.number()]).optional(),
    user_id: z.union([z.string(), z.number()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    name: z.string().nullish(),
    username: z.string().nullish(),
    ig_username: z.string().nullish(),
    text: z.string().nullish(),
    last_input_text: z.string().nullish(),
    message: z.string().nullish(),
    attachment_url: z.string().nullish(),
    audio_url: z.string().nullish(),
    image_url: z.string().nullish(),
  })
  .passthrough();

export interface InboundMessage {
  subscriberId: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  text?: string;
  mediaUrl?: string;
}

/** Variables de ManyChat que llegaron sin reemplazar, ej. "{{last_input_text}}". */
const isPlaceholder = (v: string | null | undefined) => !v || /^\{\{.*\}\}$/.test(v.trim());
const clean = (v: string | null | undefined) => (isPlaceholder(v) ? undefined : v!.trim());

export function parseInbound(body: unknown): InboundMessage | { error: string } {
  const parsed = InboundSchema.safeParse(body);
  if (!parsed.success) return { error: "Body inválido" };
  const b = parsed.data;
  const rawId = b.subscriber_id ?? b.contact_id ?? b.user_id ?? b.id;
  const subscriberId = rawId === undefined ? undefined : clean(String(rawId));
  if (!subscriberId) return { error: "Falta subscriber_id" };

  const text = clean(b.text) ?? clean(b.last_input_text) ?? clean(b.message);
  const mediaUrl = clean(b.attachment_url) ?? clean(b.audio_url) ?? clean(b.image_url);
  if (!text && !mediaUrl) return { error: "El mensaje está vacío" };

  return {
    subscriberId,
    firstName: clean(b.first_name) ?? clean(b.name)?.split(" ")[0],
    lastName: clean(b.last_name),
    username: (clean(b.username) ?? clean(b.ig_username))?.replace(/^@/, ""),
    text,
    mediaUrl,
  };
}
