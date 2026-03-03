import { basename } from "path";
import { existsSync, readFileSync } from "fs";
import { join, homedir } from "path";

const binName = basename(process.argv[1] || process.argv[0]);

function printHelp(): void {
  console.log(`
longmem - Persistent memory for AI coding assistants

Usage:
  longmem [command] [options]

Commands:
  start       Start the memory daemon
  stop        Stop the memory daemon
  status      Check daemon status
  stats       Show memory statistics
  logs        View recent daemon logs
  export      Export memory to JSON/Markdown
  daemon      Run daemon directly (for debugging)
  mcp         Run MCP server directly (for debugging)
  hook        Run hook directly (for debugging)
  --tui       Launch setup wizard
  --version   Show version
  --help      Show this help

Examples:
  longmem                  # Launch setup wizard
  longmem start            # Start daemon
  longmem status           # Check if daemon is running
  longmem export > backup.json
  longmem export --format markdown --days 30 > report.md
`);
}

function printVersion(): void {
  const versionPath = join(homedir(), ".longmem", "version");
  if (existsSync(versionPath)) {
    console.log(readFileSync(versionPath, "utf-8").trim());
  } else {
    console.log("dev");
  }
}

switch (binName) {
  case "longmemd": await import("./daemon/server.ts"); break;
  case "longmem-mcp": await import("./mcp/server.ts"); break;
  case "longmem-hook": await import("./hooks/main.ts"); break;
  case "longmem-cli": await import("./install.ts"); break;
  default: {
    const sub = process.argv[2];
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    switch (sub) {
      case "daemon": await import("./daemon/server.ts"); break;
      case "mcp": await import("./mcp/server.ts"); break;
      case "hook": await import("./hooks/main.ts"); break;
      case "export": await import("./cli/export.ts"); break;
      case "start": await import("./cli/start.ts"); break;
      case "stop": await import("./cli/stop.ts"); break;
      case "status": await import("./cli/status.ts"); break;
      case "stats": await import("./cli/stats.ts"); break;
      case "logs": await import("./cli/logs.ts"); break;
      case "--tui":
      case "-t": await import("./install.ts"); break;
      case "--version":
      case "-v": printVersion(); break;
      case "--help":
      case "-h": printHelp(); break;
      default: await import("./install.ts"); break;
    }
  }
}