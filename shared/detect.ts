import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir, platform, arch } from "os";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DetectedClient {
  name: "claude-code" | "opencode";
  binaryPath: string | null;
  configDir: string;
  configFile: string;
  configExists: boolean;
  alreadyPatched: boolean;
  version: string | null;
}

export interface DetectedDaemon {
  installed: boolean;
  running: boolean;
  mode: "binary" | "bun" | null;
  serviceInstalled: boolean;
}

export interface DetectionResult {
  platform: "linux-arm64" | "linux-x64" | "macos-arm64" | "macos-x64";
  clients: DetectedClient[];
  daemon: DetectedDaemon;
  bunPath: string | null;
  existingInstall: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const HOME = homedir();
const MEMORY_DIR = join(HOME, ".longmem");

// ─── Platform ───────────────────────────────────────────────────────────────

function detectPlatform(): "linux-arm64" | "linux-x64" | "macos-arm64" | "macos-x64" {
  const os = platform();
  const cpu = arch();
  if (os === "linux" && cpu === "arm64") return "linux-arm64";
  if (os === "linux") return "linux-x64";
  if (os === "darwin" && cpu === "arm64") return "macos-arm64";
  if (os === "darwin") return "macos-x64";
  // Fallback — best guess
  return "linux-x64";
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeReadJSON(path: string): Record<string, any> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

async function runWithTimeout(cmd: string[], timeoutMs: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    return out.trim() || null;
  } catch {
    return null;
  }
}

// ─── Claude Code Detection ──────────────────────────────────────────────────

async function detectClaudeCode(): Promise<DetectedClient | null> {
  // Find binary
  let binaryPath: string | null = null;
  const whichResult = Bun.which("claude");
  if (whichResult) {
    binaryPath = whichResult;
  } else {
    const candidates = [
      join(HOME, ".claude", "bin", "claude"),
      "/usr/local/bin/claude",
    ];
    for (const c of candidates) {
      if (existsSync(c)) { binaryPath = c; break; }
    }
  }

  const configDir = join(HOME, ".claude");
  const configFile = join(configDir, "settings.json");
  const configDirExists = existsSync(configDir);

  // If neither binary nor config dir exist, Claude Code is not present
  if (!binaryPath && !configDirExists) return null;

  const configExists = existsSync(configFile);
  let alreadyPatched = false;

  if (configExists) {
    const settings = safeReadJSON(configFile);
    if (settings) {
      // Check hooks for longmem
      const hooks = settings.hooks || {};
      const hasHook = Object.values(hooks).some((arr: any) =>
        Array.isArray(arr) && arr.some((entry: any) =>
          entry?.hooks?.some((h: any) => String(h?.command || "").includes("longmem"))
        )
      );
      // Check MCP for longmem
      const hasMCP = !!settings.mcpServers?.longmem;
      alreadyPatched = hasHook && hasMCP;
    }
  }

  // Version
  let version: string | null = null;
  if (binaryPath) {
    version = await runWithTimeout([binaryPath, "--version"], 2000);
  }

  return {
    name: "claude-code",
    binaryPath,
    configDir,
    configFile,
    configExists,
    alreadyPatched,
    version,
  };
}

// ─── OpenCode Detection ─────────────────────────────────────────────────────

async function detectOpenCode(): Promise<DetectedClient | null> {
  let binaryPath: string | null = null;
  const whichResult = Bun.which("opencode");
  if (whichResult) binaryPath = whichResult;

  const configDir = join(HOME, ".config", "opencode");
  const configDirExists = existsSync(configDir);

  if (!binaryPath && !configDirExists) return null;

  // Try config.json then opencode.jsonc
  let configFile = join(configDir, "config.json");
  if (!existsSync(configFile)) {
    const jsonc = join(configDir, "opencode.jsonc");
    if (existsSync(jsonc)) configFile = jsonc;
  }
  const configExists = existsSync(configFile);

  let alreadyPatched = false;
  if (configExists) {
    const config = safeReadJSON(configFile);
    if (config) {
      alreadyPatched = !!config.mcp?.longmem;
    }
  }

  let version: string | null = null;
  if (binaryPath) {
    version = await runWithTimeout([binaryPath, "--version"], 2000);
  }

  return {
    name: "opencode",
    binaryPath,
    configDir,
    configFile,
    configExists,
    alreadyPatched,
    version,
  };
}

// ─── Daemon Detection ───────────────────────────────────────────────────────

async function detectDaemon(): Promise<DetectedDaemon> {
  const binaryPath = join(MEMORY_DIR, "bin", "longmemd");
  const scriptPath = join(MEMORY_DIR, "daemon.js");

  let mode: "binary" | "bun" | null = null;
  if (existsSync(binaryPath)) mode = "binary";
  else if (existsSync(scriptPath)) mode = "bun";

  const installed = mode !== null;

  // Check if running
  let running = false;
  try {
    const res = await fetch("http://127.0.0.1:38741/health", {
      signal: AbortSignal.timeout(2000),
    });
    running = res.ok;
  } catch {}

  // Check service installed
  let serviceInstalled = false;
  const p = detectPlatform();
  if (p.startsWith("linux")) {
    serviceInstalled = existsSync(
      join(HOME, ".config", "systemd", "user", "longmem.service")
    );
  } else if (p.startsWith("macos")) {
    serviceInstalled = existsSync(
      join(HOME, "Library", "LaunchAgents", "com.longmem.daemon.plist")
    );
  }

  return { installed, running, mode, serviceInstalled };
}

// ─── Main Export ────────────────────────────────────────────────────────────

export async function detectEnvironment(): Promise<DetectionResult> {
  const [claude, opencode, daemon] = await Promise.all([
    detectClaudeCode(),
    detectOpenCode(),
    detectDaemon(),
  ]);

  const clients: DetectedClient[] = [];
  if (claude) clients.push(claude);
  if (opencode) clients.push(opencode);

  const bunPath = Bun.which("bun") || (existsSync(join(HOME, ".bun", "bin", "bun"))
    ? join(HOME, ".bun", "bin", "bun")
    : null);

  return {
    platform: detectPlatform(),
    clients,
    daemon,
    bunPath,
    existingInstall: existsSync(MEMORY_DIR) && (daemon.installed || existsSync(join(MEMORY_DIR, "settings.json"))),
  };
}

// ─── Pretty Printer ─────────────────────────────────────────────────────────

export function printDetectionSummary(d: DetectionResult): void {
  console.log("  Detected:");

  // Clients
  for (const c of d.clients) {
    const label = c.name === "claude-code" ? "Claude Code CLI" : "OpenCode";
    const ver = c.version ? `v${c.version.replace(/^v/, "")}` : "";
    const path = c.binaryPath ? `(${c.binaryPath})` : "(config only)";
    console.log(`    \x1b[32m✓\x1b[0m ${label.padEnd(18)} ${ver.padEnd(12)} ${path}`);
  }

  // Missing clients
  const clientNames = d.clients.map(c => c.name);
  if (!clientNames.includes("claude-code")) {
    console.log(`    \x1b[31m✗\x1b[0m ${"Claude Code CLI".padEnd(18)} not found`);
  }
  if (!clientNames.includes("opencode")) {
    console.log(`    \x1b[31m✗\x1b[0m ${"OpenCode".padEnd(18)} not found`);
  }

  // Daemon
  if (d.daemon.installed) {
    const status = d.daemon.running ? "running" : "stopped";
    console.log(`    \x1b[32m✓\x1b[0m ${"Daemon".padEnd(18)} ${d.daemon.mode} mode, ${status}`);
  }

  console.log("");
}
