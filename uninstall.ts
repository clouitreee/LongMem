#!/usr/bin/env bun
/**
 * LongMem — uninstaller with rollback.
 *
 * Usage:
 *   bun uninstall.ts              # Interactive uninstall
 *   bun uninstall.ts --yes        # Skip prompts
 *   bun uninstall.ts --dry-run    # Preview without modifying
 *   bun uninstall.ts --keep-data  # Keep memory.db (move everything else)
 */
import { existsSync, readFileSync, mkdirSync, readdirSync, renameSync, statSync, lstatSync } from "fs";
import { join, basename } from "path";
import { homedir, platform } from "os";
import { createInterface } from "readline";
import { decoupleClaudeCode, decoupleOpenCode } from "./shared/decouple.ts";
import { DEFAULT_PORT, DEFAULT_HOST, MEMORY_DIR, MEMORY_DIR_NAME, PID_FILE, DEFAULT_DB_NAME } from "./shared/constants.ts";

const HOME = homedir();

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// ─── Parse Args ─────────────────────────────────────────────────────────────

interface Flags {
  yes: boolean;
  dryRun: boolean;
  keepData: boolean;
}

function parseArgs(argv: string[]): Flags {
  return {
    yes: argv.includes("--yes") || argv.includes("-y"),
    dryRun: argv.includes("--dry-run"),
    keepData: argv.includes("--keep-data"),
  };
}

const flags = parseArgs(process.argv.slice(2));

// ─── Interactive Prompt ─────────────────────────────────────────────────────

async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  process.stdout.write(`  ${question} ${suffix}: `);

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.once("line", (line: string) => {
      rl.close();
      const answer = line.trim().toLowerCase();
      if (answer === "") return resolve(defaultYes);
      resolve(answer === "y" || answer === "yes");
    });
    rl.once("close", () => resolve(defaultYes));
  });
}

// ─── Banner ─────────────────────────────────────────────────────────────────

console.log(`${BOLD}╔══════════════════════════════════╗${RESET}`);
console.log(`${BOLD}║       LongMem uninstaller        ║${RESET}`);
console.log(`${BOLD}╚══════════════════════════════════╝${RESET}`);
console.log("");

if (flags.dryRun) {
  console.log(`${YELLOW}  (dry-run mode — no files will be modified)${RESET}\n`);
}

// ─── Check if installed ─────────────────────────────────────────────────────

if (!existsSync(MEMORY_DIR)) {
  console.log("  LongMem is not installed (~/.longmem not found).");
  console.log("  Nothing to do.\n");
  process.exit(0);
}

// Show what will be removed
console.log("  Installed at: ~/.longmem/");
try {
  const version = readFileSync(join(MEMORY_DIR, "version"), "utf-8").trim();
  console.log(`  Version: ${version}`);
} catch {
  console.log("  Version: unknown");
}

const dbPath = join(MEMORY_DIR, DEFAULT_DB_NAME);
if (existsSync(dbPath)) {
  try {
    const size = statSync(dbPath).size;
    console.log(`  Database: ${(size / 1024).toFixed(1)} KB`);
  } catch {}
}
console.log("");

// ─── Confirm ────────────────────────────────────────────────────────────────

if (!flags.yes && !flags.dryRun) {
  const confirmed = await askYesNo("Uninstall LongMem?", false);
  if (!confirmed) {
    console.log("\n  Cancelled.\n");
    process.exit(0);
  }
  console.log("");
}

const backups: string[] = [];

// ─── 1. Stop daemon ────────────────────────────────────────────────────────

console.log("── Step 1: Stop daemon ──────────────────────────────────");

