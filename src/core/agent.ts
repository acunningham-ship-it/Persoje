import type { AgentEvent } from "./events.ts";
import { Accounting } from "./tokens.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { ContextManager } from "../context/manager.ts";
import { OpenRouterClient, type ToolCallRequest } from "../models/openrouter.ts";
import { ToolError, type ToolContext, type ToolRegistry } from "../tools/types.ts";
import type { PersojeConfig } from "../config/config.ts";
import { closestToolName } from "../guardrails/fuzzy.ts";
import { rescueToolCalls } from "../guardrails/rescue.ts";
import { LoopDetector } from "../guardrails/loops.ts";
import { postEditCheck } from "../guardrails/verify.ts";
import { resolve } from "node:path";

export interface AgentDeps {
  client: OpenRouterClient;
  tools: ToolRegistry;
  config: PersojeConfig;
  cwd: string;
  /** Pre-built repo-map appended to the system prompt (empty = none). */
  repoMap?: string;
  /** Session-start memory block (fact index + recent lessons), bounded by config. */
  memoryContext?: string;
  /** Skill library — relevant skills are injected per user turn, not per session. */
  skills?: { injectFor(taskText: string, maxTokens: number): string };
  /**
   * Approval hook for mutating tools (bash/write/edit). Return false to deny.
   * Absent hook = auto-approve (plain REPL / one-shot mode).
   */
  approve?: (name: string, args: Record<string, unknown>) => Promise<boolean>;
  /** Guardrail failure sink — the router subscribes to learn which models misbehave. */
  onFailure?: (kind: "validation" | "loop" | "syntax" | "rescue", model: string) => void;
}

