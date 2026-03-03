/**
 * Version - injected at build time via --define BUILD_VERSION
 * Falls back to reading from VERSION_FILE or package.json in development
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

declare const BUILD_VERSION: string | undefined;

function getVersion(): string {
  // 1. Build-time injection (bun build --define BUILD_VERSION='"v1.2.3"')
  if (typeof BUILD_VERSION !== "undefined" && BUILD_VERSION) {
    return BUILD_VERSION;
  }

  // 2. Runtime: read from VERSION_FILE (~/.longmem/version)
  const memoryDir = join(homedir(), ".longmem");
  const versionFile = join(memoryDir, "version");
  if (existsSync(versionFile)) {
    return readFileSync(versionFile, "utf-8").trim();
  }

  // 3. Development: read from package.json
  try {
    const pkgPath = join(import.meta.dir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "dev";
  } catch {
    return "dev";
  }
}

export const VERSION = getVersion();
