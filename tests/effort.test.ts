import { describe, test, expect } from "bun:test";
import { effortPolicy, type ModelCapabilities } from "../src/core/effort.ts";

describe("effortPolicy", () => {
  describe("low effort", () => {
    test("returns no reasoning regardless of capabilities", () => {
      const caps: ModelCapabilities = { reasoning: "full" };
      const policy = effortPolicy("low", caps);
      expect(policy.reasoning).toBeUndefined();
    });

    test("sets small maxTokens budget", () => {
      const policy = effortPolicy("low", {});
      expect(policy.maxTokens).toBe(8000);
    });

    test("sets small toolBudget", () => {
      const policy = effortPolicy("low", {});
      expect(policy.toolBudget).toBe(3);
    });

    test("scaffold is low", () => {
      const policy = effortPolicy("low", {});
      expect(policy.scaffold).toBe("low");
    });
  });

  describe("mid effort", () => {
    test("enables reasoning if model supports it", () => {
      const capsWithReasoning: ModelCapabilities = { reasoning: "full" };
      const policyFull = effortPolicy("mid", capsWithReasoning);
      expect(policyFull.reasoning?.effort).toBe("medium");

      const capsWithBudget: ModelCapabilities = { reasoning: "budget" };
      const policyBudget = effortPolicy("mid", capsWithBudget);
      expect(policyBudget.reasoning?.effort).toBe("medium");
    });

    test("disables reasoning if model does not support it", () => {
      const caps: ModelCapabilities = { reasoning: "none" };
      const policy = effortPolicy("mid", caps);
      expect(policy.reasoning).toBeUndefined();
    });

    test("sets moderate maxTokens budget", () => {
      const policy = effortPolicy("mid", {});
      expect(policy.maxTokens).toBe(16000);
    });

    test("sets moderate toolBudget", () => {
      const policy = effortPolicy("mid", {});
      expect(policy.toolBudget).toBe(8);
    });

    test("scaffold is mid", () => {
      const policy = effortPolicy("mid", {});
      expect(policy.scaffold).toBe("mid");
    });
  });

  describe("high effort", () => {
    test("enables high reasoning if model supports full reasoning", () => {
      const caps: ModelCapabilities = { reasoning: "full" };
      const policy = effortPolicy("high", caps);
      expect(policy.reasoning?.effort).toBe("high");
    });

    test("enables high reasoning if model supports budget reasoning", () => {
      const caps: ModelCapabilities = { reasoning: "budget" };
      const policy = effortPolicy("high", caps);
      expect(policy.reasoning?.effort).toBe("high");
    });

    test("disables reasoning if not supported", () => {
      const caps: ModelCapabilities = { reasoning: "none" };
      const policy = effortPolicy("high", caps);
      expect(policy.reasoning).toBeUndefined();
    });

    test("scales maxTokens based on reasoning capability", () => {
      const fullCaps: ModelCapabilities = { reasoning: "full" };
      const policyFull = effortPolicy("high", fullCaps);
      expect(policyFull.maxTokens).toBe(32000);

      const budgetCaps: ModelCapabilities = { reasoning: "budget" };
      const policyBudget = effortPolicy("high", budgetCaps);
      expect(policyBudget.maxTokens).toBe(16000);

      const noneCaps: ModelCapabilities = { reasoning: "none" };
      const policyNone = effortPolicy("high", noneCaps);
      expect(policyNone.maxTokens).toBe(32000);
    });

    test("sets high toolBudget", () => {
      const policy = effortPolicy("high", {});
      expect(policy.toolBudget).toBe(12);
    });

    test("scaffold is high", () => {
      const policy = effortPolicy("high", {});
      expect(policy.scaffold).toBe("high");
    });
  });

  describe("max effort", () => {
    test("enables high reasoning if model supports it", () => {
      const caps: ModelCapabilities = { reasoning: "full" };
      const policy = effortPolicy("max", caps);
      expect(policy.reasoning?.effort).toBe("high");
    });

    test("scales maxTokens generously based on capability", () => {
      const fullCaps: ModelCapabilities = { reasoning: "full" };
      const policyFull = effortPolicy("max", fullCaps);
      expect(policyFull.maxTokens).toBe(64000);

      const budgetCaps: ModelCapabilities = { reasoning: "budget" };
      const policyBudget = effortPolicy("max", budgetCaps);
      expect(policyBudget.maxTokens).toBe(32000);

      const noneCaps: ModelCapabilities = { reasoning: "none" };
      const policyNone = effortPolicy("max", noneCaps);
      expect(policyNone.maxTokens).toBe(64000);
    });

    test("sets maximum toolBudget", () => {
      const policy = effortPolicy("max", {});
      expect(policy.toolBudget).toBe(20);
    });

    test("scaffold is max", () => {
      const policy = effortPolicy("max", {});
      expect(policy.scaffold).toBe("max");
    });
  });

  describe("monotonic increase", () => {
    test("maxTokens increases or stays same across effort levels", () => {
      const caps: ModelCapabilities = { reasoning: "full" };
      const low = effortPolicy("low", caps);
      const mid = effortPolicy("mid", caps);
      const high = effortPolicy("high", caps);
      const max = effortPolicy("max", caps);

      expect(mid.maxTokens).toBeGreaterThanOrEqual(low.maxTokens);
      expect(high.maxTokens).toBeGreaterThanOrEqual(mid.maxTokens);
      expect(max.maxTokens).toBeGreaterThanOrEqual(high.maxTokens);
    });

    test("toolBudget increases or stays same across effort levels", () => {
      const caps: ModelCapabilities = { reasoning: "full" };
      const low = effortPolicy("low", caps);
      const mid = effortPolicy("mid", caps);
      const high = effortPolicy("high", caps);
      const max = effortPolicy("max", caps);

      expect(mid.toolBudget).toBeGreaterThanOrEqual(low.toolBudget);
      expect(high.toolBudget).toBeGreaterThanOrEqual(mid.toolBudget);
      expect(max.toolBudget).toBeGreaterThanOrEqual(high.toolBudget);
    });
  });

  describe("missing capabilities", () => {
    test("handles empty capabilities object", () => {
      const caps: ModelCapabilities = {};
      const policy = effortPolicy("mid", caps);
      expect(policy.reasoning).toBeUndefined();
      expect(policy.maxTokens).toBe(16000);
      expect(policy.scaffold).toBe("mid");
    });

    test("all effort levels work with no capabilities specified", () => {
      const caps: ModelCapabilities = {};
      expect(effortPolicy("low", caps).scaffold).toBe("low");
      expect(effortPolicy("mid", caps).scaffold).toBe("mid");
      expect(effortPolicy("high", caps).scaffold).toBe("high");
      expect(effortPolicy("max", caps).scaffold).toBe("max");
    });
  });
});
