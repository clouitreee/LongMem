import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  searchSessionPrimer, formatPrimerBlock, isVaguePrompt,
  detectTopicChange,
  type PrimerEntry,
} from "../daemon/search.ts";
import {
  getDB, runMigrations, createSession, saveObservation,
  updateObservationSummary, updateSessionPrompt, getPromptCount,
} from "../daemon/db.ts";
import {
  redactSecrets, containsHighRiskPattern,
} from "../shared/privacy.ts";

// ─── Test DB setup ────────────────────────────────────────────────────────────

let dbSessionId: number;
const PROJECT = "test-project";

beforeAll(() => {
  // Initialize DB in temp dir (uses the singleton — first call wins)
  const tmpDir = mkdtempSync(join(tmpdir(), "longmem-primer-test-"));
  const dbPath = join(tmpDir, "test.db");
  getDB(dbPath);
  runMigrations();

  // Create a session with some observations that have compressed summaries
  dbSessionId = createSession("test-session-1", PROJECT, "/tmp/test")!;

  // Insert observations with compressed summaries (simulating post-compression)
  const obs1 = saveObservation(dbSessionId, "Read", '{"file_path":"/app/auth.ts"}', "export function login()...", 1);
  updateObservationSummary(obs1, "Read auth.ts — login function with JWT validation", "code_read", ["auth.ts"], ["authentication", "jwt"]);

  const obs2 = saveObservation(dbSessionId, "Edit", '{"file_path":"/app/db.ts"}', "Updated connection pool", 2);
  updateObservationSummary(obs2, "Edit db.ts — increased connection pool size from 5 to 20", "code_edit", ["db.ts"], ["database", "performance"]);

  const obs3 = saveObservation(dbSessionId, "Bash", '{"command":"npm test"}', "15 passing, 0 failing", 3);
  updateObservationSummary(obs3, "Ran test suite — all 15 tests passing", "command", [], ["testing"]);

  const obs4 = saveObservation(dbSessionId, "Read", '{"file_path":"/app/api/routes.ts"}', "export const routes = ...", 4);
  updateObservationSummary(obs4, "Read API routes — 12 endpoints, REST pattern with Express", "code_read", ["api/routes.ts"], ["api", "express"]);

  const obs5 = saveObservation(dbSessionId, "Edit", '{"file_path":"/app/config.ts"}', "Updated config", 5);
  updateObservationSummary(obs5, "Edit config.ts — added Redis cache configuration", "code_edit", ["config.ts"], ["configuration", "redis"]);

  // One observation WITHOUT summary (should be excluded from primer)
  saveObservation(dbSessionId, "Read", '{"file_path":"/app/index.ts"}', "import stuff...", 6);
});

// ─── T1: searchSessionPrimer — FTS search with concrete query ────────────────

