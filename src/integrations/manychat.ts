/**
 * Cliente mínimo de la API pública de ManyChat (https://api.manychat.com/swagger).
 * Los endpoints de ManyChat viven bajo /fb/ para todos los canales, Instagram incluido.
 */

const BASE_URL = "https://api.manychat.com";

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