if (!flags.dryRun) {
  let stopped = false;

  try {
    const res = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      console.log(`  ${GREEN}✓${RESET} Sent shutdown signal`);
      await Bun.sleep(1000);
      stopped = true;
    }
  } catch {}

  if (!stopped) {
    if (existsSync(PID_FILE)) {
      try {
        const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
        if (pid > 0) {
          try {
            process.kill(pid, 15);
            console.log(`  ${GREEN}✓${RESET} Sent SIGTERM to pid ${pid}`);
            await Bun.sleep(1000);
            stopped = true;
          } catch {}
        }
      } catch {}
    }
  }

  if (!stopped) {
    // pkill fallback
    try {
      Bun.spawnSync(["pkill", "-f", "longmemd"]);
      console.log(`  ${GREEN}✓${RESET} Killed via pkill`);
    } catch {}
  }

  // Verify stopped
  try {
    const res = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      console.log(`  ${YELLOW}⚠${RESET}  Daemon still running — continuing anyway`);
    }
  } catch {
    console.log(`  ${GREEN}✓${RESET} Daemon stopped`);
  }
} else {
  console.log(`  ${YELLOW}(dry-run)${RESET} Would stop daemon`);
}
console.log("");

// ─── 2. Remove system service ──────────────────────────────────────────────

console.log("── Step 2: Remove system service ────────────────────────");

const os = platform();
let serviceRemoved = false;

if (!flags.dryRun) {
  if (os === "linux") {
    const unitPath = join(HOME, ".config", "systemd", "user", "longmem.service");
    if (existsSync(unitPath)) {
      try {
        Bun.spawnSync(["systemctl", "--user", "stop", "longmem.service"]);
        Bun.spawnSync(["systemctl", "--user", "disable", "longmem.service"]);
      } catch {}
      // Move to backup
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const bakPath = `${unitPath}.uninstalled-${ts}.bak`;
      try {
        renameSync(unitPath, bakPath);
        backups.push(bakPath);
        console.log(`  ${GREEN}✓${RESET} Removed systemd service (backup: ${bakPath})`);
        serviceRemoved = true;
      } catch (e: any) {
        console.log(`  ${YELLOW}⚠${RESET}  Could not remove ${unitPath}: ${e.message}`);
      }
      try { Bun.spawnSync(["systemctl", "--user", "daemon-reload"]); } catch {}
    } else {
      console.log(`  No systemd service found`);
    }
  } else if (os === "darwin") {
    const plistPath = join(HOME, "Library", "LaunchAgents", "com.longmem.daemon.plist");
    if (existsSync(plistPath)) {
      try {
        Bun.spawnSync(["launchctl", "unload", plistPath]);
      } catch {}
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const bakPath = `${plistPath}.uninstalled-${ts}.bak`;
      try {
        renameSync(plistPath, bakPath);
        backups.push(bakPath);
        console.log(`  ${GREEN}✓${RESET} Removed launchd plist (backup: ${bakPath})`);
        serviceRemoved = true;
      } catch (e: any) {
        console.log(`  ${YELLOW}⚠${RESET}  Could not remove ${plistPath}: ${e.message}`);
      }
    } else {
      console.log(`  No launchd plist found`);
    }
  } else {
    console.log(`  No service manager detected on ${os}`);
  }
} else {
  console.log(`  ${YELLOW}(dry-run)${RESET} Would remove system service`);
}
console.log("");

// ─── 3. Restore client configs ─────────────────────────────────────────────

console.log("── Step 3: Restore client configs ───────────────────────");

// Claude Code
const claudeConfig = join(HOME, ".claude", "settings.json");
if (existsSync(claudeConfig)) {
  const result = decoupleClaudeCode(claudeConfig, flags.dryRun);
  for (const change of result.changes) {
    console.log(`  Claude Code: ${change}`);
  }
  if (result.backup) {
    backups.push(result.backup);
    console.log(`  ${GREEN}✓${RESET} Backup: ${result.backup}`);
  }
} else {
  console.log(`  Claude Code: no config found`);
}

