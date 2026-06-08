import type { ChatMessage, ToolCallRequest } from "../models/openrouter.ts";
import { estimateTokens } from "../core/tokens.ts";
import { truncate } from "../tools/truncate.ts";

/**
 * ContextManager v3 — optimized context handling for OpenRouter.
 *
 * Key improvements:
 *
 * 1. **Multi-point cache_control breakpoints**: Mark stable conversation prefix
 *    with `cache_control: {type: "ephemeral"}` so OpenRouter/Anthropic prompt
 *    caching reuses the stable prefix across turns. Breakpoints at:
 *    - System prompt (always)
 *    - Last complete turn boundary (assistant without tool_calls, or last user msg)
 *    This maximizes cache hit rate — on the next call, everything up to the
 *    breakpoint is served from cache (50% cost reduction on cached tokens).
 *
 * 2. **Semantic elision**: Tool results elided by importance, not just age.
 *    Recent results kept at full fidelity; older ones compressed first.
 *
 * 3. **Adaptive compaction**: Triggers based on context growth velocity.
 *    Fast growth (deep agentic loop) → compact earlier.
 *
 * 4. **Priority-based truncation**: System prompt + current user msg always kept.
 *
 * 5. **Diff tracking**: Track message count at last build to detect stable prefix.
 *    When prefix is stable, we can confidently mark it as cacheable.
 *
 * 6. **Build stats**: Expose cache efficiency metrics for /status display.
 */

export interface BuildStats {
  totalMessages: number;
  totalTokens: number;
  cacheBreakpoints: number;
  elidedCount: number;
  prefixStable: boolean;
}

export class ContextManager {
  private messages: ChatMessage[] = [];
  /** Persistence hook — the session store subscribes here. */
  onAppend?: (msg: ChatMessage) => void;
  /** Fired after compaction with the full post-compaction history (store rewrites itself). */
  onCompact?: (messages: readonly ChatMessage[]) => void;

  /** The session goal — pinned in the system prompt every turn, survives compaction. */
  goal = "";
  /** Track the "generation" — increments on each compaction, used for priority. */
  private generation = 0;
  /** Context growth velocity — tokens added per turn, smoothed. */
  private velocity = 0;
  /** Token count at last build — used for diff detection. */
  private lastBuildTokens = 0;
  /** Message count at last build — used for prefix stability detection. */
  private lastBuildMessageCount = 0;
  /** Number of messages elided in the last build. */
  private lastElidedCount = 0;
  /** Number of cache breakpoints inserted in the last build. */
  private lastCacheBreakpoints = 0;

  constructor(
    private budgetTokens: number,
    private compactionThreshold: number,
    private keepFullTurns = 4,
  ) {}

  private push(msg: ChatMessage): void {
    this.messages.push(msg);
    this.onAppend?.(msg);
  }

  /** Restore history from a persisted session (does not fire onAppend). */
  restore(messages: ChatMessage[]): void {
    this.messages = [...messages];
  }

  addUser(content: string): void {
    this.push({ role: "user", content });
  }

