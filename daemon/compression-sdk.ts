import OpenAI from "openai";
import type { MemoryConfig } from "./config.ts";

const COMPRESS_PROMPT = `You are a memory compression engine. Analyze tool usage and extract essential, reusable knowledge.

Given tool execution data, output a JSON object with:
- summary: One clear sentence about what happened (max 100 chars)
- type: One of: decision, bugfix, feature, refactor, discovery, pattern, change, note
- files: Array of file paths referenced (max 5)
- concepts: Array of key concepts/tags (max 5)

Be extremely concise. Focus on WHAT was learned, not HOW.`;

export interface CompressedObservation {
  summary: string;
  type: string;
  files: string[];
  concepts: string[];
}

function safeParseJson(text: string | null | undefined, fallback: CompressedObservation): CompressedObservation {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : fallback.summary,
      type: typeof parsed.type === "string" ? parsed.type : fallback.type,
      files: Array.isArray(parsed.files) ? parsed.files.filter((f: unknown) => typeof f === "string") : [],
      concepts: Array.isArray(parsed.concepts) ? parsed.concepts.filter((c: unknown) => typeof c === "string") : [],
    };
  } catch {
    return fallback;
  }
}

export class CompressionSDK {
  private client: OpenAI;
  private model: string;
  private timeoutMs: number;

  constructor(config: MemoryConfig["compression"]) {
    this.model = config.model;
    this.timeoutMs = (config.timeoutSeconds ?? 30) * 1000;

    this.client = new OpenAI({
      apiKey: config.apiKey || "no-key",
      baseURL: config.baseURL || "https://openrouter.ai/api/v1",
      defaultHeaders: config.provider === "openrouter" ? {
        "HTTP-Referer": "https://github.com/clouitreee/LongMem",
        "X-Title": "longmem",
      } : undefined,
    });
  }

  async compress(toolName: string, toolInput: unknown, toolOutput: unknown): Promise<CompressedObservation> {
    const fallback: CompressedObservation = {
      summary: `${toolName} executed`,
      type: "note",
      files: [],
      concepts: [toolName],
    };

    // Safely serialize input/output with size limits
    let inputStr: string;
    let outputStr: string;
    
    try {
      inputStr = JSON.stringify(toolInput, null, 2).slice(0, 1000);
    } catch {
      inputStr = "[input serialization failed]";
    }
    
    try {
      outputStr = (typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput)).slice(0, 2000);
    } catch {
      outputStr = "[output serialization failed]";
    }

    const content = `Tool: ${toolName}
Input: ${inputStr}
Output: ${outputStr}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: "system", content: COMPRESS_PROMPT },
            { role: "user", content },
          ],
          max_tokens: 256,
          temperature: 0.3,
          response_format: { type: "json_object" },
        },
        { signal: controller.signal as any }
      );

      return safeParseJson(response.choices[0]?.message?.content, fallback);
    } catch (error: any) {
      if (error?.name === "AbortError") throw new Error("Compression timeout");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
