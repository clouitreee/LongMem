/**
 * shared/decouple.ts — Reverse of couple.ts
 * Removes LongMem entries from client configs without touching user entries.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync } from "fs";
import { dirname } from "path";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

// ─── Safe JSON helpers ──────────────────────────────────────────────────────

function safeReadJSON(path: string): Record<string, any> {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function backupFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bakPath = `${filePath}.pre-longmem-uninstall-${ts}.bak`;
  copyFileSync(filePath, bakPath);
  return bakPath;
}

function safeWriteJSON(filePath: string, data: object): void {
  const tmpPath = `${filePath}.tmp`;
  const content = JSON.stringify(data, null, 2);
  writeFileSync(tmpPath, content);

  // Validate
  try {
    JSON.parse(readFileSync(tmpPath, "utf-8"));
  } catch {
    throw new Error(`Validation failed for ${tmpPath}`);
  }

  renameSync(tmpPath, filePath);
}

// ─── Remove LongMem from hooks (preserves user hooks) ──────────────────────

export function removeLongmemFromHooks(hooks: Record<string, any[]> | undefined): Record<string, any[]> | undefined {
  if (!hooks || typeof hooks !== "object") return hooks;

  const cleaned: Record<string, any[]> = {};
  let anyRemoved = false;

  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      cleaned[eventName] = entries;
      continue;
    }

    const filtered = entries.filter((entry: any) => {
      const isLongmem = entry?.hooks?.some((h: any) =>
        String(h?.command || "").includes("longmem")
      );
      if (isLongmem) anyRemoved = true;
      return !isLongmem;
    });

    if (filtered.length > 0) {
      cleaned[eventName] = filtered;
    }
    // If empty array → don't include the key at all
  }

  if (!anyRemoved) return hooks; // Nothing changed
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

// ─── Remove LongMem from MCP servers ────────────────────────────────────────

export function removeLongmemMCP(mcpServers: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!mcpServers || typeof mcpServers !== "object") return mcpServers;
  if (!("longmem" in mcpServers)) return mcpServers;

  const cleaned = { ...mcpServers };
  delete cleaned.longmem;

  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

// ─── Decouple Claude Code ───────────────────────────────────────────────────

export function decoupleClaudeCode(configPath: string, dryRun = false): { success: boolean; backup: string | null; changes: string[] } {
  const changes: string[] = [];

  if (!existsSync(configPath)) {
    return { success: true, backup: null, changes: ["Config file not found (already clean)"] };
  }

  const settings = safeReadJSON(configPath);
  let modified = false;

  // Remove hooks
  const cleanedHooks = removeLongmemFromHooks(settings.hooks);
  if (cleanedHooks !== settings.hooks) {
    if (cleanedHooks === undefined) {
      delete settings.hooks;
      changes.push("Removed hooks.PostToolUse, hooks.UserPromptSubmit, hooks.Stop (longmem entries)");
    } else {
      settings.hooks = cleanedHooks;
      changes.push("Removed longmem entries from hooks (preserved user hooks)");
    }
    modified = true;
  }

  // Remove MCP server
  const cleanedMCP = removeLongmemMCP(settings.mcpServers);
  if (cleanedMCP !== settings.mcpServers) {
    if (cleanedMCP === undefined) {
      delete settings.mcpServers;
    } else {
      settings.mcpServers = cleanedMCP;
    }
    changes.push("Removed mcpServers.longmem");
    modified = true;
  }

  if (!modified) {
    changes.push("No longmem entries found (already clean)");
    return { success: true, backup: null, changes };
  }

  if (dryRun) {
    changes.push("(dry-run: no files modified)");
    return { success: true, backup: null, changes };
  }

  // Backup → write
  const backup = backupFile(configPath);
  safeWriteJSON(configPath, settings);

  return { success: true, backup, changes };
}

// ─── Decouple OpenCode ──────────────────────────────────────────────────────

export function decoupleOpenCode(configPath: string, dryRun = false): { success: boolean; backup: string | null; changes: string[] } {
  const changes: string[] = [];

  if (!existsSync(configPath)) {
    return { success: true, backup: null, changes: ["Config file not found (already clean)"] };
  }

  const config = safeReadJSON(configPath);
  let modified = false;

  // Remove MCP
  if (config.mcp?.longmem) {
    delete config.mcp.longmem;
    if (Object.keys(config.mcp).length === 0) delete config.mcp;
    changes.push("Removed mcp.longmem");
    modified = true;
  }

  // Remove plugin entries referencing longmem
  if (Array.isArray(config.plugin)) {
    const before = config.plugin.length;
    config.plugin = config.plugin.filter((p: string) => !String(p).includes("longmem"));
    if (config.plugin.length < before) {
      changes.push("Removed longmem plugin entry");
      modified = true;
    }
    if (config.plugin.length === 0) delete config.plugin;
  }

  // Remove instructions referencing longmem/memory-instructions
  if (Array.isArray(config.instructions)) {
    const before = config.instructions.length;
    config.instructions = config.instructions.filter((p: string) =>
      !String(p).includes("longmem") && !String(p).includes("memory-instructions")
    );
    if (config.instructions.length < before) {
      changes.push("Removed longmem instructions entry");
      modified = true;
    }
    if (config.instructions.length === 0) delete config.instructions;
  }

  if (!modified) {
    changes.push("No longmem entries found (already clean)");
    return { success: true, backup: null, changes };
  }

  if (dryRun) {
    changes.push("(dry-run: no files modified)");
    return { success: true, backup: null, changes };
  }

  const backup = backupFile(configPath);
  safeWriteJSON(configPath, config);

  return { success: true, backup, changes };
}
