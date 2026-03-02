import { basename } from "path";

const binName = basename(process.argv[1] || process.argv[0]);

switch (binName) {
  case "longmemd":     await import("./daemon/server.ts"); break;
  case "longmem-mcp":  await import("./mcp/server.ts"); break;
  case "longmem-hook": await import("./hooks/main.ts"); break;
  case "longmem-cli":  await import("./install.ts"); break;
  default: {
    const sub = process.argv[2];
    process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
    switch (sub) {
      case "daemon": await import("./daemon/server.ts"); break;
      case "mcp":    await import("./mcp/server.ts"); break;
      case "hook":   await import("./hooks/main.ts"); break;
      case "export": await import("./cli/export.ts"); break;
      default:       await import("./install.ts"); break;
    }
  }
}
