import { basename } from "path";

// Bun compiled: argv = [binary_path, binary_path, ...user_args]
const binName = basename(process.argv[1] || process.argv[0]);

switch (binName) {
  case "longmemd":     await import("./daemon/server.ts"); break;
  case "longmem-mcp":  await import("./mcp/server.ts"); break;
  case "longmem-hook": await import("./hooks/main.ts"); break;
  case "longmem-cli":  await import("./install.ts"); break;
  default: {
    // Subcommand mode: longmem <daemon|mcp|hook|cli> [args...]
    const sub = process.argv[2];
    // Shift argv so the imported module sees args in expected positions
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    switch (sub) {
      case "daemon": await import("./daemon/server.ts"); break;
      case "mcp":    await import("./mcp/server.ts"); break;
      case "hook":   await import("./hooks/main.ts"); break;
      default:       await import("./install.ts"); break;
    }
  }
}
