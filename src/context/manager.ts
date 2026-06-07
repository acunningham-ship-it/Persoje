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

  constructor(
    private budgetTokens: number,
    private compactionThreshold: number,
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
}
