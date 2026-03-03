import { existsSync, readFileSync } from "fs";
import { join, homedir } from "path";
import type {
  ObserveRequest, PromptRequest, SessionStartRequest, SessionEndRequest,
  SearchResponse, ObservationResponse, TimelineResponse, HealthResponse,
  PromptContextResponse,
} from "./types.ts";

function loadPortFromConfig(): number {
  try {
    const configPath = join(homedir(), ".longmem", "settings.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (typeof config?.daemon?.port === "number") {
        return config.daemon.port;
      }
    }
  } catch {}
  return 38741;
}

const DEFAULT_PORT = loadPortFromConfig();
const SHORT_TIMEOUT = 2000;  // Fire-and-forget operations
const SEARCH_TIMEOUT = 5000; // Search operations
const CONTEXT_TIMEOUT = 1500; // Auto-context (must be fast)

export class DaemonClient {
  private baseURL: string;

  constructor(port = DEFAULT_PORT) {
    this.baseURL = `http://127.0.0.1:${port}`;
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

  // Fire-and-forget: never throws, never blocks
  async observe(data: ObserveRequest): Promise<void> {
    try {
      await fetch(`${this.baseURL}/observe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(SHORT_TIMEOUT),
      });
    } catch { /* silent */ }
  }

  async prompt(data: PromptRequest): Promise<void> {
    try {
      await fetch(`${this.baseURL}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(SHORT_TIMEOUT),
      });
    } catch { /* silent */ }
  }

  // Save prompt AND get relevant context in one call
  async promptWithContext(data: PromptRequest): Promise<PromptContextResponse | null> {
    try {
      const res = await fetch(`${this.baseURL}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(SHORT_TIMEOUT),
      });
    } catch { /* silent */ }
  }

  async sessionEnd(data: SessionEndRequest): Promise<void> {
    try {
      await fetch(`${this.baseURL}/session/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(SHORT_TIMEOUT),
      });
    } catch { /* silent */ }
  }

  async search(query: string, project?: string, limit = 5): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (project) params.set("project", project);
    const res = await fetch(`${this.baseURL}/search?${params}`, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    });
    return res.json();
  }

  async getObservations(ids: number[]): Promise<ObservationResponse> {
    const res = await fetch(`${this.baseURL}/observation/${ids.join(",")}`, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    });
    return res.json();
  }

  async timeline(id: number, before = 3, after = 3): Promise<TimelineResponse> {
    const params = new URLSearchParams({ before: String(before), after: String(after) });
    const res = await fetch(`${this.baseURL}/timeline/${id}?${params}`, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    });
    return res.json();
  }
}
