#!/usr/bin/env bun
/**
 * Claude Code CLI — UserPromptSubmit hook
 * Captures user prompts for FTS indexing.
 * Always exits 0.
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

  const text = String(data.prompt || data.message || data.text || "");
  if (!text.trim()) process.exit(0);

  const sessionId = process.env.CLAUDE_SESSION_ID || process.env.SESSION_ID || "cli-default";
  const project = process.cwd().split("/").pop() || "default";
  const directory = process.cwd();

  await ensureDaemonRunning();

  const client = new DaemonClient();
  await client.prompt({ session_id: sessionId, text, project, directory } as any);
}

main().catch(() => {}).finally(() => process.exit(0));
