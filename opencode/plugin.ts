import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin";
import { DaemonClient } from "../shared/daemon-client.ts";
import { ensureDaemonRunning } from "../shared/auto-start.ts";
import { memSearchTool } from "./mem-search-tool.ts";

const SKIP_TOOLS = new Set([
  "AskQuestion", "TodoWrite", "ListMcpResourcesTool", "Skill",
  "mem_search", "mem_get", "mem_timeline",
]);

function extractSessionId(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const e = event as Record<string, unknown>;
  const props = e.properties as Record<string, unknown> | undefined;
  return (
    (props?.sessionID as string) ||
    ((props?.info as Record<string, unknown>)?.id as string) ||
    (props?.id as string) ||
    ""
  );
}

export const OpenCodeMemoryPlugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const { directory, project } = input;
  const projectName = directory.split("/").pop() || project?.id || "default";

  // Auto-start daemon (non-blocking — if it fails, we degrade gracefully)
  ensureDaemonRunning().catch(() => {});

  const daemon = new DaemonClient();

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const sessionId = extractSessionId(event);
          if (!sessionId) return;
          await daemon.sessionStart({ session_id: sessionId, project: projectName, directory });
          break;
        }

        case "session.idle":
          // No-op: daemon detects idle via absence of POST /observe
          break;

        case "session.deleted": {
          const sessionId = extractSessionId(event);
          if (!sessionId) return;
          await daemon.sessionEnd({ session_id: sessionId });
          break;
        }

        case "session.compacted":
          // No-op: do NOT inject context here — use MCP tools instead
          break;
      }
    },

    "chat.message": async (msgInput, output) => {
      const text = output.parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text || "")
        .join("\n")
        .trim();

      if (!text) return;

      await daemon.prompt({
        session_id: msgInput.sessionID,
        text,
        project: projectName,
        directory,
      } as any);
    },

    "tool.execute.after": async (toolInput, output) => {
      if (SKIP_TOOLS.has(toolInput.tool)) return;

      const rawOutput = typeof output.output === "string"
        ? output.output
        : JSON.stringify(output.output);

      await daemon.observe({
        session_id: toolInput.sessionID,
        tool_name: toolInput.tool,
        tool_input: toolInput.args || {},
        tool_output: rawOutput,
        project: projectName,
        directory,
      } as any);
    },

    // NOTE: experimental.session.compacting is intentionally NOT implemented.
    // Context is provided via mem_search tool + MCP — the LLM decides when
    // to retrieve memory, which prevents chat contamination.

    tool: {
      "mem-search": memSearchTool,
    },
  };
};

export default OpenCodeMemoryPlugin;
