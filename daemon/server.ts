#!/usr/bin/env bun
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { loadConfig } from "./config.ts";
import { getDB, runMigrations } from "./db.ts";
import { CompressionSDK } from "./compression-sdk.ts";
import { CompressionWorker } from "./compression-worker.ts";
import { IdleDetector } from "./idle-detector.ts";
import { createRoutes, json } from "./routes.ts";
import { 
  MEMORY_DIR, PID_FILE, LOGS_DIR, VERSION_FILE, DEFAULT_HOST 
} from "../shared/constants.ts";

function readPid(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function checkExistingDaemon(port: number): Promise<{ alive: boolean; pid?: number; uptime?: number }> {
  try {
    const res = await fetch(`http://${DEFAULT_HOST}:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      const data = await res.json() as { uptime?: number };
      const pid = readPid() ?? undefined;
      return { alive: true, pid, uptime: data.uptime };
    }
  } catch {}

  const pid = readPid();
  if (pid !== null) {
    if (isProcessAlive(pid)) {
      await Bun.sleep(500);
      try {
        const res = await fetch(`http://${DEFAULT_HOST}:${port}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) return { alive: true, pid };
      } catch {}
      try { unlinkSync(PID_FILE); } catch {}
    } else {
      try { unlinkSync(PID_FILE); } catch {}
    }
  }

  return { alive: false };
}

async function printStatus(): Promise<void> {
  const config = loadConfig();
  const port = config.daemon.port;

  try {
    const res = await fetch(`http://${DEFAULT_HOST}:${port}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json() as any;
      console.log("longmem daemon: running");
      console.log(`  PID:        ${data.pid}`);
      console.log(`  Port:       ${data.port}`);
      console.log(`  Uptime:     ${data.uptime}s`);
      console.log(`  Pending:    ${data.pending} compression jobs`);
      console.log(`  Circuit:    ${data.circuit_open ? "OPEN (paused)" : "closed"}`);
      console.log(`  Idle:       ${Math.round(data.idle_ms / 1000)}s`);
      console.log(`  Service:    ${data.service_managed ? "systemd/launchd" : "manual"}`);
      return;
    }
  } catch {}

  try {
    const res = await fetch(`http://${DEFAULT_HOST}:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json() as any;
      const pid = readPid();
      console.log("longmem daemon: running");
      console.log(`  PID:     ${pid || "?"}`);
      console.log(`  Port:    ${port}`);
      console.log(`  Uptime:  ${data.uptime}s`);
      return;
    }
  } catch {}

  console.log("longmem daemon: stopped");
  const stalePid = readPid();
  if (stalePid !== null) {
    const alive = isProcessAlive(stalePid);
    console.log(`  Stale PID file: ${PID_FILE} (pid ${stalePid}, process ${alive ? "alive but not responding" : "dead"})`);
  }
}

const cliArgs = process.argv.slice(2);

if (cliArgs.includes("--status") || cliArgs.includes("status")) {
  await printStatus();
  process.exit(0);
}

if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true, mode: 0o700 });
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

const config = loadConfig();

const existing = await checkExistingDaemon(config.daemon.port);

if (existing.alive) {
  console.log(`[longmem] Daemon already running (pid: ${existing.pid || "?"}, uptime: ${existing.uptime || "?"}s)`);
  console.log(`[longmem] To check status: bun daemon/server.ts --status`);
  console.log(`[longmem] To stop: curl -X POST http://${DEFAULT_HOST}:${config.daemon.port}/shutdown`);
  process.exit(0);
}

writeFileSync(PID_FILE, String(process.pid));

runMigrations();

if (config.privacy.mode === "none") {
  console.warn("[longmem] WARNING: Privacy mode is 'none' — secrets will NOT be redacted before storage or compression");
}

const sdk = new CompressionSDK(config.compression);
const worker = new CompressionWorker(sdk, config.compression, {
  mode: config.privacy.mode,
  customPatterns: config.privacy.customPatterns,
});
const idleDetector = new IdleDetector(
  config.compression.idleThresholdSeconds * 1000,
  () => worker.processQueue()
);
const routes = createRoutes(idleDetector, worker, config);

