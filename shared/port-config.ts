import { existsSync, readFileSync } from "fs";
import { DEFAULT_PORT, SETTINGS_PATH } from "./constants.ts";

export function loadPortFromConfig(): number {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const config = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      if (typeof config?.daemon?.port === "number") {
        return config.daemon.port;
      }
    }
  } catch {}
  return DEFAULT_PORT;
}

export function getDaemonURL(): string {
  const port = loadPortFromConfig();
  return `http://127.0.0.1:${port}`;
}
