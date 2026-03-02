import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { DetectedClient, DetectionResult } from "./detect.ts";

const HOME = homedir();
const MEMORY_DIR = join(HOME, ".longmem");

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CoupleOptions {
  yes: boolean;      // --yes: skip prompts
  dryRun: boolean;   // --dry-run: preview only
  skipDaemon: boolean;
}

export interface CoupleResult {
  clientsPatched: string[];
  clientsSkipped: string[];
  errors: string[];
}

// ─── Interactive Prompt ─────────────────────────────────────────────────────

async function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  process.stdout.write(`  ${question} ${suffix}: `);

  return new Promise((resolve) => {
    const { createInterface } = require("readline");
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.once("line", (line: string) => {
      rl.close();
      const answer = line.trim().toLowerCase();
      if (answer === "") return resolve(defaultYes);
      resolve(answer === "y" || answer === "yes");
    });
    rl.once("close", () => resolve(defaultYes));
  });
}

// ─── Safe Hook Merge (critical fix for overwrite bug) ───────────────────────

function mergeHookEntry(existing: any[] | undefined, newEntry: object): any[] {
  const arr = Array.isArray(existing) ? [...existing] : [];
  // Remove old longmem entries
  const cleaned = arr.filter((entry: any) =>
    !entry?.hooks?.some((h: any) => String(h?.command || "").includes("longmem"))
  );
  // Append new longmem entry
  cleaned.push(newEntry);
  return cleaned;
}

// ─── Backup + Atomic Write ──────────────────────────────────────────────────

function safeWriteJSON(filePath: string, data: object): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  // 1. Backup existing
  if (existsSync(filePath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const bakPath = `${filePath}.pre-longmem-${ts}.bak`;
    copyFileSync(filePath, bakPath);
  }

  // 2. Write to temp
  const tmpPath = `${filePath}.tmp`;
  const content = JSON.stringify(data, null, 2);
  writeFileSync(tmpPath, content);

  // 3. Validate by re-parsing
  try {
    JSON.parse(readFileSync(tmpPath, "utf-8"));
  } catch {
    throw new Error(`Failed to validate written config: ${tmpPath}`);
  }

  // 4. Atomic rename
  renameSync(tmpPath, filePath);
}

