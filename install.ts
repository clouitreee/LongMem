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
import { createInterface } from "readline";
import { detectEnvironment, printDetectionSummary } from "./shared/detect.ts";
import { runCoupleFlow } from "./shared/couple.ts";
import { installService } from "./shared/service-unit.ts";
import { verifyInstallation } from "./shared/verify.ts";
import { scanEcosystem, printEcosystemSummary } from "./shared/ecosystem.ts";
import { runTuiConfig } from "./shared/tui-config.ts";

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

// ─── Persistent Readline ────────────────────────────────────────────────────
// Single readline for the entire installer — fixes stdin corruption bug
// where creating/destroying multiple readline interfaces on process.stdin
// causes the 3rd+ instance to get an immediate 'close' event in Bun.

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  if (flags.yes) return Promise.resolve(defaultYes);
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  return new Promise((resolve) => {
    rl.question(`  ${question} ${suffix}: `, (answer: string) => {
      const a = answer.trim().toLowerCase();
      if (a === "") return resolve(defaultYes);
      resolve(a === "y" || a === "yes");
    });
  });
}

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
  rl.close();
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
    rl.close();
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
}, askYesNo);

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
      shouldInstall = await askYesNo("Install system service for daemon auto-start on login?", true);
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
      shouldIngest = await askYesNo("Index these into LongMem memory?", true);
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

          // Offer cleanup — move source files to backup now that they're in LongMem
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

            // Default NO — destructive action. --yes does NOT auto-remove.
            const shouldRemove = await askYesNo("Remove them?", false);

            if (shouldRemove) {
              let removed = 0;
              for (const f of removable) {
                try {
                  // Move to backup, not rm
                  const ts = new Date().toISOString().replace(/[:.]/g, "-");
                  const bakPath = `${f.path}.longmem-backup-${ts}`;
                  const { renameSync } = require("fs");
                  renameSync(f.path, bakPath);
                  removed++;
                } catch {
                  // Fallback: try unlinkSync if rename fails (cross-device)
                  try { unlinkSync(f.path); removed++; } catch {}
                }
              }
              console.log(`  ${GREEN}✓${RESET} Moved ${removed} file(s) to backup\n`);
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

// ─── 8. Compression Config (TUI) ────────────────────────────────────────────

if (!flags.dryRun) {
  const settingsPath = join(MEMORY_DIR, "settings.json");
  let needsConfig = false;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    needsConfig = !settings.compression?.apiKey;
  } catch {}

  if (needsConfig && !flags.yes) {
    const wantsConfigure = await askYesNo("Configure compression now?", true);

    // Close our readline BEFORE clack takes over stdin
    rl.close();

    if (wantsConfigure) {
      await runTuiConfig();
    } else {
      console.log(`\n  ${YELLOW}⚠${RESET}  No API key — compression disabled.`);
      console.log(`  Run ${BOLD}bun install.ts${RESET} again to configure later.\n`);
    }
  } else {
    rl.close();
  }
} else {
  rl.close();
}

// ─── 9. Final Summary ───────────────────────────────────────────────────────

if (!flags.dryRun) {
  console.log(`${BOLD}══ LongMem is ready! ════════════════════════════════════${RESET}\n`);
  console.log("  MCP tools available to the LLM:");
  console.log("    mem_search   — search past sessions");
  console.log("    mem_timeline — chronological context");
  console.log("    mem_get      — full observation details");
  console.log("");
  console.log("  Changes take effect in your next Claude Code session.");
  console.log("");
}