// OpenCode
const openCodeConfigs = [
  join(HOME, ".config", "opencode", "config.json"),
  join(HOME, ".config", "opencode", "opencode.jsonc"),
];
let openCodePatched = false;
for (const ocConfig of openCodeConfigs) {
  if (existsSync(ocConfig)) {
    const result = decoupleOpenCode(ocConfig, flags.dryRun);
    for (const change of result.changes) {
      console.log(`  OpenCode: ${change}`);
    }
    if (result.backup) {
      backups.push(result.backup);
      console.log(`  ${GREEN}✓${RESET} Backup: ${result.backup}`);
    }
    openCodePatched = true;
    break;
  }
}
if (!openCodePatched) {
  console.log(`  OpenCode: no config found`);
}
console.log("");

// ─── 4. Move ~/.longmem to backup ─────────────────────────────────────────

console.log("── Step 4: Move ~/.longmem to backup ───────────────────");

if (!flags.dryRun) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(HOME, `.longmem.backup-${ts}`);

  if (flags.keepData) {
    // Move everything EXCEPT memory.db
    mkdirSync(backupDir, { recursive: true });
    const entries = readdirSync(MEMORY_DIR);
    let moved = 0;
    for (const entry of entries) {
      if (entry === DEFAULT_DB_NAME || entry === `${DEFAULT_DB_NAME}-wal` || entry === `${DEFAULT_DB_NAME}-shm`) {
        continue; // Keep database files in place
      }
      const src = join(MEMORY_DIR, entry);
      const dst = join(backupDir, entry);
      try {
        // Don't follow symlinks
        const stat = lstatSync(src);
        if (stat.isSymbolicLink()) {
          console.log(`  ${YELLOW}⚠${RESET}  Skipping symlink: ${entry}`);
          continue;
        }
        renameSync(src, dst);
        moved++;
      } catch (e: any) {
        console.log(`  ${YELLOW}⚠${RESET}  Could not move ${entry}: ${e.message}`);
      }
    }
    backups.push(backupDir);
    console.log(`  ${GREEN}✓${RESET} Moved ${moved} items to ${backupDir}`);
    console.log(`  ${GREEN}✓${RESET} Kept memory.db in ~/.longmem/`);
  } else {
    // Move entire directory
    try {
      renameSync(MEMORY_DIR, backupDir);
      backups.push(backupDir);
      console.log(`  ${GREEN}✓${RESET} Moved ~/.longmem/ → ${backupDir}`);
    } catch (e: any) {
      console.log(`  ${RED}✗${RESET} Failed to move ~/.longmem: ${e.message}`);
      console.log(`  Try manually: mv ~/.longmem ${backupDir}`);
    }
  }
} else {
  if (flags.keepData) {
    console.log(`  ${YELLOW}(dry-run)${RESET} Would move ~/.longmem/ to backup (keeping memory.db)`);
  } else {
    console.log(`  ${YELLOW}(dry-run)${RESET} Would move ~/.longmem/ to backup`);
  }
}
console.log("");

// ─── Summary ────────────────────────────────────────────────────────────────

if (flags.dryRun) {
  console.log(`${YELLOW}(dry-run complete — no changes were made)${RESET}\n`);
} else {
  console.log(`${BOLD}══ LongMem uninstalled ═══════════════════════════════════${RESET}\n`);

  if (backups.length > 0) {
    console.log("  Backups created:");
    for (const b of backups) {
      console.log(`    ${b}`);
    }
    console.log("");
    console.log("  To restore, reverse the moves:");
    for (const b of backups) {
      if (b.includes(".longmem.backup-")) {
        console.log(`    mv ${b} ~/.longmem`);
      } else {
        // Config file backup
        const original = b.replace(/\.pre-longmem-uninstall-[^.]+\.bak$/, "")
                          .replace(/\.uninstalled-[^.]+\.bak$/, "");
        console.log(`    cp ${b} ${original}`);
      }
    }
    console.log("");
  }

  console.log("  To reinstall: bun install.ts\n");
}
