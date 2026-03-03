import { Database } from "bun:sqlite";
import { join } from "path";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { MEMORY_DIR, DEFAULT_DB_PATH } from "../shared/constants.ts";
import { VERSION } from "../shared/version.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

let db: Database | null = null;

export function getDB(dbPath?: string): Database {
  if (db) return db;

  const path = dbPath || DEFAULT_DB_PATH;
  const dir = path.substring(0, path.lastIndexOf("/"));

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");

  return db;
}

export function closeDB(): void {
  if (db) {
    try {
      db.close();
    } catch {}
    db = null;
  }
}

export function runMigrations(): void {
  const database = getDB();

  database.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    (database.prepare("SELECT version FROM schema_migrations").all() as { version: string }[]).map(r => r.version)
  );

  const migrations = [
    {
      version: "001_initial",
      sql: `
        CREATE TABLE IF NOT EXISTS sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          opencode_session_id TEXT NOT NULL UNIQUE,
          project TEXT NOT NULL,
          directory TEXT NOT NULL DEFAULT '',
          first_user_prompt TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES sessions(id),
          tool_name TEXT NOT NULL,
          tool_input TEXT NOT NULL DEFAULT '{}',
          tool_output TEXT NOT NULL DEFAULT '',
          compressed_summary TEXT,
          observation_type TEXT,
          files_referenced TEXT,
          concepts TEXT,
          prompt_number INTEGER DEFAULT 0,
          redaction_meta TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE TABLE IF NOT EXISTS user_prompts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES sessions(id),
          prompt_number INTEGER NOT NULL,
          prompt TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS compression_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          observation_id INTEGER NOT NULL REFERENCES observations(id),
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES sessions(id),
          request TEXT,
          investigated TEXT,
          learned TEXT,
          completed TEXT,
          next_steps TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS concepts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          frequency INTEGER NOT NULL DEFAULT 1,
          last_seen TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS observation_concepts (
          observation_id INTEGER NOT NULL,
          concept_id INTEGER NOT NULL,
          PRIMARY KEY (observation_id, concept_id)
        );

        CREATE TABLE IF NOT EXISTS user_observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          observation_type TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_accessed TEXT NOT NULL DEFAULT (datetime('now')),
          access_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
          id UNINDEXED,
          tool_name,
          compressed_summary,
          files_referenced,
          content='observations',
          content_rowid='id'
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
          id UNINDEXED,
          prompt,
          content='user_prompts',
          content_rowid='id'
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS user_observations_fts USING fts5(
          id UNINDEXED,
          content,
          content='user_observations',
          content_rowid='id'
        );

        CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
        CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
        CREATE INDEX IF NOT EXISTS idx_compression_status ON compression_queue(status);
      `
    }
  ];

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.exec(migration.sql);
    database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
  }
}

export function createSession(sessionId: string, project: string, directory: string): number | null {
  const database = getDB();
  const existing = database.prepare("SELECT id FROM sessions WHERE opencode_session_id = ?").get(sessionId) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = database.prepare(
    "INSERT INTO sessions (opencode_session_id, project, directory) VALUES (?, ?, ?) RETURNING id"
  ).get(sessionId, project, directory) as { id: number } | undefined;

  return result?.id ?? null;
}

export function getSessionDbId(sessionId: string): number | null {
  const result = getDB().prepare("SELECT id FROM sessions WHERE opencode_session_id = ?").get(sessionId) as { id: number } | undefined;
  return result?.id ?? null;
}