describe("T1: searchSessionPrimer — FTS search", () => {
  test("concrete query returns relevant results via FTS", () => {
    const results = searchSessionPrimer("authentication JWT login", PROJECT, 5);
    expect(results.length).toBeGreaterThan(0);
    // auth.ts observation should rank high
    const hasAuth = results.some(r => r.compressed_summary.includes("auth.ts"));
    expect(hasAuth).toBe(true);
  });

  test("FTS results only contain compressed_summary (never raw input/output)", () => {
    const results = searchSessionPrimer("database connection pool", PROJECT, 5);
    for (const r of results) {
      expect(r).toHaveProperty("compressed_summary");
      expect(r).toHaveProperty("tool_name");
      expect(r).toHaveProperty("created_at");
      // Must NOT have raw tool_input or tool_output
      expect(r).not.toHaveProperty("tool_input");
      expect(r).not.toHaveProperty("tool_output");
    }
  });

  test("FTS respects limit parameter", () => {
    const results = searchSessionPrimer("test", PROJECT, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("results are scoped to the correct project", () => {
    // Create a session for a different project
    const otherSession = createSession("other-project-session", "other-project", "/tmp/other")!;
    const obs = saveObservation(otherSession, "Read", '{}', "other content", 1);
    updateObservationSummary(obs, "Read something in other project", "code_read", [], []);

    // Search in test-project should NOT return other-project results
    const results = searchSessionPrimer("other project", PROJECT, 10);
    const hasOther = results.some(r => r.compressed_summary.includes("other project"));
    expect(hasOther).toBe(false);
  });
});

// ─── T2: searchSessionPrimer — recency fallback for vague queries ────────────

describe("T2: searchSessionPrimer — recency fallback", () => {
  test("vague/empty query falls back to recency", () => {
    const results = searchSessionPrimer("", PROJECT, 5);
    expect(results.length).toBeGreaterThan(0);
    // All should have compressed_summary (null/empty excluded)
    for (const r of results) {
      expect(r.compressed_summary).toBeTruthy();
    }
  });

  test("isVaguePrompt detects vague inputs", () => {
    expect(isVaguePrompt("hello")).toBe(true);
    expect(isVaguePrompt("hi")).toBe(true);
    expect(isVaguePrompt("continue")).toBe(true);
    expect(isVaguePrompt("")).toBe(true);
  });

  test("isVaguePrompt allows concrete inputs", () => {
    expect(isVaguePrompt("fix the authentication bug in login")).toBe(false);
    expect(isVaguePrompt("add Redis caching to the API routes")).toBe(false);
  });

  test("recency results ordered by created_at DESC", () => {
    const results = searchSessionPrimer("", PROJECT, 5);
    if (results.length >= 2) {
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].created_at >= results[i + 1].created_at).toBe(true);
      }
    }
  });

  test("observations without compressed_summary are excluded", () => {
    const results = searchSessionPrimer("", PROJECT, 20);
    for (const r of results) {
      expect(r.compressed_summary).not.toBe("");
      expect(r.compressed_summary).not.toBeNull();
    }
  });
});

// ─── T3: formatPrimerBlock — output format and token truncation ──────────────

describe("T3: formatPrimerBlock — formatting", () => {
  const entries: PrimerEntry[] = [
    { id: 1, tool_name: "Read", compressed_summary: "Read auth.ts — login function", files_referenced: "auth.ts", created_at: "2026-03-01 10:00:00" },
    { id: 2, tool_name: "Edit", compressed_summary: "Edit db.ts — connection pool", files_referenced: "db.ts", created_at: "2026-03-01 10:05:00" },
    { id: 3, tool_name: "Bash", compressed_summary: "Ran tests — 15 passing", files_referenced: null, created_at: "2026-03-01 10:10:00" },
  ];

  test("block is wrapped in <longmem-context> tags", () => {
    const block = formatPrimerBlock(entries, PROJECT, 500);
    expect(block).not.toBeNull();
    expect(block!).toStartWith("<longmem-context>");
    expect(block!).toEndWith("</longmem-context>");
  });

  test("block contains project header", () => {
    const block = formatPrimerBlock(entries, PROJECT, 500)!;
    expect(block).toContain(`Recent work in "${PROJECT}":`);
  });

  test("block contains entry summaries with dates", () => {
    const block = formatPrimerBlock(entries, PROJECT, 500)!;
    expect(block).toContain("[2026-03-01]");
    expect(block).toContain("Read:");
    expect(block).toContain("auth.ts");
    expect(block).toContain("Edit:");
    expect(block).toContain("connection pool");
  });

  test("block includes files_referenced when present", () => {
    const block = formatPrimerBlock(entries, PROJECT, 500)!;
    expect(block).toContain("[auth.ts]");
    expect(block).toContain("[db.ts]");
  });

  test("token truncation respects maxTokens limit", () => {
    // Use a very small token limit — should truncate entries
    const block = formatPrimerBlock(entries, PROJECT, 50);
    // 50 tokens ≈ 66 chars — only header + maybe 1 entry
    if (block) {
      const estimatedTokens = block.length * 0.75;
      expect(estimatedTokens).toBeLessThanOrEqual(80); // some slack for tags
    }
  });

  test("truncation drops later entries, not earlier ones", () => {
    // Small limit: should keep first entry but drop later ones
    const block = formatPrimerBlock(entries, PROJECT, 100);
    if (block) {
      expect(block).toContain("auth.ts"); // first entry kept
    }
  });
});

// ─── T4: formatPrimerBlock — empty/null edge cases ──────────────────────────

