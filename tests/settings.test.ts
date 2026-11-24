import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ConsultasStore } from "../src/consultas.js";
import { AjustesSchema, AjustesStore, aConfig, enmascarar, fusionarSecretos } from "../src/settings.js";

const dir = () => mkdtempSync(path.join(tmpdir(), "setter-"));
const base = loadConfig({ BUSINESS_FILE: "./config/negocio.md", AUTOMATIONS_FILE: "./config/automatizaciones.json" } as NodeJS.ProcessEnv);

describe("ajustes", () => {
  it("la primera vez se arman desde .env y config/, con un secreto de webhook nuevo", async () => {
    const a = await new AjustesStore(dir()).load({ ...base, DATA_DIR: dir() });
    expect(a.botActivo).toBe(false);
    expect(a.negocio).toContain("Información del negocio");
    expect(a.webhookSecret.length).toBeGreaterThan(16);
    // Las automatizaciones de ejemplo (IDs de mentira) no se cargan
    expect(a.automatizaciones).toEqual([]);
  });

  it("nunca devuelve las claves completas y las conserva al guardar", () => {
    const actual = AjustesSchema.parse({ claude: { apiKey: "sk-ant-secreta-9876" }, tunel: { authtoken: "tok_abcd" } });
    const vista = enmascarar(actual);
    expect(vista.claude.apiKey).toBe("••••9876");
    expect(JSON.stringify(vista)).not.toContain("secreta");
    const editado = AjustesSchema.parse({ ...vista, negocio: "nuevo texto" });
    const fusion = fusionarSecretos(editado, actual);
    expect(fusion.claude.apiKey).toBe("sk-ant-secreta-9876");
    expect(fusion.tunel.authtoken).toBe("tok_abcd");
    expect(fusion.negocio).toBe("nuevo texto");
  });

  it("traduce los ajustes a la configuración del motor", () => {
    const a = AjustesSchema.parse({
      claude: { apiKey: "k", esfuerzo: "medium" },
      audios: { proveedor: "groq", claves: { groq: "gsk_x" } },
      agenda: { modo: "link", link: "https://calendly.com/x", calApiKey: "no-se-usa" },
      seguimientos: { activo: true, horas: 4 },
    });
    const c = aConfig(base, a);
    expect(c.CLAUDE_EFFORT).toBe("medium");
    expect(c.TRANSCRIPTION_PROVIDER).toBe("groq");
    expect(c.GROQ_API_KEY).toBe("gsk_x");
    expect(c.BOOKING_LINK).toBe("https://calendly.com/x");
    expect(c.CAL_API_KEY).toBeUndefined();
    expect(c.FOLLOWUP_ENABLED).toBe(true);
    expect(c.FOLLOWUP_AFTER_HOURS).toBe(4);
  });
});

describe("consultas", () => {
  it("guarda, lista y resuelve sin pisarse", async () => {
    const s = new ConsultasStore(dir());
    const [a, b] = await Promise.all([
      s.add({ tipo: "consulta", leadId: "1", texto: "¿Hay cuotas?" }),
      s.add({ tipo: "derivacion", leadId: "2", texto: "Pide hablar con alguien" }),
    ]);
    expect((await s.list()).length).toBe(2);
    await s.resolve(a.id, "respondida", "Sí, 3 cuotas");
    const items = await s.list();
    expect(items.find((x) => x.id === a.id)).toMatchObject({ estado: "respondida", respuesta: "Sí, 3 cuotas" });
    expect(items.find((x) => x.id === b.id)!.estado).toBe("pendiente");
  });
});

describe("guion", () => {
  it("por defecto viene activo con 3 preguntas y el link en el mensaje", () => {
    const g = AjustesSchema.parse({}).guion;
    expect(g.activo).toBe(true);
    expect(g.preguntas).toHaveLength(3);
    expect(g.mensajeAgenda).toContain("{link}");
  });

  it("con guion activo, el prompt pide las preguntas en orden y mandar la agenda", async () => {
    const { buildSystemPrompt } = await import("../src/agent/prompt.js");
    const guion = { activo: true, preguntas: ["¿Edad?", "¿Rubro?"], textosExactos: true, mensajeAgenda: "Agendá acá: {link}" };
    const p = buildSystemPrompt({ business: "x", automations: [], bookingMode: "link", businessTimezone: "UTC", guion });
    expect(p).toContain("<guion>");
    expect(p).not.toContain("<metodo>");
    expect(p).toContain("1. ¿Edad?\n2. ¿Rubro?");
    expect(p).toContain("enviar_link_agenda");
    expect(p).toContain('"Agendá acá: {link}"');
    expect(p).toContain("mismas palabras");
    // Apagado: vuelve al método libre
    const libre = buildSystemPrompt({ business: "x", automations: [], bookingMode: "link", businessTimezone: "UTC", guion: { ...guion, activo: false } });
    expect(libre).toContain("<metodo>");
  });
});

describe("reglas", () => {
  it("se agregan al prompt con su automatización, y las vacías se ignoran", async () => {
    const { buildSystemPrompt } = await import("../src/agent/prompt.js");
    const automations = [{ clave: "testimonios", flow_ns: "c1", descripcion: "videos", cuando_usar: "dudas" }];
    const p = buildSystemPrompt({
      business: "x",
      automations,
      bookingMode: "link",
      businessTimezone: "UTC",
      reglas: [
        { cuando: "dice que no tiene plata", hacer: "Ofrecele la guía gratis.", automatizacion: "" },
        { cuando: "Si el lead duda de si funciona", hacer: "", automatizacion: "testimonios" },
        { cuando: "", hacer: "esto no va", automatizacion: "" },
        { cuando: "usa un flow borrado", hacer: "", automatizacion: "no_existe" },
      ],
    });
    expect(p).toContain("<reglas_del_negocio>");
    expect(p).toContain("1. Si el lead dice que no tiene plata\n   → Ofrecele la guía gratis.");
    expect(p).toContain('2. Si el lead duda de si funciona\n   → Dispará la automatización "testimonios"');
    expect(p).not.toContain("esto no va");
    expect(buildSystemPrompt({ business: "x", automations, bookingMode: "link", businessTimezone: "UTC" })).not.toContain("<reglas_del_negocio>");
  });
});
