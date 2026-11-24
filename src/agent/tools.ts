import type Anthropic from "@anthropic-ai/sdk";
import type { BookingMode } from "../config.js";
import { buildBookingLink, formatSlot, pickSpreadSlots, type CalComClient } from "../integrations/calendar.js";
import type { ManyChatClient } from "../integrations/manychat.js";
import { registrarEtapa, type Etapa, type Lead } from "../store.js";
import type { Automation } from "./automations.js";

type Tool = Anthropic.Beta.BetaTool;

const ETAPAS: Etapa[] = ["conversando", "calificado", "no_calificado", "link_enviado", "agendado", "humano"];

export interface ToolDeps {
  manychat: ManyChatClient;
  bookingMode: BookingMode;
  calendar?: CalComClient;
  bookingLink?: string;
  businessTimezone: string;
  automations: Automation[];
  pauseTag: string;
  flowBookedNs?: string;
  handoffWebhookUrl?: string;
  /** Flow de ManyChat que se dispara para avisarle al equipo (con una acción "Notify Admin"). */
  flowAviso?: string;
  /** Guarda el aviso en la bandeja del panel. */
  registrarAviso?: (aviso: { tipo: "consulta" | "derivacion"; lead: Lead; texto: string }) => Promise<void>;
  log: (msg: string, extra?: unknown) => void;
  fetchImpl?: typeof fetch;
}

/** Define las herramientas según qué esté configurado (agenda, automatizaciones). Orden fijo = mejor caché. */
export function buildTools(deps: Pick<ToolDeps, "bookingMode" | "automations">): Tool[] {
  const tools: Tool[] = [
    {
      name: "actualizar_lead",
      description:
        "Guarda lo que aprendiste del lead y/o cambia su etapa. Llamala cada vez que el lead te cuente algo relevante para la calificación (situación, objetivo, dolor, urgencia, presupuesto, decisor, nicho) o te dé su email, teléfono o zona horaria. Los datos se guardan para el closer.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          etapa: {
            type: "string",
            enum: ETAPAS,
            description:
              "Etapa nueva. conversando = en descubrimiento; calificado = cumple criterios y está para la llamada; no_calificado = no es fit.",
          },
          datos: {
            type: "array",
            description: "Datos nuevos o actualizados del lead.",
            items: {
              type: "object",
              properties: {
                campo: {
                  type: "string",
                  description: "Nombre corto en minúsculas, ej. situacion, objetivo, dolor, urgencia, presupuesto, nicho, decisor",
                },
                valor: { type: "string", description: "Frase corta con lo que dijo el lead." },
              },
              required: ["campo", "valor"],
              additionalProperties: false,
            },
          },
          email: { type: "string", description: "Email del lead, si lo dio." },
          telefono: { type: "string", description: "Teléfono del lead con código de país, si lo dio." },
          zona_horaria: { type: "string", description: "Zona horaria IANA del lead, ej. America/Bogota." },
        },
        required: [],
        additionalProperties: false,
      },
    },
  ];

  if (deps.bookingMode === "calcom") {
    tools.push(
      {
        name: "ver_horarios_disponibles",
        description:
          "Consulta los horarios libres para la llamada de venta en los próximos días. Devuelve una lista corta de opciones con su valor ISO exacto para usar en agendar_llamada.",
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            zona_horaria: {
              type: "string",
              description: "Zona horaria IANA del lead para mostrar los horarios. Si no la sabés, omitila.",
            },
            desde_fecha: {
              type: "string",
              description: "Fecha YYYY-MM-DD desde la cual buscar, si el lead pidió un día puntual. Si no, omitila.",
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: "agendar_llamada",
        description:
          "Reserva la llamada de venta en la agenda. Solo usala cuando el lead eligió un horario concreto de los que devolvió ver_horarios_disponibles y ya tenés su nombre y email.",
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            inicio: { type: "string", description: "Valor ISO exacto del horario elegido, tal como lo devolvió ver_horarios_disponibles." },
            nombre: { type: "string", description: "Nombre y apellido del lead." },
            email: { type: "string", description: "Email del lead para la invitación." },
            zona_horaria: { type: "string", description: "Zona horaria IANA del lead, si la sabés." },
            notas: {
              type: "string",
              description: "Resumen para el closer: situación, objetivo, dolor y urgencia del lead en 2-4 frases.",
            },
          },
          required: ["inicio", "nombre", "email", "notas"],
          additionalProperties: false,
        },
      },
    );
  } else if (deps.bookingMode === "link") {
    tools.push({
      name: "enviar_link_agenda",
      description:
        "Genera el link personalizado de la agenda para que el lead elija el horario de su llamada. Pegá el link que devuelve tal cual en tu respuesta.",
      strict: true,
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    });
  }

  if (deps.automations.length > 0) {
    tools.push({
      name: "disparar_automatizacion",
      description:
        "Dispara un flujo de ManyChat que le envía contenido al lead (recursos, videos, testimonios, etc.). Revisá en las instrucciones cuándo usar cada uno. No lo dispares dos veces en la misma conversación salvo que te lo pidan.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          clave: { type: "string", enum: deps.automations.map((a) => a.clave), description: "Qué automatización disparar." },
          motivo: { type: "string", description: "Por qué la disparás, en una frase." },
        },
        required: ["clave", "motivo"],
        additionalProperties: false,
      },
    });
  }

  tools.push({
    name: "consultar_al_equipo",
    description:
      "Avisa al equipo de una pregunta del lead que no podés responder con la información del negocio (un dato, un precio, un caso particular). El equipo recibe el aviso y responde; la conversación sigue con vos. Usala en lugar de inventar.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        pregunta: { type: "string", description: "La pregunta del lead, clara y con el contexto necesario para que el equipo la responda." },
      },
      required: ["pregunta"],
      additionalProperties: false,
    },
  });

  tools.push({
    name: "derivar_a_humano",
    description:
      "Pausa el bot para este lead y avisa al equipo para que siga una persona. Usala si pide hablar con una persona, está molesto, tiene un problema con una compra o pago, o pregunta algo delicado que no podés responder.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { motivo: { type: "string", description: "Por qué se deriva, en una frase." } },
      required: ["motivo"],
      additionalProperties: false,
    },
  });

  return tools;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

function isValidTimeZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function safe(deps: ToolDeps, label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    deps.log(`⚠️  ${label} falló (sigo igual)`, err instanceof Error ? err.message : err);
  }
}

async function setEtapa(lead: Lead, etapa: Etapa, deps: ToolDeps): Promise<void> {
  if (lead.etapa === etapa) return;
  const prev = registrarEtapa(lead, etapa);
  const id = lead.subscriberId;
  await safe(deps, "tag de etapa", async () => {
    if (prev !== "nuevo") await deps.manychat.removeTag(id, `setter_${prev}`);
    await deps.manychat.addTag(id, `setter_${etapa}`);
  });
  await safe(deps, "campo setter_etapa", () => deps.manychat.setCustomField(id, "setter_etapa", etapa));
}

function perfilResumen(lead: Lead): string {
  return Object.entries(lead.perfil)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" | ")
    .slice(0, 1900);
}

/** Ejecuta una herramienta. Modifica `lead` en memoria; el que llama lo guarda. */
export async function executeTool(name: string, input: unknown, lead: Lead, deps: ToolDeps): Promise<ToolOutcome> {
  const args = (input ?? {}) as Record<string, unknown>;
  const id = lead.subscriberId;

  switch (name) {
    case "actualizar_lead": {
      const changed: string[] = [];
      const datos = Array.isArray(args.datos) ? (args.datos as { campo?: unknown; valor?: unknown }[]) : [];
      for (const d of datos) {
        if (typeof d.campo !== "string" || typeof d.valor !== "string") continue;
        const campo = d.campo.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 40);
        if (!campo) continue;
        lead.perfil[campo] = d.valor.trim().slice(0, 500);
        changed.push(campo);
      }
      if (typeof args.email === "string") {
        const email = args.email.trim().toLowerCase();
        if (!EMAIL_RE.test(email)) return { content: `El email "${args.email}" no parece válido. Pedile que lo revise.`, isError: true };
        lead.email = email;
        changed.push("email");
        await safe(deps, "campo setter_email", () => deps.manychat.setCustomField(id, "setter_email", email));
      }
      if (typeof args.telefono === "string") {
        lead.telefono = args.telefono.trim();
        changed.push("telefono");
      }
      if (typeof args.zona_horaria === "string") {
        if (!isValidTimeZone(args.zona_horaria)) {
          return { content: `"${args.zona_horaria}" no es una zona horaria IANA válida (ej. America/Mexico_City).`, isError: true };
        }
        lead.timezone = args.zona_horaria;
        changed.push("zona_horaria");
      }
      if (datos.length > 0) {
        await safe(deps, "campo setter_resumen", () => deps.manychat.setCustomField(id, "setter_resumen", perfilResumen(lead)));
      }
      if (typeof args.etapa === "string" && (ETAPAS as string[]).includes(args.etapa)) {
        await setEtapa(lead, args.etapa as Etapa, deps);
        changed.push(`etapa=${args.etapa}`);
      }
      return { content: changed.length ? `Guardado: ${changed.join(", ")}.` : "No había nada nuevo para guardar." };
    }

    case "ver_horarios_disponibles": {
      if (!deps.calendar) return { content: "La agenda no está configurada.", isError: true };
      const tz = isValidTimeZone(args.zona_horaria as string) ? (args.zona_horaria as string) : (lead.timezone ?? deps.businessTimezone);
      const now = new Date();
      let from = new Date(now.getTime() + 2 * 60 * 60 * 1000); // al menos 2 h de anticipación
      if (typeof args.desde_fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.desde_fecha)) {
        const asked = new Date(`${args.desde_fecha}T00:00:00Z`);
        if (asked > from) from = asked;
      }
      const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
      const slots = await deps.calendar.getSlots(from.toISOString(), to.toISOString(), tz);
      if (slots.length === 0) return { content: "No hay horarios libres en los próximos 7 días. Ofrecé derivar a una persona del equipo." };
      const picked = pickSpreadSlots(slots, tz);
      const lines = picked.map((s) => `- ${formatSlot(s.start, tz)} → inicio="${s.start}"`);
      return { content: `Horarios libres (zona ${tz}):\n${lines.join("\n")}\nOfrecé 2 o 3 de estos en lenguaje natural.` };
    }

    case "agendar_llamada": {
      if (!deps.calendar) return { content: "La agenda no está configurada.", isError: true };
      const email = String(args.email ?? "").trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return { content: "El email no es válido; pedile al lead que lo confirme.", isError: true };
      const inicio = String(args.inicio ?? "");
      if (Number.isNaN(Date.parse(inicio))) return { content: "El horario no es válido. Volvé a consultar los horarios.", isError: true };
      const tz = isValidTimeZone(args.zona_horaria as string) ? (args.zona_horaria as string) : (lead.timezone ?? deps.businessTimezone);
      try {
        const res = await deps.calendar.book({
          start: inicio,
          name: String(args.nombre ?? lead.firstName ?? "Lead de Instagram"),
          email,
          timeZone: tz,
          phone: lead.telefono,
          notes: String(args.notas ?? ""),
          subscriberId: id,
        });
        lead.email = email;
        lead.timezone = tz;
        lead.booking = { start: res.start, uid: res.uid, meetingUrl: res.meetingUrl };
        if (typeof args.notas === "string") lead.perfil["notas_para_closer"] = args.notas.slice(0, 800);
        await setEtapa(lead, "agendado", deps);
        await safe(deps, "campo setter_llamada", () => deps.manychat.setCustomField(id, "setter_llamada", res.start));
        if (deps.flowBookedNs) await safe(deps, "flow de confirmación", () => deps.manychat.sendFlow(id, deps.flowBookedNs!));
        return {
          content: `Llamada agendada para ${formatSlot(res.start, tz)} (${tz}). La invitación llega a ${email}.${
            res.meetingUrl ? ` Link de la reunión: ${res.meetingUrl}` : ""
          }`,
        };
      } catch (err) {
        return {
          content: `No se pudo agendar: ${err instanceof Error ? err.message : String(err)}. Probablemente el horario se ocupó; consultá horarios de nuevo.`,
          isError: true,
        };
      }
    }

    case "enviar_link_agenda": {
      if (!deps.bookingLink) return { content: "No hay link de agenda configurado.", isError: true };
      const link = buildBookingLink(deps.bookingLink, {
        name: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || undefined,
        email: lead.email,
        subscriberId: id,
      });
      lead.booking = { ...lead.booking, link };
      if (lead.etapa !== "agendado") await setEtapa(lead, "link_enviado", deps);
      return { content: link };
    }

    case "disparar_automatizacion": {
      const auto = deps.automations.find((a) => a.clave === args.clave);
      if (!auto) return { content: `No existe la automatización "${String(args.clave)}".`, isError: true };
      try {
        await deps.manychat.sendFlow(id, auto.flow_ns);
      } catch (err) {
        return { content: `No se pudo disparar: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      await safe(deps, "tag de automatización", () => deps.manychat.addTag(id, `auto_${auto.clave}`));
      return { content: `Listo, se disparó "${auto.clave}". El lead ya lo recibe; no repitas el contenido.` };
    }

    case "consultar_al_equipo": {
      const pregunta = String(args.pregunta ?? "").trim();
      if (!pregunta) return { content: "Falta la pregunta.", isError: true };
      await avisarEquipo(deps, lead, "consulta", pregunta);
      await safe(deps, "tag de consulta", () => deps.manychat.addTag(id, "setter_consulta"));
      return {
        content:
          "Avisado. Decile al lead que lo consultás con el equipo y le confirmás apenas tengas la respuesta, sin inventar nada. Si tiene sentido, seguí la conversación con la siguiente pregunta.",
      };
    }

    case "derivar_a_humano": {
      const motivo = String(args.motivo ?? "sin motivo");
      lead.paused = true;
      lead.perfil["motivo_derivacion"] = motivo.slice(0, 300);
      await setEtapa(lead, "humano", deps);
      await safe(deps, "tag de pausa", () => deps.manychat.addTag(id, deps.pauseTag));
      await avisarEquipo(deps, lead, "derivacion", motivo);
      return { content: "Derivado. El bot queda en pausa para este lead. Despedite en una frase diciendo que alguien del equipo le responde." };
    }

    default:
      return { content: `Herramienta desconocida: ${name}`, isError: true };
  }
}

/** Avisa al equipo por todos los canales configurados: bandeja del panel, flow de ManyChat y webhook. */
async function avisarEquipo(deps: ToolDeps, lead: Lead, tipo: "consulta" | "derivacion", texto: string): Promise<void> {
  const id = lead.subscriberId;
  if (deps.registrarAviso) await safe(deps, "bandeja de avisos", () => deps.registrarAviso!({ tipo, lead, texto }));
  if (deps.flowAviso) await safe(deps, "flow de aviso", () => deps.manychat.sendFlow(id, deps.flowAviso!));
  if (deps.handoffWebhookUrl) {
    const f = deps.fetchImpl ?? fetch;
    await safe(deps, "webhook de aviso", async () => {
      const res = await f(deps.handoffWebhookUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tipo,
          subscriber_id: id,
          nombre: lead.firstName,
          username: lead.username,
          texto,
          motivo: texto,
          perfil: lead.perfil,
          etapa: lead.etapa,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
  }
}
