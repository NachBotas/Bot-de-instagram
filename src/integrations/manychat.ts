/**
 * Cliente mínimo de la API pública de ManyChat (https://api.manychat.com/swagger).
 * Los endpoints de ManyChat viven bajo /fb/ para todos los canales, Instagram incluido.
 */

const BASE_URL = "https://api.manychat.com";

export interface ManyChatFlow {
  ns: string;
  name: string;
  folderId: number | null;
}

export interface ManyChatFolder {
  id: number;
  name: string;
  parentId: number | null;
}

export interface ManyChatClient {
  sendText(subscriberId: string, messages: string[]): Promise<void>;
  sendFlow(subscriberId: string, flowNs: string): Promise<void>;
  addTag(subscriberId: string, tag: string): Promise<void>;
  removeTag(subscriberId: string, tag: string): Promise<void>;
  setCustomField(subscriberId: string, field: string, value: string | number | boolean): Promise<void>;
  getSubscriberTags(subscriberId: string): Promise<string[] | undefined>;
}

export class ManyChatError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export class ManyChatApi implements ManyChatClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T = unknown>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = text;
    }
    const status = (json as { status?: string })?.status;
    if (!res.ok || status === "error") {
      throw new ManyChatError(`ManyChat ${method} ${path} falló (${res.status}): ${text.slice(0, 500)}`, res.status, json);
    }
    return json as T;
  }

  async sendText(subscriberId: string, messages: string[]): Promise<void> {
    if (messages.length === 0) return;
    await this.call("POST", "/fb/sending/sendContent", {
      subscriber_id: subscriberId,
      data: {
        version: "v2",
        content: {
          type: "instagram",
          messages: messages.map((text) => ({ type: "text", text })),
        },
      },
    });
  }

  async sendFlow(subscriberId: string, flowNs: string): Promise<void> {
    await this.call("POST", "/fb/sending/sendFlow", { subscriber_id: subscriberId, flow_ns: flowNs });
  }

  async addTag(subscriberId: string, tag: string): Promise<void> {
    await this.call("POST", "/fb/subscriber/addTagByName", { subscriber_id: subscriberId, tag_name: tag });
  }

  async removeTag(subscriberId: string, tag: string): Promise<void> {
    await this.call("POST", "/fb/subscriber/removeTagByName", { subscriber_id: subscriberId, tag_name: tag });
  }

  async setCustomField(subscriberId: string, field: string, value: string | number | boolean): Promise<void> {
    await this.call("POST", "/fb/subscriber/setCustomFieldByName", {
      subscriber_id: subscriberId,
      field_name: field,
      field_value: value,
    });
  }

  /** Datos de la cuenta conectada (sirve para verificar la API key). */
  async getPageInfo(): Promise<{ id?: string; name?: string }> {
    const res = await this.call<{ data?: { id?: number | string; name?: string } }>("GET", "/fb/page/getInfo");
    return { id: res.data?.id === undefined ? undefined : String(res.data.id), name: res.data?.name };
  }

  /** Todos los flows (automatizaciones) de la cuenta, con sus carpetas. */
  async getFlows(): Promise<{ flows: ManyChatFlow[]; folders: ManyChatFolder[] }> {
    type Raw = { data?: { flows?: Record<string, unknown>[]; folders?: Record<string, unknown>[] } };
    const res = await this.call<Raw>("GET", "/fb/page/getFlows");
    const num = (v: unknown) => (v === undefined || v === null || v === "" || v === 0 ? null : Number(v));
    return {
      flows: (res.data?.flows ?? []).map((f) => ({
        ns: String(f.ns ?? f.flow_ns ?? ""),
        name: String(f.name ?? f.ns ?? "Sin nombre"),
        folderId: num(f.folder_id),
      })).filter((f) => f.ns),
      folders: (res.data?.folders ?? []).map((f) => ({
        id: Number(f.id),
        name: String(f.name ?? "Carpeta"),
        parentId: num(f.parent_id),
      })),
    };
  }

  async getTags(): Promise<string[]> {
    const res = await this.call<{ data?: { name: string }[] }>("GET", "/fb/page/getTags");
    return (res.data ?? []).map((t) => t.name);
  }

  async createTag(name: string): Promise<void> {
    await this.call("POST", "/fb/page/createTag", { name });
  }

  async getCustomFields(): Promise<string[]> {
    const res = await this.call<{ data?: { name: string }[] }>("GET", "/fb/page/getCustomFields");
    return (res.data ?? []).map((f) => f.name);
  }

  async createCustomField(name: string, description: string): Promise<void> {
    await this.call("POST", "/fb/page/createCustomField", { caption: name, type: "text", description });
  }

  async getSubscriberTags(subscriberId: string): Promise<string[] | undefined> {
    const res = await this.call<{ data?: { tags?: { name: string }[] } }>(
      "GET",
      `/fb/subscriber/getInfo?subscriber_id=${encodeURIComponent(subscriberId)}`,
    );
    return res.data?.tags?.map((t) => t.name);
  }
}

/** No llama a ManyChat: imprime en consola. Para el simulador y para probar sin cuenta. */
export class DryRunManyChat implements ManyChatClient {
  constructor(private readonly log: (line: string) => void = (l) => console.log(l)) {}
  async sendText(id: string, messages: string[]) {
    for (const m of messages) this.log(`[ManyChat → ${id}] 💬 ${m}`);
  }
  async sendFlow(id: string, flowNs: string) {
    this.log(`[ManyChat → ${id}] ▶️  dispara flow ${flowNs}`);
  }
  async addTag(id: string, tag: string) {
    this.log(`[ManyChat → ${id}] 🏷️  +tag ${tag}`);
  }
  async removeTag(id: string, tag: string) {
    this.log(`[ManyChat → ${id}] 🏷️  -tag ${tag}`);
  }
  async setCustomField(id: string, field: string, value: string | number | boolean) {
    this.log(`[ManyChat → ${id}] ✏️  ${field} = ${value}`);
  }
  async getSubscriberTags() {
    return undefined;
  }
}
