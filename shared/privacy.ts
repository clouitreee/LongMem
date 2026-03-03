import { realpathSync } from "fs";

const PRIVATE_REGEX = /<private>[\s\S]*?<\/private>/gi;
const CONTEXT_REGEX = /<longmem-context>[\s\S]*?<\/longmem-context>/gi;

// ─── Tag stripping ───────────────────────────────────────────────────────────

export function stripAllMemoryTags(text: string): string {
  if (!text) return text;
  return text
    .replace(new RegExp(PRIVATE_REGEX.source, "gi"), "")
    .replace(new RegExp(CONTEXT_REGEX.source, "gi"), "")
    .trim();
}

export function isFullyPrivate(text: string): boolean {
  if (!text) return false;
  const stripped = stripAllMemoryTags(text);
  return stripped.trim().length === 0 && /<private>/i.test(text);
}

// ─── Truncation ──────────────────────────────────────────────────────────────

export function truncateInput(text: string, maxSize = 4096): string {
  if (!text || text.length <= maxSize) return text;
  return text.slice(0, maxSize) + `\n...[truncated ${text.length - maxSize} chars]`;
}

export function truncateOutput(text: string, maxSize = 8192): string {
  if (!text || text.length <= maxSize) return text;
  return text.slice(0, maxSize) + `\n...[truncated ${text.length - maxSize} chars]`;
}

// ─── Secret redaction ────────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  // ── Cloud provider keys ──
  { pattern: /sk-or-v1-[a-zA-Z0-9\-_]{20,}/g,     name: "openrouter-key" },
  { pattern: /sk-ant-[a-zA-Z0-9\-_]{20,}/g,        name: "anthropic-key" },
  { pattern: /sk-[a-zA-Z0-9\-_]{20,}/g,            name: "openai-key" },
  { pattern: /AIza[0-9A-Za-z\-_]{35}/g,            name: "gcp-api-key" },
  { pattern: /sk_live_[a-zA-Z0-9]{20,}/g,          name: "stripe-secret" },
  { pattern: /rk_live_[a-zA-Z0-9]{20,}/g,          name: "stripe-restricted" },
  { pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g, name: "sendgrid-key" },
  { pattern: /SK[a-f0-9]{32}/g,                    name: "twilio-key" },
  { pattern: /npm_[a-zA-Z0-9]{36}/g,               name: "npm-token" },

  // ── VCS tokens ──
  { pattern: /ghp_[a-zA-Z0-9]{36}/g,               name: "github-pat" },
  { pattern: /gho_[a-zA-Z0-9]{36}/g,               name: "github-oauth" },
  { pattern: /ghs_[a-zA-Z0-9]{36}/g,               name: "github-app" },
  { pattern: /glpat-[a-zA-Z0-9\-_]{20,}/g,         name: "gitlab-pat" },

  // ── Chat/messaging tokens ──
  { pattern: /xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+/g,  name: "slack-bot-token" },
  { pattern: /xoxp-[0-9]+-[0-9]+-[a-zA-Z0-9]+/g,  name: "slack-user-token" },

  // ── Cloud infra ──
  { pattern: /[A-Z0-9]{20}:[A-Za-z0-9+/]{40}/g,   name: "aws-secret" },
  { pattern: /AKIA[0-9A-Z]{16}/g,                  name: "aws-access-key" },
  { pattern: /DefaultEndpointsProtocol=https?;[^\s"']{20,}/g, name: "azure-connection" },

  // ── Structured secrets ──
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, name: "jwt" },
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, name: "pem-private-key" },
  { pattern: /(?:postgres|mysql|mongodb(?:\+srv)?):\/\/[^\s"']{10,}/g, name: "db-connection-string" },

  // ── Generic key=value ──
  {
    pattern: /(?:password|passwd|pwd|secret|token|api[-_]?key|auth|credential)\s*[:=]\s*["']?([^\s"',;]{8,})["']?/gi,
    name: "generic-secret",
  },
];

// Pre-compiled regex patterns for redaction (source + flags)
const COMPILED_SECRET_SOURCES: Array<{ source: string; flags: string }> = 
  SECRET_PATTERNS.map(({ pattern }) => ({ source: pattern.source, flags: pattern.flags }));

export function redactSecrets(text: string, placeholder = "[REDACTED]"): string {
  if (!text) return text;
  let result = text;
  for (const { source, flags } of COMPILED_SECRET_SOURCES) {
    result = result.replace(new RegExp(source, flags), placeholder);
  }
  return result;
}

// ─── High-risk pattern detection (egress kill switch) ────────────────────────
// These patterns should NEVER survive redaction. If they're still present
// after redactSecrets(), something went wrong → quarantine, don't send to LLM.

const HIGH_RISK_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./,
  /sk-or-v1-[a-zA-Z0-9\-_]{30,}/,
  /sk-ant-[a-zA-Z0-9\-_]{30,}/,
  /AKIA[0-9A-Z]{16}/,
  /DefaultEndpointsProtocol=https?;/,
  /(?:postgres|mysql|mongodb(?:\+srv)?):\/\/[^:]+:[^@]+@/,  // DB conn with password
];

