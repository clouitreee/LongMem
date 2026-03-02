import { getDB } from "./db.ts";

// ─── Stopwords for topic change detection ────────────────────────────────────

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "don", "now", "and", "but", "or", "nor", "if", "that", "this",
  "what", "which", "who", "whom", "me", "my", "he", "she", "it", "we",
  "they", "you", "your", "his", "her", "its", "our", "their", "them",
  // Common vague prompts
  "hola", "hello", "hi", "hey", "thanks", "thank", "please", "ok",
  "okay", "yes", "no", "continua", "continue", "sigue", "dale", "go",
]);

// ─── Topic Change Detection ──────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-záéíóúñü0-9\s_-]/g, " ")
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t))
  );
}

// Returns true if the current prompt is semantically different from recent prompts
export function detectTopicChange(currentPrompt: string, recentPrompts: string[]): boolean {
  if (recentPrompts.length === 0) return true; // First prompt — always inject

  const curTokens = tokenize(currentPrompt);
  if (curTokens.size === 0) return true; // Vague prompt — inject project context

  const prevTokens = new Set(recentPrompts.flatMap(p => [...tokenize(p)]));
  if (prevTokens.size === 0) return true;

  const overlap = [...curTokens].filter(t => prevTokens.has(t)).length;
  return overlap / curTokens.size < 0.2; // <20% overlap = topic changed
}

// Returns true if the prompt is too vague for a text-based search
export function isVaguePrompt(text: string): boolean {
  const tokens = tokenize(text);
  return tokens.size < 2;
}

// ─── Session Prompt History ──────────────────────────────────────────────────

export function getRecentSessionPrompts(dbSessionId: number, limit = 3): string[] {
  const database = getDB();
  const rows = database.prepare(
    "SELECT prompt FROM user_prompts WHERE session_id = ? ORDER BY prompt_number DESC LIMIT ?"
  ).all(dbSessionId, limit) as { prompt: string }[];
  return rows.map(r => r.prompt);
}

// ─── Project-Aware Context Search ────────────────────────────────────────────

// Combined search: observations + user_observations + sessions, scored by project + recency
export function searchProjectContext(
  query: string,
  project: string,
  limit = 5,
): { observations: SearchResult[]; userKnowledge: object[]; sessions: object[] } {
  const observations = query && !isVaguePrompt(query)
    ? searchObservations(query, project, limit)
    : getRecentObservationsWithDecay(project, limit);

  const userKnowledge = query && !isVaguePrompt(query)
    ? searchUserObservations(query, limit)
    : getRecentUserObservations(project, limit);

  // Get recent sessions for this project (for "what was I doing" context)
  const sessions = getRecentProjectSessions(project, 3);

  return { observations, userKnowledge, sessions };
}

// Recent user observations filtered by project metadata if possible
function getRecentUserObservations(project: string, limit = 5): object[] {
  const database = getDB();
  // Try project-specific first, fall back to all
  const projectResults = database.prepare(
    "SELECT * FROM user_observations WHERE metadata LIKE ? ORDER BY access_count DESC, last_accessed DESC LIMIT ?"
  ).all(`%${project}%`, limit) as object[];

  if (projectResults.length >= 2) return projectResults;

  // Fall back to most accessed
  return database.prepare(
    "SELECT * FROM user_observations ORDER BY access_count DESC, last_accessed DESC LIMIT ?"
  ).all(limit) as object[];
}

// Recent sessions for a project
function getRecentProjectSessions(project: string, limit = 3): object[] {
  const database = getDB();
  return database.prepare(`
    SELECT id, opencode_session_id, project, first_user_prompt, status, created_at
    FROM sessions WHERE project = ? AND first_user_prompt IS NOT NULL
    ORDER BY created_at DESC LIMIT ?
  `).all(project, limit) as object[];
}

// ─── Format Context Block ────────────────────────────────────────────────────

export function formatContextBlock(
  searchResults: { observations: SearchResult[]; userKnowledge: object[]; sessions: object[] },
  project: string,
): string {
  const lines: string[] = [];

  // Sessions — what was done recently in this project
  const sessions = searchResults.sessions as any[];
  if (sessions.length > 0) {
    lines.push(`Recent sessions in "${project}":`);
    for (const s of sessions) {
      const date = s.created_at?.slice(0, 10) || "";
      const prompt = (s.first_user_prompt || "").slice(0, 100);
      lines.push(`  [${date}] ${prompt}`);
    }
    lines.push("");
  }

  // Observations — relevant tool executions
  const obs = searchResults.observations.filter((o: any) => o.compressed_summary);
  if (obs.length > 0) {
    lines.push("Relevant memories:");
    for (const o of obs) {
      const date = o.created_at?.slice(0, 10) || "";
      const summary = (o.compressed_summary || "").slice(0, 150);
      const files = o.files_referenced ? ` [${o.files_referenced}]` : "";
      lines.push(`  [${date}] ${o.tool_name}: ${summary}${files}`);
    }
    lines.push("");
  }

  // User knowledge — ecosystem files, CLAUDE.md, etc.
  const knowledge = searchResults.userKnowledge as any[];
  if (knowledge.length > 0) {
    lines.push("Project knowledge:");
    for (const k of knowledge) {
      let label = "";
      try {
        const meta = JSON.parse(k.metadata || "{}");
        label = meta.source || meta.path || "";
      } catch {}
      const snippet = (k.content || "").slice(0, 200).replace(/\n/g, " ");
      lines.push(`  ${label ? `[${label}] ` : ""}${snippet}`);
    }
    lines.push("");
  }

  if (lines.length === 0) return "";

  return `<longmem-context>\n${lines.join("\n")}\n</longmem-context>`;
}

