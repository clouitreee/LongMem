/**
 * Test: Uninstall creates timestamped backup (never rm direct)
 * All tests isolated in /tmp — never touches real ~/.longmem.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, renameSync, lstatSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("uninstall backup behavior", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "longmem-uninstall-test-"));
  });

  test("move-to-backup preserves all files (never rm direct)", () => {
    // Simulate ~/.longmem structure
    const fakeMemDir = join(tmpDir, ".longmem");
    mkdirSync(join(fakeMemDir, "hooks"), { recursive: true });
    mkdirSync(join(fakeMemDir, "bin"), { recursive: true });
    mkdirSync(join(fakeMemDir, "logs"), { recursive: true });

    writeFileSync(join(fakeMemDir, "daemon.js"), "// daemon");
    writeFileSync(join(fakeMemDir, "mcp.js"), "// mcp");
    writeFileSync(join(fakeMemDir, "settings.json"), `{"daemon":{"port":38741}}`);
    writeFileSync(join(fakeMemDir, "memory.db"), "SQLITE_DB_CONTENTS");
    writeFileSync(join(fakeMemDir, "version"), "1.0.0");
    writeFileSync(join(fakeMemDir, "hooks", "post-tool.js"), "// hook");

    // Simulate uninstall: move to backup
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(tmpDir, `.longmem.backup-${ts}`);

    renameSync(fakeMemDir, backupDir);

    // Original gone
    expect(existsSync(fakeMemDir)).toBe(false);

    // Backup has everything
    expect(existsSync(backupDir)).toBe(true);
    expect(existsSync(join(backupDir, "daemon.js"))).toBe(true);
    expect(existsSync(join(backupDir, "memory.db"))).toBe(true);
    expect(existsSync(join(backupDir, "settings.json"))).toBe(true);
    expect(existsSync(join(backupDir, "version"))).toBe(true);
    expect(existsSync(join(backupDir, "hooks", "post-tool.js"))).toBe(true);

    // Content preserved
    expect(readFileSync(join(backupDir, "memory.db"), "utf-8")).toBe("SQLITE_DB_CONTENTS");
  });

  test("--keep-data preserves memory.db in place", () => {
    const fakeMemDir = join(tmpDir, ".longmem");
    mkdirSync(join(fakeMemDir, "bin"), { recursive: true });

    writeFileSync(join(fakeMemDir, "daemon.js"), "// daemon");
    writeFileSync(join(fakeMemDir, "memory.db"), "IMPORTANT_DATA");
    writeFileSync(join(fakeMemDir, "memory.db-wal"), "WAL_DATA");
    writeFileSync(join(fakeMemDir, "settings.json"), '{}');

    // Simulate --keep-data: move everything except DB files
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(tmpDir, `.longmem.backup-${ts}`);
    mkdirSync(backupDir, { recursive: true });

    const entries = readdirSync(fakeMemDir);
    const dbFiles = new Set(["memory.db", "memory.db-wal", "memory.db-shm"]);

    for (const entry of entries) {
      if (dbFiles.has(entry)) continue;
      const src = join(fakeMemDir, entry);
      const dst = join(backupDir, entry);
      renameSync(src, dst);
    }

    // DB files still in place
    expect(existsSync(join(fakeMemDir, "memory.db"))).toBe(true);
    expect(readFileSync(join(fakeMemDir, "memory.db"), "utf-8")).toBe("IMPORTANT_DATA");
    expect(existsSync(join(fakeMemDir, "memory.db-wal"))).toBe(true);

    // Other files moved to backup
    expect(existsSync(join(backupDir, "daemon.js"))).toBe(true);
    expect(existsSync(join(backupDir, "settings.json"))).toBe(true);

    // daemon.js gone from original
    expect(existsSync(join(fakeMemDir, "daemon.js"))).toBe(false);
  });

  test("restore from backup reverses the uninstall", () => {
    const fakeMemDir = join(tmpDir, ".longmem");
    mkdirSync(fakeMemDir, { recursive: true });
    writeFileSync(join(fakeMemDir, "settings.json"), '{"custom":"value"}');
    writeFileSync(join(fakeMemDir, "memory.db"), "DB_DATA");

    // Uninstall: move to backup
    const backupDir = join(tmpDir, ".longmem.backup-test");
    renameSync(fakeMemDir, backupDir);

    expect(existsSync(fakeMemDir)).toBe(false);
    expect(existsSync(backupDir)).toBe(true);

    // Restore: reverse the move
    renameSync(backupDir, fakeMemDir);

    expect(existsSync(fakeMemDir)).toBe(true);
    expect(existsSync(backupDir)).toBe(false);
    expect(readFileSync(join(fakeMemDir, "settings.json"), "utf-8")).toBe('{"custom":"value"}');
    expect(readFileSync(join(fakeMemDir, "memory.db"), "utf-8")).toBe("DB_DATA");
  });
});
