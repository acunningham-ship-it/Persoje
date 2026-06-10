import type { EffortLevel } from "./prompt.ts";
import type { ReasoningParam } from "../models/openrouter.ts";

// Re-export for convenience
export type { ReasoningParam };

/** Model capability flags for effort-aware scaling. */
export interface ModelCapabilities {
  /** Whether the model supports reasoning: 'none' (not supported), 'budget' (limited tokens), 'full' (generous). */
  reasoning?: "none" | "budget" | "full";
}

/** Effort policy output — plugs into the agent call. */
export interface EffortPolicy {
  /** Extended thinking / chain-of-thought reasoning config. undefined = no reasoning. */
  reasoning?: ReasoningParam;
  /** Max output tokens for the model call. */
  maxTokens: number;
  /** Tool iteration budget — max number of tool calls per turn before giving up. */
  toolBudget: number;
  /** Scaffold level — used in system prompt for behavior shaping. */
  scaffold: EffortLevel;
}

/**
 * Map effort level + model capabilities to concrete policy knobs.
 * This is the PHASE 1 definition — PHASE 2 adds plan→execute→verify multi-pass routing.
 */
export function effortPolicy(level: EffortLevel, caps: ModelCapabilities): EffortPolicy {
  const hasReasoning = caps.reasoning === "full" || caps.reasoning === "budget";
  const isLimitedReasoning = caps.reasoning === "budget";

  switch (level) {
    case "low":
      return {
        reasoning: undefined,
        maxTokens: 8000, // Single file write routinely exceeds 4k
        toolBudget: 3,
        scaffold: "low",
      };

    case "mid":
      return {
        reasoning: hasReasoning ? { effort: "medium" } : undefined,
        maxTokens: 16000,
        toolBudget: 8,
        scaffold: "mid",
      };

    case "high":
      return {
        reasoning: hasReasoning ? { effort: "high" } : undefined,
        maxTokens: hasReasoning ? (isLimitedReasoning ? 16000 : 32000) : 32000,
        toolBudget: 12,
        scaffold: "high",
      };

    case "max":
      return {
        reasoning: hasReasoning ? { effort: "high" } : undefined,
        maxTokens: hasReasoning ? (isLimitedReasoning ? 32000 : 64000) : 64000,
        toolBudget: 20,
        scaffold: "max",
      };
  }
}
