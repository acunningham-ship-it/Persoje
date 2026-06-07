import type { AgentEvent } from "./events.ts";
import { Accounting } from "./tokens.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { ContextManager } from "../context/manager.ts";
import { OpenRouterClient, type ToolCallRequest } from "../models/openrouter.ts";
import { ToolError, type ToolContext, type ToolRegistry } from "../tools/types.ts";
import type { PersojeConfig } from "../config/config.ts";

export interface AgentDeps {
  client: OpenRouterClient;
  tools: ToolRegistry;
  config: PersojeConfig;
  cwd: string;
}

/**
 * The agent loop. Pure core: no UI imports, communicates only via the
 * AsyncGenerator<AgentEvent> stream. Guardrails (M4) will wrap tool-call
 * handling; compaction (M3) hooks in via ContextManager.
 */
export class Agent {
  readonly context: ContextManager;
  readonly accounting = new Accounting();
  private turn = 0;

  constructor(private deps: AgentDeps) {
    this.context = new ContextManager(
      deps.config.context.budgetTokens,
      deps.config.context.compactionThreshold,
    );
  }

  get model(): string {
    return this.deps.config.model.primary;
  }

  set model(id: string) {
    this.deps.config.model.primary = id;
  }

  async *run(userInput: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const { client, tools, config, cwd } = this.deps;
    this.turn++;
    this.context.addUser(userInput);
    yield { type: "turn-start", turn: this.turn };

    let iterations = 0;
    try {
      while (iterations < config.loop.maxIterations) {
        if (signal?.aborted) {
          yield { type: "turn-end", reason: "cancelled", iterations };
          return;
        }
        iterations++;

        let text = "";
        let toolCalls: ToolCallRequest[] = [];

        const stream = client.stream({
          model: config.model.primary,
          fallbackModels: config.model.fallbacks,
          messages: this.context.build(buildSystemPrompt(cwd)),
          tools: tools.schemas(),
          temperature: config.model.temperature,
          signal,
        });

        for await (const ev of stream) {
          if (ev.type === "text") {
            text += ev.delta;
            if (ev.delta) yield { type: "text-delta", delta: ev.delta };
          } else if (ev.type === "tool-calls") {
            toolCalls = ev.calls;
          } else if (ev.type === "usage") {
            this.accounting.record(ev.usage);
            yield { type: "usage", usage: ev.usage };
          }
        }
        if (text) yield { type: "text-end", text };

        this.context.addAssistant(text, toolCalls);

        if (toolCalls.length === 0) {
          yield { type: "turn-end", reason: "done", iterations };
          return;
        }

        for (const call of toolCalls) {
          if (signal?.aborted) {
            // The API requires a tool message for every tool_call id we stored.
            this.context.addToolResult(call.id, "[cancelled by user]", 50);
            continue;
          }
          yield* this.executeToolCall(call, signal);
        }
      }
      yield { type: "turn-end", reason: "max-iterations", iterations };
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        yield { type: "turn-end", reason: "cancelled", iterations };
        return;
      }
      yield { type: "error", message: (e as Error).message, fatal: true };
      yield { type: "turn-end", reason: "error", iterations };
    }
  }

  private async *executeToolCall(call: ToolCallRequest, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const { tools, config, cwd } = this.deps;
    const started = Date.now();
    const tool = tools.get(call.name);

    // Unknown tool or bad JSON → error result back to the model so it can correct
    // itself. (Fuzzy matching and re-prompt policies arrive with guardrails in M4.)
    if (!tool) {
      const msg = `Error: unknown tool "${call.name}". Available: ${tools.names().join(", ")}`;
      this.context.addToolResult(call.id, msg, 200);
      yield { type: "tool-result", id: call.id, name: call.name, result: msg, isError: true, truncated: false, durationMs: 0 };
      return;
    }

    let rawArgs: unknown;
    try {
      rawArgs = JSON.parse(call.argsJson);
    } catch {
      const msg = `Error: arguments for ${call.name} were not valid JSON.`;
      this.context.addToolResult(call.id, msg, 200);
      yield { type: "tool-result", id: call.id, name: call.name, result: msg, isError: true, truncated: false, durationMs: 0 };
      return;
    }

    const parsed = tool.args.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      const msg = `Error: invalid arguments for ${tool.name} — ${issues}`;
      this.context.addToolResult(call.id, msg, 300);
      yield { type: "tool-result", id: call.id, name: call.name, result: msg, isError: true, truncated: false, durationMs: 0 };
      return;
    }

    yield { type: "tool-start", id: call.id, name: tool.name, args: parsed.data as Record<string, unknown> };

    const ctx: ToolContext = { cwd, signal, bashTimeoutMs: config.loop.bashTimeoutMs };
    const cap = config.toolResultCaps[tool.name] ?? tool.maxResultTokens;
    try {
      const result = await tool.execute(parsed.data, ctx);
      const { stored, truncated } = this.context.addToolResult(call.id, result, cap);
      yield {
        type: "tool-result",
        id: call.id,
        name: tool.name,
        result: stored,
        isError: false,
        truncated,
        durationMs: Date.now() - started,
      };
    } catch (e) {
      const msg = e instanceof ToolError ? `Error: ${e.message}` : `Error: ${(e as Error).message}`;
      const { stored } = this.context.addToolResult(call.id, msg, cap);
      yield {
        type: "tool-result",
        id: call.id,
        name: tool.name,
        result: stored,
        isError: true,
        truncated: false,
        durationMs: Date.now() - started,
      };
    }
  }
}
