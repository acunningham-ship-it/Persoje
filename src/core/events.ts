/** Typed event stream emitted by the agent core. The TUI/REPL are thin subscribers. */

export interface UsageReport {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from provider prompt cache (0 when provider has no caching). */
  cachedTokens: number;
  /** Real cost in USD as reported by OpenRouter's usage accounting. */
  cost: number;
  durationMs: number;
}

export type TurnEndReason = "done" | "max-iterations" | "cancelled" | "error";

export type AgentEvent =
  | { type: "turn-start"; turn: number }
  | { type: "text-delta"; delta: string }
  | { type: "text-end"; text: string }
  | { type: "tool-start"; id: string; name: string; args: Record<string, unknown> }
  | {
      type: "tool-result";
      id: string;
      name: string;
      result: string;
      isError: boolean;
      truncated: boolean;
      durationMs: number;
    }
  | { type: "usage"; usage: UsageReport }
  | { type: "guardrail"; kind: "rescue" | "fuzzy" | "loop" | "syntax"; message: string }
  | { type: "router"; message: string; target: string | null }
  | { type: "compaction"; beforeTokens: number; afterTokens: number }
  | { type: "turn-end"; reason: TurnEndReason; iterations: number }
  | { type: "error"; message: string; fatal: boolean };
