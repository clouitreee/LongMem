/**
 * shared/tui.ts — Full setup wizard for LongMem.
 * Uses @clack/prompts for all interactive screens.
 * Single export: runFullTui(options?)
 */
import { existsSync, readFileSync, unlinkSync, readdirSync, rmdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import * as p from "@clack/prompts";
import { detectEnvironment, printDetectionSummary, type DetectionResult } from "./detect.ts";
import { runCoupleFlow } from "./couple.ts";
import { installService } from "./service-unit.ts";
import { verifyInstallation } from "./verify.ts";
import { scanEcosystem } from "./ecosystem.ts";
import { loadSettings, saveConfig, PROVIDERS } from "../daemon/config.ts";
import type { PrivacyMode } from "../daemon/config.ts";
import { DEFAULT_PORT } from "./constants.ts";

const HOME = homedir();
const MEMORY_DIR = join(HOME, ".longmem");

// ─── Provider definitions for compression ────────────────────────────────────

const COMPRESSION_PROVIDERS = [
  { value: "openrouter", label: "OpenRouter", hint: "cheapest, many models", defaultModel: "meta-llama/llama-3.1-8b-instruct" },
  { value: "openai", label: "OpenAI", hint: "reliable", defaultModel: "gpt-4o-mini" },
  { value: "anthropic", label: "Anthropic", hint: "via Anthropic API", defaultModel: "claude-haiku-4-5-20251001" },
  { value: "local", label: "Local (Ollama/LM Studio)", hint: "free, no API key needed", defaultModel: "llama3.1:8b" },
] as const;

// ─── Options ─────────────────────────────────────────────────────────────────

export interface TuiOptions {
  detection?: DetectionResult;
  noService?: boolean;
  dryRun?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cancelled(): never {
  p.cancel("Setup cancelled.");
  process.exit(0);
}

function resolveDaemonExec(detection: DetectionResult): string | null {
  const binaryDaemon = join(MEMORY_DIR, "bin", "longmemd");
  if (existsSync(binaryDaemon)) return binaryDaemon;

  const scriptDaemon = join(MEMORY_DIR, "daemon.js");
  if (existsSync(scriptDaemon)) {
    const bunPath = detection.bunPath || "bun";
    return `${bunPath} run ${scriptDaemon}`;
  }

  return null;
}

async function restartDaemon(detection: DetectionResult): Promise<void> {
  // Try graceful shutdown first
  try {
    await fetch(`http://127.0.0.1:${DEFAULT_PORT}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
    await Bun.sleep(1000);
  } catch {}

  // Start daemon
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

// ─── Main TUI ────────────────────────────────────────────────────────────────

export async function runFullTui(options: TuiOptions = {}): Promise<void> {
  // Non-TTY guard
  if (!process.stdin.isTTY) {
    console.error("Error: Interactive mode requires a terminal.");
    console.error("Use --yes for non-interactive mode.");
    process.exit(1);
  }

  const dryRun = options.dryRun ?? false;

  // ── Screen 1: Welcome + Detect ─────────────────────────────────────────────

  p.intro("LongMem Setup Wizard");

  let detection = options.detection;
  if (!detection) {
    const s = p.spinner();
    s.start("Detecting environment");
    detection = await detectEnvironment();
    s.stop("Environment detected");
  }

  // Show detection summary as a note
  const clientLines: string[] = [];
  for (const c of detection.clients) {
    const label = c.name === "claude-code" ? "Claude Code CLI" : "OpenCode";
    const ver = c.version ? ` v${c.version.replace(/^v/, "")}` : "";
    const status = c.alreadyPatched ? " (configured)" : "";
    clientLines.push(`  ${label}${ver}${status}`);
  }
  if (detection.daemon.installed) {
    const status = detection.daemon.running ? "running" : "stopped";
    clientLines.push(`  Daemon: ${detection.daemon.mode} mode, ${status}`);
  }
  p.note(clientLines.join("\n"), "Detected");

  if (detection.clients.length === 0) {
    p.log.error("No supported clients found. Install Claude Code CLI or OpenCode first.");
    process.exit(1);
  }

  // Load existing settings for screens 2-6
  const settings = loadSettings();
  let settingsChanged = false;
  let backupSettings: Record<string, any> | null = null;

  // ── Screen 2: Privacy Mode ─────────────────────────────────────────────────

  const currentMode: PrivacyMode = settings.privacy?.mode || "safe";

  const privacyMode = await p.select({
    message: "Privacy mode",
    initialValue: currentMode,
    options: [
      { value: "safe", label: "Safe (recommended)", hint: "redacts secrets, blocks sensitive files" },
      { value: "flexible", label: "Flexible", hint: "same as safe + custom redaction patterns" },
      { value: "none", label: "None", hint: "no redaction — only for fully local setups" },
    ],
  });

  if (p.isCancel(privacyMode)) cancelled();

  // Double confirm for "none"
  if (privacyMode === "none") {
    const warn1 = await p.confirm({
      message: "Warning: 'none' disables ALL secret redaction. API keys, passwords, and tokens will be stored in plaintext. Continue?",
      initialValue: false,
    });
    if (p.isCancel(warn1) || !warn1) cancelled();

    const warn2 = await p.confirm({
      message: "Are you sure? This cannot be undone for already-stored data.",
      initialValue: false,
    });
    if (p.isCancel(warn2) || !warn2) cancelled();
  }

  // Custom patterns for flexible mode
  let customPatterns = settings.privacy?.customPatterns || [];
  if (privacyMode === "flexible") {
    const patternsInput = await p.text({
      message: "Custom redaction patterns (comma-separated regexes, or blank to skip)",
      placeholder: "MYTOKEN-[a-z]{10,}, SECRET_[A-Z]+",
      defaultValue: customPatterns.map((cp: any) => cp.pattern).join(", "),
    });

    if (p.isCancel(patternsInput)) cancelled();

    if (patternsInput && patternsInput.trim()) {
      customPatterns = patternsInput.split(",").map((s: string) => s.trim()).filter(Boolean).map((pattern: string) => ({
        pattern,
        name: `custom-${pattern.slice(0, 20)}`,
      }));
    }
  }

  // Apply privacy settings
  settings.privacy = {
    ...settings.privacy,
    mode: privacyMode,
    redactSecrets: privacyMode !== "none",
    customPatterns: privacyMode === "flexible" ? customPatterns : (settings.privacy?.customPatterns || []),
  };
  settingsChanged = true;

  // ── Screen 3: Auto-Context Toggle ──────────────────────────────────────────

  const currentAutoContext = settings.autoContext?.enabled ?? true;

  const enableAutoContext = await p.confirm({
    message: "Enable auto-context? (injects relevant memories at session start)",
    initialValue: currentAutoContext,
  });

  if (p.isCancel(enableAutoContext)) cancelled();

  settings.autoContext = {
    ...settings.autoContext,
    enabled: enableAutoContext,
  };
  settingsChanged = true;

  // ── Screen 4: Coupling Preview + Apply ─────────────────────────────────────

  const uncoupled = detection.clients.filter(c => !c.alreadyPatched);
  if (uncoupled.length > 0) {
    const coupleLines = uncoupled.map(c => {
      const label = c.name === "claude-code" ? "Claude Code CLI" : "OpenCode";
      return `  ${label}: ${c.configFile}`;
    });
    coupleLines.push("", "  This adds LongMem hooks and MCP server to your config.");
    p.note(coupleLines.join("\n"), "Client Configuration");

    const applyCoupling = await p.confirm({
      message: "Apply client configuration?",
      initialValue: true,
    });

    if (p.isCancel(applyCoupling)) cancelled();

    if (applyCoupling) {
      // Save backup reference before coupling (for rollback)
      backupSettings = JSON.parse(JSON.stringify(settings));

      await runCoupleFlow(detection, {
        yes: true,
        dryRun,
        skipDaemon: options.noService ?? false,
      });
    }
  } else {
    p.log.success("All clients already configured.");
  }

  // ── Screen 5: Service Install ──────────────────────────────────────────────

  if (!options.noService && !dryRun) {
    const daemonExec = resolveDaemonExec(detection);

    if (daemonExec) {
      const serviceAction = detection.daemon.serviceInstalled
        ? "Update system service for daemon auto-start?"
        : "Install system service for daemon auto-start on login?";

      const installSvc = await p.confirm({
        message: serviceAction,
        initialValue: true,
      });

      if (p.isCancel(installSvc)) cancelled();

      if (installSvc) {
        // installService expects the direct binary path, not "bun run ..."
        const binaryDaemon = join(MEMORY_DIR, "bin", "longmemd");
        const execPath = existsSync(binaryDaemon) ? binaryDaemon : daemonExec;
        const svcResult = await installService(execPath, detection.platform);
        if (svcResult.installed) {
          p.log.success(`Installed ${svcResult.type} service at ${svcResult.path}`);
        } else {
          p.log.warning(`Service install failed: ${svcResult.error}\nDaemon will still auto-start via hook fallback.`);
        }
      }
    } else {
      p.log.warning("No daemon executable found — skipping service install.");
    }
  }

  // ── Screen 6: Compression ─────────────────────────────────────────────────

  const compression = settings.compression || {};
  const hasKey = Boolean(compression.apiKey);

  const enableCompression = await p.confirm({
    message: "Enable compression? (generates summaries for smarter search)",
    initialValue: compression.enabled !== false,
  });

  if (p.isCancel(enableCompression)) cancelled();

  if (enableCompression) {
    const provider = await p.select({
      message: "Compression provider",
      initialValue: compression.provider || "openrouter",
      options: COMPRESSION_PROVIDERS.map(cp => ({
        value: cp.value,
        label: cp.label,
        hint: cp.hint,
      })),
    });

    if (p.isCancel(provider)) cancelled();

    const selected = COMPRESSION_PROVIDERS.find(cp => cp.value === provider)!;

    // API key (skip for local)
    let apiKey = compression.apiKey || "";
    if (provider !== "local") {
      if (hasKey) {
        const replaceKey = await p.confirm({
          message: "API key already set. Replace it?",
          initialValue: false,
        });
        if (p.isCancel(replaceKey)) cancelled();
        if (replaceKey) {
          const newKey = await p.password({ message: "New API key", mask: "\u2022" });
          if (p.isCancel(newKey)) cancelled();
          apiKey = newKey;
        }
      } else {
        const newKey = await p.password({ message: `API key for ${selected.label}`, mask: "\u2022" });
        if (p.isCancel(newKey)) cancelled();
        apiKey = newKey;
      }
    }

    settings.compression = {
      ...compression,
      enabled: true,
      provider,
      model: selected.defaultModel,
      apiKey,
    };
  } else {
    settings.compression = { ...compression, enabled: false };
  }
  settingsChanged = true;

  // ── Apply Settings ─────────────────────────────────────────────────────────

  if (settingsChanged && !dryRun) {
    const s = p.spinner();
    s.start("Saving settings");
    saveConfig(settings);
    s.stop("Settings saved");

    // Restart daemon to pick up new config
    const s2 = p.spinner();
    s2.start("Restarting daemon");
    await restartDaemon(detection);
    s2.stop("Daemon restarted");
  } else if (dryRun) {
    p.log.info("(dry-run) Settings would be saved.");
  }

  // ── Screen 7: Verify ──────────────────────────────────────────────────────

  if (!dryRun) {
    const s = p.spinner();
    s.start("Verifying installation");
    const result = await verifyInstallation();
    s.stop("Verification complete");

    const lines: string[] = [];
    const checks = [
      ["Daemon health", result.daemon],
      ["Hook binary", result.hook],
      ["MCP server", result.mcp],
      ["Config paths", result.configs],
    ] as const;
    for (const [label, ok] of checks) {
      lines.push(`  ${ok ? "\u2713" : "\u2717"} ${label}`);
    }
    p.note(lines.join("\n"), result.allPassed ? "All checks passed" : "Some checks failed");
  }

  // ── Screen 8: Ecosystem Scan & Memory Migration ──────────────────────────

  if (!dryRun) {
    const ecoscan = scanEcosystem();

    if (ecoscan.files.length > 0) {
      // Ingest into LongMem
      const s3 = p.spinner();
      s3.start("Indexing ecosystem files");
      try {
        const payload = ecoscan.files.map(f => ({
          path: f.path, content: f.content, hash: f.hash, source: f.source,
        }));
        const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/ecosystem/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: payload }),
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const result = await res.json() as any;
          s3.stop(`Indexed ${result.ingested} file(s) into memory (${result.skipped} unchanged)`);
        } else {
          s3.stop("Ecosystem indexing completed");
        }
      } catch {
        s3.stop("Ecosystem indexing skipped (daemon not reachable)");
      }

      // Find auto-memory files eligible for removal
      const memoryFiles = ecoscan.files.filter(f => f.source === "claude-memory");

      if (memoryFiles.length > 0) {
        const fileLines = memoryFiles.map(f => {
          const sizeKB = (f.size / 1024).toFixed(1);
          return `  ${f.path} (${sizeKB}KB)`;
        });
        p.note(fileLines.join("\n"), `Found ${memoryFiles.length} Claude Code auto-memory file(s)`);

        const migrate = await p.select({
          message: "LongMem replaces Claude Code's built-in memory. Remove these auto-memory files?",
          initialValue: "keep",
          options: [
            { value: "keep", label: "Keep them", hint: "no changes, LongMem works alongside" },
            { value: "remove", label: "Remove all", hint: "content already indexed into LongMem" },
          ],
        });

        if (!p.isCancel(migrate) && migrate === "remove") {
          let removed = 0;
          const parentDirs = new Set<string>();
          for (const f of memoryFiles) {
            try {
              const dir = join(f.path, "..");
              parentDirs.add(dir);
              unlinkSync(f.path);
              removed++;
            } catch {}
          }
          // Clean up empty memory/ directories
          for (const dir of parentDirs) {
            try {
              const remaining = readdirSync(dir);
              if (remaining.length === 0) rmdirSync(dir);
            } catch {}
          }
          p.log.success(`Removed ${removed} auto-memory file(s)`);
        }
      }
    }
  }

  // ── Screen 9: Done ─────────────────────────────────────────────────────────

  const summaryLines = [
    `Privacy: ${settings.privacy?.mode || "safe"}`,
    `Auto-context: ${settings.autoContext?.enabled !== false ? "on" : "off"}`,
    `Compression: ${settings.compression?.enabled ? settings.compression.provider : "off"}`,
  ];

  p.note(summaryLines.join("\n"), "Configuration Summary");

  p.outro("LongMem is ready! Changes take effect in your next session.");
}
