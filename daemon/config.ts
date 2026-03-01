import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface MemoryConfig {
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
    maxRetries: number;
  };
  daemon: {
    port: number;
    dbPath: string;
    logLevel: "debug" | "info" | "warn" | "error";
  };
  privacy: {
    redactSecrets: boolean;
    maxInputSize: number;
    maxOutputSize: number;
  };
}

const PROVIDERS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  local: "http://localhost:11434/v1",
};

const DEFAULTS: MemoryConfig = {
  compression: {
    enabled: true,
    provider: "openrouter",
    model: "meta-llama/llama-3.1-8b-instruct",
    apiKey: "",
    maxConcurrent: 1,
    idleThresholdSeconds: 5,
    maxPerMinute: 10,
    timeoutSeconds: 30,
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 60000,
    maxRetries: 3,
  },
  daemon: {
    port: 38741,
    dbPath: join(homedir(), ".longmem", "memory.db"),
    logLevel: "warn",
  },
  privacy: {
    redactSecrets: true,
    maxInputSize: 4096,
    maxOutputSize: 8192,
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
  const configPath = join(homedir(), ".longmem", "settings.json");

  if (!existsSync(configPath)) return DEFAULTS;

  try {
    const userConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    const merged = deepMerge(DEFAULTS, userConfig);

    // Resolve baseURL from provider name
    if (!merged.compression.baseURL && merged.compression.provider in PROVIDERS) {
      merged.compression.baseURL = PROVIDERS[merged.compression.provider];
    }

    return merged;
  } catch {
    return DEFAULTS;
  }
}

export { PROVIDERS };
