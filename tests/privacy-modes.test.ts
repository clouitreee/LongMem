import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  redactSecrets,
  extractPathHint,
  isExcludedPath,
  containsHighRiskPattern,
  compileCustomPatterns,
  redactWithCustomPatterns,
} from "../shared/privacy.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "longmem-privacy-test-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }); } catch {}
});

// ─── T1: Persist gate — canary secrets never raw in DB (safe mode) ───────────

describe("T1: persist gate — redactSecrets catches all canary patterns", () => {
  const canaries: Array<{ name: string; secret: string; safe: string }> = [
    { name: "OpenRouter key",    secret: "sk-or-v1-abcdef1234567890abcdef1234567890", safe: "[REDACTED]" },
    { name: "Anthropic key",     secret: "sk-ant-abcdef1234567890abcdef1234567890",   safe: "[REDACTED]" },
    { name: "OpenAI key",        secret: "sk-abcdef1234567890abcdef1234567890",        safe: "[REDACTED]" },
    { name: "GCP API key",       secret: "AIzaSyB1234567890abcdefghijklmnopqrstuvw",   safe: "[REDACTED]" },
    { name: "GitHub PAT",        secret: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",   safe: "[REDACTED]" },
    { name: "GitLab PAT",        secret: "glpat-abcdefghij1234567890",                 safe: "[REDACTED]" },
    { name: "Stripe secret",     secret: "sk_live_abcdefghij1234567890",               safe: "[REDACTED]" },
    { name: "SendGrid key",      secret: "SG." + "x".repeat(22) + "." + "y".repeat(43), safe: "[REDACTED]" },
    { name: "npm token",         secret: "npm_abcdefghijklmnopqrstuvwxyz1234567890",   safe: "[REDACTED]" },
    { name: "AWS access key",    secret: "AKIAIOSFODNN7EXAMPLE",                       safe: "[REDACTED]" },
    { name: "JWT",               secret: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", safe: "[REDACTED]" },
    { name: "DB connection",     secret: "postgres://admin:s3cretpass@db.example.com:5432/mydb", safe: "[REDACTED]" },
    { name: "Azure connection",  secret: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=abc123def456ghi789", safe: "[REDACTED]" },
    { name: "generic secret",    secret: 'api_key = "sk-super-secret-value-here"',     safe: "[REDACTED]" },
  ];

  for (const { name, secret, safe } of canaries) {
    test(`redacts ${name}`, () => {
      const input = `some text before ${secret} and after`;
      const result = redactSecrets(input);
      expect(result).not.toContain(secret);
      expect(result).toContain(safe);
    });
  }

  test("PEM private key is redacted", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB
-----END RSA PRIVATE KEY-----`;
    const result = redactSecrets(`config: ${pem} done`);
    expect(result).not.toContain("MIIEowIBAAK");
    expect(result).toContain("[REDACTED]");
  });

  test("non-secrets are NOT redacted", () => {
    const safe = "This is a normal log message with file src/auth.ts and port 3000";
    expect(redactSecrets(safe)).toBe(safe);
  });
});

// ─── T2: Egress gate — sdk.compress never receives canary secret ─────────────

describe("T2: egress gate — re-sanitize before LLM", () => {
  test("redactSecrets catches secret that somehow ended up in DB raw", () => {
    // Simulate: a secret bypassed the persist gate (e.g. privacy was off,
    // then user switched to safe mode). The egress gate must still catch it.
    const rawFromDb = "Database result: postgres://admin:hunter2@db.prod.internal:5432/users";
    const afterEgress = redactSecrets(rawFromDb);
    expect(afterEgress).not.toContain("hunter2");
    expect(afterEgress).not.toContain("postgres://admin");
    expect(afterEgress).toContain("[REDACTED]");
  });

  test("containsHighRiskPattern detects PEM key", () => {
    expect(containsHighRiskPattern("-----BEGIN RSA PRIVATE KEY-----\nMIIE...")).toBe(true);
  });

  test("containsHighRiskPattern detects JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(containsHighRiskPattern(jwt)).toBe(true);
  });

  test("containsHighRiskPattern detects AWS key", () => {
    expect(containsHighRiskPattern("access key: AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  test("containsHighRiskPattern detects DB connection with password", () => {
    expect(containsHighRiskPattern("mysql://root:pass123@localhost/db")).toBe(true);
  });

  test("containsHighRiskPattern returns false for safe text", () => {
    expect(containsHighRiskPattern("Just a normal log line about auth.ts")).toBe(false);
  });

  test("custom patterns redact additional secrets", () => {
    const compiled = compileCustomPatterns([
      { pattern: "MYTOKEN-[a-z]{10,}", name: "internal-token" },
    ]);
    expect(compiled.length).toBe(1);
    const result = redactWithCustomPatterns("auth: MYTOKEN-abcdefghij done", compiled);
    expect(result).not.toContain("MYTOKEN-abcdefghij");
    expect(result).toContain("[REDACTED]");
  });

  test("compileCustomPatterns rejects dangerous wildcards", () => {
    const compiled = compileCustomPatterns([
      { pattern: ".*", name: "too-broad" },
      { pattern: ".+", name: "also-broad" },
      { pattern: "ab", name: "too-short" },
      { pattern: "valid-[0-9]{4}", name: "ok" },
    ]);
    expect(compiled.length).toBe(1); // only "ok" survives
  });
});

// ─── T3: Path denylist — Read .env saves metadata-only ───────────────────────

describe("T3: path denylist — excludePaths", () => {
  const defaultExcludes = [".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_rsa.*"];

  test("exact .env is excluded", () => {
    expect(isExcludedPath("/app/.env", defaultExcludes)).toBe(true);
  });

  test(".env.production is excluded by .env.* glob", () => {
    expect(isExcludedPath("/app/.env.production", defaultExcludes)).toBe(true);
  });

  test(".env.local is excluded", () => {
    expect(isExcludedPath("/home/user/project/.env.local", defaultExcludes)).toBe(true);
  });

  test("server.pem is excluded by *.pem glob", () => {
    expect(isExcludedPath("/certs/server.pem", defaultExcludes)).toBe(true);
  });

  test("private.key is excluded by *.key glob", () => {
    expect(isExcludedPath("/ssl/private.key", defaultExcludes)).toBe(true);
  });

  test("id_rsa is excluded", () => {
    expect(isExcludedPath("/home/user/.ssh/id_rsa", defaultExcludes)).toBe(true);
  });

  test("id_rsa.pub is excluded by id_rsa.* glob", () => {
    expect(isExcludedPath("/home/user/.ssh/id_rsa.pub", defaultExcludes)).toBe(true);
  });

  test("normal source files are NOT excluded", () => {
    expect(isExcludedPath("/app/src/auth.ts", defaultExcludes)).toBe(false);
    expect(isExcludedPath("/app/package.json", defaultExcludes)).toBe(false);
    expect(isExcludedPath("/app/README.md", defaultExcludes)).toBe(false);
  });

  test("extractPathHint gets file_path from tool input", () => {
    expect(extractPathHint('{"file_path":"/app/.env"}')).toBe("/app/.env");
    expect(extractPathHint('{"path":"/ssl/cert.pem"}')).toBe("/ssl/cert.pem");
  });

  test("extractPathHint gets path from bash cat command", () => {
    expect(extractPathHint('{"command":"cat /app/.env"}')).toBe("/app/.env");
    expect(extractPathHint('{"command":"head -5 /secrets/db.key"}')).toBe("/secrets/db.key");
  });

  test("extractPathHint returns null for non-file commands", () => {
    expect(extractPathHint('{"command":"npm install"}')).toBeNull();
    expect(extractPathHint('{}')).toBeNull();
  });
});

// ─── T4: Legacy compat + mode none warning ───────────────────────────────────

describe("T4: config backward compatibility + mode inference", () => {
  // We test the loadConfig logic by simulating the config resolution

  function resolveMode(userConfig: Record<string, unknown>): string {
    const privacy = (userConfig.privacy || {}) as Record<string, unknown>;
    // This mirrors the logic in daemon/config.ts loadConfig()
    if (!privacy.mode) {
      return (privacy.redactSecrets !== false) ? "safe" : "none";
    }
    const mode = String(privacy.mode);
    return ["safe", "flexible", "none"].includes(mode) ? mode : "safe";
  }

  test("no mode + redactSecrets:true → safe", () => {
    expect(resolveMode({ privacy: { redactSecrets: true } })).toBe("safe");
  });

  test("no mode + no redactSecrets → safe (default)", () => {
    expect(resolveMode({ privacy: {} })).toBe("safe");
  });

  test("no privacy section at all → safe", () => {
    expect(resolveMode({})).toBe("safe");
  });

  test("no mode + redactSecrets:false → none", () => {
    expect(resolveMode({ privacy: { redactSecrets: false } })).toBe("none");
  });

  test("explicit mode:flexible is preserved", () => {
    expect(resolveMode({ privacy: { mode: "flexible" } })).toBe("flexible");
  });

  test("invalid mode falls back to safe", () => {
    expect(resolveMode({ privacy: { mode: "yolo" } })).toBe("safe");
  });

  test("mode:none is explicitly settable", () => {
    expect(resolveMode({ privacy: { mode: "none" } })).toBe("none");
  });

  test("mode none → stripAllMemoryTags still works (<private> always active)", () => {
    // Even in mode "none", <private> tags must be stripped
    const { stripAllMemoryTags } = require("../shared/privacy.ts");
    const input = "before <private>secret stuff</private> after";
    const result = stripAllMemoryTags(input);
    expect(result).not.toContain("secret stuff");
    expect(result).toContain("before");
    expect(result).toContain("after");
  });
});