export function containsHighRiskPattern(text: string): boolean {
  if (!text) return false;
  for (const re of HIGH_RISK_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// ─── Path exclusion ──────────────────────────────────────────────────────────

export function extractPathHint(toolInput: string): string | null {
  if (!toolInput) return null;
  try {
    const parsed = typeof toolInput === "string" ? JSON.parse(toolInput) : toolInput;
    // Claude Code tool inputs use file_path, path, or command
    const raw = parsed.file_path || parsed.path || parsed.filename || null;
    if (raw && typeof raw === "string") return raw;

    // Bash commands: extract file args from cat/less/head/tail/source
    const cmd = parsed.command || parsed.cmd || "";
    if (typeof cmd === "string") {
      const match = cmd.match(/(?:cat|less|head|tail|source|\.)\s+(?:-[^\s]+\s+)*["']?([^\s"'|;>]+)/);
      if (match) return match[1];
    }
  } catch {}
  return null;
}

function resolvePathSafe(pathHint: string): string {
  try {
    return realpathSync(pathHint);
  } catch {
    return pathHint;
  }
}

export function isExcludedPath(pathHint: string, excludePatterns: string[]): boolean {
  if (!pathHint || excludePatterns.length === 0) return false;

  const resolved = resolvePathSafe(pathHint);
  const filename = resolved.split("/").pop() || resolved;

  for (const pattern of excludePatterns) {
    // Exact filename match
    if (filename === pattern) return true;
    // Glob-like: *.pem, .env.*, id_rsa*
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    if (new RegExp(`^${escaped}$`).test(filename)) return true;
    // Also test full path for patterns like "secrets/*"
    if (new RegExp(`(?:^|/)${escaped}$`).test(resolved)) return true;
  }
  return false;
}

// ─── Custom patterns ─────────────────────────────────────────────────────────

export function compileCustomPatterns(
  patterns: Array<{ pattern: string; name: string }>
): RegExp[] {
  const compiled: RegExp[] = [];
  for (const { pattern } of patterns) {
    if (!pattern || pattern.length < 4) continue;
    if (/^\.\*$|^\.\+$/.test(pattern)) continue; // reject wildcard-everything
    try {
      compiled.push(new RegExp(pattern, "g"));
    } catch {
      // Invalid regex — skip silently
    }
  }
  return compiled;
}

export function redactWithCustomPatterns(
  text: string,
  compiledPatterns: RegExp[],
  placeholder = "[REDACTED]"
): string {
  let result = text;
  for (const re of compiledPatterns) {
    result = result.replace(new RegExp(re.source, re.flags), placeholder);
  }
  return result;
}

// ─── Combined sanitize ───────────────────────────────────────────────────────

export function sanitize(
  text: string,
  opts: { maxSize?: number; redact?: boolean; isOutput?: boolean } = {}
): string {
  const { maxSize, redact = true, isOutput = false } = opts;
  // Fast-path: truncate huge inputs before regex processing
  let result = text;
  if (result && result.length > 100_000) {
    result = result.slice(0, isOutput ? 8192 : 4096);
  }
  result = stripAllMemoryTags(result);
  if (redact) result = redactSecrets(result);
  if (maxSize !== undefined) {
    result = isOutput ? truncateOutput(result, maxSize) : truncateInput(result, maxSize);
  }
  return result;
}
