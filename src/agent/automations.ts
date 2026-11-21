import { promises as fs } from "node:fs";
import { z } from "zod";

const AutomationSchema = z.object({
  clave: z.string().regex(/^[a-z0-9_]+$/, "la clave solo puede tener minúsculas, números y _"),
  flow_ns: z.string().min(1),
  descripcion: z.string().min(1),
  cuando_usar: z.string().min(1),
});

const FileSchema = z.object({ automatizaciones: z.array(AutomationSchema) });

export type Automation = z.infer<typeof AutomationSchema>;

export async function loadAutomations(file: string): Promise<Automation[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed = FileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`${file} tiene un formato inválido: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
  }
  return parsed.data.automatizaciones;
}

export async function loadBusiness(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No encontré ${file}. Copiá config/negocio.md y completalo con la info de tu negocio.`);
    }
    throw err;
  }
}