setTimeout(() => worker.processQueue(), 5000);

function isServiceManaged(): boolean {
  const os = platform();
  if (os === "linux") {
    return existsSync(join(homedir(), ".config", "systemd", "user", "longmem.service"));
  }
  if (os === "darwin") {
    return existsSync(join(homedir(), "Library", "LaunchAgents", "com.longmem.daemon.plist"));
  }
  return false;
}

let server: ReturnType<typeof Bun.serve>;

try {
  server = Bun.serve({
    hostname: DEFAULT_HOST,
    port: config.daemon.port,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const method = req.method;
      const path = url.pathname;

      try {
        if (method === "GET" && path === "/health") return routes.handleHealth();
        if (method === "GET" && path === "/stats") return routes.handleStats();

        if (method === "GET" && path === "/status") {
          return json({
            status: "ok",
            pid: process.pid,
            port: config.daemon.port,
            uptime: Math.round(process.uptime()),
            pending: worker.pendingCount(),
            circuit_open: worker.isCircuitOpen(),
            idle_ms: idleDetector.timeSinceLastActivity(),
            service_managed: isServiceManaged(),
            version: (() => {
              try { return readFileSync(VERSION_FILE, "utf-8").trim(); }
              catch { return "unknown"; }
            })(),
          });
        }

        if (method === "POST" && path === "/shutdown") {
          console.log("[longmem] Shutdown requested via HTTP");
          setTimeout(() => shutdown(), 100);
          return json({ status: "shutting_down" });
        }

        if (method === "POST" && path === "/session/start") {
          return routes.handleSessionStart(await req.json());
        }
        if (method === "POST" && path === "/session/end") {
          return routes.handleSessionEnd(await req.json());
        }

        if (method === "POST" && path === "/observe") {
          return routes.handleObserve(await req.json());
        }
        if (method === "POST" && path === "/prompt") {
          return routes.handlePrompt(await req.json());
        }

        if (method === "POST" && path === "/ecosystem/ingest") {
          return routes.handleEcosystemIngest(await req.json());
        }

        if (method === "GET" && path === "/search") {
          return routes.handleSearch(url.searchParams);
        }
        if (method === "GET" && path === "/context") {
          return routes.handleContext(url.searchParams);
        }

        if (method === "GET" && path.startsWith("/observation/")) {
          return routes.handleGetObservation(path.slice("/observation/".length));
        }

        if (method === "GET" && path.startsWith("/timeline/")) {
          return routes.handleTimeline(path.slice("/timeline/".length), url.searchParams);
        }

        if (method === "GET" && path === "/export") {
          return routes.handleExport(url.searchParams);
        }

        return json({ error: "Not found" }, 404);
      } catch (error: any) {
        return json({ error: error?.message || "Internal error" }, 500);
      }
    },

    error(error: Error): Response {
      return json({ error: error.message }, 500);
    },
  });
} catch (e: any) {
  if (e?.code === "EADDRINUSE" || e?.message?.includes("address already in use") || e?.message?.includes("EADDRINUSE")) {
    console.error(`[longmem] Port ${config.daemon.port} already in use (EADDRINUSE)`);
    console.error(`[longmem] Another process is using this port.`);
    console.error(`[longmem] Check: lsof -ti:${config.daemon.port}`);
    try { unlinkSync(PID_FILE); } catch {}
    process.exit(1);
  }
  console.error(`[longmem] Failed to start server: ${e?.message || e}`);
  try { unlinkSync(PID_FILE); } catch {}
  process.exit(1);
}

console.log(`[longmem] Daemon started on http://${DEFAULT_HOST}:${config.daemon.port} (pid: ${process.pid})`);
console.log(`[longmem] DB: ${config.daemon.dbPath}`);
console.log(`[longmem] Compression: ${config.compression.enabled ? `${config.compression.model}` : "disabled"}`);

function shutdown(): void {
  console.log("[longmem] Shutting down...");
  idleDetector.destroy();
  server.stop();
  try { unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);