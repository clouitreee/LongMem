// Ecosystem Scanner — finds and reads Claude Code / OpenCode knowledge files
// to pre-populate LongMem's memory before the user needs it.
//
// Scanned sources:
//   1. ~/.claude/CLAUDE.md (global instructions)
//   2. CLAUDE.md in project dirs (depth-limited)
//   3. ~/.claude/projects/{project}/memory/{file}.md (auto-memory per project)
//   4. ~/.claude/skills/{file}.md (skill files)
//   5. OpenCode instructions referenced in config.json
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename, relative } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { sanitize } from "./privacy.ts";

const HOME = homedir();
const MAX_FILE_SIZE = 50 * 1024; // 50KB

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EcosystemFile {
  path: string;
  size: number;
  hash: string;       // sha256 of content
  source: string;     // "claude-global" | "claude-project" | "claude-memory" | "claude-skill" | "opencode-instructions"
  content: string;    // sanitized content (secrets redacted, <private> stripped)
}

export interface EcosystemScanResult {
  files: EcosystemFile[];
  skipped: { path: string; reason: string }[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function safeReadFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_FILE_SIZE) return null;
    if (stat.size === 0) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function isInsideHome(path: string): boolean {
  const resolved = join(path); // normalize
  return resolved.startsWith(HOME);
}

function addFile(
  files: EcosystemFile[],
  skipped: { path: string; reason: string }[],
  path: string,
  source: string
): void {
  if (!isInsideHome(path)) {
    skipped.push({ path, reason: "outside HOME" });
    return;
  }

  if (!existsSync(path)) return; // silently skip non-existent

  try {
    const stat = statSync(path);
    if (!stat.isFile()) return;
    if (stat.size > MAX_FILE_SIZE) {
      skipped.push({ path, reason: `too large (${Math.round(stat.size / 1024)}KB)` });
      return;
    }
    if (stat.size === 0) return;

    const raw = readFileSync(path, "utf-8");
    const content = sanitize(raw, { redact: true, maxSize: MAX_FILE_SIZE });

    if (!content.trim()) {
      skipped.push({ path, reason: "empty after sanitization" });
      return;
    }

    // Deduplicate by path
    if (files.some(f => f.path === path)) return;

    files.push({
      path,
      size: stat.size,
      hash: sha256(raw),
      source,
      content,
    });
  } catch {
    skipped.push({ path, reason: "read error" });
  }
}

/** List .md files in a directory (non-recursive). */
function listMdFiles(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith(".md"))
      .map(f => join(dir, f));
  } catch {
    return [];
  }
}

/** List subdirectories one level deep. */
function listSubdirs(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => join(dir, d.name));
  } catch {
    return [];
  }
}

// ─── Scanners ───────────────────────────────────────────────────────────────

function scanClaudeGlobal(files: EcosystemFile[], skipped: { path: string; reason: string }[]): void {
  addFile(files, skipped, join(HOME, ".claude", "CLAUDE.md"), "claude-global");
}

function scanClaudeProjectMemories(files: EcosystemFile[], skipped: { path: string; reason: string }[]): void {
  const projectsDir = join(HOME, ".claude", "projects");
  if (!existsSync(projectsDir)) return;

  for (const projDir of listSubdirs(projectsDir)) {
    const memoryDir = join(projDir, "memory");
    for (const mdFile of listMdFiles(memoryDir)) {
      addFile(files, skipped, mdFile, "claude-memory");
    }
  }
}

function scanClaudeSkills(files: EcosystemFile[], skipped: { path: string; reason: string }[]): void {
  const skillsDir = join(HOME, ".claude", "skills");
  for (const mdFile of listMdFiles(skillsDir)) {
    addFile(files, skipped, mdFile, "claude-skill");
  }
}

