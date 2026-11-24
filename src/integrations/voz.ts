import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Notas de voz con ElevenLabs (https://elevenlabs.io). Podés usar una voz de su
 * biblioteca o clonar la tuya en su web y pegar acá el ID de la voz.
 */
export async function sintetizarElevenLabs(
  texto: string,
  opts: { apiKey: string; vozId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  if (!opts.apiKey || !opts.vozId) throw new Error("Falta la API key o el ID de voz de ElevenLabs");
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.vozId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": opts.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text: texto.slice(0, 2500), model_id: "eleven_multilingual_v2" }),
  });
  if (!res.ok) {
    const detalle = (await res.text()).slice(0, 200);
    if (res.status === 401) throw new Error("La API key de ElevenLabs no es válida");
    if (res.status === 404) throw new Error("No existe una voz con ese ID en ElevenLabs");
    throw new Error(`ElevenLabs falló (${res.status}): ${detalle}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Carpeta de archivos públicos (las notas de voz que manda el bot). ManyChat
 * las descarga desde /media/<archivo>; los nombres son aleatorios y se borran a los 3 días.
 */
export class MediaPublica {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "media");
  }

  async guardar(data: Buffer, ext: string): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true });
    const nombre = `${randomBytes(12).toString("hex")}.${ext}`;
    await fs.writeFile(path.join(this.dir, nombre), data);
    return nombre;
  }

  /** Ruta segura a un archivo (o undefined si el nombre no es válido). */
  ruta(nombre: string): string | undefined {
    return /^[a-f0-9]{24}\.(mp3|ogg|m4a)$/.test(nombre) ? path.join(this.dir, nombre) : undefined;
  }

  async limpiar(maxDias = 3): Promise<void> {
    const limite = Date.now() - maxDias * 86_400_000;
    for (const f of await fs.readdir(this.dir).catch(() => [] as string[])) {
      const p = path.join(this.dir, f);
      const st = await fs.stat(p).catch(() => undefined);
      if (st && st.mtimeMs < limite) await fs.rm(p, { force: true });
    }
  }
}
