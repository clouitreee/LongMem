/**
 * shared/tui-config.ts — Terminal UI for LongMem configuration.
 * Uses @clack/prompts for modern interactive prompts.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, copyFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import * as p from "@clack/prompts";

const HOME = homedir();
const SETTINGS_PATH = join(HOME, ".longmem", "settings.json");

// ─── Provider definitions ───────────────────────────────────────────────────

const PROVIDERS = [
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "cheapest, many models",
    defaultModel: "meta-llama/llama-3.1-8b-instruct",
  },
  {
    value: "openai",
    label: "OpenAI",
    hint: "reliable",
    defaultModel: "gpt-4o-mini",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "via Anthropic API",
    defaultModel: "claude-haiku-4-5-20251001",
  },
  {
    value: "local",
    label: "Local (Ollama/LM Studio)",
    hint: "free, no API key needed",
    defaultModel: "llama3.1:8b",
  },
] as const;

// ─── Load/save settings ─────────────────────────────────────────────────────

function loadSettings(): Record<string, any> {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function saveSettings(settings: Record<string, any>): void {
  // Backup first
  if (existsSync(SETTINGS_PATH)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(SETTINGS_PATH, `${SETTINGS_PATH}.pre-config-${ts}.bak`);
  }

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  chmodSync(SETTINGS_PATH, 0o600);
}

// ─── Main TUI flow ──────────────────────────────────────────────────────────

export async function runTuiConfig(): Promise<boolean> {
  const settings = loadSettings();
  const compression = settings.compression || {};
  const currentProvider = compression.provider || "openrouter";
  const hasKey = Boolean(compression.apiKey);

  p.intro("Compression Settings");

  if (hasKey) {
    p.note(
      `Provider: ${currentProvider}\nAPI key: set\nModel: ${compression.model || "default"}`,
      "Current config"
    );
  }

  // 1. Enable compression?
  const enableCompression = await p.confirm({
    message: "Enable compression?",
    initialValue: true,
  });

  if (p.isCancel(enableCompression)) {
    p.cancel("Configuration cancelled.");
    return false;
  }

  if (!enableCompression) {
    settings.compression = { ...compression, enabled: false };
    saveSettings(settings);
    p.outro("Compression disabled. Observations will be stored raw.");
    return true;
  }

  // 2. Select provider
  const provider = await p.select({
    message: "Select provider",
    initialValue: currentProvider,
    options: PROVIDERS.map(p => ({
      value: p.value,
      label: p.label,
      hint: p.hint,
    })),
  });

  if (p.isCancel(provider)) {
    p.cancel("Configuration cancelled.");
    return false;
  }

  const selected = PROVIDERS.find(p => p.value === provider)!;

  // 3. Model
  const model = await p.text({
    message: "Model",
    placeholder: selected.defaultModel,
    defaultValue: selected.defaultModel,
  });

  if (p.isCancel(model)) {
    p.cancel("Configuration cancelled.");
    return false;
  }

  // 4. API key (masked) — skip for local
  let apiKey = compression.apiKey || "";

  if (provider !== "local") {
    if (hasKey) {
      const replaceKey = await p.confirm({
        message: "API key already set. Replace it?",
        initialValue: false,
      });

      if (p.isCancel(replaceKey)) {
        p.cancel("Configuration cancelled.");
        return false;
      }

      if (replaceKey) {
        const newKey = await p.password({
          message: "New API key",
          mask: "•",
        });

        if (p.isCancel(newKey)) {
          p.cancel("Configuration cancelled.");
          return false;
        }

        apiKey = newKey;
      }
    } else {
      const newKey = await p.password({
        message: "API key",
        mask: "•",
      });

      if (p.isCancel(newKey)) {
        p.cancel("Configuration cancelled.");
        return false;
      }

      apiKey = newKey;
    }
  }

  // 5. Save
  settings.compression = {
    ...compression,
    enabled: true,
    provider,
    model: model || selected.defaultModel,
    apiKey,
  };

  saveSettings(settings);

  const summary = [
    `Provider: ${selected.label}`,
    `Model: ${model || selected.defaultModel}`,
    `API key: ${apiKey ? "set" : "not set"}`,
  ].join("\n");

  p.note(summary, "Saved");

  // 6. Quick health check
  if (apiKey) {
    const s = p.spinner();
    s.start("Testing connection");
    try {
      const res = await fetch("http://127.0.0.1:38741/health", {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        s.stop("Daemon reachable");
      } else {
        s.stop("Daemon not responding (will retry on next session)");
      }
    } catch {
      s.stop("Daemon not reachable (will retry on next session)");
    }
  }

  p.outro("Compression configured!");
  return true;
}
