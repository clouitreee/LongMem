#!/usr/bin/env bun
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadConfig } from "./config.ts";
import { getDB, runMigrations } from "./db.ts";
import { CompressionSDK } from "./compression-sdk.ts";
import { CompressionWorker } from "./compression-worker.ts";
import { IdleDetector } from "./idle-detector.ts";
import { createRoutes, json } from "./routes.ts";

const MEMORY_DIR = join(homedir(), ".claude-memory");
const PID_FILE = join(MEMORY_DIR, "daemon.pid");
const LOG_DIR = join(MEMORY_DIR, "logs");

// Ensure dirs exist
if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true, mode: 0o700 });
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

// Write PID
writeFileSync(PID_FILE, String(process.pid));

const config = loadConfig();

// Initialize DB
runMigrations();

// Initialize components
const sdk = new CompressionSDK(config.compression);
const worker = new CompressionWorker(sdk, config.compression);
const idleDetector = new IdleDetector(
  config.compression.idleThresholdSeconds * 1000,
  () => worker.processQueue()
);
const routes = createRoutes(idleDetector, worker, config);

// HTTP Server — listens only on localhost
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.daemon.port,

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;

    // CORS-free: only localhost
    try {
      // Health & stats
      if (method === "GET" && path === "/health") return routes.handleHealth();
      if (method === "GET" && path === "/stats") return routes.handleStats();

      // Session management
      if (method === "POST" && path === "/session/start") {
        return routes.handleSessionStart(await req.json());
      }
      if (method === "POST" && path === "/session/end") {
        return routes.handleSessionEnd(await req.json());
      }

      // Observation capture
      if (method === "POST" && path === "/observe") {
        return routes.handleObserve(await req.json());
      }
      if (method === "POST" && path === "/prompt") {
        return routes.handlePrompt(await req.json());
      }

      // Search & retrieval
      if (method === "GET" && path === "/search") {
        return routes.handleSearch(url.searchParams);
      }
      if (method === "GET" && path === "/context") {
        return routes.handleContext(url.searchParams);
      }

      // Observation detail
      if (method === "GET" && path.startsWith("/observation/")) {
        return routes.handleGetObservation(path.slice("/observation/".length));
      }

      // Timeline
      if (method === "GET" && path.startsWith("/timeline/")) {
        return routes.handleTimeline(path.slice("/timeline/".length), url.searchParams);
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

console.log(`[claude-memory] Daemon started on http://127.0.0.1:${config.daemon.port}`);
console.log(`[claude-memory] DB: ${config.daemon.dbPath}`);
console.log(`[claude-memory] Compression: ${config.compression.enabled ? `${config.compression.model}` : "disabled"}`);

// Graceful shutdown
function shutdown(): void {
  console.log("[claude-memory] Shutting down...");
  idleDetector.destroy();
  server.stop();
  try { Bun.file(PID_FILE) && require("fs").unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
