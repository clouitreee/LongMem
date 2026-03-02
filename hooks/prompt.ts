#!/usr/bin/env bun
/**
 * Claude Code CLI — UserPromptSubmit hook
 * Captures user prompts AND auto-injects relevant memory context.
 *
 * Flow:
 * 1. Parse prompt from stdin
 * 2. Ensure daemon running
 * 3. POST /prompt with with_context=true
 * 4. If daemon returns context → output to stdout (Claude Code injects it)
 * 5. Always exit 0
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

  // Single call: saves prompt + returns context if topic changed
  const result = await client.promptWithContext({
    session_id: sessionId,
    text,
    project,
    directory,
    with_context: true,
  });

  // Output context to stdout — Claude Code injects this into the conversation
  if (result?.context) {
    process.stdout.write(result.context);
  }
}

main().catch(() => {}).finally(() => process.exit(0));
