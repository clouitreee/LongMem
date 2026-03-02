/**
 * Test: Single-instance daemon guard
 * Validates that the daemon prevents double-start gracefully.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const DAEMON_PORT = 38741;
const HEALTH_URL = `http://127.0.0.1:${DAEMON_PORT}/health`;
const STATUS_URL = `http://127.0.0.1:${DAEMON_PORT}/status`;
const SHUTDOWN_URL = `http://127.0.0.1:${DAEMON_PORT}/shutdown`;

async function isDaemonRunning(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

describe("single-instance daemon guard", () => {
  // These tests require a running daemon
  let daemonWasRunning = false;

  beforeAll(async () => {
    daemonWasRunning = await isDaemonRunning();
    if (!daemonWasRunning) {
      console.log("  [skip] Daemon not running — some tests will be skipped");
    }
  });

  test("health endpoint returns valid JSON", async () => {
    if (!daemonWasRunning) return;

    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    expect(res.ok).toBe(true);

    const data = await res.json() as any;
    expect(data.status).toBe("ok");
    expect(typeof data.uptime).toBe("number");
    expect(data.uptime).toBeGreaterThanOrEqual(0);
  });

  test("/status endpoint returns PID + port + service info", async () => {
    if (!daemonWasRunning) return;

    const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(2000) });
    expect(res.ok).toBe(true);

    const data = await res.json() as any;
    expect(data.status).toBe("ok");
    expect(typeof data.pid).toBe("number");
    expect(data.pid).toBeGreaterThan(0);
    expect(data.port).toBe(DAEMON_PORT);
    expect(typeof data.service_managed).toBe("boolean");
    expect(typeof data.version).toBe("string");
  });

  test("second daemon instance exits cleanly (exit 0) when one is already running", async () => {
    if (!daemonWasRunning) return;

    // Launch a second daemon — it should detect the running instance and exit 0
    const proc = Bun.spawnSync(["bun", "run", "daemon/server.ts"], {
      cwd: process.cwd().includes("longmem") ? process.cwd() : "/home/ubuntu/longmem",
      timeout: 5000,
      stderr: "pipe",
      stdout: "pipe",
    });

    const stdout = proc.stdout?.toString() || "";
    const exitCode = proc.exitCode;

    // Should exit 0 (not error)
    expect(exitCode).toBe(0);
    // Should mention "already running"
    expect(stdout).toContain("already running");
  });
});
