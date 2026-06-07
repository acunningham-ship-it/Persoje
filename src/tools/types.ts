import { z } from "zod";
import type { ToolSchema } from "../models/openrouter.ts";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  bashTimeoutMs: number;
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

export class ToolRegistry {
  private tools = new Map<string, Tool>();

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

  /** OpenAI-format schemas for the API request. */
  schemas(): ToolSchema[] {
    return this.all().map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: z.toJSONSchema(t.args),
      },
    }));
  }
}