export function markSessionCompleted(dbId: number): void {
  getDB().prepare("UPDATE sessions SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(dbId);
}

export function updateSessionPrompt(dbId: number, prompt: string): number {
  const database = getDB();
  const existing = database.prepare("SELECT first_user_prompt FROM sessions WHERE id = ?").get(dbId) as { first_user_prompt: string | null } | undefined;
  if (!existing?.first_user_prompt) {
    database.prepare("UPDATE sessions SET first_user_prompt = ?, updated_at = datetime('now') WHERE id = ?").run(prompt.slice(0, 500), dbId);
  }

  const count = database.prepare("SELECT COUNT(*) as n FROM user_prompts WHERE session_id = ?").get(dbId) as { n: number };
  const promptNumber = count.n + 1;
  database.prepare("INSERT INTO user_prompts (session_id, prompt_number, prompt) VALUES (?, ?, ?)").run(dbId, promptNumber, prompt.slice(0, 2000));

  database.prepare("INSERT INTO prompts_fts (id, prompt) VALUES (last_insert_rowid(), ?)").run(prompt.slice(0, 2000));

  return promptNumber;
}

export function getPromptCount(dbSessionId: number): number {
  const result = getDB().prepare(
    "SELECT COUNT(*) as n FROM user_prompts WHERE session_id = ?"
  ).get(dbSessionId) as { n: number };
  return result.n;
}

export function saveObservation(
  sessionDbId: number,
  toolName: string,
  toolInput: string,
  toolOutput: string,
  promptNumber = 0,
  redactionMeta?: string
): number {
  const database = getDB();
  const result = database.prepare(`
    INSERT INTO observations (session_id, tool_name, tool_input, tool_output, prompt_number, redaction_meta)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id
  `).get(sessionDbId, toolName, toolInput, toolOutput, promptNumber, redactionMeta ?? null) as { id: number };

  const outputSnippet = toolOutput.slice(0, 500);
  database.prepare("INSERT INTO observations_fts (id, tool_name, compressed_summary, files_referenced) VALUES (?, ?, ?, '')").run(result.id, toolName, outputSnippet);

  return result.id;
}

export function updateObservationSummary(
  obsId: number,
  summary: string,
  type: string,
  files: string[],
  concepts: string[]
): void {
  const database = getDB();
  const filesStr = files.join(", ");
  const conceptsStr = concepts.join(", ");

  database.prepare(`
    UPDATE observations SET
      compressed_summary = ?,
      observation_type = ?,
      files_referenced = ?,
      concepts = ?
    WHERE id = ?
  `).run(summary, type, filesStr, conceptsStr, obsId);

  try {
    database.prepare("DELETE FROM observations_fts WHERE id = ?").run(obsId);
    const row = database.prepare("SELECT tool_name FROM observations WHERE id = ?").get(obsId) as { tool_name: string } | undefined;
    database.prepare("INSERT INTO observations_fts (id, tool_name, compressed_summary, files_referenced) VALUES (?, ?, ?, ?)").run(
      obsId,
      row?.tool_name ?? "",
      summary,
      filesStr
    );
  } catch {}
}

export function getObservationById(id: number): {
  id: number; tool_name: string; tool_input: string; tool_output: string;
} | undefined {
  return getDB().prepare("SELECT id, tool_name, tool_input, tool_output FROM observations WHERE id = ?").get(id) as any;
}

export function getFullObservation(id: number): object | undefined {
  return getDB().prepare("SELECT * FROM observations WHERE id = ?").get(id) as any;
}

export function getFullObservations(ids: number[]): object[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return getDB().prepare(`SELECT * FROM observations WHERE id IN (${placeholders})`).all(...ids) as object[];
}

export function getRecentObservations(project: string, limit = 20): object[] {
  return getDB().prepare(`
    SELECT o.* FROM observations o
    JOIN sessions s ON o.session_id = s.id
    WHERE s.project = ? AND o.compressed_summary IS NOT NULL
    ORDER BY o.created_at DESC
    LIMIT ?
  `).all(project, limit) as object[];
}

export function queueCompression(obsId: number): void {
  getDB().prepare(
    "INSERT OR IGNORE INTO compression_queue (observation_id) VALUES (?)"
  ).run(obsId);
}

export function getPendingCompressionJobs(limit = 1): Array<{ id: number; observation_id: number; attempts: number }> {
  return getDB().prepare(`
    SELECT id, observation_id, attempts FROM compression_queue
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit) as any[];
}

export function updateCompressionJob(id: number, status: string, error?: string): void {
  getDB().prepare(`
    UPDATE compression_queue
    SET status = ?, error = ?, attempts = attempts + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, error ?? null, id);
}

export function resetFailedCompressionJobs(): void {
  getDB().prepare(`
    UPDATE compression_queue SET status = 'pending', updated_at = datetime('now')
    WHERE status = 'failed' AND attempts < 3
  `).run();
}

export function upsertConcepts(concepts: string[]): void {
  const database = getDB();
  for (const name of concepts) {
    database.prepare(`
      INSERT INTO concepts (name, frequency, last_seen) VALUES (?, 1, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET frequency = frequency + 1, last_seen = datetime('now')
    `).run(name);
  }
}

export function linkObservationConcepts(obsId: number, concepts: string[]): void {
  const database = getDB();
  for (const name of concepts) {
    const concept = database.prepare("SELECT id FROM concepts WHERE name = ?").get(name) as { id: number } | undefined;
    if (concept) {
      database.prepare("INSERT OR IGNORE INTO observation_concepts (observation_id, concept_id) VALUES (?, ?)").run(obsId, concept.id);
    }
  }
}

export function saveUserObservation(type: string, content: string, metadata?: Record<string, unknown>): void {
  const database = getDB();
  const existing = database.prepare("SELECT id FROM user_observations WHERE content = ?").get(content) as { id: number } | undefined;
  if (existing) {
    database.prepare("UPDATE user_observations SET access_count = access_count + 1, last_accessed = datetime('now') WHERE id = ?").run(existing.id);
    return;
  }
  const result = database.prepare(`
    INSERT INTO user_observations (observation_type, content, metadata) VALUES (?, ?, ?) RETURNING id
  `).get(type, content, metadata ? JSON.stringify(metadata) : null) as { id: number };

  database.prepare("INSERT INTO user_observations_fts (id, content) VALUES (?, ?)").run(result.id, content);
}

export function getUserObservations(limit = 10): object[] {
  return getDB().prepare(
    "SELECT * FROM user_observations ORDER BY access_count DESC, last_accessed DESC LIMIT ?"
  ).all(limit) as object[];
}

export function getStats(): {
  totalSessions: number;
  totalObservations: number;
  totalUserObservations: number;
  totalConcepts: number;
  pendingCompressions: number;
} {
  const database = getDB();
  return {
    totalSessions: (database.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number }).n,
    totalObservations: (database.prepare("SELECT COUNT(*) as n FROM observations").get() as { n: number }).n,
    totalUserObservations: (database.prepare("SELECT COUNT(*) as n FROM user_observations").get() as { n: number }).n,
    totalConcepts: (database.prepare("SELECT COUNT(*) as n FROM concepts").get() as { n: number }).n,
    pendingCompressions: (database.prepare("SELECT COUNT(*) as n FROM compression_queue WHERE status = 'pending'").get() as { n: number }).n,
  };
}

