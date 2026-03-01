#!/usr/bin/env bun
/**
 * Unified installer for claude-memory.
 * Usage:
 *   bun install.ts            # Install for Claude Code CLI (default)
 *   bun install.ts --opencode # Also configure OpenCode
 *   bun install.ts --all      # Both
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const MEMORY_DIR = join(homedir(), ".claude-memory");
const DIST_DIR = join(import.meta.dir, "dist");
const args = process.argv.slice(2);
const installOpenCode = args.includes("--opencode") || args.includes("--all");
const installCLI = !args.includes("--opencode-only");

console.log("╔══════════════════════════════════╗");
console.log("║     claude-memory installer      ║");
console.log("╚══════════════════════════════════╝\n");

// 1. Create ~/.claude-memory/ with safe permissions
if (!existsSync(MEMORY_DIR)) {
  mkdirSync(MEMORY_DIR, { recursive: true, mode: 0o700 });
  console.log(`✓ Created ${MEMORY_DIR}`);
} else {
  console.log(`✓ ${MEMORY_DIR} exists`);
}

mkdirSync(join(MEMORY_DIR, "hooks"), { recursive: true });
mkdirSync(join(MEMORY_DIR, "logs"), { recursive: true });

// 2. Copy compiled files
const filesToCopy: [string, string][] = [
  [join(DIST_DIR, "daemon.js"), join(MEMORY_DIR, "daemon.js")],
  [join(DIST_DIR, "mcp.js"), join(MEMORY_DIR, "mcp.js")],
  [join(DIST_DIR, "hooks", "post-tool.js"), join(MEMORY_DIR, "hooks", "post-tool.js")],
  [join(DIST_DIR, "hooks", "prompt.js"), join(MEMORY_DIR, "hooks", "prompt.js")],
  [join(DIST_DIR, "hooks", "stop.js"), join(MEMORY_DIR, "hooks", "stop.js")],
];

for (const [src, dst] of filesToCopy) {
  if (!existsSync(src)) {
    console.error(`✗ Missing built file: ${src}`);
    console.error("  Run: bun run build");
    process.exit(1);
  }
  copyFileSync(src, dst);
}
console.log("✓ Copied daemon, MCP server, and hooks");

// 3. Create settings.json with defaults (if not exists)
const settingsPath = join(MEMORY_DIR, "settings.json");
if (!existsSync(settingsPath)) {
  const defaultSettings = {
    compression: {
      enabled: true,
      provider: "openrouter",
      model: "meta-llama/llama-3.1-8b-instruct",
      apiKey: "",
      maxConcurrent: 1,
      idleThresholdSeconds: 5,
      maxPerMinute: 10,
    },
    daemon: { port: 38741 },
    privacy: { redactSecrets: true },
  };
  writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));
  chmodSync(settingsPath, 0o600);
  console.log(`✓ Created ${settingsPath}`);
  console.log("  ⚠  Set your API key in settings.json to enable compression");
} else {
  console.log(`✓ ${settingsPath} already exists`);
}

// 4. Configure Claude Code CLI
if (installCLI) {
  const claudeDir = join(homedir(), ".claude");
  const claudeSettingsPath = join(claudeDir, "settings.json");

  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

  let claudeSettings: Record<string, any> = {};
  if (existsSync(claudeSettingsPath)) {
    try {
      claudeSettings = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
    } catch {
      console.warn("  ⚠  Could not parse existing ~/.claude/settings.json — creating backup");
      copyFileSync(claudeSettingsPath, claudeSettingsPath + ".bak");
    }
  }

  const bunPath = Bun.which("bun") || `${homedir()}/.bun/bin/bun`;

  // Hooks
  claudeSettings.hooks = claudeSettings.hooks || {};
  claudeSettings.hooks.PostToolUse = [
    {
      matcher: "",
      hooks: [{ type: "command", command: `${bunPath} ${join(MEMORY_DIR, "hooks/post-tool.js")}` }],
    },
  ];
  claudeSettings.hooks.UserPromptSubmit = [
    {
      matcher: "",
      hooks: [{ type: "command", command: `${bunPath} ${join(MEMORY_DIR, "hooks/prompt.js")}` }],
    },
  ];
  claudeSettings.hooks.Stop = [
    {
      matcher: "",
      hooks: [{ type: "command", command: `${bunPath} ${join(MEMORY_DIR, "hooks/stop.js")}` }],
    },
  ];

  // MCP Server
  claudeSettings.mcpServers = claudeSettings.mcpServers || {};
  claudeSettings.mcpServers["claude-memory"] = {
    command: bunPath,
    args: [join(MEMORY_DIR, "mcp.js")],
  };

  writeFileSync(claudeSettingsPath, JSON.stringify(claudeSettings, null, 2));
  console.log(`✓ Updated ~/.claude/settings.json (hooks + MCP server)`);
}

// 5. Configure OpenCode
if (installOpenCode) {
  const bunPath = Bun.which("bun") || `${homedir()}/.bun/bin/bun`;
  const pluginPath = join(DIST_DIR, "plugin.js");
  const opencodeConfigPath = join(homedir(), ".config", "opencode", "config.json");
  const opencodeConfigDir = dirname(opencodeConfigPath);
  const instructionsSrc = join(import.meta.dir, ".opencode", "memory-instructions.md");
  const instructionsDst = join(process.cwd(), ".opencode", "memory-instructions.md");

  // Copy instructions file to project dir if possible, else to home
  const targetDir = join(homedir(), ".opencode");
  mkdirSync(targetDir, { recursive: true });
  const instructionTarget = join(targetDir, "memory-instructions.md");
  if (existsSync(instructionsSrc)) {
    copyFileSync(instructionsSrc, instructionTarget);
    console.log(`✓ Copied memory instructions to ${instructionTarget}`);
  }

  // Patch OpenCode config
  if (!existsSync(opencodeConfigDir)) mkdirSync(opencodeConfigDir, { recursive: true });
  let opencodeConfig: Record<string, any> = {};
  if (existsSync(opencodeConfigPath)) {
    try { opencodeConfig = JSON.parse(readFileSync(opencodeConfigPath, "utf-8")); }
    catch { copyFileSync(opencodeConfigPath, opencodeConfigPath + ".bak"); }
  }

  // instructions
  const instrRelPath = instructionTarget;
  if (!Array.isArray(opencodeConfig.instructions)) opencodeConfig.instructions = [];
  if (!opencodeConfig.instructions.includes(instrRelPath)) {
    opencodeConfig.instructions.push(instrRelPath);
  }

  // plugin
  if (!Array.isArray(opencodeConfig.plugin)) opencodeConfig.plugin = [];
  if (!opencodeConfig.plugin.includes(pluginPath)) {
    opencodeConfig.plugin.push(pluginPath);
  }

  // MCP
  opencodeConfig.mcp = opencodeConfig.mcp || {};
  opencodeConfig.mcp["claude-memory"] = {
    command: bunPath,
    args: [join(MEMORY_DIR, "mcp.js")],
  };

  writeFileSync(opencodeConfigPath, JSON.stringify(opencodeConfig, null, 2));
  console.log("✓ Updated ~/.config/opencode/config.json (instructions + plugin + MCP)");
}

// 6. Start daemon
console.log("\n── Starting daemon ──────────────────────────────────────");
const bunPath = Bun.which("bun") || `${homedir()}/.bun/bin/bun`;
const child = Bun.spawn([bunPath, "run", join(MEMORY_DIR, "daemon.js")], {
  detached: true,
  stdio: ["ignore", "ignore", "ignore"],
});
child.unref();

await Bun.sleep(1500);

try {
  const res = await fetch("http://127.0.0.1:38741/health", { signal: AbortSignal.timeout(2000) });
  const health = await res.json() as any;
  console.log(`✓ Daemon running — port 38741, pending compressions: ${health.pending}`);
} catch {
  console.log("  ⚠  Daemon did not respond — check logs at ~/.claude-memory/logs/");
}

console.log("\n══ Installation complete! ═══════════════════════════════════");
if (!existsSync(settingsPath) || JSON.parse(readFileSync(settingsPath, "utf-8")).compression?.apiKey === "") {
  console.log("\nNext step: set your compression API key:");
  console.log(`  nano ${settingsPath}`);
  console.log("  (compression works without a key — observations are stored raw)");
}
console.log("\nMCP tools available to the LLM:");
console.log("  mem_search  — search past sessions");
console.log("  mem_timeline — chronological context");
console.log("  mem_get     — full observation details");
console.log("");
