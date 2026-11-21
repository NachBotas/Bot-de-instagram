/**
 * Transcripción de notas de voz. Claude no recibe audio directamente, así que
 * primero pasamos el audio a texto con un proveedor de speech-to-text.
 *
 *  - groq:     Whisper large v3 turbo. Muy rápido y barato. (recomendado)
 *  - openai:   gpt-4o-mini-transcribe.
 *  - deepgram: nova-3.
 */

export type TranscriptionProvider = "openai" | "groq" | "deepgram" | "none";

export interface Transcriber {
  readonly enabled: boolean;
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

interface TranscriberOptions {
  provider: TranscriptionProvider;
  language: string;
  openaiKey?: string;
  groqKey?: string;
  deepgramKey?: string;
  fetchImpl?: typeof fetch;
}

function extFor(mime: string): string {
  const map: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };
  return map[mime] ?? "mp4";
}

export function createTranscriber(opts: TranscriberOptions): Transcriber {
  const f = opts.fetchImpl ?? fetch;

  const whisperLike = (endpoint: string, key: string, model: string): Transcriber => ({
    enabled: true,
    async transcribe(audio, mimeType) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `audio.${extFor(mimeType)}`);
      form.append("model", model);
      form.append("language", opts.language);
      form.append("response_format", "json");
      const res = await f(endpoint, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
      if (!res.ok) throw new Error(`Transcripción falló (${res.status}): ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { text?: string };
      return (json.text ?? "").trim();
    },
  });

  switch (opts.provider) {
    case "groq":
      if (!opts.groqKey) throw new Error("TRANSCRIPTION_PROVIDER=groq requiere GROQ_API_KEY");
      return whisperLike("https://api.groq.com/openai/v1/audio/transcriptions", opts.groqKey, "whisper-large-v3-turbo");
    case "openai":
      if (!opts.openaiKey) throw new Error("TRANSCRIPTION_PROVIDER=openai requiere OPENAI_API_KEY");
      return whisperLike("https://api.openai.com/v1/audio/transcriptions", opts.openaiKey, "gpt-4o-mini-transcribe");
    case "deepgram": {
      const key = opts.deepgramKey;
      if (!key) throw new Error("TRANSCRIPTION_PROVIDER=deepgram requiere DEEPGRAM_API_KEY");
      return {
        enabled: true,
        async transcribe(audio, mimeType) {
          const qs = new URLSearchParams({ model: "nova-3", language: opts.language, smart_format: "true" });
          const res = await f(`https://api.deepgram.com/v1/listen?${qs}`, {
            method: "POST",
            headers: { Authorization: `Token ${key}`, "Content-Type": mimeType },
            body: new Uint8Array(audio),
          });
          if (!res.ok) throw new Error(`Transcripción falló (${res.status}): ${(await res.text()).slice(0, 300)}`);
          const json = (await res.json()) as {
            results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
          };
          return (json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
        },
      };
    }
    case "none":
    default:
      return {
        enabled: false,
        async transcribe() {
          throw new Error("Transcripción desactivada (TRANSCRIPTION_PROVIDER=none)");
        },
      };
  }
}
