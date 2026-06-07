import { describe, it, expect } from "bun:test";
import {
  loadPersonality,
  savePersonality,
  personalityPrompt,
  formatPersonality,
  DEFAULT_PERSONALITY,
  PERSONALITY_OPTIONS,
} from "../src/core/personality.ts";

describe("personality", () => {
  it("has all required fields in default", () => {
    expect(DEFAULT_PERSONALITY.tone).toBe("professional");
    expect(DEFAULT_PERSONALITY.verbosity).toBe("concise");
    expect(DEFAULT_PERSONALITY.workEthic).toBe("driven");
    expect(DEFAULT_PERSONALITY.formality).toBe("neutral");
    expect(DEFAULT_PERSONALITY.humor).toBe("subtle");
    expect(DEFAULT_PERSONALITY.codeStyle).toBe("clean");
    expect(DEFAULT_PERSONALITY.explanations).toBe("brief");
    expect(DEFAULT_PERSONALITY.custom).toBe("");
  });

  it("has options for every non-custom trait", () => {
    const traits = Object.keys(PERSONALITY_OPTIONS);
    expect(traits).toContain("tone");
    expect(traits).toContain("verbosity");
    expect(traits).toContain("workEthic");
    expect(traits).toContain("formality");
    expect(traits).toContain("humor");
    expect(traits).toContain("codeStyle");
    expect(traits).toContain("explanations");
    // custom is freeform, not in options
    expect(traits).not.toContain("custom");
  });

  it("generates a non-empty prompt from defaults", () => {
    const prompt = personalityPrompt(DEFAULT_PERSONALITY);
    expect(prompt.length).toBeGreaterThan(50);
    expect(prompt).toContain("Personality & Communication Style:");
    expect(prompt).toContain("professional");
    expect(prompt).toContain("concise");
  });

  it("includes custom instructions when set", () => {
    const p = { ...DEFAULT_PERSONALITY, custom: "Always use TypeScript" };
    const prompt = personalityPrompt(p);
    expect(prompt).toContain("Always use TypeScript");
  });

  it("formatPersonality returns a displayable string", () => {
    const formatted = formatPersonality(DEFAULT_PERSONALITY);
    expect(formatted).toContain("tone");
    expect(formatted).toContain("professional");
  });

  it("all option values are non-empty strings", () => {
    for (const [trait, options] of Object.entries(PERSONALITY_OPTIONS)) {
      expect(options.length).toBeGreaterThan(0);
      for (const opt of options) {
        expect(typeof opt).toBe("string");
        expect(opt.length).toBeGreaterThan(0);
      }
    }
  });
});
