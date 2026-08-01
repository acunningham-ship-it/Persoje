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

import { contextLengthFromShow } from "../src/config/providers.ts";

describe("local (Ollama) context window extraction", () => {
  test("⛔ the key is ARCHITECTURE-PREFIXED, not a plain context_length", () => {
    // Measured against a live Ollama: qwen2.5-coder:7b returns exactly this shape.
    // A hardcoded `model_info.context_length` lookup finds NOTHING and reports "unknown",
    // which is the case that silently overflows the budget.
    expect(contextLengthFromShow({ model_info: { "qwen2.context_length": 32768 } })).toBe(32768);
    expect(contextLengthFromShow({ model_info: { "llama.context_length": 8192 } })).toBe(8192);
    expect(contextLengthFromShow({ model_info: { "gemma3.context_length": 131072 } })).toBe(131072);
  });

  test("accepts an unprefixed key too, if a server ever emits one", () => {
    expect(contextLengthFromShow({ model_info: { context_length: 4096 } })).toBe(4096);
  });

  test("ignores other numeric model_info fields", () => {
    const show = { model_info: { "qwen2.embedding_length": 3584, "qwen2.block_count": 28 } };
    expect(contextLengthFromShow(show)).toBeUndefined();
  });

  test("returns undefined on junk rather than throwing", () => {
    expect(contextLengthFromShow(null)).toBeUndefined();
    expect(contextLengthFromShow({})).toBeUndefined();
    expect(contextLengthFromShow({ model_info: "nope" })).toBeUndefined();
    expect(contextLengthFromShow({ model_info: { "x.context_length": 0 } })).toBeUndefined();
    expect(contextLengthFromShow({ model_info: { "x.context_length": "abc" } })).toBeUndefined();
  });

  test("end to end: an 8k local model no longer gets the 40k floor", () => {
    const win = contextLengthFromShow({ model_info: { "llama.context_length": 8192 } });
    expect(resolveBudgetTokens(200_000, win)).toBe(6_553); // 80% of 8192, not 40k
  });
});
