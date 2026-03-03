#!/usr/bin/env bun
import { DaemonClient } from "../shared/daemon-client.ts";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const MEMORY_DIR = join(homedir(), ".longmem");

async function main(): Promise<void> {
  const client = new DaemonClient();
  
  const healthy = await client.health();
  
  console.log(`Daemon: ${healthy ? "running" : "stopped"}`);
  
  const versionPath = join(MEMORY_DIR, "version");
  if (existsSync(versionPath)) {
    console.log(`Version: ${readFileSync(versionPath, "utf-8").trim()}`);
  }
  
  const dbPath = join(MEMORY_DIR, "memory.db");
  if (existsSync(dbPath)) {
    const stats = Bun.file(dbPath).size;
    const sizeMB = (stats / 1024 / 1024).toFixed(2);
    console.log(`Database: ${sizeMB} MB`);
  }
  
  process.exit(healthy ? 0 : 1);
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});