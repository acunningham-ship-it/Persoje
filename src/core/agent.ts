import type { AgentEvent } from "./events.ts";
import { Accounting } from "./tokens.ts";
import { buildSystemPrompt, type EffortLevel, findProjectConventions } from "./prompt.ts";
import { loadPersonality, type Personality } from "./personality.ts";
import { effortPolicy } from "./effort.ts";
import { ContextManager } from "../context/manager.ts";
import { OpenRouterClient, type ToolCallRequest } from "../models/openrouter.ts";
import { getCapabilities } from "../models/capabilities.ts";
import { ToolError, type ToolContext, type ToolRegistry } from "../tools/types.ts";
import { ReadCache } from "../tools/read-cache.ts";
import type { PersojeConfig } from "../config/config.ts";
import { closestToolName } from "../guardrails/fuzzy.ts";
import { rescueToolCalls } from "../guardrails/rescue.ts";
import { LoopDetector } from "../guardrails/loops.ts";
import { postEditCheck } from "../guardrails/verify.ts";
import { assessDanger } from "../guardrails/danger.ts";
import { resolve } from "node:path";

/**
 * Tools with no side effects and no ordering constraints — safe to run
 * concurrently when the model batches several in one turn. Anything that writes,
 * edits, runs a shell command, or mutates session state is deliberately absent,
 * so a batch containing one stays strictly sequential.
 */
