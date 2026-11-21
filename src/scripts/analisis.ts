/**
 * Detecta dónde se cae la gente en las conversaciones del setter.
 *
 *   npm run analisis                 todo el historial, con recomendaciones de Claude
 *   npm run analisis -- --dias 30    solo los últimos 30 días
 *   npm run analisis -- --sin-ia     solo números, sin recomendaciones
 *
 * Imprime el informe y lo guarda en data/reportes/.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadBusiness } from "../agent/automations.js";
import { correrAnalisis } from "../analytics/run.js";
import { config } from "../config.js";
import { FileLeadStore } from "../store.js";

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--dias");
  const dias = i >= 0 ? Number(args[i + 1]) : undefined;
  if (dias !== undefined && !(dias > 0)) throw new Error("--dias tiene que ser un número mayor a 0");

  const res = await correrAnalisis({
    store: new FileLeadStore(config.DATA_DIR),
    client: new Anthropic(),
    model: config.CLAUDE_MODEL,
    dataDir: config.DATA_DIR,
    negocio: await loadBusiness(config.BUSINESS_FILE).catch(() => ""),
    dias,
    recomendaciones: !args.includes("--sin-ia"),
    log: (m) => console.error(`… ${m}`),
  });

  const dir = path.join(config.DATA_DIR, "reportes");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `cuellos-de-botella-${new Date().toISOString().slice(0, 10)}.md`);
  await fs.writeFile(file, res.markdown, "utf8");

  console.log(res.markdown);
  console.error(`\n📄 Guardado en ${file}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