/** Tools that can change the system — gated behind the approval hook. */
const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);

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
      deps.config.context.keepFullTurns,
    );
  }

  /** Compact the conversation via the compactor model (free-model grunt work). */
  async compact(): Promise<{ before: number; after: number } | null> {
    const { client, config } = this.deps;
    return this.context.compact(async (transcript) => {
      let summary = "";
      const stream = client.stream({
        model: config.model.compactor || config.model.primary,
        messages: [
          {
            role: "user",
            content:
              `Summarize this coding-session transcript into a dense brief for an agent continuing the work. ` +
              `Include: completed steps, files touched and how, current task state, key decisions/constraints. ` +
              `Max 250 words, no preamble.\n\n${transcript}`,
          },
        ],
        maxTokens: 600,
        temperature: 0,
      });
      for await (const ev of stream) {
        if (ev.type === "text") summary += ev.delta;
      }
      return summary.trim() || "(summary unavailable)";
    });
  }

  /** Install/replace the approval hook after construction (the TUI does this). */
  setApprover(approve: AgentDeps["approve"]): void {
    this.deps.approve = approve;
  }

  /** Install the guardrail-failure sink (the router subscribes through this). */
  setFailureSink(onFailure: AgentDeps["onFailure"]): void {
    this.deps.onFailure = onFailure;
  }

  get model(): string {
    return this.deps.config.model.primary;
  }

  get repoMap(): string {
    return this.deps.repoMap ?? "";
  }

  set model(id: string) {
    this.deps.config.model.primary = id;
  }

  async *run(userInput: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const { client, tools, config, cwd } = this.deps;
    this.turn++;
    // Skills ride on the user message (not the system prompt) so they only
    // cost tokens on turns where they're actually relevant.
    const skill = this.deps.skills?.injectFor(userInput, 600) ?? "";
    this.context.addUser(skill ? `${userInput}\n\n[relevant skill from memory]\n${skill}` : userInput);
    yield { type: "turn-start", turn: this.turn };

    let iterations = 0;
    const loops = new LoopDetector();
    const maxIter = config.loop.maxIterations; // 0 = unlimited
    try {
      while (maxIter === 0 || iterations < maxIter) {
        if (signal?.aborted) {
          yield { type: "turn-end", reason: "cancelled", iterations };
          return;
        }
        iterations++;

        // Token discipline: compact before the call once history crosses the
        // threshold; inside a single long turn, fall back to eliding old tool results.
        if (this.context.needsCompaction()) {
          const result = (await this.compact().catch(() => null)) ?? this.context.elideOldToolResults();
          if (result) yield { type: "compaction", beforeTokens: result.before, afterTokens: result.after };
        }

        let text = "";
        let toolCalls: ToolCallRequest[] = [];

        // Effort-aware system prompt
        const effort = (config as any).effort?.level ?? "mid";
        const systemPrompt = buildSystemPrompt(cwd, this.deps.repoMap, this.deps.memoryContext, effort);
        // Use cache-optimized build when prompt caching is enabled — inserts
        // cache_control breakpoints at stable turn boundaries for maximum
        // cache hit rate on OpenRouter/Anthropic (50% cost on cached tokens).
        const messages = config.context.cacheSystemPrompt
          ? this.context.buildWithCacheBreakpoints(systemPrompt)
          : this.context.build(systemPrompt);
        const stream = client.stream({
          model: config.model.primary,
          fallbackModels: config.model.fallbacks,
          messages,
          tools: tools.schemas(),
          temperature: config.model.temperature,
          cacheSystemPrompt: config.context.cacheSystemPrompt,
          provider: config.openrouter.provider,
          signal,
          maxRetries: (config as any).retry?.maxRetries ?? 5,
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
          } else if (ev.type === "retry") {
            yield { type: "retry", attempt: ev.attempt, maxRetries: ev.maxRetries, delayMs: ev.delayMs, reason: ev.reason };
          }
        }
        // Rescue: weak models emit tool calls as text instead of native tool_calls.
        if (toolCalls.length === 0 && text) {
          const rescued = rescueToolCalls(text, tools.names());
          if (rescued.calls.length > 0) {
            toolCalls = rescued.calls;
            text = rescued.cleanedText;
            this.deps.onFailure?.("rescue", config.model.primary);
            yield {
              type: "guardrail",
              kind: "rescue",
              message: `recovered ${rescued.calls.length} tool call(s) embedded in text`,
            };
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
          // Loop guard: identical call repeating — refuse execution, tell the model.
          if (loops.record(call.name, call.argsJson)) {
            const msg =
              "Loop detected: you've made this exact call repeatedly. The result will not change. " +
              "Try a different approach, or summarize what you have and stop.";
            this.context.addToolResult(call.id, msg, 100);
            this.deps.onFailure?.("loop", config.model.primary);
            yield { type: "guardrail", kind: "loop", message: `${call.name} repeated — execution blocked` };
            yield { type: "tool-result", id: call.id, name: call.name, result: msg, isError: true, truncated: false, durationMs: 0 };
            continue;
          }
          yield* this.executeToolCall(call, signal);
        }
      }
      // Only reached if maxIter > 0 and we hit it
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
    let started = Date.now();
    let tool = tools.get(call.name);

    // Hallucinated tool name → fuzzy-correct silently when unambiguous,
    // otherwise error back to the model so it can fix itself.
    if (!tool) {
      const corrected = closestToolName(call.name, tools.names());
      if (corrected) {
        tool = tools.get(corrected)!;
        this.deps.onFailure?.("validation", config.model.primary);
        yield { type: "guardrail", kind: "fuzzy", message: `"${call.name}" → ${corrected}` };
      } else {
        const msg = `Error: unknown tool "${call.name}". Available: ${tools.names().join(", ")}`;
        this.context.addToolResult(call.id, msg, 200);
        this.deps.onFailure?.("validation", config.model.primary);
        yield { type: "tool-result", id: call.id, name: call.name, result: msg, isError: true, truncated: false, durationMs: 0 };
        return;
      }
    }

    let rawArgs: unknown;
    try {
      rawArgs = JSON.parse(call.argsJson);
    } catch {
      const msg = `Error: arguments for ${call.name} were not valid JSON.`;
      this.context.addToolResult(call.id, msg, 200);
      this.deps.onFailure?.("validation", config.model.primary);
      yield { type: "tool-result", id: call.id, name: call.name, result: msg, isError: true, truncated: false, durationMs: 0 };
      return;
    }

    const parsed = tool.args.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      const msg = `Error: invalid arguments for ${tool.name} — ${issues}`;
      this.context.addToolResult(call.id, msg, 300);
      this.deps.onFailure?.("validation", config.model.primary);
      yield { type: "tool-result", id: call.id, name: call.name, result: msg, isError: true, truncated: false, durationMs: 0 };
      return;
    }

    yield { type: "tool-start", id: call.id, name: tool.name, args: parsed.data as Record<string, unknown> };

    if (MUTATING_TOOLS.has(tool.name) && this.deps.approve) {
      const ok = await this.deps.approve(tool.name, parsed.data as Record<string, unknown>);
      if (!ok) {
        const msg = "Denied by user. Ask before retrying this action, or try a different approach.";
        this.context.addToolResult(call.id, msg, 100);
        yield { type: "tool-result", id: call.id, name: tool.name, result: msg, isError: true, truncated: false, durationMs: 0 };
        return;
      }
      started = Date.now(); // don't count time spent waiting for the user's answer
    }

    const ctx: ToolContext = { cwd, signal, bashTimeoutMs: config.loop.bashTimeoutMs };
    const cap = config.toolResultCaps[tool.name] ?? tool.maxResultTokens;
    try {
      let result = await tool.execute(parsed.data, ctx);

      // Post-edit verification: don't let a weak model leave the file broken
      // and believe its own "done". The error goes straight back to the model.
      if ((tool.name === "edit" || tool.name === "write") && typeof (parsed.data as any).path === "string") {
        const syntaxError = await postEditCheck(resolve(cwd, (parsed.data as any).path)).catch(() => null);
        if (syntaxError) {
          result += `\nWARNING — the file now has a syntax error. Fix it before proceeding:\n${syntaxError}`;
          this.deps.onFailure?.("syntax", config.model.primary);
          yield { type: "guardrail", kind: "syntax", message: `post-edit check failed: ${(parsed.data as any).path}` };
        }
      }

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
