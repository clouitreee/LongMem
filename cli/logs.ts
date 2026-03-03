#!/usr/bin/env bun
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { LOGS_DIR, MEMORY_DIR_NAME } from "../shared/constants.ts";

const LOG_FILE = join(LOGS_DIR, "daemon.log");

function printHelp(): void {
  console.log(`
longmem logs - View recent daemon logs

Usage:
  longmem logs [options]

Options:
  -n, --lines <n>   Number of lines to show (default: 50)
  -f, --follow      Follow log output (tail -f)
  -h, --help        Show this help
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  let lines = 50;
  let follow = false;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "-n" || arg === "--lines") {
      lines = parseInt(args[++i], 10) || 50;
    } else if (arg === "-f" || arg === "--follow") {
      follow = true;
    }
  }
  
  if (!existsSync(LOG_FILE)) {
    console.log("No logs found. Daemon may not have started yet.");
    process.exit(0);
  }
  
  if (follow) {
    const child = Bun.spawn(["tail", "-f", LOG_FILE], { stdio: ["ignore", "inherit", "inherit"] });
    await child.exited;
  } else {
    const content = readFileSync(LOG_FILE, "utf-8");
    const allLines = content.trim().split("\n");
    const lastLines = allLines.slice(-lines);
    console.log(lastLines.join("\n"));
  }
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});