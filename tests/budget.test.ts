import { test, expect, describe } from "bun:test";
import { resolveBudgetTokens, UNKNOWN_WINDOW_BUDGET } from "../src/config/budget.ts";

describe("context budget resolution", () => {
  test("a known big window allows the full configured budget", () => {
    // owl-alpha, 1M window: 200k is well under 80% of it, so it survives intact.
    expect(resolveBudgetTokens(200_000, 1_000_000)).toBe(200_000);
  });

  test("a known SMALL window clamps the budget below it", () => {
    // 32k model: 80% = 25600. The 200k default must not survive.
    expect(resolveBudgetTokens(200_000, 32_000)).toBe(25_600);
    expect(resolveBudgetTokens(200_000, 8_192)).toBe(6_553);
  });

  test("⛔ an UNKNOWN window falls back to the conservative floor, not the configured max", () => {
    // The regression this guards: raising the default to 200k made the old
    // "keep the configured budget" fallback dangerous. Local Ollama models and custom
    // providers are absent from OpenRouter's /models list, so this path is COMMON.
    expect(resolveBudgetTokens(200_000, undefined)).toBe(UNKNOWN_WINDOW_BUDGET);
    expect(resolveBudgetTokens(200_000, null)).toBe(UNKNOWN_WINDOW_BUDGET);
    expect(resolveBudgetTokens(200_000, 0)).toBe(UNKNOWN_WINDOW_BUDGET);
  });

  test("a deliberately lean configured budget is never raised", () => {
    // Clamping must only ever lower. Someone running 10k on purpose stays at 10k,
    // whether or not we know the window.
    expect(resolveBudgetTokens(10_000, 1_000_000)).toBe(10_000);
    expect(resolveBudgetTokens(10_000, undefined)).toBe(10_000);
  });

  test("a negative or nonsense window is treated as unknown", () => {
    expect(resolveBudgetTokens(200_000, -1)).toBe(UNKNOWN_WINDOW_BUDGET);
  });
});