export function runGarbageCollection(maxAgeDays = 90): { observationsDeleted: number; sessionsDeleted: number } {
  const database = getDB();
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const obs = database.prepare("DELETE FROM observations WHERE created_at < ? AND compressed_summary IS NULL").run(cutoff);
  const sessions = database.prepare(`
    DELETE FROM sessions WHERE created_at < ?
    AND id NOT IN (SELECT DISTINCT session_id FROM observations)
  `).run(cutoff);

  return { observationsDeleted: obs.changes, sessionsDeleted: sessions.changes };
}

export interface ExportOptions {
  project?: string;
  days?: number;
  format?: "json" | "markdown";
  includeRaw?: boolean;
}

export interface ExportData {
  exported_at: string;
  version: string;
  options: ExportOptions;
  sessions: object[];
  observations: object[];
  userObservations: object[];
  concepts: object[];
}

export function exportMemory(opts: ExportOptions = {}): ExportData {
  const database = getDB();
  const { project, days, includeRaw = false } = opts;

  const cutoff = days
    ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const sessionWhere = [
    project ? "project = ?" : null,
    cutoff ? "created_at >= ?" : null,
  ].filter(Boolean).join(" AND ");

  const sessionParams = [
    project,
    cutoff,
  ].filter(Boolean);

  const sessions = database.prepare(
    `SELECT * FROM sessions${sessionWhere ? ` WHERE ${sessionWhere}` : ""} ORDER BY created_at DESC`
  ).all(...sessionParams) as object[];

  const sessionIds = sessions.map((s: any) => s.id);
  const obsWhere = sessionIds.length > 0
    ? `session_id IN (${sessionIds.map(() => "?").join(",")})`
    : "1=0";

  let observations = database.prepare(
    `SELECT id, session_id, tool_name, ${includeRaw ? "tool_input, tool_output," : ""} compressed_summary, observation_type, files_referenced, concepts, created_at FROM observations WHERE ${obsWhere}${cutoff ? " AND created_at >= ?" : ""} ORDER BY created_at DESC`
  ).all(...sessionIds, ...(cutoff ? [cutoff] : [])) as object[];

  const userObsWhere = cutoff ? "WHERE created_at >= ?" : "";
  const userObservations = database.prepare(
    `SELECT id, observation_type, content, metadata, created_at FROM user_observations ${userObsWhere} ORDER BY created_at DESC`
  ).all(...(cutoff ? [cutoff] : [])) as object[];

  const concepts = database.prepare(
    "SELECT name, frequency, last_seen FROM concepts ORDER BY frequency DESC LIMIT 100"
  ).all() as object[];

  return {
    exported_at: new Date().toISOString(),
    version: VERSION,
    options: opts,
    sessions,
    observations,
    userObservations,
    concepts,
  };
}