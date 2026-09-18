const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "v3";

export class GhlError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export class GhlClient {
  constructor(
    private readonly token: string,
    readonly locationId: string
  ) {
    if (!token) throw new Error("GHL token is required");
    if (!locationId) throw new Error("GHL location ID is required");
  }

  static fromEnv() {
    return new GhlClient(
      process.env.GHL_PRIVATE_INTEGRATION_TOKEN ?? "",
      process.env.GHL_LOCATION_ID ?? ""
    );
  }

  private async fetchResponse(path: string, init: RequestInit = {}, query?: Query): Promise<Response> {
    const url = new URL(path, GHL_BASE_URL);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        Version: GHL_API_VERSION,
        ...init.headers
      }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new GhlError(`GHL request failed: ${response.status} ${path}`, response.status, body);
    }
    return response;
  }

  private async request<T>(path: string, init: RequestInit = {}, query?: Query): Promise<T> {
    const response = await this.fetchResponse(path, init, query);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  searchContacts(params: Query = {}) {
    return this.request<Record<string, unknown>>("/contacts/", {}, {
      locationId: this.locationId,
      limit: 100,
      ...params
    });
  }

  getContact(contactId: string) {
    return this.request<Record<string, unknown>>(`/contacts/${contactId}`);
  }

  searchConversations(params: Query = {}) {
    return this.request<Record<string, unknown>>("/conversations/search", {}, {
      locationId: this.locationId,
      limit: 100,
      ...params
    });
  }

  getConversationMessages(conversationId: string, params: Query = {}) {
    return this.request<Record<string, unknown>>(
      `/conversations/${conversationId}/messages`,
      {},
      { limit: 100, ...params }
    );
  }

  async getCallRecording(messageId: string): Promise<Buffer> {
    const response = await this.fetchResponse(
      `/conversations/messages/${messageId}/locations/${this.locationId}/recording`,
      { headers: { Accept: "audio/x-wav" } }
    );
    return Buffer.from(await response.arrayBuffer());
  }

  getCallTranscript(messageId: string) {
    return this.request<unknown>(
      `/conversations/locations/${this.locationId}/messages/${messageId}/transcription`
    );
  }

  searchOpportunities(params: Query = {}) {
    return this.request<Record<string, unknown>>("/opportunities/search", {}, {
      location_id: this.locationId,
      limit: 100,
      ...params
    });
  }

  getCalendars() {
    return this.request<Record<string, unknown>>("/calendars/", {}, { locationId: this.locationId });
  }

  getCalendarEvents(params: Query) {
    return this.request<Record<string, unknown>>("/calendars/events", {}, {
      locationId: this.locationId,
      ...params
    });
  }

  getCustomFields() {
    return this.request<Record<string, unknown>>(`/locations/${this.locationId}/customFields`);
  }
}

export function findArray(payload: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asDate(value: unknown): Date | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}
