#!/usr/bin/env bun
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { DaemonClient } from "../shared/daemon-client.ts";

const MEMORY_DIR = join(homedir(), ".longmem");

async function main(): Promise<void> {
  const client = new DaemonClient();
  
  const healthy = await client.health();
  if (healthy) {
    console.log("Daemon already running.");
    process.exit(0);
  }

  const binaryDaemon = join(MEMORY_DIR, "bin", "longmemd");
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
    console.error("Error: Daemon failed to start. Check ~/.longmem/logs/daemon.log");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});