import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join, homedir } from "path";

const LOG_DIR = join(homedir(), ".longmem", "logs");
const LOG_FILE = join(LOG_DIR, "hook.log");

export function logHookError(context: string, error: unknown): void {
  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString();
    const message = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    appendFileSync(LOG_FILE, `${timestamp} [${context}] ${message}\n`);
  } catch {}
}