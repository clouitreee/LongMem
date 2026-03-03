import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { DaemonClient } from "./daemon-client.ts";
import { DEFAULT_PORT, MEMORY_DIR, BIN_DIR } from "./constants.ts";
import { readPid, isProcessAlive, isServiceManaged } from "./process-utils.ts";

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
    const child = Bun.spawn(cmd, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env },
    });

    // Check if spawn succeeded
    if (!child.pid) {
      console.error(`[longmem] Failed to spawn daemon: ${cmd.join(" ")}`);
      return false;
    }

    child.unref();

    for (let i = 0; i < 6; i++) {
      await Bun.sleep(500);
      if (await client.health()) return true;
    }

    return false;
  } catch (err: any) {
    console.error(`[longmem] Error spawning daemon: ${err?.message || err}`);
    return false;
  }
}