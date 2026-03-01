import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Walk up from startDir looking for a .git directory.
 * Returns the git root path, or null if not in a git repo.
 */
export function getGitRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dir.substring(0, dir.lastIndexOf("/"));
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the project name for a given working directory.
 * Priority: package.json "name" at git root → git root basename → cwd basename.
 */
export function resolveProject(cwd: string): string {
  const gitRoot = getGitRoot(cwd);
  if (gitRoot) {
    const pkgPath = join(gitRoot, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name) return pkg.name;
      } catch {}
    }
    return gitRoot.split("/").pop() || "default";
  }
  return cwd.split("/").pop() || "default";
}
