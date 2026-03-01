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
  { pattern: /sk-or-v1-[a-zA-Z0-9\-_]{20,}/g,     name: "openrouter-key" },
  { pattern: /sk-ant-[a-zA-Z0-9\-_]{20,}/g,        name: "anthropic-key" },
  { pattern: /sk-[a-zA-Z0-9\-_]{20,}/g,            name: "openai-key" },
  { pattern: /ghp_[a-zA-Z0-9]{36}/g,               name: "github-pat" },
  { pattern: /gho_[a-zA-Z0-9]{36}/g,               name: "github-oauth" },
  { pattern: /xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+/g,  name: "slack-bot-token" },
  { pattern: /[A-Z0-9]{20}:[A-Za-z0-9+/]{40}/g,   name: "aws-secret" },
  {
    pattern: /(?:password|passwd|pwd|secret|token|api[-_]?key)\s*[:=]\s*["']?([^\s"',;]{8,})["']?/gi,
    name: "generic-secret",
  },
];

export function redactSecrets(text: string, placeholder = "[REDACTED]"): string {
  let result = text;
  for (const { pattern } of SECRET_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), placeholder);
  }
  return result;
}

// ─── Combined sanitize ───────────────────────────────────────────────────────

export function sanitize(
  text: string,
  opts: { maxSize?: number; redact?: boolean; isOutput?: boolean } = {}
): string {
  const { maxSize, redact = true, isOutput = false } = opts;
  let result = stripAllMemoryTags(text);
  if (redact) result = redactSecrets(result);
  if (maxSize !== undefined) {
    result = isOutput ? truncateOutput(result, maxSize) : truncateInput(result, maxSize);
  }
  return result;
}
