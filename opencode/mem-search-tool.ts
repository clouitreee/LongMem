import { tool } from "@opencode-ai/plugin";
import { DaemonClient } from "../shared/daemon-client.ts";

const daemon = new DaemonClient();

export const memSearchTool = tool({
  description: `Search persistent memory from past coding sessions.

Operations:
- search: Full-text search observations (with temporal decay ranking)
- recent: Get recent observations for current project
- get:    Get full details of specific observations by ID
- timeline: Chronological context around a specific observation

Use mem_search BEFORE answering any technical question or starting any task.
This gives you context from past sessions that may directly affect the answer.`,

  args: {
    operation: tool.schema.enum(["search", "recent", "get", "timeline"]),
    query: tool.schema.string().optional().describe("Search query (for search operation)"),
    ids: tool.schema.array(tool.schema.number()).optional().describe("Observation IDs (for get operation)"),
    observation_id: tool.schema.number().optional().describe("Observation ID (for timeline operation)"),
    limit: tool.schema.number().optional().default(5).describe("Max results (default: 5)"),
    project: tool.schema.string().optional().describe("Filter by project (defaults to current)"),
  },

  async execute(args, context) {
    const project = args.project || context.directory.split("/").pop() || "default";

    switch (args.operation) {
      case "search": {
        if (!args.query) return "Error: query is required for search operation";
        try {
          const result = await daemon.search(args.query, project, args.limit ?? 5);
          if (result.total === 0) return "No matching memories found.";
          const lines = result.results.map(r =>
            `[ID:${r.id}] ${r.date} | ${r.tool}${r.files ? ` | ${r.files}` : ""}\n  ${r.summary || "(not yet compressed)"}`
          );
          return `Found ${result.total} memories:\n\n${lines.join("\n\n")}`;
        } catch {
          return "Memory daemon unavailable — search skipped.";
        }
      }

      case "recent": {
        try {
          const result = await daemon.search("", project, args.limit ?? 5);
          if (result.total === 0) return "No recent memories for this project.";
          const lines = result.results.map(r =>
            `[ID:${r.id}] ${r.date} | ${r.tool}${r.files ? ` | ${r.files}` : ""}\n  ${r.summary || "(not yet compressed)"}`
          );
          return `Recent observations (${project}):\n\n${lines.join("\n\n")}`;
        } catch {
          return "Memory daemon unavailable.";
        }
      }

      case "get": {
        if (!args.ids || args.ids.length === 0) return "Error: ids array is required for get operation";
        try {
          const result = await daemon.getObservations(args.ids);
          if (result.observations.length === 0) return "No observations found for those IDs.";
          return result.observations.map((o: any) => [
            `**[${o.id}] ${o.tool_name}** — ${o.created_at?.slice(0, 16)}`,
            o.compressed_summary ? `Summary: ${o.compressed_summary}` : "",
            o.files_referenced ? `Files: ${o.files_referenced}` : "",
            o.concepts ? `Concepts: ${o.concepts}` : "",
            `Output snippet: ${(o.tool_output || "").slice(0, 500)}`,
          ].filter(Boolean).join("\n")).join("\n\n---\n\n");
        } catch {
          return "Memory daemon unavailable.";
        }
      }

      case "timeline": {
        if (!args.observation_id) return "Error: observation_id is required for timeline operation";
        try {
          const result = await daemon.timeline(args.observation_id, 3, 3);
          const parts: string[] = [];
          if ((result.before as any[]).length > 0) {
            parts.push("**Before:**");
            for (const o of result.before as any[]) {
              parts.push(`  [${o.id}] ${o.created_at?.slice(0, 10)} | ${o.tool_name}: ${o.compressed_summary || o.tool_output?.slice(0, 80) || ""}`);
            }
          }
          if (result.target) {
            const t = result.target as any;
            parts.push(`\n**Target [${t.id}]:** ${t.tool_name} — ${t.compressed_summary || "(no summary yet)"}`);
          }
          if ((result.after as any[]).length > 0) {
            parts.push("\n**After:**");
            for (const o of result.after as any[]) {
              parts.push(`  [${o.id}] ${o.created_at?.slice(0, 10)} | ${o.tool_name}: ${o.compressed_summary || o.tool_output?.slice(0, 80) || ""}`);
            }
          }
          return parts.join("\n") || "No timeline data.";
        } catch {
          return "Memory daemon unavailable.";
        }
      }

      default:
        return `Unknown operation`;
    }
  },
});
