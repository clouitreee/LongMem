import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();

// ─── Types ──────────────────────────────────────────────────────────────────

interface ServiceResult {
  installed: boolean;
  path: string;
  type: "systemd" | "launchd";
  error?: string;
}

// ─── systemd (Linux) ────────────────────────────────────────────────────────

function generateSystemdUnit(execPath: string): string {
  return `[Unit]
Description=LongMem memory daemon

[Service]
Type=simple
ExecStart=${execPath}
Restart=on-failure
RestartSec=5
Environment=HOME=${HOME}

[Install]
WantedBy=default.target
`;
}

async function installSystemdUnit(execPath: string): Promise<ServiceResult> {
  const unitDir = join(HOME, ".config", "systemd", "user");
  const unitPath = join(unitDir, "longmem.service");

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, generateSystemdUnit(execPath));

  // daemon-reload + enable + start
  const commands = [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "longmem.service"],
    ["systemctl", "--user", "start", "longmem.service"],
  ];

  for (const cmd of commands) {
    try {
      const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return { installed: false, path: unitPath, type: "systemd", error: stderr.trim() };
      }
    } catch (e: any) {
      return { installed: false, path: unitPath, type: "systemd", error: e.message };
    }
  }

  return { installed: true, path: unitPath, type: "systemd" };
}

// ─── launchd (macOS) ────────────────────────────────────────────────────────

function generateLaunchdPlist(execPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.longmem.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${execPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${join(HOME, ".longmem", "logs", "daemon.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(HOME, ".longmem", "logs", "daemon.err")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
</dict>
</plist>
`;
}

async function installLaunchdPlist(execPath: string): Promise<ServiceResult> {
  const agentsDir = join(HOME, "Library", "LaunchAgents");
  const plistPath = join(agentsDir, "com.longmem.daemon.plist");

  mkdirSync(agentsDir, { recursive: true });

  // Unload first if already loaded (ignore errors)
  if (existsSync(plistPath)) {
    try {
      const proc = Bun.spawn(["launchctl", "unload", plistPath], {
        stdout: "ignore", stderr: "ignore",
      });
      await proc.exited;
    } catch {}
  }

  writeFileSync(plistPath, generateLaunchdPlist(execPath));

  try {
    const proc = Bun.spawn(["launchctl", "load", plistPath], {
      stdout: "ignore", stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return { installed: false, path: plistPath, type: "launchd", error: stderr.trim() };
    }
  } catch (e: any) {
    return { installed: false, path: plistPath, type: "launchd", error: e.message };
  }

  return { installed: true, path: plistPath, type: "launchd" };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function installService(
  daemonBinaryPath: string,
  plat: "linux-x64" | "macos-arm64" | "macos-x64"
): Promise<ServiceResult> {
  if (plat === "linux-x64") {
    return installSystemdUnit(daemonBinaryPath);
  }
  return installLaunchdPlist(daemonBinaryPath);
}

export function isServiceInstalled(plat: "linux-x64" | "macos-arm64" | "macos-x64"): boolean {
  if (plat === "linux-x64") {
    return existsSync(join(HOME, ".config", "systemd", "user", "longmem.service"));
  }
  return existsSync(join(HOME, "Library", "LaunchAgents", "com.longmem.daemon.plist"));
}
