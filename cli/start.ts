#!/usr/bin/env bun
import { existsSync } from "fs";
import { join } from "path";
import { DaemonClient } from "../shared/daemon-client.ts";
import { MEMORY_DIR, BIN_DIR, LOGS_DIR, DEFAULT_HOST, DEFAULT_PORT } from "../shared/constants.ts";

async function main(): Promise<void> {
  const client = new DaemonClient();
  
  const healthy = await client.health();
  if (healthy) {
    console.log("Daemon already running.");
    process.exit(0);
  }

  const binaryDaemon = join(BIN_DIR, "longmemd");
  const scriptDaemon = join(MEMORY_DIR, "daemon.js");

  let cmd: string[];
  if (existsSync(binaryDaemon)) {
    cmd = [binaryDaemon];
  } else if (existsSync(scriptDaemon)) {
    cmd = ["bun", "run", scriptDaemon];
  } else {
    console.error("Error: Daemon not found. Run `longmem --tui` to install.");
    process.exit(1);
  }

  console.log("Starting daemon...");
  
  const child = Bun.spawn(cmd, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();

  await Bun.sleep(1500);

  const started = await client.health();
  if (started) {
    console.log("Daemon started.");
  } else {
    console.error(`Error: Daemon failed to start. Check ${LOGS_DIR}/daemon.log`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});