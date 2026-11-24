import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Equipo: usuarios del panel con contraseña y permisos.
 *  - admin:  todo, incluido el equipo, las cuentas y los respaldos.
 *  - editor: configura el bot de las cuentas que tenga asignadas.
 *  - agente: solo responde consultas y mira conversaciones.
 */
export type Rol = "admin" | "editor" | "agente";
export const ROLES: Rol[] = ["agente", "editor", "admin"];
export const nivel = (r: Rol) => ROLES.indexOf(r);

export interface Usuario {
  usuario: string;
  nombre: string;
  rol: Rol;
  /** IDs de cuentas a las que tiene acceso; ["*"] = todas. */
  cuentas: string[];
  sal: string;
  hash: string;
  creado: string;
}

export type UsuarioPublico = Omit<Usuario, "sal" | "hash">;

export const publico = ({ sal: _s, hash: _h, ...u }: Usuario): UsuarioPublico => u;

const hashClave = (clave: string, sal: string) => scryptSync(clave, sal, 32).toString("hex");

export function validarUsuario(u: string): string {
  const limpio = u.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(limpio)) throw new Error("El usuario tiene que tener entre 3 y 32 letras, números, puntos o guiones.");
  return limpio;
}

export function validarClave(c: string): void {
  if (c.length < 8) throw new Error("La contraseña tiene que tener al menos 8 caracteres.");
}

export class Usuarios {
  private readonly file: string;
  private cache?: Usuario[];

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "usuarios.json");
  }

  async list(): Promise<Usuario[]> {
    if (!this.cache) {
      try {
        this.cache = JSON.parse(await fs.readFile(this.file, "utf8")) as Usuario[];
      } catch {
        this.cache = [];
      }
    }
    return this.cache;
  }

  async hayUsuarios(): Promise<boolean> {
    return (await this.list()).length > 0;
  }

  private async guardar(items: Usuario[]) {
    this.cache = items;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(items, null, 2), "utf8");
  }

  async get(usuario: string): Promise<Usuario | undefined> {
    return (await this.list()).find((u) => u.usuario === usuario);
  }

  async crear(d: { usuario: string; nombre?: string; rol: Rol; cuentas: string[]; clave: string }): Promise<Usuario> {
    const usuario = validarUsuario(d.usuario);
    validarClave(d.clave);
    if (!ROLES.includes(d.rol)) throw new Error("Rol inválido");
    const items = await this.list();
    if (items.some((u) => u.usuario === usuario)) throw new Error("Ya existe un usuario con ese nombre.");
    const sal = randomBytes(16).toString("hex");
    const nuevo: Usuario = {
      usuario,
      nombre: d.nombre?.trim() || usuario,
      rol: d.rol,
      cuentas: d.cuentas.length ? d.cuentas : ["*"],
      sal,
      hash: hashClave(d.clave, sal),
      creado: new Date().toISOString(),
    };
    await this.guardar([...items, nuevo]);
    return nuevo;
  }

  async actualizar(usuario: string, cambios: { nombre?: string; rol?: Rol; cuentas?: string[]; clave?: string }): Promise<Usuario> {
    const items = await this.list();
    const u = items.find((x) => x.usuario === usuario);
    if (!u) throw new Error("No existe ese usuario.");
    if (cambios.rol && cambios.rol !== "admin" && u.rol === "admin" && items.filter((x) => x.rol === "admin").length === 1) {
      throw new Error("Tiene que quedar al menos un administrador.");
    }
    if (cambios.nombre !== undefined) u.nombre = cambios.nombre.trim() || u.usuario;
    if (cambios.rol) {
      if (!ROLES.includes(cambios.rol)) throw new Error("Rol inválido");
      u.rol = cambios.rol;
    }
    if (cambios.cuentas) u.cuentas = cambios.cuentas.length ? cambios.cuentas : ["*"];
    if (cambios.clave) {
      validarClave(cambios.clave);
      u.sal = randomBytes(16).toString("hex");
      u.hash = hashClave(cambios.clave, u.sal);
    }
    await this.guardar(items);
    return u;
  }

  async borrar(usuario: string): Promise<void> {
    const items = await this.list();
    const u = items.find((x) => x.usuario === usuario);
    if (!u) return;
    if (u.rol === "admin" && items.filter((x) => x.rol === "admin").length === 1) throw new Error("Tiene que quedar al menos un administrador.");
    await this.guardar(items.filter((x) => x.usuario !== usuario));
  }

  async verificar(usuario: string, clave: string): Promise<Usuario | undefined> {
    const u = await this.get(usuario.trim().toLowerCase());
    // Aunque no exista, calculamos un hash para que la respuesta tarde lo mismo.
    const calculado = Buffer.from(hashClave(clave, u?.sal ?? "x".repeat(32)), "hex");
    if (!u) return undefined;
    const guardado = Buffer.from(u.hash, "hex");
    return guardado.length === calculado.length && timingSafeEqual(guardado, calculado) ? u : undefined;
  }
}

export function puedeVerCuenta(u: Pick<Usuario, "cuentas">, cuenta: string): boolean {
  return u.cuentas.includes("*") || u.cuentas.includes(cuenta);
}

// ------------------------------------------------------------------ sesiones (cookie firmada)

const DIAS_SESION = 30;

export function firmarSesion(usuario: string, secreto: string, ahora = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: usuario, exp: ahora + DIAS_SESION * 86_400_000 })).toString("base64url");
  const firma = createHmac("sha256", secreto).update(payload).digest("base64url");
  return `${payload}.${firma}`;
}

export function leerSesion(token: string | undefined, secreto: string, ahora = Date.now()): string | undefined {
  if (!token) return undefined;
  const [payload, firma] = token.split(".");
  if (!payload || !firma) return undefined;
  const esperada = createHmac("sha256", secreto).update(payload).digest("base64url");
  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { u: string; exp: number };
    return exp > ahora ? u : undefined;
  } catch {
    return undefined;
  }
}

export const DURACION_SESION_SEG = DIAS_SESION * 86_400;
