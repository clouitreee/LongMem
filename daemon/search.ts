import { getDB } from "./db.ts";

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
