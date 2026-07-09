import { describe, it, expect } from "bun:test";
import type { PersojeConfig } from "../src/config/config.ts";
import { buildProviderMenu, presetHasKey, BUILTIN_PROVIDERS } from "../src/config/providers.ts";

// buildProviderMenu / presetHasKey only read activeProvider + providers, so a
// partial cast is enough — no need to hand-build the whole config shape.
const cfg = (activeProvider: string, providers: Record<string, any> = {}): PersojeConfig =>
  ({ activeProvider, providers } as unknown as PersojeConfig);

describe("provider menu", () => {
  it("always offers the built-in presets + a custom/primer slot", () => {
    const items = buildProviderMenu(cfg("openrouter"));
    // 3 presets, then the custom slot
    expect(items.slice(0, 3).map((i: any) => i.preset.name)).toEqual(["openrouter", "openai", "anthropic"]);
    expect(items.at(-1)!.kind).toBe("custom");
  });

  it("marks the active provider with a check", () => {
    const items = buildProviderMenu(cfg("anthropic"));
    const anthropic = items.find((i: any) => i.kind === "preset" && i.preset.name === "anthropic")!;
    expect(anthropic.label).toContain("✓");
  });

  it("lists user-configured providers, but folds primer into the custom slot", () => {
    const items = buildProviderMenu(
      cfg("mylocal", {
        mylocal: { baseUrl: "http://box:8000/v1" },
        primer: { baseUrl: "http://localhost:8000/v1" },
      }),
    );
    const existing = items.filter((i: any) => i.kind === "existing");
    expect(existing.map((i: any) => i.name)).toEqual(["mylocal"]); // primer excluded
    // the custom slot surfaces the configured primer URL
    expect(items.at(-1)!.label).toContain("http://localhost:8000/v1");
  });

  it("presetHasKey is true when an explicit apiKey is configured", () => {
    const openai = BUILTIN_PROVIDERS.find((p) => p.name === "openai")!;
    expect(presetHasKey(cfg("openrouter", { openai: { baseUrl: openai.baseUrl, apiKey: "sk-x" } }), openai)).toBe(true);
    // no configured key and (assuming) no env var set in the test runner
    if (!process.env.OPENAI_API_KEY) {
      expect(presetHasKey(cfg("openrouter"), openai)).toBe(false);
    }
  });
});
