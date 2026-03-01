#!/usr/bin/env bun
/**
 * LongMem — unified installer with auto-detection & permission flow.
 *
 * Usage:
 *   bun install.ts              # Detect & configure all found clients
 *   bun install.ts --yes        # Skip all prompts (answer Y)
 *   bun install.ts --dry-run    # Preview without modifying anything
 *   bun install.ts --no-service # Don't install systemd/launchd unit
 *   bun install.ts --opencode   # Also look for OpenCode
 *   bun install.ts --all        # Same as --opencode
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { detectEnvironment, printDetectionSummary } from "./shared/detect.ts";
import { runCoupleFlow } from "./shared/couple.ts";
import { installService } from "./shared/service-unit.ts";
import { verifyInstallation } from "./shared/verify.ts";
import { scanEcosystem, printEcosystemSummary } from "./shared/ecosystem.ts";

const MEMORY_DIR = join(homedir(), ".longmem");
const DIST_DIR = join(import.meta.dir, "dist");

// ─── Parse Args ─────────────────────────────────────────────────────────────

interface Flags {
  yes: boolean;
  dryRun: boolean;
  noService: boolean;
  opencode: boolean;
}

function parseArgs(argv: string[]): Flags {
  return {
    yes: argv.includes("--yes") || argv.includes("-y"),
    dryRun: argv.includes("--dry-run"),
    noService: argv.includes("--no-service"),
    opencode: argv.includes("--opencode") || argv.includes("--all"),
  };
}

const flags = parseArgs(process.argv.slice(2));

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// ─── Banner ─────────────────────────────────────────────────────────────────

console.log(`${BOLD}╔══════════════════════════════════╗${RESET}`);
console.log(`${BOLD}║       LongMem installer          ║${RESET}`);
console.log(`${BOLD}╚══════════════════════════════════╝${RESET}`);
console.log("");

if (flags.dryRun) {
  console.log(`${YELLOW}  (dry-run mode — no files will be modified)${RESET}\n`);
}

// ─── 1. Detect Environment ──────────────────────────────────────────────────

console.log("Scanning...\n");
const detection = await detectEnvironment();
printDetectionSummary(detection);

if (detection.clients.length === 0) {
  console.log("No supported clients found.");
  console.log("Install Claude Code CLI or OpenCode first, then re-run this installer.");
  process.exit(1);
}

// ─── 2. Handle Update Flow ──────────────────────────────────────────────────

if (detection.existingInstall) {
  const versionFile = join(MEMORY_DIR, "version");
  const oldVersion = existsSync(versionFile) ? readFileSync(versionFile, "utf-8").trim() : "unknown";
  console.log(`  Existing install detected (${oldVersion})`);

  if (detection.daemon.running) {
    console.log("  Stopping daemon for update...");
    try {
      await fetch("http://127.0.0.1:38741/shutdown", {
        method: "POST",
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // Try pkill as fallback
      try {
        Bun.spawnSync(["pkill", "-f", "longmemd"]);
      } catch {}
    }
    await Bun.sleep(1000);
  }
  console.log("");
}

// ─── 3. Install Files to ~/.longmem/ ────────────────────────────────────────

if (!flags.dryRun) {
  // Create dirs
  mkdirSync(join(MEMORY_DIR, "hooks"), { recursive: true });
  mkdirSync(join(MEMORY_DIR, "logs"), { recursive: true });
  mkdirSync(join(MEMORY_DIR, "bin"), { recursive: true });
  chmodSync(MEMORY_DIR, 0o700);

  // Copy compiled JS files (bun mode)
  const jsFiles: [string, string][] = [
    [join(DIST_DIR, "daemon.js"), join(MEMORY_DIR, "daemon.js")],
    [join(DIST_DIR, "mcp.js"), join(MEMORY_DIR, "mcp.js")],
    [join(DIST_DIR, "hooks", "post-tool.js"), join(MEMORY_DIR, "hooks", "post-tool.js")],
    [join(DIST_DIR, "hooks", "prompt.js"), join(MEMORY_DIR, "hooks", "prompt.js")],
    [join(DIST_DIR, "hooks", "stop.js"), join(MEMORY_DIR, "hooks", "stop.js")],
  ];

  let jsCount = 0;
  for (const [src, dst] of jsFiles) {
    if (existsSync(src)) {
      copyFileSync(src, dst);
      jsCount++;
    }
  }

  // Copy compiled binaries if they exist
  const binFiles: [string, string][] = [
    [join(DIST_DIR, "bin", `longmemd-${detection.platform}`), join(MEMORY_DIR, "bin", "longmemd")],
    [join(DIST_DIR, "bin", `longmem-mcp-${detection.platform}`), join(MEMORY_DIR, "bin", "longmem-mcp")],
    [join(DIST_DIR, "bin", `longmem-hook-${detection.platform}`), join(MEMORY_DIR, "bin", "longmem-hook")],
  ];

  let binCount = 0;
  for (const [src, dst] of binFiles) {
    if (existsSync(src)) {
      copyFileSync(src, dst);
      chmodSync(dst, 0o755);
      binCount++;
    }
  }

  if (binCount > 0) {
    console.log(`${GREEN}✓${RESET} Copied ${binCount} binaries`);
  }
  if (jsCount > 0) {
    console.log(`${GREEN}✓${RESET} Copied ${jsCount} JS modules`);
  }
  if (binCount === 0 && jsCount === 0) {
    console.error("✗ No built files found. Run: bun run build");
    process.exit(1);
  }

  // Create settings.json with defaults (never overwrite existing)
  const settingsPath = join(MEMORY_DIR, "settings.json");
  if (!existsSync(settingsPath)) {
    const defaultSettings = {
      compression: {
        enabled: true,
        provider: "openrouter",
        model: "meta-llama/llama-3.1-8b-instruct",
        apiKey: "",
        maxConcurrent: 1,
        idleThresholdSeconds: 5,
        maxPerMinute: 10,
      },
      daemon: { port: 38741 },
      privacy: { redactSecrets: true },
    };
    writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));
    chmodSync(settingsPath, 0o600);
    console.log(`${GREEN}✓${RESET} Created ${settingsPath}`);
    console.log(`  ${YELLOW}⚠${RESET}  Set your API key in settings.json to enable compression`);
  } else {
    console.log(`${GREEN}✓${RESET} ${settingsPath} preserved`);
  }

  console.log("");
}

// ─── 4. Interactive Permission Flow ─────────────────────────────────────────

const coupleResult = await runCoupleFlow(detection, {
  yes: flags.yes,
  dryRun: flags.dryRun,
  skipDaemon: flags.noService,
});

// ─── 5. Daemon Service ──────────────────────────────────────────────────────

if (!flags.noService && !flags.dryRun) {
  // Resolve daemon executable
  const binaryDaemon = join(MEMORY_DIR, "bin", "longmemd");
  const scriptDaemon = join(MEMORY_DIR, "daemon.js");

  let daemonExec: string;
  if (existsSync(binaryDaemon)) {
    daemonExec = binaryDaemon;
  } else if (existsSync(scriptDaemon)) {
    const bunPath = detection.bunPath || "bun";
    daemonExec = `${bunPath} run ${scriptDaemon}`;
  } else {
    console.log(`${YELLOW}⚠${RESET}  No daemon executable found — skipping service install`);
    daemonExec = "";
  }

  if (daemonExec) {
    let shouldInstall = flags.yes;
    if (!shouldInstall && !detection.daemon.serviceInstalled) {
      process.stdout.write(`  Install system service for daemon auto-start on login? [Y/n]: `);
      shouldInstall = await new Promise<boolean>((resolve) => {
        const { createInterface } = require("readline");
        const rl = createInterface({ input: process.stdin, terminal: false });
        rl.once("line", (line: string) => {
          rl.close();
          const answer = line.trim().toLowerCase();
          resolve(answer === "" || answer === "y" || answer === "yes");
        });
        rl.once("close", () => resolve(true));
      });
    } else if (detection.daemon.serviceInstalled) {
      shouldInstall = true; // Re-install to update paths
    }

    if (shouldInstall) {
      const svcResult = await installService(daemonExec, detection.platform);
      if (svcResult.installed) {
        console.log(`${GREEN}✓${RESET} Installed ${svcResult.type} service at ${svcResult.path}`);
      } else {
        console.log(`${YELLOW}⚠${RESET}  Service install failed: ${svcResult.error}`);
        console.log("  Daemon will still auto-start via hook fallback.");
      }
    }
  }

  console.log("");
}

// ─── 6. Start Daemon + Verify ───────────────────────────────────────────────

if (!flags.dryRun) {
  // Start daemon if not already running
  try {
    const healthRes = await fetch("http://127.0.0.1:38741/health", {
      signal: AbortSignal.timeout(1000),
    });
    if (healthRes.ok) {
      console.log(`${GREEN}✓${RESET} Daemon already running`);
    }
  } catch {
    // Try to start it
    const binaryDaemon = join(MEMORY_DIR, "bin", "longmemd");
    const scriptDaemon = join(MEMORY_DIR, "daemon.js");

    let cmd: string[];
    if (existsSync(binaryDaemon)) {
      cmd = [binaryDaemon];
    } else {
      const bunPath = detection.bunPath || "bun";
      cmd = [bunPath, "run", scriptDaemon];
    }

    try {
      const child = Bun.spawn(cmd, {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.unref();
      await Bun.sleep(1500);
    } catch {}
  }

  console.log("");
  await verifyInstallation();

  // Write version file
  const versionFile = join(MEMORY_DIR, "version");
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf-8"));
    writeFileSync(versionFile, pkg.version || "1.0.0");
  } catch {
    writeFileSync(versionFile, "1.0.0");
  }
} else {
  console.log(`\n${YELLOW}(dry-run complete — no changes were made)${RESET}\n`);
}

// ─── 7. Ecosystem Scan ──────────────────────────────────────────────────────

if (!flags.dryRun) {
  const ecoscan = scanEcosystem();

  if (ecoscan.files.length > 0) {
    printEcosystemSummary(ecoscan);

    let shouldIngest = flags.yes;
    if (!shouldIngest) {
      process.stdout.write(`  Index these into LongMem memory? [Y/n]: `);
      shouldIngest = await new Promise<boolean>((resolve) => {
        const { createInterface } = require("readline");
        const rl = createInterface({ input: process.stdin, terminal: false });
        rl.once("line", (line: string) => {
          rl.close();
          const answer = line.trim().toLowerCase();
          resolve(answer === "" || answer === "y" || answer === "yes");
        });
        rl.once("close", () => resolve(true));
      });
    }

    if (shouldIngest) {
      try {
        const payload = ecoscan.files.map(f => ({
          path: f.path,
          content: f.content,
          hash: f.hash,
          source: f.source,
        }));

        const res = await fetch("http://127.0.0.1:38741/ecosystem/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: payload }),
          signal: AbortSignal.timeout(10000),
        });

        if (res.ok) {
          const result = await res.json() as any;
          console.log(`  ${GREEN}✓${RESET} Indexed ${result.ingested} file(s) into memory (${result.skipped} unchanged)\n`);

          // Offer cleanup — remove source files now that they're in LongMem
          const removable = ecoscan.files.filter(f =>
            f.source === "claude-memory" || f.source === "claude-global"
          );

          if (removable.length > 0) {
            console.log("── Cleanup ──────────────────────────────────────────────\n");
            console.log("  LongMem will manage your memory from now on.\n");
            console.log("  These files are now indexed and can be removed:");
            for (const f of removable) {
              const sizeKB = (f.size / 1024).toFixed(1);
              console.log(`    ${f.path} (${sizeKB}KB)`);
            }
            console.log("");

            // Default NO — destructive action
            let shouldRemove = false;
            if (!flags.yes) {
              process.stdout.write(`  Remove them? [y/N]: `);
              shouldRemove = await new Promise<boolean>((resolve) => {
                const { createInterface } = require("readline");
                const rl = createInterface({ input: process.stdin, terminal: false });
                rl.once("line", (line: string) => {
                  rl.close();
                  const answer = line.trim().toLowerCase();
                  resolve(answer === "y" || answer === "yes");
                });
                rl.once("close", () => resolve(false));
              });
            }
            // --yes does NOT auto-remove. Destructive action requires explicit confirmation.

            if (shouldRemove) {
              let removed = 0;
              for (const f of removable) {
                try {
                  unlinkSync(f.path);
                  removed++;
                } catch {}
              }
              console.log(`  ${GREEN}✓${RESET} Removed ${removed} file(s)\n`);
            } else {
              console.log("  Kept original files.\n");
            }
          }
        } else {
          console.log(`  ${YELLOW}⚠${RESET}  Ingest failed (HTTP ${res.status}) — memory will build up naturally\n`);
        }
      } catch {
        console.log(`  ${YELLOW}⚠${RESET}  Could not reach daemon for ingest — memory will build up naturally\n`);
      }
    } else {
      console.log("  Skipped ecosystem indexing.\n");
    }
  }
} else if (flags.dryRun) {
  const ecoscan = scanEcosystem();
  if (ecoscan.files.length > 0) {
    printEcosystemSummary(ecoscan);
    console.log(`  ${YELLOW}(dry-run)${RESET} Would index ${ecoscan.files.length} file(s) into memory\n`);
  }
}

// ─── 8. Final Notes ─────────────────────────────────────────────────────────

if (!flags.dryRun) {
  const settingsPath = join(MEMORY_DIR, "settings.json");
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!settings.compression?.apiKey) {
      console.log("Next step: set your compression API key:");
      console.log(`  nano ${settingsPath}`);
      console.log("  (compression works without a key — observations are stored raw)\n");
    }
  } catch {}

  console.log("MCP tools available to the LLM:");
  console.log("  mem_search   — search past sessions");
  console.log("  mem_timeline — chronological context");
  console.log("  mem_get      — full observation details");
  console.log("");
}