function safeReadJSON(path: string): Record<string, any> {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

// ─── Resolve Paths ──────────────────────────────────────────────────────────

function resolveHookCommand(detection: DetectionResult): string {
  const binaryHook = join(MEMORY_DIR, "bin", "longmem-hook");
  if (existsSync(binaryHook)) return binaryHook;

  // Fallback to bun + script
  const bunPath = detection.bunPath || "bun";
  return bunPath;
}

function resolveMCPCommand(detection: DetectionResult): { command: string; args: string[] } {
  const binaryMCP = join(MEMORY_DIR, "bin", "longmem-mcp");
  if (existsSync(binaryMCP)) return { command: binaryMCP, args: [] };

  const bunPath = detection.bunPath || "bun";
  return { command: bunPath, args: [join(MEMORY_DIR, "mcp.js")] };
}

function resolveHookEntries(detection: DetectionResult): { useBinary: boolean; commands: Record<string, string> } {
  const binaryHook = join(MEMORY_DIR, "bin", "longmem-hook");
  if (existsSync(binaryHook)) {
    return {
      useBinary: true,
      commands: {
        PostToolUse: `${binaryHook} post-tool`,
        UserPromptSubmit: `${binaryHook} prompt`,
        Stop: `${binaryHook} stop`,
      },
    };
  }

  const bunPath = detection.bunPath || "bun";
  return {
    useBinary: false,
    commands: {
      PostToolUse: `${bunPath} ${join(MEMORY_DIR, "hooks/post-tool.js")}`,
      UserPromptSubmit: `${bunPath} ${join(MEMORY_DIR, "hooks/prompt.js")}`,
      Stop: `${bunPath} ${join(MEMORY_DIR, "hooks/stop.js")}`,
    },
  };
}

// ─── Claude Code Patching ───────────────────────────────────────────────────

function previewClaudeChanges(hookEntries: Record<string, string>, mcp: { command: string; args: string[] }): void {
  console.log("");
  console.log(`  Will add:`);
  console.log(`    hooks.PostToolUse      → ${hookEntries.PostToolUse}`);
  console.log(`    hooks.UserPromptSubmit → ${hookEntries.UserPromptSubmit}`);
  console.log(`    hooks.Stop             → ${hookEntries.Stop}`);
  console.log(`    mcpServers.longmem     → ${mcp.command} ${mcp.args.join(" ")}`.trimEnd());
  console.log("");
}

function patchClaudeCode(
  client: DetectedClient,
  detection: DetectionResult,
  dryRun: boolean
): boolean {
  const settings = safeReadJSON(client.configFile);
  const { commands } = resolveHookEntries(detection);
  const mcp = resolveMCPCommand(detection);

  // Merge hooks (not overwrite!)
  settings.hooks = settings.hooks || {};

  for (const [eventName, command] of Object.entries(commands)) {
    const newEntry = {
      matcher: "",
      hooks: [{ type: "command", command }],
    };
    settings.hooks[eventName] = mergeHookEntry(settings.hooks[eventName], newEntry);
  }

  // MCP server
  settings.mcpServers = settings.mcpServers || {};
  settings.mcpServers["longmem"] = { command: mcp.command, args: mcp.args };

  if (dryRun) {
    console.log(`  ${YELLOW}(dry-run)${RESET} Would write to ${client.configFile}`);
    return true;
  }

  safeWriteJSON(client.configFile, settings);
  console.log(`  ${GREEN}✓${RESET} Updated ${client.configFile}`);
  return true;
}

// ─── OpenCode Patching ──────────────────────────────────────────────────────

function previewOpenCodeChanges(mcp: { command: string; args: string[] }): void {
  console.log("");
  console.log(`  Will add:`);
  console.log(`    mcp.longmem            → ${mcp.command} ${mcp.args.join(" ")}`.trimEnd());
  console.log(`    plugin                 → longmem plugin`);
  console.log(`    instructions           → memory-instructions.md`);
  console.log("");
}

function patchOpenCode(
  client: DetectedClient,
  detection: DetectionResult,
  dryRun: boolean
): boolean {
  const config = safeReadJSON(client.configFile);
  const mcp = resolveMCPCommand(detection);

  // MCP
  config.mcp = config.mcp || {};
  config.mcp["longmem"] = { command: mcp.command, args: mcp.args };

  // Plugin
  const pluginPath = join(MEMORY_DIR, "plugin.js");
  if (!Array.isArray(config.plugin)) config.plugin = [];
  if (!config.plugin.includes(pluginPath)) config.plugin.push(pluginPath);

  // Instructions
  const instrPath = join(HOME, ".opencode", "memory-instructions.md");
  if (!Array.isArray(config.instructions)) config.instructions = [];
  if (!config.instructions.includes(instrPath)) config.instructions.push(instrPath);

  if (dryRun) {
    console.log(`  ${YELLOW}(dry-run)${RESET} Would write to ${client.configFile}`);
    return true;
  }

  // Ensure config dir exists
  mkdirSync(dirname(client.configFile), { recursive: true });
  if (!existsSync(client.configFile)) writeFileSync(client.configFile, "{}");

  safeWriteJSON(client.configFile, config);
  console.log(`  ${GREEN}✓${RESET} Updated ${client.configFile}`);
  return true;
}

// ─── Main Export ────────────────────────────────────────────────────────────

// askFn type: (question, defaultYes) => Promise<boolean>
type AskFn = (question: string, defaultYes: boolean) => Promise<boolean>;

export async function runCoupleFlow(
  detection: DetectionResult,
  options: CoupleOptions,
  askFn?: AskFn,
): Promise<CoupleResult> {
  const ask = askFn || askYesNo; // Use shared askFn if provided, else fallback
  const result: CoupleResult = { clientsPatched: [], clientsSkipped: [], errors: [] };

  for (const client of detection.clients) {
    const label = client.name === "claude-code" ? "Claude Code CLI" : "OpenCode";

    console.log(`── ${label} ${"─".repeat(Math.max(0, 50 - label.length))}`);
    console.log(`  Config: ${client.configFile}`);

    // Already patched?
    if (client.alreadyPatched) {
      console.log(`  ${GREEN}✓${RESET} Already configured (skipping)`);
      console.log("");
      result.clientsSkipped.push(client.name);
      continue;
    }

    // Show preview
    if (client.name === "claude-code") {
      const { commands } = resolveHookEntries(detection);
      const mcp = resolveMCPCommand(detection);
      previewClaudeChanges(commands, mcp);
    } else {
      const mcp = resolveMCPCommand(detection);
      previewOpenCodeChanges(mcp);
    }

    // Ask permission
    let approved = options.yes;
    if (!approved) {
      approved = await ask("Apply changes?", true);
    }

    if (!approved) {
      console.log(`  Skipped.`);
      console.log("");
      result.clientsSkipped.push(client.name);
      continue;
    }

    // Patch
    try {
      if (client.name === "claude-code") {
        patchClaudeCode(client, detection, options.dryRun);
      } else {
        patchOpenCode(client, detection, options.dryRun);
      }
      result.clientsPatched.push(client.name);
    } catch (e: any) {
      console.log(`  ${YELLOW}⚠${RESET}  Failed: ${e.message}`);
      result.errors.push(`${client.name}: ${e.message}`);
    }

    console.log("");
  }

  return result;
}
