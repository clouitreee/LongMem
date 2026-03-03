import { existsSync, readFileSync } from "fs";
import { DEFAULT_HOST, SETTINGS_PATH } from "./constants.ts";
import { loadPortFromConfig } from "./port-config.ts";
import type {
  ObserveRequest, PromptRequest, SessionStartRequest, SessionEndRequest,
  SearchResponse, ObservationResponse, TimelineResponse, HealthResponse,
  PromptContextResponse,
} from "./types.ts";

function loadTokenFromConfig(): string | undefined {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const config = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      return config?.daemon?.authToken;
    }
  } catch {}
  return undefined;
}

const PORT = loadPortFromConfig();
const TOKEN = loadTokenFromConfig();
const SHORT_TIMEOUT = 2000;
const SEARCH_TIMEOUT = 5000;
const CONTEXT_TIMEOUT = 1500;

export class DaemonClient {
  private baseURL: string;
  private token?: string;

  constructor(port = PORT, token = TOKEN) {
    this.baseURL = `http://${DEFAULT_HOST}:${port}`;
    this.token = token;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    return headers;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseURL}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async observe(data: ObserveRequest): Promise<void> {
    try {
      await fetch(`${this.baseURL}/observe`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(SHORT_TIMEOUT),
      });
    } catch {}
  }

  async prompt(data: PromptRequest): Promise<void> {
    try {
      await fetch(`${this.baseURL}/prompt`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(SHORT_TIMEOUT),
      });
    } catch {}
  }

  async promptWithContext(data: PromptRequest): Promise<PromptContextResponse | null> {
    try {
      const res = await fetch(`${this.baseURL}/prompt`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({ ...data, with_context: true }),
        signal: AbortSignal.timeout(CONTEXT_TIMEOUT),
      });
      if (!res.ok) return null;
      return await res.json() as PromptContextResponse;
    } catch {
      return null;
    }
  }

  async sessionStart(data: SessionStartRequest): Promise<void> {
    try {
      await fetch(`${this.baseURL}/session/start`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(SHORT_TIMEOUT),
      });
    } catch {}
  }

  async sessionEnd(data: SessionEndRequest): Promise<void> {
    try {
      await fetch(`${this.baseURL}/session/end`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(SHORT_TIMEOUT),
      });
    } catch {}
  }

  async search(query: string, project?: string, limit = 5): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (project) params.set("project", project);
    const res = await fetch(`${this.baseURL}/search?${params}`, {
      headers: this.getHeaders(),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    });
    return res.json();
  }

  async getObservations(ids: number[]): Promise<ObservationResponse> {
    const res = await fetch(`${this.baseURL}/observation/${ids.join(",")}`, {
      headers: this.getHeaders(),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    });
    return res.json();
  }

  async timeline(id: number, before = 3, after = 3): Promise<TimelineResponse> {
    const params = new URLSearchParams({ before: String(before), after: String(after) });
    const res = await fetch(`${this.baseURL}/timeline/${id}?${params}`, {
      headers: this.getHeaders(),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    });
    return res.json();
  }
}