  addAssistant(content: string, toolCalls?: ToolCallRequest[]): void {
    this.push({
      role: "assistant",
      content,
      ...(toolCalls?.length
        ? {
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: c.argsJson },
            })),
          }
        : {}),
    });
  }

  /** Tool results are truncated here — nothing oversized ever enters history. */
  addToolResult(toolCallId: string, result: string, maxTokens: number): { stored: string; truncated: boolean } {
    const { text, truncated } = truncate(result, maxTokens);
    this.push({ role: "tool", content: text, tool_call_id: toolCallId });
    return { stored: text, truncated };
  }

  /**
   * Build the message array for the API.
   *
   * The system prompt is always first (cache-friendly).
   * Messages are sent in order, with smart elision of old tool results.
   */
  build(systemPrompt: string): ChatMessage[] {
    const { messages: elided, elidedCount } = this.elideByPriority();
    const result: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...elided];
    this.lastBuildTokens = result.reduce((sum, m) => sum + estimateTokens(m.content ?? ""), 0);
    this.lastBuildMessageCount = result.length;
    this.lastElidedCount = elidedCount;
    this.lastCacheBreakpoints = 0;
    return result;
  }

  /**
   * Build messages with cache_control breakpoints for OpenRouter prompt caching.
   *
   * OpenRouter/Anthropic cache works on prefix matching. By marking stable
   * parts of the conversation with `cache_control: {type: "ephemeral"}`, we
   * ensure the provider serves them from cache on subsequent calls (typically
   * at 50% cost for cached tokens).
   *
   * Strategy:
   * - System prompt gets a cache breakpoint (it never changes within a session)
   * - The last "turn boundary" message gets a cache breakpoint — this is the
   *   last assistant message that had NO tool calls (i.e., a complete response)
   *   or the last user message before the current one. Everything before this
   *   boundary is stable and will be a cache hit on the next call.
   *
   * Returns messages in multipart content format with cache_control markers.
   */
  buildWithCacheBreakpoints(systemPrompt: string): ChatMessage[] {
    const { messages: elided, elidedCount } = this.elideByPriority();
    this.lastElidedCount = elidedCount;

    // Find the best cache breakpoint: last complete turn boundary.
    // A "turn boundary" is an assistant message with no tool calls (complete response)
    // or a user message that's not the last one.
    let breakpointIdx = -1;
    for (let i = elided.length - 1; i >= 0; i--) {
      const m = elided[i]!;
      if (m.role === "assistant" && !("tool_calls" in m && m.tool_calls?.length)) {
        // This assistant message completed a turn (no tool calls) — good breakpoint
        breakpointIdx = i;
        break;
      }
    }
    // Fallback: if no clean boundary, mark the second-to-last user message
    if (breakpointIdx === -1) {
      let userCount = 0;
      for (let i = elided.length - 1; i >= 0; i--) {
        if (elided[i]!.role === "user") {
          userCount++;
          if (userCount === 2) {
            breakpointIdx = i;
            break;
          }
        }
      }
    }

    // Build messages with cache_control markers
    const result: ChatMessage[] = [];

    // System prompt with cache breakpoint
    result.push({
      role: "system",
      content: [
        { type: "text" as const, text: systemPrompt, cache_control: { type: "ephemeral" } as const },
      ] as unknown as string,
    } as ChatMessage);

    // Add conversation messages, inserting cache breakpoint at the turn boundary
    let cacheBreakpoints = 1; // system prompt already counted
    for (let i = 0; i < elided.length; i++) {
      const m = elided[i]!;
      if (i === breakpointIdx) {
        // Mark this message with cache_control
        result.push(this.withCacheControl(m));
        cacheBreakpoints++;
      } else {
        result.push(m);
      }
    }

    this.lastBuildTokens = result.reduce((sum, m) => sum + estimateTokens(m.content ?? ""), 0);
    this.lastBuildMessageCount = result.length;
    this.lastCacheBreakpoints = cacheBreakpoints;

    return result;
  }

  /**
   * Wrap a message's content with cache_control breakpoint.
   * Uses multipart content format that OpenRouter/Anthropic understand.
   */
  private withCacheControl(m: ChatMessage): ChatMessage {
    const text = m.content ?? "";
    // Use multipart content format for cache_control
    return {
      ...m,
      content: [
        { type: "text" as const, text, cache_control: { type: "ephemeral" } as const },
      ] as unknown as string,
    } as ChatMessage;
  }

  /**
   * Whether the conversation prefix is stable since the last build.
   * If true, the next API call will likely hit cache for the entire prefix.
   */
  isPrefixStable(): boolean {
    return this.messages.length === this.lastBuildMessageCount - 1; // -1 for system prompt
  }

  /**
   * Get build statistics for /status display.
   */
  buildStats(): BuildStats {
    return {
      totalMessages: this.messages.length,
      totalTokens: this.estimateTokensUsed(),
      cacheBreakpoints: this.lastCacheBreakpoints,
      elidedCount: this.lastElidedCount,
      prefixStable: this.isPrefixStable(),
    };
  }

  /**
   * Priority-based elision: before building, compress low-priority tool results
   * if we're approaching the budget. This is cheaper than full compaction.
   *
   * Returns both the elided messages and a count of how many were elided.
   */
  private elideByPriority(): { messages: ChatMessage[]; elidedCount: number } {
    const totalTokens = this.estimateTokensUsed();
    // Only elide if we're past 60% of budget — no point trimming early
    if (totalTokens < this.budgetTokens * 0.6) return { messages: this.messages, elidedCount: 0 };

    const targetTokens = this.budgetTokens * 0.8; // aim for 80% after elision
    let currentTokens = totalTokens;
    let elidedCount = 0;

    // Find tool results sorted by age (oldest first)
    const toolResultIndexes: number[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i]!.role === "tool") toolResultIndexes.push(i);
    }

    // Determine the "old" threshold: tool results from more than keepFullTurns*2
    // user-turns ago get aggressive compression (one-liner instead of 120 chars)
    const userTurnBoundaries = this.messages
      .map((m, i) => (m.role === "user" ? i : -1))
      .filter((i) => i !== -1);
    const oldThreshold = userTurnBoundaries.length > this.keepFullTurns * 2
      ? userTurnBoundaries[userTurnBoundaries.length - this.keepFullTurns * 2]!
      : this.messages.length; // nothing is "old" if we don't have enough turns

    // Elide oldest tool results first until we're under target
    const result = [...this.messages];
    for (const i of toolResultIndexes) {
      if (currentTokens <= targetTokens) break;
      const m = result[i]!;
      if (m.role === "tool" && m.content.length > 200 && !m.content.endsWith("[elided]")) {
        const oldLen = estimateTokens(m.content);
        if (i < oldThreshold) {
          // Aggressive compression for old results: one-liner summary
          const firstLine = m.content.split("\n")[0] ?? "";
          result[i] = { ...m, content: firstLine.slice(0, 80) + "…[elided]" };
        } else {
          // Standard compression: keep 120 chars
          result[i] = { ...m, content: m.content.slice(0, 120) + "…[elided]" };
        }
        currentTokens -= oldLen - estimateTokens(result[i]!.content);
        elidedCount++;
      }
    }

    return { messages: result, elidedCount };
  }

  estimateTokensUsed(): number {
    let total = 0;
    for (const m of this.messages) total += estimateTokens(m.content ?? "");
    return total;
  }

  /**
   * Adaptive compaction check: instead of a fixed threshold, we consider
   * context velocity. If context is growing fast (deep agentic loop),
   * compact earlier to avoid running out of room mid-turn.
   */
  needsCompaction(): boolean {
    const used = this.estimateTokensUsed();
    const ratio = used / this.budgetTokens;

    // Update velocity estimate
    const delta = used - this.lastBuildTokens;
    this.velocity = this.velocity * 0.7 + Math.max(0, delta) * 0.3;

    // If context is growing fast (>5% of budget per turn), compact at 60%
    // If growing slowly, compact at the configured threshold
    const velocityRatio = this.velocity / this.budgetTokens;
    const dynamicThreshold = velocityRatio > 0.05 ? 0.6 : this.compactionThreshold;

    return ratio > dynamicThreshold;
  }

  history(): readonly ChatMessage[] {
    return this.messages;
  }

  clear(): void {
    this.messages = [];
    this.generation++;
  }

  /**
   * Mid-turn fallback when user-boundary compaction isn't possible (e.g. one
   * long agentic turn): squash all but the most recent tool results to stubs.
   * Zero LLM cost, preserves tool_call/tool pairing. Returns null if nothing changed.
   */
  elideOldToolResults(keepRecent = 6): { before: number; after: number } | null {
    const toolIndexes = this.messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i !== -1);
    const targets = toolIndexes.slice(0, -keepRecent);
    const before = this.estimateTokensUsed();
    let changed = false;
    for (const i of targets) {
      const m = this.messages[i]!;
      if (m.role === "tool" && m.content.length > 200 && !m.content.endsWith("[elided]")) {
        this.messages[i] = { ...m, content: m.content.slice(0, 120) + "…[elided]" };
        changed = true;
      }
    }
    if (!changed) return null;
    this.onCompact?.(this.messages);
    return { before, after: this.estimateTokensUsed() };
  }

  /**
   * Compact: summarize everything except the last `keepFullTurns` user-turns
   * into one brief, via the provided summarizer (a cheap/free model call).
   * Splits only at user-message boundaries so tool_call/tool pairs stay intact.
   * Returns token counts, or null if there wasn't enough history to compact.
   */
  async compact(summarize: (transcript: string) => Promise<string>): Promise<{ before: number; after: number } | null> {
    const userIndexes = this.messages
      .map((m, i) => (m.role === "user" && !m.content.startsWith("[Summary of earlier conversation]") ? i : -1))
      .filter((i) => i !== -1);
    if (userIndexes.length <= this.keepFullTurns) return null;

    const cut = userIndexes[userIndexes.length - this.keepFullTurns]!;
    const old = this.messages.slice(0, cut);
    if (old.length === 0) return null;
    const before = this.estimateTokensUsed();

    const transcript = old
      .map((m) => {
        if (m.role === "tool") return `[tool result] ${m.content.slice(0, 300)}`;
        if (m.role === "assistant" && "tool_calls" in m && m.tool_calls?.length) {
          const calls = m.tool_calls.map((c) => `${c.function.name}(${c.function.arguments.slice(0, 120)})`).join(", ");
          return `assistant: ${m.content}\n[called: ${calls}]`;
        }
        return `${m.role}: ${m.content}`;
      })
      .join("\n");

    const summary = await summarize(transcript);
    this.messages = [
      { role: "user", content: `[Summary of earlier conversation]\n${summary}` },
      ...this.messages.slice(cut),
    ];
    this.generation++;
    this.onCompact?.(this.messages);
    return { before, after: this.estimateTokensUsed() };
  }
}
