#!/usr/bin/env bun
import { writeFileSync } from "fs";
import { DEFAULT_HOST, DEFAULT_PORT } from "../shared/constants.ts";

interface ExportOptions {
  project?: string;
  days?: number;
  format?: "json" | "markdown";
  includeRaw?: boolean;
  output?: string;
}

function parseArgs(argv: string[]): ExportOptions & { help?: boolean } {
  const result: ExportOptions & { help?: boolean } = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--project" || arg === "-p") {
      result.project = argv[++i];
    } else if (arg === "--days" || arg === "-d") {
      result.days = parseInt(argv[++i], 10);
    } else if (arg === "--format" || arg === "-f") {
      result.format = argv[++i] as "json" | "markdown";
    } else if (arg === "--raw" || arg === "-r") {
      result.includeRaw = true;
    } else if (arg === "--output" || arg === "-o") {
      result.output = argv[++i];
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
longmem export - Export LongMem memory to JSON or Markdown

Usage:
  longmem export [options]

Options:
  -p, --project <name>   Filter by project name
  -d, --days <n>         Only include last N days (max: 365)
  -f, --format <fmt>     Output format: json (default) or markdown
  -r, --raw              Include raw tool_input/tool_output
  -o, --output <file>    Write to file instead of stdout
  -h, --help             Show this help

Examples:
  longmem export > backup.json
  longmem export --format markdown --days 30 > report.md
  longmem export --project myapp -o myapp-memory.json
`);
}

export async function runExport(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (opts.days && (isNaN(opts.days) || opts.days < 1 || opts.days > 365)) {
    console.error("Error: --days must be between 1 and 365");
    process.exit(1);
  }

  const params = new URLSearchParams();
  if (opts.project) params.set("project", opts.project);
  if (opts.days) params.set("days", String(opts.days));
  if (opts.format) params.set("format", opts.format);
  if (opts.includeRaw) params.set("include_raw", "true");

  try {
    const res = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/export?${params}`, {
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const err = await res.json() as any;
      console.error(`Error: ${err.error || "Export failed"}`);
      process.exit(1);
    }

    if (opts.format === "markdown") {
      const text = await res.text();
      if (opts.output) {
        writeFileSync(opts.output, text);
        console.log(`Exported to ${opts.output}`);
      } else {
        console.log(text);
      }
    } else {
      const data = await res.json();
      const json = JSON.stringify(data, null, 2);

      if (opts.output) {
        writeFileSync(opts.output, json);
        console.log(`Exported to ${opts.output}`);
      } else {
        console.log(json);
      }
    }
  } catch (e: any) {
    if (e?.cause?.code === "ECONNREFUSED") {
      console.error("Error: Daemon not running. Start with: longmem start");
    } else {
      console.error(`Error: ${e?.message || "Export failed"}`);
    }
    process.exit(1);
  }
}

runExport(process.argv.slice(2));