describe("T4: formatPrimerBlock — edge cases", () => {
  test("returns null for empty entries array", () => {
    const block = formatPrimerBlock([], PROJECT, 500);
    expect(block).toBeNull();
  });

  test("returns null when maxTokens too small for any entry", () => {
    const entries: PrimerEntry[] = [
      { id: 1, tool_name: "Read", compressed_summary: "Read a very long file with lots of details about the implementation", files_referenced: "very-long-file.ts", created_at: "2026-03-01 10:00:00" },
    ];
    // 5 tokens ≈ 6 chars — not enough for header + entry
    const block = formatPrimerBlock(entries, PROJECT, 5);
    expect(block).toBeNull();
  });

  test("handles entries with null files_referenced", () => {
    const entries: PrimerEntry[] = [
      { id: 1, tool_name: "Bash", compressed_summary: "Ran npm install", files_referenced: null, created_at: "2026-03-01 10:00:00" },
    ];
    const block = formatPrimerBlock(entries, PROJECT, 500)!;
    expect(block).toContain("Ran npm install");
    expect(block).not.toContain("[null]");
  });
});

// ─── T5: Safety — sanitize + quarantine on injected block ────────────────────

describe("T5: safety — primer block sanitization", () => {
  test("redactSecrets strips secrets from compressed_summary", () => {
    // If a compressed_summary somehow contains a secret, redactSecrets catches it
    const entries: PrimerEntry[] = [
      { id: 1, tool_name: "Read", compressed_summary: "Read .env — found API key sk-ant-abcdef1234567890abcdef1234567890", files_referenced: ".env", created_at: "2026-03-01 10:00:00" },
    ];
    const block = formatPrimerBlock(entries, PROJECT, 500)!;
    const sanitized = redactSecrets(block);
    expect(sanitized).not.toContain("sk-ant-abcdef1234567890");
    expect(sanitized).toContain("[REDACTED]");
  });

  test("containsHighRiskPattern detects PEM in block", () => {
    const block = `<longmem-context>
Recent work in "test":
  [2026-03-01] Read: Found -----BEGIN RSA PRIVATE KEY----- MIIEowIBAAK
</longmem-context>`;
    expect(containsHighRiskPattern(block)).toBe(true);
  });

  test("containsHighRiskPattern detects JWT in block", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const block = `<longmem-context>\nRecent work in "test":\n  [2026-03-01] Read: Found token ${jwt}\n</longmem-context>`;
    expect(containsHighRiskPattern(block)).toBe(true);
  });

  test("safe block passes both checks", () => {
    const entries: PrimerEntry[] = [
      { id: 1, tool_name: "Read", compressed_summary: "Read auth.ts — login function with password hashing", files_referenced: "auth.ts", created_at: "2026-03-01 10:00:00" },
    ];
    const block = formatPrimerBlock(entries, PROJECT, 500)!;
    const sanitized = redactSecrets(block);
    expect(sanitized).toBe(block); // No changes — no secrets
    expect(containsHighRiskPattern(block)).toBe(false);
  });
});

// ─── T6: getPromptCount + first-prompt detection ─────────────────────────────

describe("T6: prompt count and first-prompt detection", () => {
  test("new session has promptCount 0", () => {
    const newSession = createSession("primer-count-test", PROJECT, "/tmp/test")!;
    expect(getPromptCount(newSession)).toBe(0);
  });

  test("after saving prompt, count increments", () => {
    const session = createSession("primer-count-test-2", PROJECT, "/tmp/test")!;
    expect(getPromptCount(session)).toBe(0);

    updateSessionPrompt(session, "first prompt");
    expect(getPromptCount(session)).toBe(1);

    updateSessionPrompt(session, "second prompt");
    expect(getPromptCount(session)).toBe(2);
  });
});

// ─── T7: Topic change detection (subsequent prompts) ─────────────────────────

describe("T7: topic change detection for subsequent prompts", () => {
  test("first prompt always triggers (empty history)", () => {
    expect(detectTopicChange("fix the login bug", [])).toBe(true);
  });

  test("same topic does NOT trigger", () => {
    expect(detectTopicChange("fix the login validation", ["fix the login bug"])).toBe(false);
  });

  test("different topic triggers", () => {
    expect(detectTopicChange("add Redis caching to API", ["fix the login bug"])).toBe(true);
  });

  test("vague prompt triggers (empty tokens)", () => {
    expect(detectTopicChange("ok", ["fix the login bug"])).toBe(true);
  });
});
