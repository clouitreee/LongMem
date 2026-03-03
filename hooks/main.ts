#!/usr/bin/env bun
/**
 * LongMem — unified hook binary for Claude Code CLI.
 * Usage: longmem-hook <post-tool|prompt|stop>
 *
 * This is the single standalone binary used by the binary installer.
 * The individual .ts files (post-tool.ts, prompt.ts, stop.ts) are used
 * by the dev installer (bun run install.ts) and compiled separately.
 */
import { ensureDaemonRunning } from "../shared/auto-start.ts";
import { DaemonClient } from "../shared/daemon-client.ts";
import { resolveProject } from "../shared/git-root.ts";

const mode = process.argv[2] as "post-tool" | "prompt" | "stop" | undefined;

const SKIP_TOOLS = new Set([
  "AskQuestion", "TodoWrite", "ListMcpResourcesTool", "Skill",
  "mem_search", "mem_get", "mem_timeline",
]);

async function main(): Promise<void> {
  const sessionId = process.env.CLAUDE_SESSION_ID || process.env.SESSION_ID || "cli-default";
  const directory = process.cwd();
  const project = resolveProject(directory);
  const client = new DaemonClient();

  switch (mode) {
    case "post-tool": {
      const raw = await Bun.stdin.text();
      if (!raw.trim()) return;
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(raw); } catch { return; }

      const toolName = String(data.tool_name || data.tool || "unknown");
      if (SKIP_TOOLS.has(toolName)) return;

      const toolInput = (data.tool_input || data.input || {}) as Record<string, unknown>;
      const toolOutput = String(data.tool_response || data.output || "");

      await ensureDaemonRunning();
      await client.observe({ session_id: sessionId, tool_name: toolName, tool_input: toolInput, tool_output: toolOutput, project, directory } as any);
      break;
    }

    case "prompt": {
      const raw = await Bun.stdin.text();
      if (!raw.trim()) return;
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(raw); } catch { return; }

      const text = String(data.prompt || data.message || data.text || "");
      if (!text.trim()) return;

      await ensureDaemonRunning();

      // Single call: saves prompt + returns context if topic changed
      const result = await client.promptWithContext({
        session_id: sessionId,
        text,
        project,
        directory,
        with_context: true,
      });

      // Output context to stdout — Claude Code injects it into the conversation
      if (result?.context) {
        process.stdout.write(result.context);
      }
      break;
    }

    case "stop": {
      await client.sessionEnd({ session_id: sessionId });
      break;
    }

    default:
      // Unknown mode — exit silently
      break;
  }
}

import { logHookError } from "../shared/hook-logger.ts";

main().catch((e) => logHookError("main-hook", e)).finally(() => process.exit(0));
