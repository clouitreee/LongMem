#!/usr/bin/env bun
import { DaemonClient } from "../shared/daemon-client.ts";
import { existsSync } from "fs";
import { MEMORY_DIR, VERSION_FILE, DEFAULT_DB_PATH } from "../shared/constants.ts";

async function main(): Promise<void> {
  const client = new DaemonClient();
  
  const healthy = await client.health();
  
  console.log(`Daemon: ${healthy ? "running" : "stopped"}`);
  
  if (existsSync(VERSION_FILE)) {
    const { readFileSync } = await import("fs");
    console.log(`Version: ${readFileSync(VERSION_FILE, "utf-8").trim()}`);
  }
  
  if (existsSync(DEFAULT_DB_PATH)) {
    const stats = Bun.file(DEFAULT_DB_PATH).size;
    const sizeMB = (stats / 1024 / 1024).toFixed(2);
    console.log(`Database: ${sizeMB} MB`);
  }
  
  process.exit(healthy ? 0 : 1);
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});