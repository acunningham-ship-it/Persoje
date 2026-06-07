import { test, expect, describe } from "bun:test";
import { seedProfile, ProfileStore, Router } from "../src/router/router";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("seedProfile heuristics", () => {
  test("anthropic models get excellent/explicit", () => {
    const p = seedProfile("anthropic/claude-3.5-sonnet");
    expect(p.toolQuality).toBe("excellent");
    expect(p.cachingMode).toBe("explicit");
    expect(p.quirks).toEqual([]);
  });

  test("openai and google models get excellent/automatic", () => {
    const p1 = seedProfile("openai/gpt-4");
    expect(p1.toolQuality).toBe("excellent");
    expect(p1.cachingMode).toBe("automatic");

    const p2 = seedProfile("google/gemini-2.0-flash");
    expect(p2.toolQuality).toBe("excellent");
    expect(p2.cachingMode).toBe("automatic");
  });

  test("strong open-weight models get good/automatic", () => {
    const p1 = seedProfile("deepseek/deepseek-chat");
    expect(p1.toolQuality).toBe("good");
    expect(p1.cachingMode).toBe("automatic");

    const p2 = seedProfile("qwen/qwen-max");
    expect(p2.toolQuality).toBe("good");

    const p3 = seedProfile("mistralai/mistral-large");
    expect(p3.toolQuality).toBe("good");
  });

  test("free-tier and openrouter models get variable/none", () => {
    const p1 = seedProfile("something:free");
    expect(p1.toolQuality).toBe("variable");
    expect(p1.cachingMode).toBe("none");

    const p2 = seedProfile("openrouter/auto");
    expect(p2.toolQuality).toBe("variable");
    expect(p2.cachingMode).toBe("none");
  });

  test("unknown models default to unknown/none", () => {
    const p = seedProfile("unknown-provider/unknown-model");
    expect(p.toolQuality).toBe("unknown");
    expect(p.cachingMode).toBe("none");
  });
});

describe("ProfileStore", () => {
  test("get returns seeded default if not persisted", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "persoje-test-"));
    const tempPath = join(tempDir, "models.json");
    const store = new ProfileStore(tempPath);
    const p = store.get("anthropic/claude-3.5-sonnet");
    expect(p.id).toBe("anthropic/claude-3.5-sonnet");
    expect(p.toolQuality).toBe("excellent");
  });

  test("upsert persists and survives reload", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "persoje-test-"));
    const tempPath = join(tempDir, "models.json");
    const store1 = new ProfileStore(tempPath);
    const p = seedProfile("test/model");
    p.quirks.push("slow");
    p.escalateTo = "fallback/model";
    store1.upsert(p);

    const store2 = new ProfileStore(tempPath);
    const loaded = store2.get("test/model");
    expect(loaded.quirks).toContain("slow");
    expect(loaded.escalateTo).toBe("fallback/model");
  });

  test("addQuirk deduplicates and caps at 10", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "persoje-test-"));
    const tempPath = join(tempDir, "models.json");
    const store = new ProfileStore(tempPath);
    const id = "test/model";

    for (let i = 0; i < 15; i++) {
      const quirk = i % 2 === 0 ? "duplicate" : `quirk_${i}`;
      store.addQuirk(id, quirk);
    }

    const p = store.get(id);
    expect(p.quirks).toContain("duplicate");
    expect(p.quirks.length).toBeLessThanOrEqual(10);
    expect(p.quirks.filter((q) => q === "duplicate").length).toBe(1);
  });
});

describe("Router escalation", () => {
  function makeRouter(threshold: number) {
    const tempDir = mkdtempSync(join(tmpdir(), "persoje-test-"));
    const tempPath = join(tempDir, "models.json");
    const store = new ProfileStore(tempPath);
    return new Router({
      enabled: true,
      mode: "auto",
      failureThreshold: threshold,
      profiles: store,
    });
  }

  test("below threshold returns null", () => {
    const router = makeRouter(5);
    router.recordFailure("test/model", "validation");
    const result = router.shouldEscalate("test/model");
    expect(result).toBeNull();
  });

  test("at threshold fires with reason", () => {
    const router = makeRouter(2);
    router.recordFailure("test/model", "validation");
    router.recordFailure("test/model", "loop");
    const result = router.shouldEscalate("test/model");
    expect(result).not.toBeNull();
    expect(result?.reason).toContain("2 failures");
  });

  test("doesn't re-fire immediately after escalation", () => {
    const router = makeRouter(2);
    router.recordFailure("test/model", "validation");
    router.recordFailure("test/model", "loop");
    const first = router.shouldEscalate("test/model");
    expect(first).not.toBeNull();

    router.recordFailure("test/model", "syntax");
    const second = router.shouldEscalate("test/model");
    expect(second).toBeNull(); // need 5+ new failures
  });

  test("re-fires after 5+ new failures", () => {
    const router = makeRouter(2);
    for (let i = 0; i < 2; i++) router.recordFailure("test/model", "validation");
    const first = router.shouldEscalate("test/model");
    expect(first).not.toBeNull();

    for (let i = 0; i < 5; i++) router.recordFailure("test/model", "api");
    const second = router.shouldEscalate("test/model");
    expect(second).not.toBeNull();
  });

  test("disabled router always returns null", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "persoje-test-"));
    const tempPath = join(tempDir, "models.json");
    const store = new ProfileStore(tempPath);
    const router = new Router({
      enabled: false,
      mode: "offer",
      failureThreshold: 1,
      profiles: store,
    });
    router.recordFailure("test/model", "api");
    const result = router.shouldEscalate("test/model");
    expect(result).toBeNull();
  });

  test("failureCount respects time window", async () => {
    const router = makeRouter(10);
    router.recordFailure("test/model", "validation");
    await Bun.sleep(100); // Wait a bit
    router.recordFailure("test/model", "api");

    const count = router.failureCount("test/model", 50); // 50ms window — miss oldest
    expect(count).toBe(1);

    const allCount = router.failureCount("test/model", 1000); // 1s window — catch both
    expect(allCount).toBe(2);
  });
});
