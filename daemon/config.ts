import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { DEFAULT_PORT, DEFAULT_DB_PATH, SETTINGS_PATH } from "../shared/constants.ts";

export type PrivacyMode = "safe" | "flexible" | "none";

export interface AutoContextConfig {
  enabled: boolean;
  maxEntries: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface MemoryConfig {
  autoContext: AutoContextConfig;
  compression: {
    enabled: boolean;
    provider: string;
    model: string;
    apiKey: string;
    baseURL?: string;
    maxConcurrent: number;
    idleThresholdSeconds: number;
    maxPerMinute: number;
    timeoutSeconds: number;
    circuitBreakerThreshold: number;
    circuitBreakerCooldownMs: number;
    circuitBreakerMaxCooldownMs: number;
    maxRetries: number;
  };
  daemon: {
    port: number;
    dbPath: string;
    logLevel: "debug" | "info" | "warn" | "error";
    authToken?: string;
  };
  privacy: {
    redactSecrets: boolean;
    mode: PrivacyMode;
    maxInputSize: number;
    maxOutputSize: number;
    excludePaths: string[];
    excludeTools: string[];
    customPatterns: Array<{ pattern: string; name: string }>;
  };
}

const PROVIDERS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  local: "http://localhost:11434/v1",
};

const DEFAULT_EXCLUDE_PATHS = [
  ".env", ".env.*", "*.pem", "*.key", "id_rsa", "id_rsa.*", "id_ed25519",
  "*.p12", "*.pfx", "*.jks", "credentials.json", "service-account.json",
];

const DEFAULTS: MemoryConfig = {
  autoContext: {
    enabled: true,
    maxEntries: 5,
    maxTokens: 500,
    timeoutMs: 300,
  },
  compression: {
    enabled: false,
    provider: "openrouter",
    model: "meta-llama/llama-3.1-8b-instruct",
    apiKey: "",
    maxConcurrent: 1,
    idleThresholdSeconds: 5,
    maxPerMinute: 10,
    timeoutSeconds: 30,
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 60000,
    circuitBreakerMaxCooldownMs: 300000,
    maxRetries: 3,
  },
  daemon: {
    port: DEFAULT_PORT,
    dbPath: DEFAULT_DB_PATH,
    logLevel: "warn",
    authToken: undefined,
  },
  privacy: {
    redactSecrets: true,
    mode: "safe",
    maxInputSize: 4096,
    maxOutputSize: 8192,
    excludePaths: DEFAULT_EXCLUDE_PATHS,
    excludeTools: [],
    customPatterns: [],
  },
};

function deepMerge<T>(defaults: T, overrides: Partial<T>): T {
  const result = { ...defaults };
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const val = overrides[key];
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      result[key] = deepMerge(defaults[key] as object, val as object) as T[keyof T];
    } else if (val !== undefined) {
      result[key] = val as T[keyof T];
    }
  }
  return result;
}

export function loadConfig(): MemoryConfig {
  if (!existsSync(SETTINGS_PATH)) return DEFAULTS;

  try {
    const userConfig = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    const merged = deepMerge(DEFAULTS, userConfig);

    if (!merged.compression.baseURL && merged.compression.provider in PROVIDERS) {
      merged.compression.baseURL = PROVIDERS[merged.compression.provider];
    }

    if (!userConfig.privacy?.mode) {
      merged.privacy.mode = merged.privacy.redactSecrets ? "safe" : "none";
    }

    if (!["safe", "flexible", "none"].includes(merged.privacy.mode)) {
      merged.privacy.mode = "safe";
    }

    return merged;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Parse error";
    console.warn(`[longmem] Failed to parse settings.json (${SETTINGS_PATH}): ${msg}. Using defaults.`);
    return DEFAULTS;
  }
}

export function loadSettings(): Record<string, any> {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

export function saveConfig(settings: Record<string, any>): void {
  if (existsSync(SETTINGS_PATH)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(SETTINGS_PATH, `${SETTINGS_PATH}.pre-config-${ts}.bak`);
  }

  const tmpPath = `${SETTINGS_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
  renameSync(tmpPath, SETTINGS_PATH);
  chmodSync(SETTINGS_PATH, 0o600);
}

export { PROVIDERS, DEFAULT_EXCLUDE_PATHS };
