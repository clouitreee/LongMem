import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { LOGS_DIR } from "./constants.ts";

const HOOK_LOG_FILE = join(LOGS_DIR, "hook.log");

export function logHookError(context: string, error: unknown): void {
  try {
    if (!existsSync(LOGS_DIR)) {
      mkdirSync(LOGS_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString();
    const message = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    appendFileSync(HOOK_LOG_FILE, `${timestamp} [${context}] ${message}\n`);
  } catch {}
}