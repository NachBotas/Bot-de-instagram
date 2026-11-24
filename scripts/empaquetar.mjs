/**
 * Arma los zips listos para usar (sin instalar nada):
 *
 *   npm run empaquetar
 *
 * Genera en dist-zip/:
 *   Setter-Windows.zip     (Windows 10/11, 64 bits)
 *   Setter-Mac-Apple.zip   (Mac con chip M1/M2/M3/M4)
 *   Setter-Mac-Intel.zip   (Mac con procesador Intel)
 *
 * Cada zip trae el bot ya compilado, el panel, la plantilla del negocio y el
 * "motor" (Node.js oficial) para que corra con doble clic.
 * Necesita: conexión a nodejs.org y al registro de npm, y los comandos tar, unzip y zip.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_VERSION = "v22.23.5";
const NGROK_VERSION = JSON.parse(readFileSync(path.join(ROOT, "node_modules/@ngrok/ngrok/package.json"), "utf8")).version;
const CACHE = path.join(ROOT, ".cache-empaquetar");
const OUT = path.join(ROOT, "dist-zip");
const STAGE = path.join(ROOT, ".stage-empaquetar");

const TARGETS = [
  {
    zip: "Setter-Windows.zip",
    nodeArchive: `node-${NODE_VERSION}-win-x64.zip`,
    nodeInside: `node-${NODE_VERSION}-win-x64/node.exe`,
    nodeOut: "motor/node.exe",
    ngrok: "@ngrok/ngrok-win32-x64-msvc",
    launcher: "Abrir Setter.bat",
  },
  {
    zip: "Setter-Mac-Apple.zip",
    nodeArchive: `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
    nodeInside: `node-${NODE_VERSION}-darwin-arm64/bin/node`,
    nodeOut: "motor/node",
    ngrok: "@ngrok/ngrok-darwin-arm64",
    launcher: "Abrir Setter.command",
  },
  {
    zip: "Setter-Mac-Intel.zip",
    nodeArchive: `node-${NODE_VERSION}-darwin-x64.tar.gz`,
    nodeInside: `node-${NODE_VERSION}-darwin-x64/bin/node`,
    nodeOut: "motor/node",
    ngrok: "@ngrok/ngrok-darwin-x64",
    launcher: "Abrir Setter.command",
  },
];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], ...opts });
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

async function descargar(url, destino) {
  if (existsSync(destino)) return;
  console.log(`  ↓ ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No pude descargar ${url} (${res.status})`);
  writeFileSync(destino, Buffer.from(await res.arrayBuffer()));
}

async function motorNode(t) {
  const sums = path.join(CACHE, `SHASUMS256-${NODE_VERSION}.txt`);
  await descargar(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, sums);
  const archivo = path.join(CACHE, t.nodeArchive);
  await descargar(`https://nodejs.org/dist/${NODE_VERSION}/${t.nodeArchive}`, archivo);
  const esperado = readFileSync(sums, "utf8")
    .split("\n")
    .find((l) => l.endsWith(`  ${t.nodeArchive}`))
    ?.split(" ")[0];
  if (!esperado || esperado !== sha256(archivo)) {
    rmSync(archivo, { force: true });
    throw new Error(`La descarga de ${t.nodeArchive} no coincide con la firma oficial. Volvé a intentar.`);
  }
  // Extrae solo el ejecutable de node.
  return t.nodeArchive.endsWith(".zip")
    ? run("unzip", ["-p", archivo, t.nodeInside], { maxBuffer: 512 * 1024 * 1024 })
    : run("tar", ["-xzf", archivo, "-O", t.nodeInside], { maxBuffer: 512 * 1024 * 1024 });
}

function paqueteNpm(nombre, version, destino) {
  const tgzDir = path.join(CACHE, "npm");
  mkdirSync(tgzDir, { recursive: true });
  const archivo = path.join(tgzDir, `${nombre.replace("@", "").replace("/", "-")}-${version}.tgz`);
  if (!existsSync(archivo)) {
    console.log(`  ↓ ${nombre}@${version}`);
    const out = run("npm", ["pack", `${nombre}@${version}`, "--pack-destination", tgzDir, "--silent"], { cwd: tgzDir })
      .toString()
      .trim()
      .split("\n")
      .pop();
    const generado = path.join(tgzDir, out);
    if (generado !== archivo) cpSync(generado, archivo);
  }
  mkdirSync(destino, { recursive: true });
  run("tar", ["-xzf", archivo, "-C", destino, "--strip-components=1"]);
}

const LEEME = `SETTER DE INSTAGRAM
===================

CÓMO ABRIRLO

Windows
  1. Descomprimí el zip: clic derecho sobre el zip → "Extraer todo".
  2. Entrá a la carpeta "Setter" y hacé doble clic en "Abrir Setter.bat".
     Si Windows muestra "Windows protegió su PC": tocá "Más información" → "Ejecutar de todas formas".
  3. Se abre el panel en tu navegador.

Mac
  1. Hacé doble clic en el zip para descomprimirlo.
  2. Entrá a la carpeta "Setter", hacé clic DERECHO sobre "Abrir Setter.command" → "Abrir" → "Abrir".
     (La primera vez hay que hacerlo con clic derecho porque el archivo no viene de la App Store.
     Si igual no te deja: Configuración del Sistema → Privacidad y seguridad → "Abrir igualmente".)
  3. Se abre el panel en tu navegador.

IMPORTANTE
  - No cierres la ventana negra (la terminal) mientras quieras que el bot responda.
  - El bot responde solo mientras la compu esté prendida y sin suspenderse.
  - Para volver al panel: http://localhost:4000
  - Tus ajustes y conversaciones se guardan en la carpeta "data".
    Si bajás una versión nueva, copiá la carpeta "data" a la nueva carpeta para no perder nada.

Después de abrirlo, seguí los "Primeros pasos" que aparecen en la pantalla de inicio del panel.
`;

const BAT = `@echo off\r
chcp 65001 >nul\r
title Setter de Instagram\r
cd /d "%~dp0"\r
if not exist "motor\\node.exe" (\r
  echo No encuentro los archivos del setter.\r
  echo Primero descomprimi el zip: clic derecho sobre el zip y "Extraer todo".\r
  echo Despues abri "Abrir Setter.bat" desde la carpeta que se creo.\r
  pause\r
  exit /b\r
)\r
echo.\r
echo  Abriendo el panel del setter...\r
echo  NO cierres esta ventana mientras quieras que el bot responda.\r
echo.\r
"motor\\node.exe" "app\\setter.mjs" --abrir\r
echo.\r
echo  El setter se cerro.\r
pause\r
`;

const COMMAND = `#!/bin/bash
# Doble clic (la primera vez: clic derecho → Abrir) para abrir el setter.
cd "$(dirname "$0")" || exit 1
# Quita la marca de "descargado de internet" para que macOS deje usar los archivos de esta carpeta.
xattr -dr com.apple.quarantine . 2>/dev/null
chmod +x motor/node 2>/dev/null
echo
echo "  Abriendo el panel del setter..."
echo "  NO cierres esta ventana mientras quieras que el bot responda."
echo
./motor/node app/setter.mjs --abrir
echo
echo "  El setter se cerró. Podés cerrar esta ventana."
`;

async function main() {
  const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  console.log("1. Compilando el bot en un solo archivo…");
  const bundle = path.join(STAGE, "app.mjs");
  await build({
    entryPoints: [path.join(ROOT, "src/server.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["@ngrok/ngrok"],
    // express y otras librerías usan require(): se lo damos dentro del módulo ESM.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    legalComments: "none",
    logLevel: "warning",
  });

  for (const t of TARGETS) {
    console.log(`2. Armando ${t.zip}…`);
    const dir = path.join(STAGE, t.zip.replace(".zip", ""), "Setter");
    mkdirSync(path.join(dir, "app"), { recursive: true });
    mkdirSync(path.join(dir, "motor"), { recursive: true });

    cpSync(bundle, path.join(dir, "app/setter.mjs"));
    cpSync(path.join(ROOT, "panel"), path.join(dir, "panel"), { recursive: true });
    cpSync(path.join(ROOT, "config"), path.join(dir, "config"), { recursive: true });

    // ngrok (para conectar ManyChat con esta compu): la parte JS + el binario de la plataforma.
    cpSync(path.join(ROOT, "node_modules/@ngrok/ngrok"), path.join(dir, "node_modules/@ngrok/ngrok"), { recursive: true });
    paqueteNpm(t.ngrok, NGROK_VERSION, path.join(dir, "node_modules", t.ngrok));

    writeFileSync(path.join(dir, t.nodeOut), await motorNode(t));
    chmodSync(path.join(dir, t.nodeOut), 0o755);

    if (t.launcher.endsWith(".bat")) writeFileSync(path.join(dir, t.launcher), BAT);
    else {
      writeFileSync(path.join(dir, t.launcher), COMMAND);
      chmodSync(path.join(dir, t.launcher), 0o755);
    }
    writeFileSync(path.join(dir, "LEEME.txt"), LEEME.replace(/\n/g, t.launcher.endsWith(".bat") ? "\r\n" : "\n"));
    writeFileSync(path.join(dir, "VERSION.txt"), `Setter ${version} · motor Node ${NODE_VERSION} · ${new Date().toISOString().slice(0, 10)}\n`);

    const zipPath = path.join(OUT, t.zip);
    rmSync(zipPath, { force: true });
    run("zip", ["-r", "-q", "-X", "-9", zipPath, "Setter"], { cwd: path.dirname(dir) });
    console.log(`   ✓ ${path.relative(ROOT, zipPath)} (${(statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);
  }
  rmSync(STAGE, { recursive: true, force: true });
  console.log("\nListo. Los zips están en dist-zip/");
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
