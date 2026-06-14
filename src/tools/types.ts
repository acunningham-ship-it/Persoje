import { z } from "zod";
import type { ToolSchema } from "../models/openrouter.ts";
import type { ReadCache } from "./read-cache.ts";

/** A single step in the working plan the model maintains via update_todos. */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "done";
}

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  bashTimeoutMs: number;
  /** Record/replace the session goal (set_goal tool). */
  setGoal?: (goal: string) => void;
  /** Replace the working plan (update_todos tool). */
  setTodos?: (items: TodoItem[]) => void;
  /** Path to the full session transcript .md (transcript tool reads it). */
  transcriptPath?: string;
  /** Live progress (e.g. latest bash stdout line) — surfaced in the spinner. */
  onProgress?: (line: string) => void;
  /** Per-session read deduplication cache. */
  readCache?: ReadCache;
}

export interface Tool<A = any> {
  name: string;
  /** One line. Tool schemas ride along on every model call — keep them token-lean. */
  description: string;
  args: z.ZodType<A>;
  /** Default result cap in tokens (config can override per tool). */
  maxResultTokens: number;
  execute(args: A, ctx: ToolContext): Promise<string>;
}

export class ToolError extends Error {}

/**
 * Drop JSON-schema keywords the model doesn't need but that ride on every call:
 * the `$schema` dialect URL (~15 tok/tool) and `additionalProperties`. Pure
 * token savings, zero effect on how the model reads the tool.
 */
function stripSchemaNoise(schema: Record<string, unknown>): Record<string, unknown> {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "$schema" || k === "additionalProperties") continue;
        out[k] = clean(v);
      }
      return out;
    }
    return node;
  };
  return clean(schema) as Record<string, unknown>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private schemasCache: ToolSchema[] | null = null;
  private schemaCacheTokens = 0;
  private lastToolNames: string[] = [];

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  all(): Tool[] {
    return [...this.tools.values()];
  }

  /** Subset registry, for sub-agents / read-only modes. */
  subset(names: string[]): ToolRegistry {
    const r = new ToolRegistry();
    for (const n of names) {
      const t = this.tools.get(n);
      if (t) r.register(t);
    }
    return r;
  }

  /** OpenAI-format schemas for the API request (memoized). */
  schemas(): ToolSchema[] {
    const currentNames = this.names();
    // Check if tool list changed — if not, return cached schemas
    if (
      this.schemasCache !== null &&
      this.lastToolNames.length === currentNames.length &&
      this.lastToolNames.every((name, i) => name === currentNames[i])
    ) {
      return this.schemasCache;
    }

    // Recompute schemas when tool list changes
    this.schemasCache = this.all().map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: stripSchemaNoise(z.toJSONSchema(t.args)),
      },
    }));
    this.lastToolNames = [...currentNames];

    // Estimate token count (simple heuristic: JSON length / 4)
    const serialized = JSON.stringify(this.schemasCache);
    this.schemaCacheTokens = Math.ceil(serialized.length / 4);

    return this.schemasCache;
  }

  /** Return the token cost of the current schemas (computed at last call to schemas()). */
  schemaTokens(): number {
    return this.schemaCacheTokens;
  }

  /** Invalidate schema cache if tool registry mutates dynamically. */
  invalidateSchemaCache(): void {
    this.schemasCache = null;
    this.lastToolNames = [];
    this.schemaCacheTokens = 0;
  }
}
