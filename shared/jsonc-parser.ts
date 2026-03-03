import { readFileSync, existsSync } from "fs";

function stripJsonc(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
}

export type ParseResult =
  | {
      ok: true;
      data: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
    };

export function parseJsonc(path: string): ParseResult {
  try {
    if (!existsSync(path)) {
      return { ok: false, error: "File not found" };
    }
    const raw = readFileSync(path, "utf-8");
    const stripped = stripJsonc(raw);
    const data = JSON.parse(stripped);
    return { ok: true, data };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Parse error";
    return { ok: false, error: msg };
  }
}
