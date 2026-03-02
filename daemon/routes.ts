import {
  createSession, getSessionDbId, markSessionCompleted,
  saveObservation, updateSessionPrompt, queueCompression,
  getFullObservation, getFullObservations, getStats,
  saveUserObservation, getDB,
} from "./db.ts";
import {
  searchObservations, searchSessions, searchUserObservations,
  getRecentObservationsWithDecay, getTimeline,
  getRecentSessionPrompts, detectTopicChange, isVaguePrompt,
  searchProjectContext, formatContextBlock,
} from "./search.ts";
import {
  stripAllMemoryTags, truncateInput, truncateOutput, isFullyPrivate,
  redactSecrets, extractPathHint, isExcludedPath,
  compileCustomPatterns, redactWithCustomPatterns,
} from "./privacy.ts";
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
  const privacyMode = config.privacy.mode;
  const privacyEnabled = privacyMode !== "none";
  const compressionEnabled = config.compression.enabled;
  const compiledCustom = compileCustomPatterns(config.privacy.customPatterns);

  return {
    async handleObserve(body: Record<string, unknown>): Promise<Response> {
      idleDetector.recordActivity();

      const sessionId = String(body.session_id || "default");
      const toolName = String(body.tool_name || "unknown");
      const toolInput = (body.tool_input as Record<string, unknown>) || {};
      let rawOutput = String(body.tool_output || "");
      const promptNumber = Number(body.prompt_number || 0);
      const project = String(body.project || "default");
      const directory = String(body.directory || "");

      // ── Fast-path: truncate huge inputs before regex ──
      let rawInput = JSON.stringify(toolInput);
      if (rawInput.length > 100_000) rawInput = rawInput.slice(0, config.privacy.maxInputSize);
      if (rawOutput.length > 100_000) rawOutput = rawOutput.slice(0, config.privacy.maxOutputSize);

      let inputStr = truncateInput(stripAllMemoryTags(rawInput), config.privacy.maxInputSize);
      let outputStr = truncateOutput(stripAllMemoryTags(rawOutput), config.privacy.maxOutputSize);

      // ── Tool exclusion gate ──
      if (config.privacy.excludeTools.includes(toolName)) {
        return json({ status: "excluded", reason: "tool_excluded" });
      }

      // ── Path exclusion gate (metadata-only, NO content saved) ──
      const pathHint = extractPathHint(inputStr);
      if (pathHint && isExcludedPath(pathHint, config.privacy.excludePaths)) {
        const dbSessionId = getOrCreateDbSession(sessionId, project, directory);
        if (!dbSessionId) return json({ error: "Failed to create session" }, 500);
        const obsId = saveObservation(
          dbSessionId, toolName,
          JSON.stringify({ file_path: pathHint }),
          "[EXCLUDED: path matched denylist]",
          promptNumber,
          JSON.stringify({ reason: "path_excluded", path: pathHint, mode: config.privacy.mode })
        );
        return json({ status: "excluded", observation_id: obsId, reason: "path_denylist" });
      }

      // ── Secret redaction ──
      if (privacyEnabled) {
        inputStr = redactSecrets(inputStr);
        outputStr = redactSecrets(outputStr);
        if (compiledCustom.length > 0) {
          inputStr = redactWithCustomPatterns(inputStr, compiledCustom);
          outputStr = redactWithCustomPatterns(outputStr, compiledCustom);
        }
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
      const withContext = Boolean(body.with_context);

      if (!text.trim()) return json({ status: "skipped" });

      const dbSessionId = getOrCreateDbSession(sessionId, project, directory);
      if (!dbSessionId) return json({ error: "Failed to get session" }, 500);

      const cleanText = privacyEnabled ? redactSecrets(stripAllMemoryTags(text)) : stripAllMemoryTags(text);

      // Get recent prompts BEFORE saving current one (for topic change detection)
      let recentPrompts: string[] = [];
      if (withContext) {
        recentPrompts = getRecentSessionPrompts(dbSessionId, 3);
      }

      updateSessionPrompt(dbSessionId, cleanText);

      if (!withContext) {
        return json({ status: "ok" });
      }

      // ── Auto-context: detect topic change + search (300ms timeout) ──
      try {
        const contextPromise = (async () => {
          const topicChanged = detectTopicChange(cleanText, recentPrompts);
          if (!topicChanged) return { context: null, topic_changed: false };

          const searchQuery = isVaguePrompt(cleanText) ? "" : cleanText;
          const results = searchProjectContext(searchQuery, project, 5);
          const context = formatContextBlock(results, project);
          return { context: context || null, topic_changed: true };
        })();

        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 300));
        const result = await Promise.race([contextPromise, timeout]);

        if (result === null) {
          // Timeout — return ok without context (silent fallback)
          return json({ status: "ok", context: null, topic_changed: false });
        }
        return json({ status: "ok", ...result });
      } catch {
        // Any error in context search — fail silently
        return json({ status: "ok", context: null, topic_changed: false });
      }
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
