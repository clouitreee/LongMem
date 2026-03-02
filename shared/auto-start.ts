import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { DaemonClient } from "./daemon-client.ts";

const MEMORY_DIR = join(homedir(), ".longmem");
const PID_FILE = join(MEMORY_DIR, "daemon.pid");
const DEFAULT_PORT = 38741;

function isServiceManaged(): boolean {
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

function readPid(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDaemonRunning(port = DEFAULT_PORT): Promise<boolean> {
  const client = new DaemonClient(port);

  if (await client.health()) return true;

  // If systemd/launchd manages daemon, wait longer (it may be restarting)
  if (isServiceManaged()) {
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(500);
      if (await client.health()) return true;
    }
    return false; // Let service manager handle it
  }

  // Check PID file — if process is alive, it might be starting up
  const existingPid = readPid();
  if (existingPid !== null && isProcessAlive(existingPid)) {
    // Process exists but health check failed. Wait for it.
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(500);
      if (await client.health()) return true;
    }
    // Still not responding — don't spawn a second instance
    return false;
  }

  // No daemon running — spawn one
  const binaryPath = join(MEMORY_DIR, "bin", "longmemd");
  const scriptPath = join(MEMORY_DIR, "daemon.js");

  let cmd: string[];
  if (existsSync(binaryPath)) {
    cmd = [binaryPath];
  } else if (existsSync(scriptPath)) {
    const bunPath = Bun.which("bun") || join(homedir(), ".bun", "bin", "bun");
    cmd = [bunPath, "run", scriptPath];
  } else {
    return false; // Not installed
  }

  try {
    Bun.spawn(cmd, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env },
    });

    // Wait up to 3s for daemon to start
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(500);
      if (await client.health()) return true;
    }

    return false;
  } catch {
    return false;
  }
}
