#!/usr/bin/env bun
/**
 * LongMem — unified installer with auto-detection & TUI setup wizard.
 *
 * Usage:
 *   bun install.ts              # Full TUI setup wizard
 *   bun install.ts --yes        # Headless: no prompts
 *   bun install.ts --dry-run    # Preview without modifying anything
 *   bun install.ts --no-service # Don't install systemd/launchd unit
 *   bun install.ts --opencode   # Also look for OpenCode
 *   bun install.ts --all        # Same as --opencode
 *   bun install.ts --tui        # Force TUI even for re-configuration
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, symlinkSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { detectEnvironment, printDetectionSummary } from "./shared/detect.ts";
import { runCoupleFlow } from "./shared/couple.ts";
import { installService } from "./shared/service-unit.ts";
import { verifyInstallation } from "./shared/verify.ts";
import { scanEcosystem, printEcosystemSummary } from "./shared/ecosystem.ts";
import { runFullTui } from "./shared/tui.ts";

const MEMORY_DIR = join(homedir(), ".longmem");
const DIST_DIR = join(import.meta.dir, "dist");

// When running as compiled binary from ~/.longmem/bin/, dist/ won't exist
// but the binaries are already in place (downloaded by install.sh)
const hasDist = existsSync(DIST_DIR);
const binariesInPlace = existsSync(join(MEMORY_DIR, "bin", "longmem")) || existsSync(join(MEMORY_DIR, "bin", "longmemd"));

// ─── Parse Args ─────────────────────────────────────────────────────────────

interface Flags {
  yes: boolean;
  dryRun: boolean;
  noService: boolean;
  opencode: boolean;
  tui: boolean;
}

function parseArgs(argv: string[]): Flags {
  return {
    yes: argv.includes("--yes") || argv.includes("-y"),
    dryRun: argv.includes("--dry-run"),
    noService: argv.includes("--no-service"),
    opencode: argv.includes("--opencode") || argv.includes("--all"),
    tui: argv.includes("--tui"),
  };
}

const flags = parseArgs(process.argv.slice(2));

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// ─── Banner (skip if called from install.sh which already shows one) ────────

if (hasDist) {
  console.log(`${BOLD}\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557${RESET}`);
  console.log(`${BOLD}\u2551       LongMem installer          \u2551${RESET}`);
  console.log(`${BOLD}\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d${RESET}`);
  console.log("");
}

if (flags.dryRun) {
  console.log(`${YELLOW}  (dry-run mode \u2014 no files will be modified)${RESET}\n`);
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
  mkdirSync(join(MEMORY_DIR, "hooks"), { recursive: true });
  mkdirSync(join(MEMORY_DIR, "logs"), { recursive: true });
  mkdirSync(join(MEMORY_DIR, "bin"), { recursive: true });
  chmodSync(MEMORY_DIR, 0o700);

  if (!hasDist && binariesInPlace) {
    // Running as compiled binary — files already downloaded by install.sh
    console.log(`${GREEN}\u2713${RESET} Binaries already installed`);
  } else if (hasDist) {
    // Running from source — copy dist/ files to ~/.longmem/
    const jsFiles: [string, string][] = [
      [join(DIST_DIR, "daemon.js"), join(MEMORY_DIR, "daemon.js")],
      [join(DIST_DIR, "mcp.js"), join(MEMORY_DIR, "mcp.js")],
      [join(DIST_DIR, "hooks", "post-tool.js"), join(MEMORY_DIR, "hooks", "post-tool.js")],
      [join(DIST_DIR, "hooks", "prompt.js"), join(MEMORY_DIR, "hooks", "prompt.js")],
      [join(DIST_DIR, "hooks", "stop.js"), join(MEMORY_DIR, "hooks", "stop.js")],
    ];

    let jsCount = 0;
    for (const [src, dst] of jsFiles) {
      if (existsSync(src)) { copyFileSync(src, dst); jsCount++; }
    }

    const monolith = join(DIST_DIR, "bin", `longmem-${detection.platform}`);
    const dest = join(MEMORY_DIR, "bin", "longmem");
    let binCount = 0;
    if (existsSync(monolith)) {
      copyFileSync(monolith, dest);
      chmodSync(dest, 0o755);
      binCount = 1;
    }
    // Create symlinks for backward compatibility
    for (const name of ["longmemd", "longmem-mcp", "longmem-hook", "longmem-cli"]) {
      const link = join(MEMORY_DIR, "bin", name);
      try { unlinkSync(link); } catch {}
      symlinkSync("longmem", link);
    }

    if (binCount > 0) console.log(`${GREEN}\u2713${RESET} Copied ${binCount} binaries`);
    if (jsCount > 0) console.log(`${GREEN}\u2713${RESET} Copied ${jsCount} JS modules`);
    if (binCount === 0 && jsCount === 0) {
      console.error("\u2717 No built files found. Run: bun run build");
      process.exit(1);
    }
  } else {
    console.error("\u2717 No built files found and no binaries installed. Run: bun run build");
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
    console.log(`${GREEN}\u2713${RESET} Created ${settingsPath}`);
  } else {
    console.log(`${GREEN}\u2713${RESET} ${settingsPath} preserved`);
  }

  console.log("");
}

// ─── 4. Branch: TUI or Headless ─────────────────────────────────────────────

if (flags.tui || (!flags.yes && process.stdin.isTTY)) {
  // Interactive: full TUI
  await runFullTui({ detection, noService: flags.noService, dryRun: flags.dryRun });
} else {
  // Headless: couple + service + start + verify (no prompts)
  await applyHeadless(detection, flags);
}

// ─── Headless Flow ──────────────────────────────────────────────────────────

async function applyHeadless(detection: any, flags: Flags): Promise<void> {
  // Coupling
  await runCoupleFlow(detection, {
    yes: true,
    dryRun: flags.dryRun,
    skipDaemon: flags.noService,
  });

  // Service install
  if (!flags.noService && !flags.dryRun) {
    const binaryDaemon = join(MEMORY_DIR, "bin", "longmemd");
    const scriptDaemon = join(MEMORY_DIR, "daemon.js");
    let daemonExec = "";

    if (existsSync(binaryDaemon)) {
      daemonExec = binaryDaemon;
    } else if (existsSync(scriptDaemon)) {
      daemonExec = `${detection.bunPath || "bun"} run ${scriptDaemon}`;
    }

    if (daemonExec) {
      const svcResult = await installService(daemonExec, detection.platform);
      if (svcResult.installed) {
        console.log(`${GREEN}\u2713${RESET} Installed ${svcResult.type} service at ${svcResult.path}`);
      } else {
        console.log(`${YELLOW}\u26a0${RESET}  Service install failed: ${svcResult.error}`);
      }
    }
    console.log("");
  }

  // Start daemon + verify
  if (!flags.dryRun) {
    try {
      const healthRes = await fetch("http://127.0.0.1:38741/health", { signal: AbortSignal.timeout(1000) });
      if (healthRes.ok) console.log(`${GREEN}\u2713${RESET} Daemon already running`);
    } catch {
      const binaryDaemon = join(MEMORY_DIR, "bin", "longmemd");
      const scriptDaemon = join(MEMORY_DIR, "daemon.js");
      let cmd: string[];
      if (existsSync(binaryDaemon)) {
        cmd = [binaryDaemon];
      } else {
        cmd = [detection.bunPath || "bun", "run", scriptDaemon];
      }
      try {
        const child = Bun.spawn(cmd, { detached: true, stdio: ["ignore", "ignore", "ignore"] });
        child.unref();
        await Bun.sleep(1500);
      } catch {}
    }

    console.log("");
    await verifyInstallation();

    // Ecosystem scan
    const ecoscan = scanEcosystem();
    if (ecoscan.files.length > 0) {
      printEcosystemSummary(ecoscan);
      try {
        const payload = ecoscan.files.map(f => ({ path: f.path, content: f.content, hash: f.hash, source: f.source }));
        const res = await fetch("http://127.0.0.1:38741/ecosystem/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: payload }),
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const result = await res.json() as any;
          console.log(`  ${GREEN}\u2713${RESET} Indexed ${result.ingested} file(s) into memory (${result.skipped} unchanged)\n`);
        }
      } catch {}
    }

    // Write version file
    const versionFile = join(MEMORY_DIR, "version");
    try {
      const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf-8"));
      writeFileSync(versionFile, pkg.version || "1.0.0");
    } catch {
      writeFileSync(versionFile, "1.0.0");
    }
  } else {
    console.log(`\n${YELLOW}(dry-run complete \u2014 no changes were made)${RESET}\n`);
  }

  // Final summary
  if (!flags.dryRun) {
    console.log(`${BOLD}\u2550\u2550 LongMem is ready! \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${RESET}\n`);
    console.log("  MCP tools available to the LLM:");
    console.log("    mem_search   \u2014 search past sessions");
    console.log("    mem_timeline \u2014 chronological context");
    console.log("    mem_get      \u2014 full observation details");
    console.log("");
    console.log("  Changes take effect in your next Claude Code session.");
    console.log("");
  }
}
