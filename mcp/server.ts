#!/usr/bin/env bun
/**
 * MCP Server — exposes mem_search, mem_timeline, mem_get to the LLM.
 * The LLM calls these tools on demand — no auto-injection.
 * Works with both OpenCode and Claude Code CLI via stdio transport.
 */
import { DaemonClient } from "../shared/daemon-client.ts";
import { ensureDaemonRunning } from "../shared/auto-start.ts";
import { resolveProject } from "../shared/git-root.ts";
import { DEFAULT_PORT } from "../shared/constants.ts";

const daemon = new DaemonClient();
const currentProject = resolveProject(process.cwd());

// ─── MCP Protocol (minimal stdio implementation) ──────────────────────────────

interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

function respond(id: string | number, result: unknown): void {
  const response: MCPResponse = { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(response) + "\n");
}

function respondError(id: string | number, code: number, message: string): void {
  const response: MCPResponse = { jsonrpc: "2.0", id, error: { code, message } };
  process.stdout.write(JSON.stringify(response) + "\n");
}

const TOOLS = [
  {
    name: "mem_search",
    description: `Search past coding session memory across ALL projects. Returns a compact index of matching observations. Use this FIRST to find relevant context, then call mem_get for full details on specific items. Current project context: ${currentProject}`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query — keywords or natural language" },
        project: { type: "string", description: "Filter by project name (optional — omit to search across all projects)" },
        limit: { type: "number", description: "Max results to return (default: 5, max: 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "mem_timeline",
    description: "Get chronological context around a specific observation — what happened before and after. Use an ID from mem_search results.",
    inputSchema: {
      type: "object",
      properties: {
        observation_id: { type: "number", description: "Observation ID from mem_search results" },
        before: { type: "number", description: "Observations to show before (default: 3)" },
        after: { type: "number", description: "Observations to show after (default: 3)" },
      },
      required: ["observation_id"],
    },
  },
  {
    name: "mem_get",
    description: "Get full details of specific observations by ID. Use after mem_search to retrieve complete information about relevant items. Only costs tokens for what you actually need.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "number" },
          description: "Observation IDs to retrieve (from mem_search)",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "mem_export",
    description: "Export memory to JSON or Markdown for backup, sharing, or analysis. Returns the exported data or a summary.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by project name (optional — omit for all projects)" },
        days: { type: "number", description: "Only include last N days (default: all, max: 365)" },
        format: { type: "string", enum: ["json", "markdown"], description: "Export format (default: json)" },
        include_raw: { type: "boolean", description: "Include raw tool_input/tool_output (default: false)" },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const daemonUp = await ensureDaemonRunning();

  if (!daemonUp) {
    return "Memory daemon is not running. Start it with: bun ~/.longmem/daemon.js";
  }

  switch (name) {
    case "mem_search": {
      const { query, project, limit } = args;
      try {
        // Search globally by default — only filter by project if explicitly requested
        const result = await daemon.search(String(query || ""), project as string | undefined, Number(limit || 5));

        if (result.total === 0) return "No matching memories found.";

        const lines = result.results.map(r =>
          `[ID:${r.id}] ${r.date} | ${r.tool}${r.files ? ` | ${r.files}` : ""}\n  ${r.summary}`
        );
        const projectNote = project ? ` (project: ${project})` : " (all projects)";
        return `Found ${result.total} memories${projectNote}:\n\n${lines.join("\n\n")}`;
      } catch {
        return "Search failed — daemon may be unavailable.";
      }
    }

    case "mem_timeline": {
      const id = Number(args.observation_id);
      const before = Number(args.before || 3);
      const after = Number(args.after || 3);
      try {
        const result = await daemon.timeline(id, before, after);
        const parts: string[] = [];

        if (result.before.length > 0) {
          parts.push("**Before:**");
          for (const o of result.before as any[]) {
            parts.push(`  [${o.id}] ${o.created_at?.slice(0, 10)} | ${o.tool_name}: ${o.compressed_summary || "(no summary)"}`);
          }
        }

        if (result.target) {
          const t = result.target as any;
          parts.push(`\n**Target [${t.id}]:** ${t.tool_name} — ${t.compressed_summary || "(no summary)"}`);
          if (t.files_referenced) parts.push(`Files: ${t.files_referenced}`);
        }

        if (result.after.length > 0) {
          parts.push("\n**After:**");
          for (const o of result.after as any[]) {
            parts.push(`  [${o.id}] ${o.created_at?.slice(0, 10)} | ${o.tool_name}: ${o.compressed_summary || "(no summary)"}`);
          }
        }

        return parts.join("\n") || "No timeline data found.";
      } catch {
        return "Timeline retrieval failed.";
      }
    }

    case "mem_get": {
      const ids = (args.ids as number[]) || [];
      if (ids.length === 0) return "No IDs provided.";
      try {
        const result = await daemon.getObservations(ids);
        if (result.observations.length === 0) return "No observations found for those IDs.";

        return result.observations.map((o: any) => [
          `**[${o.id}] ${o.tool_name}** — ${o.created_at?.slice(0, 16)}`,
          o.compressed_summary ? `Summary: ${o.compressed_summary}` : "",
          o.files_referenced ? `Files: ${o.files_referenced}` : "",
          o.concepts ? `Concepts: ${o.concepts}` : "",
          `Input: ${o.tool_input?.slice(0, 200) || ""}`,
          `Output: ${o.tool_output?.slice(0, 500) || ""}`,
        ].filter(Boolean).join("\n")).join("\n\n---\n\n");
      } catch {
        return "Observation retrieval failed.";
      }
    }

    case "mem_export": {
      const { project, days, format, include_raw } = args;
      try {
        const params = new URLSearchParams();
        if (project) params.set("project", String(project));
        if (days) params.set("days", String(days));
        if (format) params.set("format", String(format));
        if (include_raw) params.set("include_raw", "true");

        const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/export?${params}`, {
          signal: AbortSignal.timeout(30000),
        });

        if (!res.ok) {
          const err = await res.json() as any;
          return `Export failed: ${err.error || "unknown error"}`;
        }

        if (format === "markdown") {
          const text = await res.text();
          return `Exported memory:\n\n${text.slice(0, 8000)}${text.length > 8000 ? "\n\n... (truncated)" : ""}`;
        }

        const data = await res.json() as any;
        const summary = [
          `**LongMem Export**`,
          `Exported: ${data.exported_at}`,
          `Sessions: ${data.sessions?.length || 0}`,
          `Observations: ${data.observations?.length || 0}`,
          `User observations: ${data.userObservations?.length || 0}`,
          `Concepts: ${data.concepts?.length || 0}`,
        ].join("\n");

        return summary;
      } catch {
        return "Export failed — daemon may be unavailable.";
      }
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── Main loop ───────────────────────────────────────────────────────────────

let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", async (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    let request: MCPRequest;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }

    const { id, method, params } = request;

    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "longmem", version: "1.0.0" },
        });
        break;

      case "tools/list":
        respond(id, { tools: TOOLS });
        break;

      case "tools/call": {
        const toolName = String((params as any)?.name || "");
        const toolArgs = ((params as any)?.arguments || {}) as Record<string, unknown>;
        try {
          const content = await callTool(toolName, toolArgs);
          respond(id, { content: [{ type: "text", text: content }] });
        } catch (err: any) {
          respondError(id, -32000, err?.message || "Tool error");
        }
        break;
      }

      default:
        respondError(id, -32601, `Method not found: ${method}`);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
