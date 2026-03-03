#!/usr/bin/env bun
import { DaemonClient } from "../shared/daemon-client.ts";
import { DEFAULT_PORT } from "../shared/constants.ts";

async function main(): Promise<void> {
  const client = new DaemonClient();
  
  const healthy = await client.health();
  if (!healthy) {
    console.error("Error: Daemon not running. Start with: longmem start");
    process.exit(1);
  }

  try {
    const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/stats`, {
      signal: AbortSignal.timeout(5000),
    });
    
    if (!res.ok) {
      console.error("Error: Failed to get stats.");
      process.exit(1);
    }
    
    const stats = await res.json() as any;
    
    console.log("LongMem Statistics");
    console.log("===================");
    console.log(`Sessions: ${stats.totalSessions ?? "N/A"}`);
    console.log(`Observations: ${stats.totalObservations ?? "N/A"}`);
    console.log(`User observations: ${stats.totalUserObservations ?? "N/A"}`);
    console.log(`Concepts: ${stats.totalConcepts ?? "N/A"}`);
    console.log(`Pending compressions: ${stats.pendingCompressions ?? "N/A"}`);
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

main();