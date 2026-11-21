/**
 * Simulador: chateá con el setter desde la terminal, sin ManyChat ni Instagram.
 *
 *   npm run chat
 *
 * Comandos:
 *   /audio <ruta-o-url>   simula que el lead manda una nota de voz
 *   /imagen <ruta-o-url>  simula que manda una imagen
 *   /lead                 muestra lo que el bot guardó del lead
 *   /reset                empieza una conversación nueva
 *   /salir
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { buildApp } from "../app.js";
import { config } from "../config.js";
import { DryRunManyChat } from "../integrations/manychat.js";
import { MemoryLeadStore } from "../store.js";

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** Sirve archivos locales como si fueran URLs del CDN de Instagram. */
const localFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("file://")) {
    const file = decodeURIComponent(url.slice("file://".length));
    const data = await fs.readFile(file);
    return new Response(new Uint8Array(data), {
      headers: { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" },
    });
  }
  return fetch(input, init);
};

async function main() {
  const store = new MemoryLeadStore();
  const quiet = (l: string) => {
    if (l.includes("🔧") || l.includes("⚠️") || l.includes("🚫")) console.log(`\x1b[2m${l}\x1b[0m`);
  };
  const manychat = new DryRunManyChat((l) => {
    if (l.includes("💬")) console.log(`\x1b[36m${l.replace(/^\[ManyChat → [^\]]+\] 💬 /, "🤖 ")}\x1b[0m`);
    else console.log(`\x1b[2m${l}\x1b[0m`);
  });
  const app = await buildApp(
    { ...config, DEBOUNCE_SECONDS: 0, TYPING_DELAY_MS: 0 },
    {
      store,
      manychat,
      fetchImpl: localFetch,
      logger: (m, e) => quiet(e === undefined ? m : `${m} ${typeof e === "string" ? e : JSON.stringify(e)}`),
    },
  );

  let id = `sim_${Date.now()}`;
  console.log(`Simulador del setter · agenda: ${app.mode} · audios: ${config.TRANSCRIPTION_PROVIDER}`);
  console.log("Escribí como si fueras un lead. Comandos: /audio <archivo>, /imagen <archivo>, /lead, /reset, /salir\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const toUrl = (arg: string) => (/^https?:\/\//.test(arg) ? arg : `file://${path.resolve(arg)}`);

  for (;;) {
    const line = (await rl.question("👤 ")).trim();
    if (!line) continue;
    if (line === "/salir") break;
    if (line === "/reset") {
      id = `sim_${Date.now()}`;
      console.log("— conversación nueva —");
      continue;
    }
    if (line === "/lead") {
      const lead = await store.get(id);
      console.log(JSON.stringify({ ...lead, history: `${lead?.history.length ?? 0} mensajes` }, null, 2));
      continue;
    }
    const [cmd, ...rest] = line.split(" ");
    const arg = rest.join(" ").trim();
    const msg =
      (cmd === "/audio" || cmd === "/imagen") && arg
        ? { subscriberId: id, firstName: "Lead", username: "lead_de_prueba", mediaUrl: toUrl(arg) }
        : { subscriberId: id, firstName: "Lead", username: "lead_de_prueba", text: line };
    try {
      await app.engine.receive(msg);
      await app.engine.flush(id);
    } catch (err) {
      console.error("❌", err instanceof Error ? err.message : err);
    }
  }
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
