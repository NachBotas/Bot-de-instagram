import { describe, expect, it } from "vitest";
import { toBubbles, stripMarkdown } from "../src/agent/bubbles.js";
import { buildTools, executeTool, type ToolDeps } from "../src/agent/tools.js";
import { parseInbound } from "../src/inbound.js";
import { buildBookingLink, pickSpreadSlots } from "../src/integrations/calendar.js";
import { DryRunManyChat } from "../src/integrations/manychat.js";
import { kindFromMime, looksLikeAttachmentUrl } from "../src/integrations/media.js";
import { newLead } from "../src/store.js";

describe("parseInbound", () => {
  it("acepta el body armado a mano", () => {
    const r = parseInbound({ subscriber_id: "123", first_name: "Ana", username: "@ana", text: "hola!" });
    expect(r).toEqual({ subscriberId: "123", firstName: "Ana", lastName: undefined, username: "ana", text: "hola!", mediaUrl: undefined });
  });
  it("acepta Full Contact Data de ManyChat", () => {
    const r = parseInbound({ id: 987, first_name: "Juan", last_name: "Pérez", ig_username: "juanp", last_input_text: "info" });
    expect(r).toMatchObject({ subscriberId: "987", firstName: "Juan", username: "juanp", text: "info" });
  });
  it("ignora variables sin reemplazar", () => {
    expect(parseInbound({ subscriber_id: "1", text: "{{last_input_text}}" })).toEqual({ error: "El mensaje está vacío" });
    expect(parseInbound({ subscriber_id: "{{user_id}}", text: "hola" })).toEqual({ error: "Falta subscriber_id" });
  });
});

describe("media", () => {
  it("detecta URLs de adjuntos de Instagram", () => {
    expect(looksLikeAttachmentUrl("https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x")).toBe(true);
    expect(looksLikeAttachmentUrl("mirá esto https://lookaside.fbsbx.com/x")).toBe(false);
    expect(looksLikeAttachmentUrl("https://miweb.com")).toBe(false);
    expect(looksLikeAttachmentUrl("https://x.com/nota.m4a")).toBe(true);
  });
  it("clasifica por tipo MIME", () => {
    expect(kindFromMime("audio/mpeg")).toBe("audio");
    expect(kindFromMime("image/jpeg")).toBe("image");
    expect(kindFromMime("video/mp4", "https://lookaside.fbsbx.com/ig_messaging_cdn/audio_clip")).toBe("audio");
    expect(kindFromMime("application/octet-stream", "https://x/a.ogg")).toBe("audio");
  });
});

describe("toBubbles", () => {
  it("separa por párrafos y limpia markdown", () => {
    expect(toBubbles("Hola **Ana**!\n\nContame, ¿a qué te dedicás?")).toEqual(["Hola Ana!", "Contame, ¿a qué te dedicás?"]);
    expect(stripMarkdown("- uno\n- dos")).toBe("uno\ndos");
  });
  it("respeta el máximo de burbujas y el límite de caracteres", () => {
    expect(toBubbles("a\n\nb\n\nc\n\nd\n\ne", 3)).toEqual(["a", "b", "c\n\nd\n\ne"]);
    const long = "Esto es una oración. ".repeat(80);
    expect(toBubbles(long).every((b) => b.length <= 1000)).toBe(true);
  });
  it("respuesta vacía = no se manda nada", () => {
    expect(toBubbles("   ")).toEqual([]);
  });
});

describe("agenda", () => {
  it("arma el link con datos precargados", () => {
    const link = new URL(buildBookingLink("https://calendly.com/yo/llamada", { name: "Ana Paz", email: "a@b.com", subscriberId: "42" }));
    expect(link.searchParams.get("name")).toBe("Ana Paz");
    expect(link.searchParams.get("email")).toBe("a@b.com");
    expect(link.searchParams.get("utm_content")).toBe("42");
  });
  it("reparte los horarios en distintos días", () => {
    const slots = ["2026-11-23T12:00:00Z", "2026-11-23T13:00:00Z", "2026-11-23T14:00:00Z", "2026-11-24T12:00:00Z", "2026-11-25T12:00:00Z"].map(
      (start) => ({ start }),
    );
    const picked = pickSpreadSlots(slots, "UTC", 4);
    expect(picked.map((s) => s.start.slice(0, 10))).toEqual(["2026-11-23", "2026-11-23", "2026-11-24", "2026-11-25"]);
  });
});

describe("herramientas", () => {
  const logs: string[] = [];
  const deps: ToolDeps = {
    manychat: new DryRunManyChat((l) => logs.push(l)),
    bookingMode: "link",
    bookingLink: "https://calendly.com/yo/llamada",
    businessTimezone: "America/Argentina/Buenos_Aires",
    automations: [{ clave: "recurso_gratis", flow_ns: "content123", descripcion: "Guía", cuando_usar: "si no califica" }],
    pauseTag: "bot_pausado",
    log: () => undefined,
  };

  it("expone las herramientas según la configuración", () => {
    const names = buildTools(deps).map((t) => t.name);
    expect(names).toEqual(["actualizar_lead", "enviar_link_agenda", "disparar_automatizacion", "derivar_a_humano"]);
    expect(buildTools({ bookingMode: "calcom", automations: [] }).map((t) => t.name)).toContain("agendar_llamada");
  });

  it("actualizar_lead guarda datos, valida email y cambia etapa con tags", async () => {
    const lead = newLead("7");
    lead.etapa = "conversando";
    const bad = await executeTool("actualizar_lead", { email: "no-es-email" }, lead, deps);
    expect(bad.isError).toBe(true);
    const ok = await executeTool(
      "actualizar_lead",
      { etapa: "calificado", email: "Ana@Mail.com", datos: [{ campo: "Objetivo", valor: "llegar a 10k/mes" }] },
      lead,
      deps,
    );
    expect(ok.isError).toBeUndefined();
    expect(lead.perfil.objetivo).toBe("llegar a 10k/mes");
    expect(lead.email).toBe("ana@mail.com");
    expect(lead.etapa).toBe("calificado");
    expect(logs.some((l) => l.includes("+tag setter_calificado"))).toBe(true);
    expect(logs.some((l) => l.includes("-tag setter_conversando"))).toBe(true);
  });

  it("disparar_automatizacion manda el flow correcto", async () => {
    const lead = newLead("8");
    const r = await executeTool("disparar_automatizacion", { clave: "recurso_gratis", motivo: "no califica" }, lead, deps);
    expect(r.isError).toBeUndefined();
    expect(logs.some((l) => l.includes("dispara flow content123"))).toBe(true);
  });

  it("derivar_a_humano pausa el bot", async () => {
    const lead = newLead("9");
    await executeTool("derivar_a_humano", { motivo: "pide hablar con alguien" }, lead, deps);
    expect(lead.paused).toBe(true);
    expect(lead.etapa).toBe("humano");
  });

  it("enviar_link_agenda devuelve el link y marca la etapa", async () => {
    const lead = newLead("10");
    lead.firstName = "Ana";
    const r = await executeTool("enviar_link_agenda", {}, lead, deps);
    expect(r.content).toContain("calendly.com/yo/llamada");
    expect(lead.etapa).toBe("link_enviado");
  });
});
