import type { AgentEvent } from "./events.ts";
import { Accounting, estimateTokens } from "./tokens.ts";
import { buildSystemPrompt, buildRepoMapSection, buildPinsSection, findProjectConventions } from "./prompt.ts";
import { ContextManager } from "../context/manager.ts";
import { OpenRouterClient, type ToolCallRequest, type ChatMessage } from "../models/openrouter.ts";
import { ToolError, type ToolContext, type ToolRegistry } from "../tools/types.ts";
import { ReadCache } from "../tools/read-cache.ts";
import type { PersojeConfig } from "../config/config.ts";
import { resolveProvider } from "../config/config.ts";
import { detectPrimerMode } from "../guardrails/primer-detect.ts";
import { closestToolName } from "../guardrails/fuzzy.ts";
import { rescueToolCalls } from "../guardrails/rescue.ts";
import { LoopDetector } from "../guardrails/loops.ts";
import { postEditCheck } from "../guardrails/verify.ts";
import { assessDanger } from "../guardrails/danger.ts";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { FactStore } from "../memory/facts.ts";
import { getMonitorManager, type MonitorTick } from "./monitors.ts";

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
  /** Skill library — relevant skills are injected per user turn, not per session. */
  skills?: { injectFor(taskText: string, maxTokens: number): string; list(): Array<{ name: string; description: string }>; summaryForPrompt(): string };
  /**
   * Approval hook for mutating tools (bash/write/edit). Return false to deny.
   * Absent hook = auto-approve (plain REPL / one-shot mode).
   */
  approve?: (name: string, args: Record<string, unknown>, dangerReason?: string) => Promise<boolean>;
  /** Guardrail failure sink — the router subscribes to learn which models misbehave. */
  onFailure?: (kind: "validation" | "loop" | "syntax" | "rescue", model: string) => void;
  /** Router event sink — escalation suggestions and warnings. */
  onRouterEvent?: (event: { message: string; target: string | null; mode: string; currentModel: string }) => void;
  /** Path to the session transcript .md — given to the transcript tool. */
  transcriptPath?: string;
  /** Fired when the model (or /goal) sets the goal — persisted by the session store. */
  onGoalSet?: (goal: string) => void;
  /** Live tool progress (e.g. bash stdout tail) — the TUI shows it in the spinner. */
  onToolProgress?: (name: string, line: string) => void;
  /** Record usage from an external source (subagent costs roll up to parent). */
  recordExternalUsage?: (usage: { inputTokens: number; outputTokens: number; cost: number; calls: number }) => void;
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
  private cachedQuirks: string[];
  /** Cached primer-mode detection result per session (one probe, reuse for all turns). */
  private primerModeCache: boolean | null = null;

  constructor(readonly deps: AgentDeps) {
    this.context = new ContextManager(
      deps.config.context.budgetTokens,
      deps.config.context.compactionThreshold,
      deps.config.context.keepFullTurns,
      deps.config.context.headroom,
      deps.config.context.accurateEstimates,
    );
    // Invalidate read cache on compaction: earlier reads may have been elided.
    // Safe-guarding against returning "[already read]" marker for content the agent no longer has.
    this.context.onCompact = () => {
      this.readCache.clear();
    };
    // Cache project conventions at initialization to ensure stable system prompt
    // prefix across all turns (no per-turn filesystem I/O).
    this.cachedConventions = findProjectConventions(deps.cwd);

    // Fetch and cache the active model's quirks once at init. Quirks are stable
    // per session — only change if the user explicitly switches models.
    const factDir = join(homedir(), ".config", "persoje", "memory");
    const facts = new FactStore(factDir);
    this.cachedQuirks = facts.getQuirks(deps.config.model.primary);

    // Wire schema cost into context for /status display — compute schemas once to populate cache,
    // then store the cost; schemas are memoized and stable across turns.
    deps.tools.schemas();
    this.context.setSchemaTokens(deps.tools.schemaTokens());
    // Wire subagent cost roll-up to this agent's accounting
    deps.recordExternalUsage = (usage) => this.accounting.recordExternal(usage);
  }

  /** Force primer-mode re-detection on the next turn — call after the provider/client changes
   *  (e.g. a live /provider switch), since detection is otherwise probed once and cached. */
  resetPrimerDetection(): void {
    this.primerModeCache = null;
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

  /** Compact for primer mode: freeze old turns into an immutable summary block (append-only). */
  async compactForPrimer(): Promise<{ before: number; after: number } | null> {
    const { client, config } = this.deps;
    return this.context.compactForPrimer(async (transcript) => {
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

        // Background monitor check: run any due monitors silently between iterations.
        // Fired alerts (non-zero exit or stderr) are injected into context as system
        // messages so the model can see and react to them in the active session.
        if (config.loop.enableMonitors ?? true) {
          try {
            const ticks = await getMonitorManager().checkAll();
            for (const tick of ticks) {
              const alert = [
                `[MONITOR: ${tick.name}]`,
                tick.exitCode !== 0 ? `  exit code: ${tick.exitCode}` : "",
                tick.error ? `  stderr: ${tick.error.trim()}` : "",
                tick.output ? `  output: ${tick.output.trim()}` : "",
              ].filter(Boolean).join("\n");
              this.context.addSystem(alert);
              yield { type: "monitor-event", name: tick.name, output: tick.output, error: tick.error, exitCode: tick.exitCode };
            }
          } catch {
            // Swallow monitor errors — they shouldn't crash the agent loop
          }
        }

        // Primer mode detection (cached after first turn): determines whether to use seg1/seg3/pins
        // layout or bundle everything into one system prompt.
        let primerMode = false;
        if (this.primerModeCache === null) {
          // First turn: probe the active provider for primer support.
          const resolved = resolveProvider(config);
          this.primerModeCache = await detectPrimerMode(resolved.baseUrl);
        }
        primerMode = this.primerModeCache;

        // Do not summarize automatically between tool calls. Rewriting the
        // conversation in the middle of a turn changes the model's working
        // context and has caused degraded reasoning / tool-call loops.
        //
        // Keep the full transcript by default. Only use the non-semantic,
        // reversible tool-output elision as an emergency when the hard budget
        // is actually exceeded. Summarization remains available explicitly via
        // the /compact command (agent.compact()).
        if (this.context.effectiveTokens() > config.context.budgetTokens) {
          const result = this.context.elideOldToolResults();
          if (result) yield { type: "compaction", beforeTokens: result.before, afterTokens: result.after };
        }

        let text = "";
        let toolCalls: ToolCallRequest[] = [];
        let sawUsage = false;

        const skillCatalog = this.deps.skills?.summaryForPrompt() ?? "";

        // seg1 (byte-stable base): base rules + quirks + conventions + skills.
        // NOT in seg1: repo-map (→ seg3) and goal/todos (→ seg5 pins) — both volatile, kept out so seg1's hash stays stable.
        const seg1 = buildSystemPrompt(cwd, skillCatalog, this.cachedConventions, this.cachedQuirks);
        const seg3RepoMap = buildRepoMapSection(this.deps.repoMap ?? "");
        const pinsSection = buildPinsSection(this.context.goal, this.context.todos);

        // Primer mode: systemPrompt is just seg1 (stable); seg3/pins are placed by buildForPrimer.
        // Cloud mode: bundle seg1 + repo-map (seg3) + pins back into one system prompt (matches prior behavior).
        const systemPrompt = primerMode
          ? seg1
          : seg1 + seg3RepoMap + pinsSection;

        // Build message array: primer-mode vs cloud mode.
        // Primer mode: [system:seg1] [user: seg3+history+pins+current]
        // Cloud mode: [system: seg1+pins] [user: history+current] OR multipart with cache_control
        let messages: ChatMessage[];
        if (primerMode) {
          // Primer: [system:seg1] [system:seg3] [verbatim history] [pins] [current turn].
          // The current turn is already the last user message in context, so it's not passed separately.
          messages = this.context.buildForPrimer(seg1, seg3RepoMap, pinsSection);
        } else {
          // Cloud mode: current behavior (seg1 + pins bundled into system prompt)
          messages = config.context.cacheSystemPrompt
            ? this.context.buildWithCacheBreakpoints(systemPrompt)
            : this.context.build(systemPrompt);
        }

        // Compute the seg1+seg2 disk-cache key for primer mode (X-Primer-Prefix-Hash header).
        // Primer uses on-disk prefix reuse, not cloud cache_control. The hash covers exactly the
        // byte-stable unit primer caches — the seg1 system text + serialized tool schemas — with a
        // domain separator so seg1/tools can't concatenate ambiguously. seg1 carries no repo-map or
        // goal/todos, so this stays stable for the session (changes only on a rare skill change).
        let primerPrefixHash = "";
        if (primerMode) {
          const toolSchemas = JSON.stringify(tools.schemas());
          const hashInput = `${seg1}\n\n__PERSOJE_TOOLS__\n\n${toolSchemas}`;
          primerPrefixHash = createHash("sha256").update(hashInput).digest("hex");
        }

        // Build per-request headers (primer hash is added per-call, not per-provider).
        const perRequestHeaders: Record<string, string> = {};
        if (primerMode && primerPrefixHash) {
          perRequestHeaders["X-Primer-Prefix-Hash"] = primerPrefixHash;
        }

        const stream = client.stream({
          model: config.model.primary,
          fallbackModels: config.model.fallbacks,
          messages,
          tools: tools.schemas(),
          temperature: config.model.temperature,
maxTokens: 8192,
          provider: config.openrouter.provider,
          signal,
          maxRetries: (config as any).retry?.maxRetries ?? 5,
          extraHeaders: perRequestHeaders,
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
            sawUsage = true;
            this.accounting.record(ev.usage);
            this.context.recordActualInput(ev.usage.inputTokens, ev.usage.cachedTokens); // calibrate gauge + compaction (and detect caching)
            yield { type: "usage", usage: ev.usage };
          } else if (ev.type === "retry") {
            yield { type: "retry", attempt: ev.attempt, maxRetries: ev.maxRetries, delayMs: ev.delayMs, reason: ev.reason };
          }
        }

        // Ollama and some OpenAI-compat servers omit the `usage` object entirely.
        // Without it the call never reaches accounting and the session summary reads
        // "0 calls · 0 tok" after a real generation. Synthesize a record so the call
        // is counted; tokens are estimated (we have the sent context + the reply) and
        // cost is 0 — local generation is genuinely free, not unknown.
        if (!sawUsage) {
          // Estimate from what actually went on the wire — system prompt + history
          // (messages) plus the tool schemas, which are sent separately — and the
          // reply. estimateTokensUsed() would undercount badly: it's history-only,
          // ~6 tokens on a first turn, ignoring the multi-thousand-token system+tools.
          const sent = JSON.stringify(messages) + JSON.stringify(tools.schemas());
          const synth = {
            model: config.model.primary,
            inputTokens: estimateTokens(sent),
            outputTokens: estimateTokens(text),
            cachedTokens: 0,
            cost: 0,
            durationMs: 0,
          };
          this.accounting.record(synth);
          yield { type: "usage", usage: synth };
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
