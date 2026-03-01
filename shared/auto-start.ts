import { existsSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { DaemonClient } from "./daemon-client.ts";

const MEMORY_DIR = join(homedir(), ".longmem");
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

  // Spawn fallback — try binary first, then bun script
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
