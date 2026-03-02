/**
 * Test: Decouple preserves user hooks
 * Validates that removing LongMem entries doesn't destroy user-defined hooks.
 * All tests isolated in /tmp.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  removeLongmemFromHooks,
  removeLongmemMCP,
  decoupleClaudeCode,
  decoupleOpenCode,
} from "../shared/decouple.ts";

describe("removeLongmemFromHooks", () => {
  test("removes longmem entries and preserves user hooks", () => {
    const hooks = {
      PostToolUse: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "/home/user/.longmem/bin/longmem-hook post-tool" }],
        },
        {
          matcher: "*.py",
          hooks: [{ type: "command", command: "black --check" }],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "/home/user/.longmem/bin/longmem-hook prompt" }],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "/home/user/.longmem/bin/longmem-hook stop" }],
        },
      ],
    };

    const result = removeLongmemFromHooks(hooks);

    // User hook preserved
    expect(result).toBeDefined();
    expect(result!.PostToolUse).toHaveLength(1);
    expect(result!.PostToolUse[0].hooks[0].command).toBe("black --check");

    // Longmem-only events are gone (empty arrays removed)
    expect(result!.UserPromptSubmit).toBeUndefined();
    expect(result!.Stop).toBeUndefined();
  });

  test("returns unchanged hooks when no longmem entries exist", () => {
    const hooks = {
      PostToolUse: [
        {
          matcher: "*.rs",
          hooks: [{ type: "command", command: "cargo clippy" }],
        },
      ],
    };

    const result = removeLongmemFromHooks(hooks);

    // Should return the same reference (not modified)
    expect(result).toBe(hooks);
  });

  test("handles undefined/null hooks gracefully", () => {
    expect(removeLongmemFromHooks(undefined)).toBeUndefined();
    expect(removeLongmemFromHooks(null as any)).toBeNull();
  });
});

describe("removeLongmemMCP", () => {
  test("removes longmem and preserves other MCP servers", () => {
    const mcpServers = {
      longmem: { command: "/home/user/.longmem/bin/longmem-mcp", args: [] },
      "my-custom-mcp": { command: "my-mcp", args: ["--port", "3000"] },
    };

    const result = removeLongmemMCP(mcpServers);

    expect(result).toBeDefined();
    expect(result!.longmem).toBeUndefined();
    expect(result!["my-custom-mcp"]).toBeDefined();
  });

  test("returns undefined when longmem is the only MCP server", () => {
    const mcpServers = {
      longmem: { command: "/home/user/.longmem/bin/longmem-mcp", args: [] },
    };

    const result = removeLongmemMCP(mcpServers);
    expect(result).toBeUndefined();
  });
});

describe("decoupleClaudeCode (end-to-end)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "longmem-decouple-test-"));
  });

  test("decouples Claude Code config and creates backup", () => {
    const configPath = join(tmpDir, "settings.json");

    // Write a config with longmem + user entries
    const config = {
      hooks: {
        PostToolUse: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "/home/user/.longmem/bin/longmem-hook post-tool" }],
          },
          {
            matcher: "*.ts",
            hooks: [{ type: "command", command: "eslint --fix" }],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "/home/user/.longmem/bin/longmem-hook prompt" }],
          },
        ],
      },
      mcpServers: {
        longmem: { command: "/home/user/.longmem/bin/longmem-mcp", args: [] },
        "other-mcp": { command: "other", args: [] },
      },
      theme: "dark",
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const result = decoupleClaudeCode(configPath, false);

    expect(result.success).toBe(true);
    expect(result.backup).toBeTruthy();
    expect(existsSync(result.backup!)).toBe(true);

    // Verify cleaned config
    const cleaned = JSON.parse(readFileSync(configPath, "utf-8"));

    // User hook preserved
    expect(cleaned.hooks.PostToolUse).toHaveLength(1);
    expect(cleaned.hooks.PostToolUse[0].hooks[0].command).toBe("eslint --fix");

    // Longmem-only events gone
    expect(cleaned.hooks.UserPromptSubmit).toBeUndefined();

    // MCP: longmem removed, other preserved
    expect(cleaned.mcpServers.longmem).toBeUndefined();
    expect(cleaned.mcpServers["other-mcp"]).toBeDefined();

    // Non-longmem settings preserved
    expect(cleaned.theme).toBe("dark");
  });

  test("is idempotent — running twice produces same result", () => {
    const configPath = join(tmpDir, "settings.json");

    const config = {
      hooks: {
        PostToolUse: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "/home/user/.longmem/bin/longmem-hook post-tool" }],
          },
        ],
      },
      mcpServers: {
        longmem: { command: "longmem-mcp", args: [] },
      },
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // First decouple
    const r1 = decoupleClaudeCode(configPath, false);
    expect(r1.success).toBe(true);

    const afterFirst = readFileSync(configPath, "utf-8");

    // Second decouple — should be a no-op
    const r2 = decoupleClaudeCode(configPath, false);
    expect(r2.success).toBe(true);
    expect(r2.backup).toBeNull(); // No backup = no modification
    expect(r2.changes.some(c => c.includes("already clean"))).toBe(true);

    const afterSecond = readFileSync(configPath, "utf-8");
    expect(afterSecond).toBe(afterFirst);
  });
});

describe("decoupleOpenCode (end-to-end)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "longmem-decouple-oc-test-"));
  });

  test("removes longmem MCP, plugin, and instructions from OpenCode config", () => {
    const configPath = join(tmpDir, "config.json");

    const config = {
      mcp: {
        longmem: { command: "longmem-mcp", args: [] },
        "other-mcp": { command: "other", args: [] },
      },
      plugin: ["/home/user/.longmem/plugin.js", "/home/user/my-plugin.js"],
      instructions: ["/home/user/.opencode/memory-instructions.md", "/home/user/custom.md"],
      theme: "monokai",
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const result = decoupleOpenCode(configPath, false);

    expect(result.success).toBe(true);
    expect(result.backup).toBeTruthy();

    const cleaned = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(cleaned.mcp.longmem).toBeUndefined();
    expect(cleaned.mcp["other-mcp"]).toBeDefined();
    expect(cleaned.plugin).toEqual(["/home/user/my-plugin.js"]);
    expect(cleaned.instructions).toEqual(["/home/user/custom.md"]);
    expect(cleaned.theme).toBe("monokai");
  });
});
