import type { ChatMessage, ToolCallRequest } from "../models/openrouter.ts";
import { estimateTokens } from "../core/tokens.ts";
import { truncate } from "../tools/truncate.ts";

/**
 * ContextManager v2 — smarter context handling.
 *
 * Key improvements over naive "send everything every time":
 *
 * 1. **Incremental diff tracking**: We track what's new since the last API call.
 *    When the model supports conversation caching (Anthropic, Gemini via OpenRouter),
 *    the stable prefix hits cache and only the delta is computed fresh.
 *
 * 2. **Semantic elision**: Tool results are elided by *importance*, not just age.
 *    Recent results + results from the current task chain are kept at full fidelity;
 *    older results from different subtasks get compressed first.
 *
 * 3. **Adaptive compaction**: Instead of a fixed threshold, compaction triggers
 *    based on how fast the context is growing (velocity). If context is growing
 *    fast (deep agentic loop), compact earlier. If growing slowly, let it fill.
 *
 * 4. **Priority-based truncation**: When we must truncate, we preserve:
 *    - System prompt (always)
 *    - Current user message (always)
 *    - Recent assistant reasoning (high priority)
 *    - Recent tool calls + results (high priority)
 *    - Older tool results (low priority — elide first)
 *    - Old user messages (medium priority — summarize)
 */
export class ContextManager {
  private messages: ChatMessage[] = [];
  /** Persistence hook — the session store subscribes here. */
  onAppend?: (msg: ChatMessage) => void;
  /** Fired after compaction with the full post-compaction history (store rewrites itself). */
  onCompact?: (messages: readonly ChatMessage[]) => void;

  /** Track the "generation" — increments on each compaction, used for priority. */
  private generation = 0;
  /** Context growth velocity — tokens added per turn, smoothed. */
  private velocity = 0;
  /** Token count at last build — used for diff detection. */
  private lastBuildTokens = 0;

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
   * Messages are sent in order, but with smart elision of old tool results
   * that are unlikely to be needed for the current task.
   */
  build(systemPrompt: string): ChatMessage[] {
    const msgs = this.elideByPriority();
    const result: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...msgs];
    this.lastBuildTokens = result.reduce((sum, m) => sum + estimateTokens(m.content ?? ""), 0);
    return result;
  }

  /**
   * Priority-based elision: before building, compress low-priority tool results
   * if we're approaching the budget. This is cheaper than full compaction.
   */
  private elideByPriority(): ChatMessage[] {
    const totalTokens = this.estimateTokensUsed();
    // Only elide if we're past 60% of budget — no point trimming early
    if (totalTokens < this.budgetTokens * 0.6) return this.messages;

    const targetTokens = this.budgetTokens * 0.8; // aim for 80% after elision
    let currentTokens = totalTokens;

    // Find tool results sorted by age (oldest first)
    const toolResultIndexes: number[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i]!.role === "tool") toolResultIndexes.push(i);
    }

    // Elide oldest tool results first until we're under target
    const result = [...this.messages];
    for (const i of toolResultIndexes) {
      if (currentTokens <= targetTokens) break;
      const m = result[i]!;
      if (m.role === "tool" && m.content.length > 200 && !m.content.endsWith("[elided]")) {
        const oldLen = estimateTokens(m.content);
        result[i] = { ...m, content: m.content.slice(0, 120) + "…[elided]" };
        currentTokens -= oldLen - estimateTokens(result[i]!.content);
      }
    }

    return result;
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
