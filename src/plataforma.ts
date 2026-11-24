import { randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { log } from "./app.js";
import type { AppConfig } from "./config.js";
import { MediaPublica } from "./integrations/voz.js";
import { Runtime, explicarError } from "./runtime.js";
import { Usuarios } from "./usuarios.js";

/**
 * Toda la app: varias cuentas de Instagram (cada una con su bot), el equipo
 * (usuarios del panel) y la conexión con internet (túnel ngrok o la nube).
 *
 * Estructura en disco:
 *   data/plataforma.json      cuentas, túnel y secreto de sesiones
 *   data/usuarios.json        equipo
 *   data/media/               notas de voz públicas
 *   data/cuentas/<id>/        ajustes.json, leads/, consultas.json, gasto.json…
 */

interface CuentaMeta {
  id: string;
  nombre: string;
  creada: string;
}

interface Datos {
  cuentas: CuentaMeta[];
  tunel: { activo: boolean; authtoken: string; dominio: string };
  secretoSesion: string;
}

export interface Tunel {
  url?: string;
  error?: string;
  iniciando?: boolean;
}

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30) || "cuenta";

export class Plataforma {
  readonly cuentas = new Map<string, Runtime>();
  readonly usuarios: Usuarios;
  readonly media: MediaPublica;
  datos!: Datos;
  tunel: Tunel = {};
  private ngrokListener?: { close(): Promise<void>; url(): string | null };
  private readonly file: string;

  private constructor(readonly base: AppConfig) {
    this.file = path.join(base.DATA_DIR, "plataforma.json");
    this.usuarios = new Usuarios(base.DATA_DIR);
    this.media = new MediaPublica(base.DATA_DIR);
  }

  static async start(base: AppConfig): Promise<Plataforma> {
    const p = new Plataforma(base);
    await fs.mkdir(base.DATA_DIR, { recursive: true });
    await p.migrarVersionAnterior();
    p.datos = await p.cargar();
    if (p.datos.cuentas.length === 0) {
      p.datos.cuentas.push({ id: "principal", nombre: "Cuenta principal", creada: new Date().toISOString() });
      await p.guardar();
    }
    for (const c of p.datos.cuentas) await p.arrancarCuenta(c.id);

    // En la nube, el primer administrador se crea con PANEL_PASSWORD.
    if (base.PANEL_PASSWORD && !(await p.usuarios.hayUsuarios())) {
      await p.usuarios.crear({ usuario: "admin", nombre: "Administrador", rol: "admin", cuentas: ["*"], clave: base.PANEL_PASSWORD });
      log("👤 Se creó el usuario 'admin' con la contraseña de PANEL_PASSWORD");
    }

    if (p.datos.tunel.activo && !p.esNube) await p.iniciarTunel().catch(() => undefined);
    setInterval(() => void p.media.limpiar().catch(() => undefined), 6 * 3_600_000).unref();
    return p;
  }

  get esNube(): boolean {
    return this.base.NUBE;
  }

  /** La versión anterior guardaba todo suelto en data/: lo pasamos a data/cuentas/principal. */
  private async migrarVersionAnterior(): Promise<void> {
    const dir = this.base.DATA_DIR;
    const viejo = path.join(dir, "ajustes.json");
    if (!existsSync(viejo) || existsSync(path.join(dir, "cuentas"))) return;
    const destino = path.join(dir, "cuentas", "principal");
    await fs.mkdir(destino, { recursive: true });
    for (const f of ["ajustes.json", "leads", "consultas.json", "gasto.json", "analytics", "reportes"]) {
      if (existsSync(path.join(dir, f))) await fs.rename(path.join(dir, f), path.join(destino, f));
    }
    const ajustes = JSON.parse(await fs.readFile(path.join(destino, "ajustes.json"), "utf8")) as {
      manychat?: { pagina?: string };
      tunel?: Datos["tunel"];
    };
    const datos: Datos = {
      cuentas: [{ id: "principal", nombre: ajustes.manychat?.pagina || "Cuenta principal", creada: new Date().toISOString() }],
      tunel: { activo: false, authtoken: "", dominio: "", ...ajustes.tunel },
      secretoSesion: randomBytes(32).toString("hex"),
    };
    await fs.writeFile(this.file, JSON.stringify(datos, null, 2), "utf8");
    log("📦 Pasé tus datos a la nueva estructura de varias cuentas (cuenta 'principal')");
  }

  private async cargar(): Promise<Datos> {
    try {
      const d = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<Datos>;
      return {
        cuentas: d.cuentas ?? [],
        tunel: { activo: false, authtoken: "", dominio: "", ...d.tunel },
        secretoSesion: d.secretoSesion || randomBytes(32).toString("hex"),
      };
    } catch {
      return { cuentas: [], tunel: { activo: false, authtoken: "", dominio: "" }, secretoSesion: randomBytes(32).toString("hex") };
    }
  }

  async guardar(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.datos, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }

  private async arrancarCuenta(id: string): Promise<Runtime> {
    const rt = await Runtime.start(
      { ...this.base, DATA_DIR: path.join(this.base.DATA_DIR, "cuentas", id) },
      { id, urlBase: () => this.urlBase(), media: this.media },
    );
    this.cuentas.set(id, rt);
    return rt;
  }

