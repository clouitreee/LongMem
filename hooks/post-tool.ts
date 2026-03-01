#!/usr/bin/env bun
/**
 * Claude Code CLI — PostToolUse hook
 * Captures tool execution and sends to memory daemon.
 * Always exits 0 (never blocks Claude Code).
 */
import { ensureDaemonRunning } from "../shared/auto-start.ts";
import { DaemonClient } from "../shared/daemon-client.ts";

async function main(): Promise<void> {
  const raw = await Bun.stdin.text();
  if (!raw.trim()) process.exit(0);

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = String(data.tool_name || data.tool || "unknown");
  const toolInput = (data.tool_input || data.input || {}) as Record<string, unknown>;
  const toolOutput = String(data.tool_response || data.output || "");

  // Skip noisy or irrelevant tools
  const SKIP_TOOLS = new Set(["AskQuestion", "TodoWrite", "ListMcpResourcesTool", "Skill", "mem_search", "mem_get", "mem_timeline"]);
  if (SKIP_TOOLS.has(toolName)) process.exit(0);

  const sessionId = process.env.CLAUDE_SESSION_ID || process.env.SESSION_ID || "cli-default";
  const project = process.cwd().split("/").pop() || "default";
  const directory = process.cwd();

  await ensureDaemonRunning();

  const client = new DaemonClient();
  await client.observe({ session_id: sessionId, tool_name: toolName, tool_input: toolInput, tool_output: toolOutput, project, directory } as any);
}

main().catch(() => {}).finally(() => process.exit(0));
