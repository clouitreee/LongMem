import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { 
  MEMORY_DIR, BIN_DIR, HOOKS_DIR, SETTINGS_PATH, LOGS_DIR 
} from "./constants.ts";
import { getDaemonURL } from "./port-config.ts";
import { VERSION } from "./version.ts";

const HOME = homedir();
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

interface VerifyResult {
  daemon: boolean;
  hook: boolean;
  mcp: boolean;
  configs: boolean;
  allPassed: boolean;
}

async function checkDaemon(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${getDaemonURL()}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const health = (await res.json()) as any;
    const uptime = health.uptime != null ? `uptime ${Math.round(health.uptime)}s` : "";
    return { ok: true, detail: `responding${uptime ? ", " + uptime : ""}` };
  } catch {
    return { ok: false, detail: "not responding" };
  }
}

async function checkHookBinary(): Promise<{ ok: boolean; detail: string }> {
  const binaryPath = join(BIN_DIR, "longmem-hook");
  const scriptPath = join(HOOKS_DIR, "post-tool.js");

  let cmd: string[];
  if (existsSync(binaryPath)) {
    cmd = [binaryPath, "post-tool"];
  } else if (existsSync(scriptPath)) {
    const bunPath = Bun.which("bun") || join(HOME, ".bun", "bin", "bun");
    cmd = [bunPath, scriptPath];
  } else {
    return { ok: false, detail: "hook binary/script not found" };
  }

  try {
    const proc = Bun.spawn(cmd, {
      stdin: new Blob(['{}']),
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, LONGMEM_DRY_RUN: "1" },
    });
    const code = await proc.exited;
    return { ok: code <= 1, detail: `exits ${code}` };
  } catch (e: any) {
    return { ok: false, detail: e.message };
  }
}

async function checkMCPServer(): Promise<{ ok: boolean; detail: string }> {
  const binaryPath = join(BIN_DIR, "longmem-mcp");
  const scriptPath = join(MEMORY_DIR, "mcp.js");

  let cmd: string[];
  if (existsSync(binaryPath)) {
    cmd = [binaryPath];
  } else if (existsSync(scriptPath)) {
    const bunPath = Bun.which("bun") || join(HOME, ".bun", "bin", "bun");
    cmd = [bunPath, scriptPath];
  } else {
    return { ok: false, detail: "MCP binary/script not found" };
  }

  try {
    const initRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "longmem-verify", version: VERSION },
      },
    });

    const toolsRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const input = initRequest + "\n" + toolsRequest + "\n";

    const proc = Bun.spawn(cmd, {
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "ignore",
    });

    const timer = setTimeout(() => proc.kill(), 5000);
    const output = await new Response(proc.stdout).text();
    clearTimeout(timer);

    const toolsMatch = output.match(/"tools"\s*:\s*\[/);
    if (toolsMatch) {
      const toolNames = output.match(/"name"\s*:\s*"mem_/g) || [];
      return { ok: toolNames.length > 0, detail: `${toolNames.length} tools registered` };
    }

    return { ok: false, detail: "no tools response" };
  } catch (e: any) {
    return { ok: false, detail: e.message };
  }
}

function checkConfigPaths(): { ok: boolean; detail: string } {
  const required = [MEMORY_DIR];
  const optional = [SETTINGS_PATH, LOGS_DIR];

  for (const p of required) {
    if (!existsSync(p)) return { ok: false, detail: `missing ${p}` };
  }

  const missing = optional.filter(p => !existsSync(p));
  if (missing.length > 0) {
    return { ok: true, detail: `${optional.length - missing.length}/${optional.length} paths resolve` };
  }

  return { ok: true, detail: "all resolve" };
}

export async function verifyInstallation(): Promise<VerifyResult> {
  console.log("── Verification ─────────────────────────────────────────\n");

  const [daemon, hook, mcp] = await Promise.all([
    checkDaemon(),
    checkHookBinary(),
    checkMCPServer(),
  ]);
  const configs = checkConfigPaths();

  const checks = [
    { label: "Daemon health", ...daemon },
    { label: "Hook binary", ...hook },
    { label: "MCP server", ...mcp },
    { label: "Config paths", ...configs },
  ];

  for (const c of checks) {
    const icon = c.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`  ${icon} ${c.label.padEnd(18)} ${c.detail}`);
  }

  const allPassed = checks.every(c => c.ok);
  console.log("");

  if (!allPassed) {
    console.log("══ Some checks failed ═══════════════════════════════════\n");
    console.log("  LongMem is partially installed. Check warnings above.\n");
  }

  return {
    daemon: daemon.ok,
    hook: hook.ok,
    mcp: mcp.ok,
    configs: configs.ok,
    allPassed,
  };
}