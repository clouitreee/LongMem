import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { PID_FILE } from "./constants.ts";

export function readPid(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isServiceManaged(): boolean {
  const os = platform();
  if (os === "linux") {
    return existsSync(
      join(homedir(), ".config", "systemd", "user", "longmem.service")
    );
  }
  if (os === "darwin") {
    return existsSync(
      join(homedir(), "Library", "LaunchAgents", "com.longmem.daemon.plist")
    );
  }
  return false;
}