const READONLY_TOOLS = new Set(["read", "grep", "glob", "ls", "web_fetch", "web_search", "transcript"]);
/** Cap concurrency so a model can't fan out 30 simultaneous network fetches. */
const MAX_PARALLEL_TOOLS = 8;

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
  skills?: { injectFor(taskText: string, maxTokens: number): string; list(): Array<{ name: string; description: string }>; summaryForPrompt(): string };
  /** Personality config — loaded from disk, controls tone/verbosity/etc. */
  personality?: Personality;
  /**
   * Approval hook for mutating tools (bash/write/edit). Return false to deny.
   * Absent hook = auto-approve (plain REPL / one-shot mode).
   */
  approve?: (name: string, args: Record<string, unknown>, dangerReason?: string) => Promise<boolean>;
  /** Guardrail failure sink — the router subscribes to learn which models misbehave. */
  onFailure?: (kind: "validation" | "loop" | "syntax" | "rescue", model: string) => void;
  /** Path to the session transcript .md — given to the transcript tool. */
  transcriptPath?: string;
  /** Fired when the model (or /goal) sets the goal — persisted by the session store. */
  onGoalSet?: (goal: string) => void;
  /** Live tool progress (e.g. bash stdout tail) — the TUI shows it in the spinner. */
  onToolProgress?: (name: string, line: string) => void;
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
  readonly readCache = new ReadCache();
  private turn = 0;
  private cachedConventions: string;

  constructor(private deps: AgentDeps) {
    this.context = new ContextManager(
      deps.config.context.budgetTokens,
      deps.config.context.compactionThreshold,
      deps.config.context.keepFullTurns,
    );
    // Invalidate read cache on compaction: earlier reads may have been elided.
    // Safe-guarding against returning "[already read]" marker for content the agent no longer has.
    this.context.onCompact = () => {
      this.readCache.clear();
    };
    // Cache project conventions at initialization to ensure stable system prompt
    // prefix across all turns (no per-turn filesystem I/O).
    this.cachedConventions = findProjectConventions(deps.cwd);
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

  /**
   * Reflexion: turn a failure (or a user correction) into a concrete, reusable
   * lesson + an optional note about the model's own misbehavior. One cheap-model
   * call over the recent transcript. This is what makes self-improvement learn
   * something real instead of logging "ended with max-iterations".
   */
  async reflect(problem: string): Promise<{ lesson: string; quirk: string }> {
    const { client, config } = this.deps;
    const transcript = this.context
      .history()
      .slice(-14)
      .map((m) => {
        if (m.role === "tool") return `[tool result] ${(m.content ?? "").slice(0, 200)}`;
        if (m.role === "assistant" && "tool_calls" in m && m.tool_calls?.length)
          return `assistant: ${m.content}\n[called: ${m.tool_calls.map((c) => c.function.name).join(", ")}]`;
        return `${m.role}: ${(m.content ?? "").slice(0, 400)}`;
      })
      .join("\n");

    let raw = "";
    const stream = client.stream({
      model: config.model.compactor || config.model.primary,
      messages: [
        {
          role: "user",
          content:
            `A coding-agent turn went wrong. Problem: ${problem}\n\nRecent transcript:\n${transcript}\n\n` +
            `Reply with ONLY JSON: {"lesson": "one concrete, actionable rule to avoid this next time — imperative, <=30 words", ` +
            `"quirk": "if the MODEL itself misbehaved (malformed tool calls, looping, ignoring instructions), one short note about it; otherwise empty string"}`,
        },
      ],
      maxTokens: 250,
      temperature: 0,
    });
    for await (const ev of stream) if (ev.type === "text") raw += ev.delta;

    try {
      const m = raw.match(/\{[\s\S]*\}/);
      const obj = JSON.parse(m ? m[0] : raw) as { lesson?: string; quirk?: string };
      return { lesson: String(obj.lesson ?? "").trim(), quirk: String(obj.quirk ?? "").trim() };
    } catch {
      return { lesson: raw.trim().slice(0, 200), quirk: "" };
    }
  }

  /** Short "where are we" summary of the session so far (the /recap command). */
  async recap(): Promise<string> {
    const { client, config } = this.deps;
    const transcript = this.context
      .history()
      .slice(-20)
      .map((m) => {
        if (m.role === "tool") return `[tool] ${(m.content ?? "").slice(0, 150)}`;
        return `${m.role}: ${(m.content ?? "").slice(0, 400)}`;
      })
      .join("\n");
    if (!transcript.trim()) return "Nothing to recap yet.";
    let out = "";
    const stream = client.stream({
      model: config.model.compactor || config.model.primary,
      messages: [
        {
          role: "user",
          content:
            `Recap this coding session for someone rejoining it. 4-6 short bullets: what's been done, the current state, and what's next. No preamble.\n\n${transcript}`,
        },
      ],
      maxTokens: 400,
      temperature: 0,
    });
    for await (const ev of stream) if (ev.type === "text") out += ev.delta;
    return out.trim() || "(recap unavailable)";
  }

  /** Install/replace the approval hook after construction (the TUI does this). */
  setApprover(approve: AgentDeps["approve"]): void {
    this.deps.approve = approve;
  }

  /** Install the guardrail-failure sink (the router subscribes through this). */
  setFailureSink(onFailure: AgentDeps["onFailure"]): void {
    this.deps.onFailure = onFailure;
  }

  /** Install the live tool-progress sink (the TUI shows it in the spinner). */
  setToolProgress(onToolProgress: AgentDeps["onToolProgress"]): void {
    this.deps.onToolProgress = onToolProgress;
  }

  get model(): string {
    return this.deps.config.model.primary;
  }

  get goal(): string {
    return this.context.goal;
  }

  /** Set the goal directly (the /goal command) and persist via onGoalSet. */
  setGoal(goal: string): void {
    this.context.goal = goal;
    this.deps.onGoalSet?.(goal);
  }

  /** Wire per-session bits (transcript path + goal persistence) after construction. */
  setSessionContext(opts: { transcriptPath?: string; onGoalSet?: (goal: string) => void }): void {
    if (opts.transcriptPath !== undefined) this.deps.transcriptPath = opts.transcriptPath;
    if (opts.onGoalSet) this.deps.onGoalSet = opts.onGoalSet;
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
    let deadIters = 0; // consecutive iterations that made tool calls but ALL errored
    // NOT an iteration cap — productive turns run unbounded. This only catches a
    // model purely flailing (every call errors, zero progress) so it can't spin
    // forever, which matters most in headless/autonomous mode. 0 = never stop.
    const DEAD_LIMIT = config.loop.stuckLimit ?? 10;
    const loops = new LoopDetector();
    const maxIter = config.loop.maxIterations; // 0 = unlimited
    try {
      while (maxIter === 0 || iterations < maxIter) {
        if (signal?.aborted) {
          yield { type: "turn-end", reason: "cancelled", iterations };
          return;
        }

        // Cost ceiling: the safety net for autonomous/long runs. Checked before
        // each model call so we never spend past the limit (refusing to even
        // start a turn that's already over budget).
        const ceiling = config.loop.maxCostUsd;
        if (ceiling > 0) {
          const spent = this.accounting.totals().cost;
          if (spent >= ceiling) {
            yield {
              type: "error",
              message: `Session cost ceiling reached ($${spent.toFixed(4)} ≥ $${ceiling.toFixed(2)}). Raise it with /budget <usd> (or set loop.maxCostUsd) to continue.`,
              fatal: false,
            };
            yield { type: "turn-end", reason: "budget", iterations };
            return;
          }
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

        // Effort-aware system prompt and policy
        const effort = (config as any).effort?.level ?? "mid";
        const personality = this.deps.personality ?? loadPersonality();
        const skillCatalog = this.deps.skills?.summaryForPrompt() ?? "";
        const systemPrompt = buildSystemPrompt(cwd, this.deps.repoMap, this.deps.memoryContext, effort, personality, skillCatalog, this.context.goal, this.context.todos, this.cachedConventions);

        // Compute effort policy: reasoning, maxTokens, toolBudget, scaffold
        const modelCapabilities = getCapabilities(config.model.primary);
        const policy = effortPolicy(effort as EffortLevel, modelCapabilities);

        // Tool iteration budget: effort-aware cap on how many model→tool→model cycles per turn
        // (distinct from cost ceiling above, which is a session-level USD limit).
        if (iterations >= policy.toolBudget) {
          yield { type: "turn-end", reason: "max-iterations", iterations };
          return;
        }

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
          maxTokens: policy.maxTokens,
          reasoning: policy.reasoning,
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
          } else if (ev.type === "reasoning") {
            // Pass reasoning content through unchanged (Phase 2 renders it).
            yield { type: "reasoning", content: ev.content };
          } else if (ev.type === "usage") {
            this.accounting.record(ev.usage);
            this.context.recordActualInput(ev.usage.inputTokens, ev.usage.cachedTokens); // calibrate gauge + compaction (and detect caching)
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

        let anyOk = false;
        let anyErr = false;

        // Per-call processing: loop-guard, then execute, draining the tool's
        // event stream into an array so a batch can run concurrently while we
        // still emit events in deterministic call order.
        const processCall = async (call: ToolCallRequest): Promise<AgentEvent[]> => {
          if (loops.record(call.name, call.argsJson)) {
            const msg =
              "Loop detected: you've made this exact call repeatedly. The result will not change. " +
              "Try a different approach, or summarize what you have and stop.";
            this.context.addToolResult(call.id, msg, 100);
            this.deps.onFailure?.("loop", config.model.primary);
            return [
              { type: "guardrail", kind: "loop", message: `${call.name} repeated — execution blocked` },
              { type: "tool-result", id: call.id, name: call.name, result: msg, isError: true, truncated: false, durationMs: 0 },
            ];
          }
          const evs: AgentEvent[] = [];
          for await (const ev of this.executeToolCall(call, signal)) evs.push(ev);
          return evs;
        };

        const emit = function* (batches: AgentEvent[][]): Generator<AgentEvent> {
          for (const evs of batches) {
            for (const ev of evs) {
              if (ev.type === "tool-result") ev.isError ? (anyErr = true) : (anyOk = true);
              yield ev;
            }
          }
        };

        if (signal?.aborted) {
          // The API requires a tool message for every tool_call id we stored.
          for (const call of toolCalls) this.context.addToolResult(call.id, "[cancelled by user]", 50);
        } else if (
          toolCalls.length > 1 &&
          toolCalls.length <= MAX_PARALLEL_TOOLS &&
          toolCalls.every((c) => READONLY_TOOLS.has(c.name))
        ) {
          // Independent read-only calls (the model batched several reads/searches)
          // — run them concurrently, then emit in call order. No side effects, so
          // ordering is irrelevant to correctness and we save the round-trip latency.
          if (!signal?.aborted) {
            const batches = await Promise.all(toolCalls.map((c) => processCall(c)));
            yield* emit(batches);
          }
        } else {
          // Anything that mutates (write/edit/bash/…) stays strictly sequential,
          // preserving the order the model intended (e.g. edit then run the test).
          for (const call of toolCalls) {
            if (signal?.aborted) {
              this.context.addToolResult(call.id, "[cancelled by user]", 50);
              continue;
            }
            yield* emit([await processCall(call)]);
          }
        }

        // Circuit breaker: if a run keeps making tool calls that all error and
        // nothing succeeds, stop — otherwise an unlimited (maxIter=0) turn spins
        // forever on a confused model (e.g. malformed tool names).
        deadIters = !anyOk && anyErr ? deadIters + 1 : 0;
        if (DEAD_LIMIT >= 1 && deadIters >= DEAD_LIMIT) {
          yield {
            type: "error",
            message: `Stopped: ${DEAD_LIMIT} straight rounds of tool errors with no progress. The model may be stuck — try rephrasing, a stronger model, or /clear.`,
            fatal: false,
          };
          yield { type: "turn-end", reason: "max-iterations", iterations };
          return;
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

    // Danger guard is enforced in CORE so no UI trust level (not even yolo) can
    // bypass it. Dangerous calls always go through approve() with a reason; the
    // TUI is required to confirm those regardless of permsoff/always-allow.
    const danger = assessDanger(tool.name, parsed.data as Record<string, unknown>, cwd);
    // No approver (headless / one-shot): refuse dangerous ops rather than run
    // them blind. Routine mutations still auto-run in those modes.
    if (danger.dangerous && !this.deps.approve) {
      const msg = `Refused (${danger.reason}): this needs interactive confirmation, which isn't available here. Use a safer approach or run it yourself.`;
      this.context.addToolResult(call.id, msg, 120);
      yield { type: "tool-result", id: call.id, name: tool.name, result: msg, isError: true, truncated: false, durationMs: 0 };
      return;
    }
    if ((danger.dangerous || MUTATING_TOOLS.has(tool.name)) && this.deps.approve) {
      const ok = await this.deps.approve(
        tool.name,
        parsed.data as Record<string, unknown>,
        danger.dangerous ? danger.reason : undefined,
      );
      if (!ok) {
        const msg = "Denied by user. Ask before retrying this action, or try a different approach.";
        this.context.addToolResult(call.id, msg, 100);
        yield { type: "tool-result", id: call.id, name: tool.name, result: msg, isError: true, truncated: false, durationMs: 0 };
        return;
      }
      started = Date.now(); // don't count time spent waiting for the user's answer
    }

    const ctx: ToolContext = {
      cwd,
      signal,
      bashTimeoutMs: config.loop.bashTimeoutMs,
      transcriptPath: this.deps.transcriptPath,
      readCache: this.readCache,
      setGoal: (g: string) => {
        this.context.goal = g;
        this.deps.onGoalSet?.(g);
      },
      setTodos: (items) => {
        this.context.todos = items;
      },
      onProgress: (line: string) => this.deps.onToolProgress?.(tool.name, line),
    };
    const cap = config.toolResultCaps[tool.name] ?? tool.maxResultTokens;
    try {
      let result = await tool.execute(parsed.data, ctx);

      // Post-edit verification: don't let a weak model leave the file broken
      // and believe its own "done". The error goes straight back to the model.
      if ((tool.name === "edit" || tool.name === "write" || tool.name === "multi_edit") && typeof (parsed.data as any).path === "string") {
        const syntaxError = await postEditCheck(resolve(cwd, (parsed.data as any).path)).catch(() => null);
        if (syntaxError) {
          result += `\nWARNING — the file now has a syntax error. Fix it before proceeding:\n${syntaxError}`;
          this.deps.onFailure?.("syntax", config.model.primary);
          yield { type: "guardrail", kind: "syntax", message: `post-edit check failed: ${(parsed.data as any).path}` };
        }
      }

      // Surface plan changes to the UI so the checklist updates live mid-turn.
      if (tool.name === "update_todos") {
        yield { type: "todos", items: this.context.todos };
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
