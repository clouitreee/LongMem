import {
  createSession, getSessionDbId, markSessionCompleted,
  saveObservation, updateSessionPrompt, queueCompression,
  getFullObservation, getFullObservations, getStats,
  saveUserObservation, getDB,
} from "./db.ts";
import {
  searchObservations, searchSessions, searchUserObservations,
  getRecentObservationsWithDecay, getTimeline,
} from "./search.ts";
import { stripAllMemoryTags, truncateInput, truncateOutput, isFullyPrivate, redactSecrets } from "./privacy.ts";
import { IdleDetector } from "./idle-detector.ts";
import { CompressionWorker } from "./compression-worker.ts";
import type { MemoryConfig } from "./config.ts";

// Session ID → DB session ID cache
const sessionCache = new Map<string, number>();

function getOrCreateDbSession(sessionId: string, project = "default", directory = ""): number | null {
  if (sessionCache.has(sessionId)) return sessionCache.get(sessionId)!;
  const dbId = createSession(sessionId, project, directory);
  if (dbId) sessionCache.set(sessionId, dbId);
  return dbId;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createRoutes(
  idleDetector: IdleDetector,
  worker: CompressionWorker,
  config: MemoryConfig
) {
  const privacyEnabled = config.privacy.redactSecrets;
  const compressionEnabled = config.compression.enabled;

  return {
    async handleObserve(body: Record<string, unknown>): Promise<Response> {
      idleDetector.recordActivity();

      const sessionId = String(body.session_id || "default");
      const toolName = String(body.tool_name || "unknown");
      const toolInput = (body.tool_input as Record<string, unknown>) || {};
      const rawOutput = String(body.tool_output || "");
      const promptNumber = Number(body.prompt_number || 0);
      const project = String(body.project || "default");
      const directory = String(body.directory || "");

      let inputStr = truncateInput(stripAllMemoryTags(JSON.stringify(toolInput)), config.privacy.maxInputSize);
      let outputStr = truncateOutput(stripAllMemoryTags(rawOutput), config.privacy.maxOutputSize);

      if (privacyEnabled) {
        inputStr = redactSecrets(inputStr);
        outputStr = redactSecrets(outputStr);
      }

      if (isFullyPrivate(outputStr)) {
        return json({ status: "skipped", reason: "private" });
      }

      const dbSessionId = getOrCreateDbSession(sessionId, project, directory);
      if (!dbSessionId) return json({ error: "Failed to create session" }, 500);

      const obsId = saveObservation(dbSessionId, toolName, inputStr, outputStr, promptNumber);

      if (compressionEnabled) {
        queueCompression(obsId);
      }

      return json({ status: "ok", observation_id: obsId });
    },

    async handlePrompt(body: Record<string, unknown>): Promise<Response> {
      const sessionId = String(body.session_id || "default");
      const text = String(body.text || "");
      const project = String(body.project || "default");
      const directory = String(body.directory || "");

      if (!text.trim()) return json({ status: "skipped" });

      const dbSessionId = getOrCreateDbSession(sessionId, project, directory);
      if (!dbSessionId) return json({ error: "Failed to get session" }, 500);

      const cleanText = privacyEnabled ? redactSecrets(stripAllMemoryTags(text)) : stripAllMemoryTags(text);
      updateSessionPrompt(dbSessionId, cleanText);

      return json({ status: "ok" });
    },

    async handleSessionStart(body: Record<string, unknown>): Promise<Response> {
      const sessionId = String(body.session_id || "");
      const project = String(body.project || "default");
      const directory = String(body.directory || "");

      if (!sessionId) return json({ error: "session_id required" }, 400);

      const dbId = getOrCreateDbSession(sessionId, project, directory);
      return json({ status: "ok", db_id: dbId });
    },

    async handleSessionEnd(body: Record<string, unknown>): Promise<Response> {
      const sessionId = String(body.session_id || "");
      if (!sessionId) return json({ error: "session_id required" }, 400);

      const dbId = sessionCache.get(sessionId) ?? getSessionDbId(sessionId);
      if (dbId) {
        markSessionCompleted(dbId);
        sessionCache.delete(sessionId);
      }

      return json({ status: "ok" });
    },

    async handleSearch(params: URLSearchParams): Promise<Response> {
      const query = params.get("q") || "";
      const project = params.get("project") || undefined;
      const limit = Math.min(parseInt(params.get("limit") || "5", 10), 50);
      const type = params.get("type") || "observations";

      let results: object[];

      switch (type) {
        case "sessions":
          results = searchSessions(query, project, limit);
          break;
        case "user":
          results = searchUserObservations(query, limit);
          break;
        case "recent":
          results = getRecentObservationsWithDecay(project || "", limit);
          break;
        default:
          results = query
            ? searchObservations(query, project, limit)
            : getRecentObservationsWithDecay(project || "", limit);
      }

      // Compact format for MCP progressive disclosure
      const compact = (results as any[]).map(r => ({
        id: r.id,
        date: r.created_at?.slice(0, 10) || "",
        tool: r.tool_name || r.status || "",
        summary: (r.compressed_summary || r.first_user_prompt || "").slice(0, 120),
        files: r.files_referenced || null,
        rank: r.weighted_rank || 0,
      }));

      return json({ results: compact, total: compact.length });
    },

    async handleContext(params: URLSearchParams): Promise<Response> {
      const project = params.get("project") || "";
      const limit = Math.min(parseInt(params.get("limit") || "10", 10), 30);

      const observations = getRecentObservationsWithDecay(project, limit);
      const lines = observations
        .filter((o: any) => o.compressed_summary)
        .map((o: any) => `- [${o.created_at?.slice(0, 10)}] **${o.tool_name}**: ${o.compressed_summary}`);

      return json({ context: lines.join("\n"), count: lines.length });
    },

    async handleGetObservation(idParam: string): Promise<Response> {
      const ids = idParam.split(",").map(Number).filter(n => !isNaN(n) && n > 0);
      if (ids.length === 0) return json({ error: "Invalid IDs" }, 400);

      const observations = getFullObservations(ids);
      return json({ observations });
    },

    async handleTimeline(idParam: string, params: URLSearchParams): Promise<Response> {
      const id = parseInt(idParam, 10);
      if (isNaN(id)) return json({ error: "Invalid ID" }, 400);

      const before = Math.min(parseInt(params.get("before") || "3", 10), 10);
      const after = Math.min(parseInt(params.get("after") || "3", 10), 10);

      return json(getTimeline(id, before, after));
    },

    async handleEcosystemIngest(body: Record<string, unknown>): Promise<Response> {
      const files = body.files as Array<{ path: string; content: string; hash: string; source: string }>;
      if (!Array.isArray(files) || files.length === 0) {
        return json({ error: "files array required" }, 400);
      }

      const database = getDB();
      let ingested = 0;
      let skipped = 0;

      for (const file of files) {
        if (!file.path || !file.content) continue;

        // Check if this exact hash is already stored
        const existing = database.prepare(
          "SELECT id, metadata FROM user_observations WHERE observation_type = 'ecosystem' AND metadata LIKE ?"
        ).get(`%"path":"${file.path}"%`) as { id: number; metadata: string } | undefined;

        if (existing) {
          try {
            const meta = JSON.parse(existing.metadata || "{}");
            if (meta.hash === file.hash) {
              // Same content, just bump access count
              database.prepare(
                "UPDATE user_observations SET access_count = access_count + 1, last_accessed = datetime('now') WHERE id = ?"
              ).run(existing.id);
              skipped++;
              continue;
            }
            // Content changed — update in place
            database.prepare(
              "UPDATE user_observations SET content = ?, metadata = ?, last_accessed = datetime('now') WHERE id = ?"
            ).run(
              file.content,
              JSON.stringify({ path: file.path, hash: file.hash, source: file.source }),
              existing.id
            );
            // Rebuild FTS entry
            try {
              database.prepare("DELETE FROM user_observations_fts WHERE id = ?").run(existing.id);
              database.prepare("INSERT INTO user_observations_fts (id, content) VALUES (?, ?)").run(existing.id, file.content);
            } catch {}
            ingested++;
          } catch {
            skipped++;
          }
          continue;
        }

        // New file — insert
        saveUserObservation("ecosystem", file.content, {
          path: file.path,
          hash: file.hash,
          source: file.source,
        });
        ingested++;
      }

      return json({ status: "ok", ingested, skipped, total: files.length });
    },

    handleHealth(): Response {
      return json({
        status: "ok",
        uptime: Math.round(process.uptime()),
        pending: worker.pendingCount(),
        circuit_open: worker.isCircuitOpen(),
        idle_ms: idleDetector.timeSinceLastActivity(),
      });
    },

    handleStats(): Response {
      return json(getStats());
    },
  };
}