function scanProjectClaudeMd(files: EcosystemFile[], skipped: { path: string; reason: string }[]): void {
  // Scan ~/ at max depth 3 for CLAUDE.md files
  // Avoid heavy dirs: node_modules, .git, .cache, .local, .bun, .npm, .longmem
  const SKIP_DIRS = new Set([
    "node_modules", ".git", ".cache", ".local", ".bun", ".npm",
    ".longmem", ".nvm", ".cargo", ".rustup", "dist", "build",
    ".vscode", ".cursor", "Library", ".Trash",
  ]);

  function walk(dir: string, depth: number): void {
    if (depth > 3) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") && depth === 0 && entry.name !== ".claude") continue;
        if (SKIP_DIRS.has(entry.name)) continue;

        const fullPath = join(dir, entry.name);
        if (entry.isFile() && entry.name === "CLAUDE.md") {
          addFile(files, skipped, fullPath, "claude-project");
        } else if (entry.isDirectory() && depth < 3) {
          walk(fullPath, depth + 1);
        }
      }
    } catch {} // permission errors, etc.
  }

  walk(HOME, 0);
}

function scanOpenCodeInstructions(files: EcosystemFile[], skipped: { path: string; reason: string }[]): void {
  const configPaths = [
    join(HOME, ".config", "opencode", "config.json"),
    join(HOME, ".config", "opencode", "opencode.jsonc"),
  ];

  for (const configPath of configPaths) {
    const content = safeReadFile(configPath);
    if (!content) continue;

    try {
      const config = JSON.parse(content);
      const instructions = config.instructions;
      if (!Array.isArray(instructions)) break;

      for (const instrPath of instructions) {
        if (typeof instrPath === "string" && instrPath.endsWith(".md")) {
          addFile(files, skipped, instrPath, "opencode-instructions");
        }
      }
    } catch {}
    break; // only read one config
  }
}

// ─── Main Export ────────────────────────────────────────────────────────────

export function scanEcosystem(): EcosystemScanResult {
  const files: EcosystemFile[] = [];
  const skipped: { path: string; reason: string }[] = [];

  scanClaudeGlobal(files, skipped);
  scanClaudeProjectMemories(files, skipped);
  scanClaudeSkills(files, skipped);
  scanProjectClaudeMd(files, skipped);
  scanOpenCodeInstructions(files, skipped);

  return { files, skipped };
}

// ─── Pretty Print ───────────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function printEcosystemSummary(scan: EcosystemScanResult): void {
  console.log("── Ecosystem Scan ───────────────────────────────────────\n");

  if (scan.files.length === 0) {
    console.log("  No ecosystem files found.\n");
    return;
  }

  console.log("  Found:");
  // Group by source
  const bySource: Record<string, EcosystemFile[]> = {};
  for (const f of scan.files) {
    (bySource[f.source] ??= []).push(f);
  }

  const sourceLabels: Record<string, string> = {
    "claude-global": "Claude global",
    "claude-project": "CLAUDE.md",
    "claude-memory": "Memory files",
    "claude-skill": "Skill files",
    "opencode-instructions": "OpenCode instructions",
  };

  for (const [source, files] of Object.entries(bySource)) {
    if (files.length === 1) {
      const f = files[0];
      const sizeKB = (f.size / 1024).toFixed(1);
      console.log(`    ${GREEN}✓${RESET} ${f.path} ${DIM}(${sizeKB}KB)${RESET}`);
    } else {
      const label = sourceLabels[source] || source;
      console.log(`    ${GREEN}✓${RESET} ${files.length} ${label}:`);
      for (const f of files) {
        const sizeKB = (f.size / 1024).toFixed(1);
        console.log(`      ${DIM}${f.path} (${sizeKB}KB)${RESET}`);
      }
    }
  }

  if (scan.skipped.length > 0) {
    for (const s of scan.skipped) {
      console.log(`    ${YELLOW}⚠${RESET}  ${s.path} — ${s.reason}`);
    }
  }

  console.log("");
}
