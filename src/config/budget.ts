/**
 * Resolving the effective context budget for the active model.
 *
 * The configured budget is an UPPER BOUND, not a promise. It has to be reconciled with the
 * model actually in use, and the interesting case is when we cannot find out.
 *
 * Why this exists as its own function: the budget default was raised 40k -> 200k to stop
 * strangling reasoning on a 1M-window model. The clamp that makes that safe reads the window
 * from OpenRouter's /models list — but that list does NOT contain:
 *   - models behind a custom provider (persoje's live owl-alpha is one)
 *   - local Ollama models (added as a keyless backend)
 *   - anything at all when the key is missing, rate-limited, or the network is down
 * so "window unknown" is the COMMON path for local models, not a rare failure. At the old 40k
 * default, falling through with the configured value was harmless. At 200k it hands a
 * 200k budget to a model whose real window may be 8k, and the overflow shows up as a
 * mid-session provider error rather than a clean compaction.
 *
 * So: known window -> clamp to 80% of it. Unknown window -> fall back to a conservative floor.
 */

/** The budget we fall back to when the model's real window cannot be determined. */
export const UNKNOWN_WINDOW_BUDGET = 40_000;

/** Fraction of a known window we're willing to fill (leaves room for tools + response). */
export const WINDOW_FILL = 0.8;

export function resolveBudgetTokens(configured: number, window: number | undefined | null): number {
  if (typeof window === "number" && window > 0) {
    return Math.min(configured, Math.floor(window * WINDOW_FILL));
  }
  // Unknown window: never exceed the conservative floor, but honour a configured value that
  // is already below it (someone deliberately running lean should stay lean).
  return Math.min(configured, UNKNOWN_WINDOW_BUDGET);
}