// ─── Types & Existing Functions ──────────────────────────────────────────────

export interface SearchResult {
  id: number;
  session_id: number;
  tool_name: string;
  compressed_summary: string;
  files_referenced: string | null;
  created_at: string;
  rank: number;
  weighted_rank: number;
}

export function searchObservations(query: string, project?: string, limit = 10): SearchResult[] {
  const database = getDB();

  const searchTerms = query
    .split(/\s+/)
    .filter(t => t.length > 1)
    .map(t => `${t.replace(/['"*]/g, "")}*`)
    .join(" OR ");

  if (!searchTerms) return getRecentObservationsWithDecay(project || "", limit);

  try {
    if (project) {
      return database.prepare(`
        SELECT o.id, o.session_id, o.tool_name, o.compressed_summary,
               o.files_referenced, o.created_at,
               bm25(observations_fts) as rank,
               bm25(observations_fts) * (1.0 + 1.0/(1.0 + julianday('now') - julianday(o.created_at))) as weighted_rank
        FROM observations_fts
        JOIN observations o ON observations_fts.rowid = o.id
        JOIN sessions s ON o.session_id = s.id
        WHERE observations_fts MATCH ? AND s.project = ?
        ORDER BY weighted_rank DESC
        LIMIT ?
      `).all(searchTerms, project, limit) as SearchResult[];
    }
    return database.prepare(`
      SELECT o.id, o.session_id, o.tool_name, o.compressed_summary,
             o.files_referenced, o.created_at,
             bm25(observations_fts) as rank,
             bm25(observations_fts) * (1.0 + 1.0/(1.0 + julianday('now') - julianday(o.created_at))) as weighted_rank
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
      ORDER BY weighted_rank DESC
      LIMIT ?
    `).all(searchTerms, limit) as SearchResult[];
  } catch {
    return getRecentObservationsWithDecay(project || "", limit);
  }
}

export function getRecentObservationsWithDecay(project: string, limit = 10): SearchResult[] {
  const database = getDB();
  if (project) {
    return database.prepare(`
      SELECT o.id, o.session_id, o.tool_name, o.compressed_summary,
             o.files_referenced, o.created_at, 0 as rank,
             (1.0 + 1.0/(1.0 + julianday('now') - julianday(o.created_at))) as weighted_rank
      FROM observations o
      JOIN sessions s ON o.session_id = s.id
      WHERE s.project = ?
      ORDER BY weighted_rank DESC
      LIMIT ?
    `).all(project, limit) as SearchResult[];
  }
  return database.prepare(`
    SELECT o.id, o.session_id, o.tool_name, o.compressed_summary,
           o.files_referenced, o.created_at, 0 as rank,
           (1.0 + 1.0/(1.0 + julianday('now') - julianday(o.created_at))) as weighted_rank
    FROM observations o
    ORDER BY weighted_rank DESC
    LIMIT ?
  `).all(limit) as SearchResult[];
}

export function searchSessions(query: string, project?: string, limit = 10): object[] {
  const database = getDB();
  const pattern = `%${query}%`;
  if (project) {
    return database.prepare(`
      SELECT id, opencode_session_id, project, first_user_prompt, status, created_at
      FROM sessions WHERE first_user_prompt LIKE ? AND project = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(pattern, project, limit) as object[];
  }
  return database.prepare(`
    SELECT id, opencode_session_id, project, first_user_prompt, status, created_at
    FROM sessions WHERE first_user_prompt LIKE ?
    ORDER BY created_at DESC LIMIT ?
  `).all(pattern, limit) as object[];
}

export function searchUserObservations(query: string, limit = 10): object[] {
  const database = getDB();
  const searchTerms = query.split(/\s+/).filter(t => t.length > 1).map(t => `${t}*`).join(" OR ");
  if (!searchTerms) {
    return database.prepare("SELECT * FROM user_observations ORDER BY access_count DESC LIMIT ?").all(limit) as object[];
  }
  try {
    return database.prepare(`
      SELECT uo.* FROM user_observations_fts
      JOIN user_observations uo ON user_observations_fts.rowid = uo.id
      WHERE user_observations_fts MATCH ?
      ORDER BY bm25(user_observations_fts) DESC
      LIMIT ?
    `).all(searchTerms, limit) as object[];
  } catch {
    return [];
  }
}

export function getTimeline(obsId: number, before = 3, after = 3): {
  before: object[]; target: object | null; after: object[];
} {
  const database = getDB();

  const target = database.prepare("SELECT * FROM observations WHERE id = ?").get(obsId) as any;
  if (!target) return { before: [], target: null, after: [] };

  const beforeObs = database.prepare(`
    SELECT o.id, o.tool_name, o.compressed_summary, o.files_referenced, o.created_at
    FROM observations o
    WHERE o.session_id = ? AND o.id < ?
    ORDER BY o.id DESC LIMIT ?
  `).all(target.session_id, obsId, before) as object[];

  const afterObs = database.prepare(`
    SELECT o.id, o.tool_name, o.compressed_summary, o.files_referenced, o.created_at
    FROM observations o
    WHERE o.session_id = ? AND o.id > ?
    ORDER BY o.id ASC LIMIT ?
  `).all(target.session_id, obsId, after) as object[];

  return { before: beforeObs.reverse(), target, after: afterObs };
}
