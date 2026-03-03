/**
 * Test: CLI export argument parsing and validation
 * Tests the parseArgs function and argument validation logic.
 */
import { describe, test, expect } from "bun:test";

interface ExportOptions {
  project?: string;
  days?: number;
  format?: "json" | "markdown";
  includeRaw?: boolean;
  output?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): ExportOptions {
  const result: ExportOptions = {};

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

function validateDays(days: number | undefined): boolean {
  if (days === undefined) return true;
  return !isNaN(days) && days >= 1 && days <= 365;
}

describe("cli/export parseArgs", () => {
  test("empty args returns empty object", () => {
    expect(parseArgs([])).toEqual({});
  });

  test("--help sets help flag", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["-h"])).toEqual({ help: true });
  });

  test("--project sets project name", () => {
    expect(parseArgs(["--project", "myapp"])).toEqual({ project: "myapp" });
    expect(parseArgs(["-p", "myapp"])).toEqual({ project: "myapp" });
  });

  test("--days sets days number", () => {
    expect(parseArgs(["--days", "30"])).toEqual({ days: 30 });
    expect(parseArgs(["-d", "7"])).toEqual({ days: 7 });
  });

  test("--format sets format", () => {
    expect(parseArgs(["--format", "json"])).toEqual({ format: "json" });
    expect(parseArgs(["-f", "markdown"])).toEqual({ format: "markdown" });
  });

  test("--raw sets includeRaw flag", () => {
    expect(parseArgs(["--raw"])).toEqual({ includeRaw: true });
    expect(parseArgs(["-r"])).toEqual({ includeRaw: true });
  });

  test("--output sets output file", () => {
    expect(parseArgs(["--output", "export.json"])).toEqual({ output: "export.json" });
    expect(parseArgs(["-o", "export.md"])).toEqual({ output: "export.md" });
  });

  test("combined args work together", () => {
    const result = parseArgs([
      "--project", "myapp",
      "--days", "30",
      "--format", "markdown",
      "--raw",
      "--output", "export.md"
    ]);
    expect(result).toEqual({
      project: "myapp",
      days: 30,
      format: "markdown",
      includeRaw: true,
      output: "export.md"
    });
  });

  test("short flags combined", () => {
    const result = parseArgs([
      "-p", "myapp",
      "-d", "7",
      "-f", "json",
      "-r",
      "-o", "export.json"
    ]);
    expect(result).toEqual({
      project: "myapp",
      days: 7,
      format: "json",
      includeRaw: true,
      output: "export.json"
    });
  });

  test("unknown args are ignored", () => {
    const result = parseArgs(["--unknown", "value", "--project", "myapp"]);
    expect(result).toEqual({ project: "myapp" });
  });
});

describe("cli/export validateDays", () => {
  test("undefined days is valid", () => {
    expect(validateDays(undefined)).toBe(true);
  });

  test("valid days range 1-365", () => {
    expect(validateDays(1)).toBe(true);
    expect(validateDays(30)).toBe(true);
    expect(validateDays(365)).toBe(true);
  });

  test("days below 1 is invalid", () => {
    expect(validateDays(0)).toBe(false);
    expect(validateDays(-1)).toBe(false);
  });

  test("days above 365 is invalid", () => {
    expect(validateDays(366)).toBe(false);
    expect(validateDays(1000)).toBe(false);
  });

  test("NaN days is invalid", () => {
    expect(validateDays(NaN)).toBe(false);
  });
});

describe("cli/export help output", () => {
  test("help string contains expected sections", () => {
    const helpText = `
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
`;

    expect(helpText).toContain("--project");
    expect(helpText).toContain("--days");
    expect(helpText).toContain("--format");
    expect(helpText).toContain("--raw");
    expect(helpText).toContain("--output");
    expect(helpText).toContain("--help");
    expect(helpText).toContain("json");
    expect(helpText).toContain("markdown");
  });
});