  // ------------------------------------------------------------ cuentas

  lista(): { id: string; nombre: string; botActivo: boolean; pagina: string }[] {
    return this.datos.cuentas.map((c) => {
      const rt = this.cuentas.get(c.id);
      return { id: c.id, nombre: c.nombre, botActivo: !!rt?.ajustes.botActivo, pagina: rt?.ajustes.manychat.pagina ?? "" };
    });
  }

  cuenta(id: string | undefined): Runtime | undefined {
    return id ? this.cuentas.get(id) : undefined;
  }

  get principal(): Runtime {
    return this.cuentas.get(this.datos.cuentas[0]!.id)!;
  }

  async crearCuenta(nombre: string): Promise<CuentaMeta> {
    const limpio = nombre.trim();
    if (!limpio) throw new Error("Poné un nombre para la cuenta.");
    let id = slug(limpio);
    for (let i = 2; this.cuentas.has(id) || existsSync(path.join(this.base.DATA_DIR, "cuentas", id)); i++) id = `${slug(limpio)}-${i}`;
    const meta = { id, nombre: limpio, creada: new Date().toISOString() };
    // Arranca con el bot apagado y la plantilla del negocio; las claves se cargan desde el panel.
    await this.arrancarCuenta(id);
    this.datos.cuentas.push(meta);
    await this.guardar();
    log(`➕ Cuenta nueva: ${limpio} (${id})`);
    return meta;
  }

  async renombrarCuenta(id: string, nombre: string): Promise<void> {
    const c = this.datos.cuentas.find((x) => x.id === id);
    if (!c) throw new Error("No existe esa cuenta.");
    c.nombre = nombre.trim() || c.nombre;
    await this.guardar();
  }

  /** Borra una cuenta (sus datos van a data/papelera, por las dudas). */
  async borrarCuenta(id: string): Promise<void> {
    if (this.datos.cuentas.length <= 1) throw new Error("Tiene que quedar al menos una cuenta.");
    const rt = this.cuentas.get(id);
    if (!rt) throw new Error("No existe esa cuenta.");
    rt.detener();
    this.cuentas.delete(id);
    this.datos.cuentas = this.datos.cuentas.filter((c) => c.id !== id);
    await this.guardar();
    const papelera = path.join(this.base.DATA_DIR, "papelera");
    await fs.mkdir(papelera, { recursive: true });
    await fs.rename(path.join(this.base.DATA_DIR, "cuentas", id), path.join(papelera, `${id}-${Date.now()}`)).catch(() => undefined);
    log(`🗑️  Cuenta borrada: ${id} (los datos quedaron en data/papelera)`);
  }

  // ------------------------------------------------------------ dirección pública

  /** Dirección pública de la app: túnel, PUBLIC_BASE_URL o el dominio que da Railway. */
  urlBase(): string | undefined {
    const railway = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined;
    const render = process.env.RENDER_EXTERNAL_URL;
    const base = this.tunel.url ?? this.base.PUBLIC_BASE_URL ?? railway ?? render;
    return base?.replace(/\/$/, "");
  }

  // ------------------------------------------------------------ túnel (ngrok), solo en la compu

  async guardarTunel(authtoken: string | undefined, dominio: string): Promise<void> {
    const t = this.datos.tunel;
    const cambio = (authtoken !== undefined && authtoken !== t.authtoken) || dominio !== t.dominio;
    if (authtoken !== undefined) t.authtoken = authtoken;
    t.dominio = dominio;
    await this.guardar();
    if (cambio && this.tunel.url) {
      await this.detenerTunel(false);
      await this.iniciarTunel().catch(() => undefined);
    }
  }

  async iniciarTunel(): Promise<Tunel> {
    const { authtoken, dominio } = this.datos.tunel;
    if (!authtoken) {
      this.tunel = { error: "Falta el authtoken de ngrok (mirá el tutorial en la sección Conexión)." };
      throw new Error(this.tunel.error);
    }
    this.tunel = { iniciando: true };
    try {
      const ngrok = await import("@ngrok/ngrok");
      this.ngrokListener = await ngrok.forward({
        addr: this.base.PORT,
        authtoken,
        ...(dominio.trim() ? { domain: dominio.trim().replace(/^https?:\/\//, "").replace(/\/$/, "") } : {}),
      });
      this.tunel = { url: this.ngrokListener.url() ?? undefined };
      if (!this.datos.tunel.activo) {
        this.datos.tunel.activo = true;
        await this.guardar();
      }
      log(`🌐 Túnel abierto: ${this.tunel.url}`);
      return this.tunel;
    } catch (err) {
      this.tunel = { error: explicarError(err) };
      log("❌ No se pudo abrir el túnel", this.tunel.error);
      throw err;
    }
  }

  async detenerTunel(guardar = true): Promise<void> {
    await this.ngrokListener?.close().catch(() => undefined);
    this.ngrokListener = undefined;
    this.tunel = {};
    if (guardar) {
      this.datos.tunel.activo = false;
      await this.guardar();
    }
  }
}
