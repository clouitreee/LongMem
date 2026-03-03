#!/usr/bin/env bun
/**
 * Claude Code CLI — Stop hook
 * Signals session end to memory daemon.
 * Always exits 0.
 */
import { DaemonClient } from "../shared/daemon-client.ts";

async function main(): Promise<void> {
  const sessionId = process.env.CLAUDE_SESSION_ID || process.env.SESSION_ID || "cli-default";
  const client = new DaemonClient();
  await client.sessionEnd({ session_id: sessionId });
}

import { logHookError } from "../shared/hook-logger.ts";

main().catch((e) => logHookError("stop", e)).finally(() => process.exit(0));
