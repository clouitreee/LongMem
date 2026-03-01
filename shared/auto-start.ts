import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { DaemonClient } from "./daemon-client.ts";

const MEMORY_DIR = join(homedir(), ".longmem");
const DEFAULT_PORT = 38741;

export async function ensureDaemonRunning(port = DEFAULT_PORT): Promise<boolean> {
  const client = new DaemonClient(port);

  if (await client.health()) return true;

  const daemonScript = join(MEMORY_DIR, "daemon.js");
  if (!existsSync(daemonScript)) return false; // Not installed, fail silently

  try {
    Bun.spawn(["bun", "run", daemonScript], {
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
