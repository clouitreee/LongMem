import { existsSync } from "fs";
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
 * Uses the git root basename if available, otherwise falls back to cwd basename.
 */
export function resolveProject(cwd: string): string {
  const gitRoot = getGitRoot(cwd);
  if (gitRoot) return gitRoot.split("/").pop() || "default";
  return cwd.split("/").pop() || "default";
}
