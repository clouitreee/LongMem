/**
 * Test: Export endpoint integration
 * Requires running daemon. Tests the /export HTTP endpoint.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { DEFAULT_PORT, DEFAULT_HOST } from "../shared/constants.ts";

const EXPORT_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/export`;

async function isDaemonRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`, {
      signal: AbortSignal.timeout(1000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe("export endpoint", () => {
  let daemonWasRunning = false;

  beforeAll(async () => {
    daemonWasRunning = await isDaemonRunning();
    if (!daemonWasRunning) {
      console.log("  [skip] Daemon not running — export tests will be skipped");
    }
  });

  test("/export returns valid JSON with default params", async () => {
    if (!daemonWasRunning) return;

    const res = await fetch(EXPORT_URL, { signal: AbortSignal.timeout(5000) });
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("application/json");

    const data = await res.json() as any;
    expect(data).toHaveProperty("exported_at");
    expect(data).toHaveProperty("version");
    expect(data).toHaveProperty("sessions");
    expect(data).toHaveProperty("observations");
    expect(Array.isArray(data.sessions)).toBe(true);
    expect(Array.isArray(data.observations)).toBe(true);
  });

  test("/export?format=markdown returns markdown", async () => {
    if (!daemonWasRunning) return;

    const res = await fetch(`${EXPORT_URL}?format=markdown`, {
      signal: AbortSignal.timeout(5000)
    });
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("text/markdown");

    const text = await res.text();
    expect(text).toContain("# LongMem Export");
    expect(text).toContain("**Exported:**");
    expect(text).toContain("**Sessions:**");
  });

  test("/export?days=7 filters by days", async () => {
    if (!daemonWasRunning) return;

    const res = await fetch(`${EXPORT_URL}?days=7`, {
      signal: AbortSignal.timeout(5000)
    });
    expect(res.ok).toBe(true);

    const data = await res.json() as any;
    expect(data).toHaveProperty("options");
    expect(data.options?.days).toBe(7);
  });

  test("/export?project=myapp filters by project", async () => {
    if (!daemonWasRunning) return;

    const res = await fetch(`${EXPORT_URL}?project=myapp`, {
      signal: AbortSignal.timeout(5000)
    });
    expect(res.ok).toBe(true);

    const data = await res.json() as any;
    expect(data).toHaveProperty("options");
    expect(data.options?.project).toBe("myapp");
  });

  test("/export?include_raw=true includes raw fields", async () => {
    if (!daemonWasRunning) return;

    const res = await fetch(`${EXPORT_URL}?include_raw=true`, {
      signal: AbortSignal.timeout(5000)
    });
    expect(res.ok).toBe(true);

    const data = await res.json() as any;
    expect(data.options?.includeRaw).toBe(true);
  });

  test("/export?days=0 returns 400 error", async () => {
    if (!daemonWasRunning) return;

    const res = await fetch(`${EXPORT_URL}?days=0`, {
      signal: AbortSignal.timeout(5000)
    });
    expect(res.status).toBe(400);

    const data = await res.json() as any;
    expect(data).toHaveProperty("error");
    expect(data.error).toContain("days must be between 1 and 365");
  });

  test("/export?days=400 returns 400 error", async () => {
    if (!daemonWasRunning) return;

    const res = await fetch(`${EXPORT_URL}?days=400`, {
      signal: AbortSignal.timeout(5000)
    });
    expect(res.status).toBe(400);

    const data = await res.json() as any;
    expect(data).toHaveProperty("error");
    expect(data.error).toContain("days must be between 1 and 365");
  });

  test("/export combined filters work", async () => {
    if (!daemonWasRunning) return;

    const res = await fetch(`${EXPORT_URL}?project=test&days=30&format=json&include_raw=true`, {
      signal: AbortSignal.timeout(5000)
    });
    expect(res.ok).toBe(true);

    const data = await res.json() as any;
    expect(data.options?.project).toBe("test");
    expect(data.options?.days).toBe(30);
    expect(data.options?.includeRaw).toBe(true);
  });
});