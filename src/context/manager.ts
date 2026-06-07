import type { ChatMessage, ToolCallRequest } from "../models/openrouter.ts";
import { estimateTokens } from "../core/tokens.ts";
import { truncate } from "../tools/truncate.ts";

/**
 * Owns the message history and enforces token discipline before anything
 * reaches the model. Compaction lands in M3 — the interface is already here
 * so the agent loop doesn't change.
 */
export class ContextManager {
  private messages: ChatMessage[] = [];
  /** Persistence hook — the session store subscribes here. */
  onAppend?: (msg: ChatMessage) => void;
  /** Fired after compaction with the full post-compaction history (store rewrites itself). */
  onCompact?: (messages: readonly ChatMessage[]) => void;

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

  /** Full message array for the API: stable prefix (system first) for cache hits. */
  build(systemPrompt: string): ChatMessage[] {
    return [{ role: "system", content: systemPrompt }, ...this.messages];
  }

  estimateTokensUsed(): number {
    let total = 0;
    for (const m of this.messages) total += estimateTokens(m.content ?? "");
    return total;
  }

  needsCompaction(): boolean {
    return this.estimateTokensUsed() > this.budgetTokens * this.compactionThreshold;
  }

  history(): readonly ChatMessage[] {
    return this.messages;
  }

  clear(): void {
    this.messages = [];
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
    this.onCompact?.(this.messages);
    return { before, after: this.estimateTokensUsed() };
  }
}
