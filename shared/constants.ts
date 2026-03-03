import { join } from "path";
import { homedir } from "os";

export const DEFAULT_PORT = 38741;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_DB_NAME = "memory.db";
export const MEMORY_DIR_NAME = ".longmem";

// Derived constants
export const MEMORY_DIR = join(homedir(), MEMORY_DIR_NAME);
export const DEFAULT_DB_PATH = join(MEMORY_DIR, DEFAULT_DB_NAME);
export const LOGS_DIR = join(MEMORY_DIR, "logs");
export const BIN_DIR = join(MEMORY_DIR, "bin");
export const HOOKS_DIR = join(MEMORY_DIR, "hooks");
export const SETTINGS_PATH = join(MEMORY_DIR, "settings.json");
export const PID_FILE = join(MEMORY_DIR, "daemon.pid");
export const VERSION_FILE = join(MEMORY_DIR, "version");