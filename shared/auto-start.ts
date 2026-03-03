import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { DaemonClient } from "./daemon-client.ts";
import { DEFAULT_PORT, MEMORY_DIR, PID_FILE, BIN_DIR } from "./constants.ts";

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

  if (isServiceManaged()) {
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(500);
      if (await client.health()) return true;
    }
    return false;
  }

  const existingPid = readPid();
  if (existingPid !== null && isProcessAlive(existingPid)) {
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(500);
      if (await client.health()) return true;
    }
    return false;
  }

  const binaryPath = join(BIN_DIR, "longmemd");
  const scriptPath = join(MEMORY_DIR, "daemon.js");

  let cmd: string[];
  if (existsSync(binaryPath)) {
    cmd = [binaryPath];
  } else if (existsSync(scriptPath)) {
    const bunPath = Bun.which("bun") || join(homedir(), ".bun", "bin", "bun");
    cmd = [bunPath, "run", scriptPath];
  } else {
    return false;
  }

  try {
    Bun.spawn(cmd, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env },
    });

    for (let i = 0; i < 6; i++) {
      await Bun.sleep(500);
      if (await client.health()) return true;
    }

    return false;
  } catch {
    return false;
  }
}