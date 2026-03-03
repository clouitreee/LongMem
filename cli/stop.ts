#!/usr/bin/env bun
import { DaemonClient } from "../shared/daemon-client.ts";
import { DEFAULT_PORT } from "../shared/constants.ts";

async function main(): Promise<void> {
  const client = new DaemonClient();
  
  const healthy = await client.health();
  if (!healthy) {
    console.log("Daemon not running.");
    process.exit(0);
  }

  try {
    await fetch(`http://127.0.0.1:${DEFAULT_PORT}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
    console.log("Daemon stopped.");
  } catch {
    console.error("Error: Failed to stop daemon.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});