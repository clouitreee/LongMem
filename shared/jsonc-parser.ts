import { readFileSync, existsSync } from "fs";

function stripJsonc(content: string): string {
  let out = "";
  let inString = false;
  let stringChar = "";
  let i = 0;

  while (i < content.length) {
    const c = content[i];
    const next = content[i + 1];

    if (inString) {
      out += c;
      if (c === "\\" && next) {
        out += next;
        i += 2;
        continue;
      }
      if (c === stringChar) inString = false;
      i += 1;
      continue;
    }

    if (c === "\"" || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      i += 1;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < content.length && content[i] !== "\n") i += 1;
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    out += c;
    i += 1;
  }

  return out.replace(/,(\s*[}\]])/g, "$1");
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
