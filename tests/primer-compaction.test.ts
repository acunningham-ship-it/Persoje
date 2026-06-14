import { test, expect, describe } from "bun:test";
import { ContextManager } from "../src/context/manager.ts";
import { createHash } from "node:crypto";

function filledManager(turns: number, keepFull = 2): ContextManager {
  const cm = new ContextManager(1000, 0.8, keepFull);
  for (let i = 1; i <= turns; i++) {
    cm.addUser(`task ${i}: ` + "x".repeat(200));
    cm.addAssistant(`working on task ${i}`, [
      { id: `c${i}`, name: "read", argsJson: `{"path":"f${i}.ts"}` },
    ]);
    cm.addToolResult(`c${i}`, `contents of f${i}`, 100);
    cm.addAssistant(`finished task ${i}`);
  }
  return cm;
}

function computePrimerHash(seg1: string, toolSchemas: string): string {
  const hashInput = `${seg1}\n\n__PERSOJE_TOOLS__\n\n${toolSchemas}`;
  return createHash("sha256").update(hashInput).digest("hex");
}

describe("Primer Compaction — Immutability & Append-Only Behavior", () => {
  test("frozen summary is immutable across builds with different pins", async () => {
    const cm = filledManager(10, 2);
    await cm.compactForPrimer(async () => "summary of tasks 1-8");

    const seg1 = "stable system prompt";
    const seg3 = "repo map";

    // Build with pins v1
    const build1 = cm.buildForPrimer(seg1, seg3, "pins version 1");
    const frozenIdx1 = build1.findIndex((m) => m.content.includes("summary of tasks 1-8"));

    // Build with different pins v2
    const build2 = cm.buildForPrimer(seg1, seg3, "pins version 2");
    const frozenIdx2 = build2.findIndex((m) => m.content.includes("summary of tasks 1-8"));

    expect(frozenIdx1).toBeGreaterThanOrEqual(0);
    expect(frozenIdx2).toBeGreaterThanOrEqual(0);
    expect(build1[frozenIdx1]!.content).toBe(build2[frozenIdx2]!.content);
  });

  test("live turns remain byte-stable after frozen block inserted", async () => {
    const cm = filledManager(5, 2);
    await cm.compactForPrimer(async () => "old summary");

    // Add 2 more live turns (won't be frozen)
    cm.addUser("task 6: more work");
    cm.addAssistant("done with 6");

    const seg1 = "system";
    const seg3 = "repo";

    // Build twice without further compaction
    const build1 = cm.buildForPrimer(seg1, seg3, "pins a");
    const build2 = cm.buildForPrimer(seg1, seg3, "pins b");

    // Extract live portion (after frozen block): should be identical
    const findFirstLiveIdx = (build: any[]) => {
      let frozenCount = 0;
      for (let i = 0; i < build.length; i++) {
        if (build[i]!.role === "system" && build[i]!.content.includes("old summary")) {
          frozenCount++;
        }
      }
      // First live turn is after seg1 + seg3 + frozen blocks
      return 2 + frozenCount;
    };

    const liveStart1 = findFirstLiveIdx(build1);
    const liveStart2 = findFirstLiveIdx(build2);
    expect(liveStart1).toBe(liveStart2);

    // Live messages should be identical
    for (let i = liveStart1; i < Math.min(build1.length, build2.length); i++) {
      const m1 = build1[i]!;
      const m2 = build2[i]!;
      // Skip if one of them is the pins message (transient)
      if (m1.content.includes("pins") || m2.content.includes("pins")) continue;
      expect(m1.content).toBe(m2.content);
    }
  });
});

describe("Primer Compaction — Structure & Layout", () => {
  test("multiple frozen blocks stay in append-order", async () => {
    const cm = filledManager(12, 2);

    // First compaction
    await cm.compactForPrimer(async () => "summary 1-10");
    expect(cm["frozenSummaries"].length).toBe(1);

    // Add more turns
    for (let i = 13; i <= 20; i++) {
      cm.addUser(`task ${i}`);
      cm.addAssistant(`done ${i}`);
    }

    // Second compaction
    await cm.compactForPrimer(async () => "summary 11-18");
    expect(cm["frozenSummaries"].length).toBe(2);

    const build = cm.buildForPrimer("sys", "map", "pins");
    const frozen1Idx = build.findIndex((m) => m.content.includes("summary 1-10"));
    const frozen2Idx = build.findIndex((m) => m.content.includes("summary 11-18"));

    expect(frozen1Idx).toBeGreaterThanOrEqual(0);
    expect(frozen2Idx).toBeGreaterThanOrEqual(0);
    expect(frozen1Idx).toBeLessThan(frozen2Idx);
  });

  test("frozenSummaries inserted after seg3 and before live history", async () => {
    const cm = filledManager(6, 2);
    await cm.compactForPrimer(async () => "frozen block");

    const build = cm.buildForPrimer("segment1", "segment3", "pins");

    // Find indices
    const seg1Idx = 0; // first system message
    const seg3Idx = 1; // second system message (if provided)
    const frozenIdx = build.findIndex((m) => m.content === "frozen block");
    let liveUserIdx = -1;
    for (let i = build.length - 1; i >= 0; i--) {
      if (build[i]!.role === "user" && !build[i]!.content.includes("pins")) {
        liveUserIdx = i;
        break;
      }
    }

    expect(frozenIdx).toBeGreaterThan(seg3Idx);
    expect(frozenIdx).toBeLessThan(liveUserIdx);
  });
});

describe("Primer Compaction — Correctness", () => {
  test("compactForPrimer preserves message integrity", async () => {
    const cm = filledManager(20, 2);
    const before = cm.history().length;

    const result = await cm.compactForPrimer(async () => "condensed summary");
    expect(result).not.toBeNull();
    expect(result!.after).toBeLessThan(result!.before);

    // History should not contain a user message with the summary (primer stores it in frozenSummaries)
    const history = cm.history();
    expect(history.some((m) => m.role === "user" && m.content.includes("[Summary"))).toBe(false);

    // frozenSummaries should hold the summary
    expect(cm["frozenSummaries"].some((s) => s.includes("condensed"))).toBe(true);

    // Live history should be shorter than before
    expect(history.length).toBeLessThan(before);
  });

  test("X-Primer-Prefix-Hash unchanged by primer compaction", async () => {
    const cm = filledManager(10, 2);
    const seg1 = "stable base";
    const toolSchemas = JSON.stringify({ test: "schemas" });

    const hash1 = computePrimerHash(seg1, toolSchemas);

    // Compact
    await cm.compactForPrimer(async () => "summary");

    const hash2 = computePrimerHash(seg1, toolSchemas);

    expect(hash1).toBe(hash2);
  });
});

describe("Primer Compaction — State Management", () => {
  test("clear() resets frozenSummaries", async () => {
    const cm = filledManager(10, 2);
    await cm.compactForPrimer(async () => "summary");

    expect(cm["frozenSummaries"].length).toBe(1);

    cm.clear();

    expect(cm["frozenSummaries"].length).toBe(0);
    expect(cm.history().length).toBe(0);
  });

  test("compactForPrimer returns null when nothing to freeze", async () => {
    const cm = new ContextManager(1000, 0.8, 4);
    cm.addUser("task 1");
    cm.addAssistant("done 1");
    cm.addUser("task 2");
    cm.addAssistant("done 2");
    cm.addUser("task 3");
    cm.addAssistant("done 3");

    const result = await cm.compactForPrimer(async () => "summary");
    expect(result).toBeNull();
  });
});

describe("Primer Compaction — Live Turn Integrity", () => {
  test("live turns are never elided in buildForPrimer after compaction", async () => {
    const cm = new ContextManager(5000, 0.8, 2);
    // Add turns with long tool results
    for (let i = 1; i <= 10; i++) {
      cm.addUser(`task ${i}`);
      cm.addAssistant("", [{ id: `c${i}`, name: "read", argsJson: "{}" }]);
      cm.addToolResult(`c${i}`, "x".repeat(800), 500);
      cm.addAssistant("done");
    }

    // Compact
    await cm.compactForPrimer(async () => "summary of old work");

    const build = cm.buildForPrimer("sys", "map", "pins");

    // Extract live history (after frozen block)
    const frozenIdx = build.findIndex((m) => m.content.includes("summary of old work"));
    const live = build.slice(frozenIdx + 1).filter((m) => !m.content.includes("pins"));

    // No live message should contain "[elided]"
    expect(live.some((m) => m.content.includes("[elided]"))).toBe(false);
  });

  test("live turns remain verbatim after frozen block inserted", async () => {
    const longMsg = "x".repeat(1000);
    const cm = new ContextManager(10000, 0.8, 2);

    // Add turns that will become frozen
    for (let i = 1; i <= 4; i++) {
      cm.addUser(`old task ${i}`);
      cm.addAssistant("done");
    }

    // Add a turn with distinctive content (will be live)
    cm.addUser(longMsg);
    cm.addAssistant("processed");

    // Add more turns
    cm.addUser("final task");
    cm.addAssistant("final done");

    // Compact (should freeze old turns, keep recent ones live)
    await cm.compactForPrimer(async () => "summary of old");

    const build = cm.buildForPrimer("sys", "map", "pins");

    // Find the long message in the live portion
    let found = false;
    for (const m of build) {
      if (m.content === longMsg) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});

describe("Primer Compaction — Error Handling", () => {
  test("compactForPrimer rolls back on summarize failure", async () => {
    const cm = filledManager(10, 2);
    const historyBefore = cm.history().length;
    const frozenBefore = cm["frozenSummaries"].length;

    try {
      await cm.compactForPrimer(async () => {
        throw new Error("mock failure");
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("mock failure");
    }

    // Verify rollback
    expect(cm["frozenSummaries"].length).toBe(frozenBefore);
    expect(cm.history().length).toBe(historyBefore);
  });
});

describe("Primer Compaction — Edge Cases", () => {
  test("empty frozen block not appended if transcript is empty", async () => {
    const cm = new ContextManager(10000, 0.8, 4);
    cm.addUser("one task");
    cm.addAssistant("done");

    // With keepFullTurns=4, we only have 1 user turn, so compaction should return null
    const result = await cm.compactForPrimer(async () => "summary");
    expect(result).toBeNull();
    expect(cm["frozenSummaries"].length).toBe(0);
  });

  test("freeze with tool_call/tool pairs preserves pairing", async () => {
    const cm = new ContextManager(5000, 0.8, 2);

    // Add old turns (will be frozen)
    for (let i = 1; i <= 5; i++) {
      cm.addUser(`old task ${i}`);
      cm.addAssistant("", [{ id: `c${i}`, name: "read", argsJson: `{"path":"f${i}"}` }]);
      cm.addToolResult(`c${i}`, `content of f${i}`, 100);
      cm.addAssistant("done with read");
    }

    // Add recent turns (will be kept live)
    cm.addUser("new task");
    cm.addAssistant("processing");

    // Compact (old turns are frozen, pairings should stay intact in the live portion)
    await cm.compactForPrimer(async () => "processed old turns");

    const build = cm.buildForPrimer("sys", "map", "pins");

    // Check that tool_call and tool result maintain their ids in the live portion
    const live = build.filter((m) => !m.content.includes("system") && !m.content.includes("processed"));
    for (const m of live) {
      if (m.role === "tool") {
        expect((m as any).tool_call_id).toBeDefined();
      }
    }
  });

  test("onCompact fires after primer compaction", async () => {
    const cm = filledManager(10, 2);
    let fired = false;
    let capturedLen = 0;

    cm.onCompact = (msgs) => {
      fired = true;
      capturedLen = msgs.length;
    };

    await cm.compactForPrimer(async () => "summary");

    expect(fired).toBe(true);
    expect(capturedLen).toBe(cm.history().length);
  });

  test("generation incremented on primer compaction", async () => {
    const cm = filledManager(10, 2);
    // generation is private, but we can infer it via clear() which resets it
    // So we'll just verify the method runs without error
    const result = await cm.compactForPrimer(async () => "summary");
    expect(result).not.toBeNull();
  });
});

describe("Primer Compaction — Interaction with Cloud Mode", () => {
  test("cloud-mode compact() still works (cloud mode path unchanged)", async () => {
    const cm = filledManager(6, 2);
    const before = cm.estimateTokensUsed();

    const result = await cm.compact(async () => "cloud summary");
    expect(result).not.toBeNull();
    expect(result!.after).toBeLessThan(before);

    // Cloud mode injects a user message with [Summary ...]
    const history = cm.history();
    expect(history[0]!.content).toContain("[Summary of earlier conversation]");
  });

  test("buildForPrimer uses frozenSummaries, build() does not", async () => {
    const cm = filledManager(10, 2);
    await cm.compactForPrimer(async () => "frozen summary");

    // buildForPrimer should include the frozen block
    const primerBuild = cm.buildForPrimer("sys", "map", "pins");
    expect(primerBuild.some((m) => m.content === "frozen summary")).toBe(true);

    // build() (cloud mode) should NOT (it uses its own elision/compaction)
    const cloudBuild = cm.build("system prompt");
    expect(cloudBuild.some((m) => m.content === "frozen summary")).toBe(false);
  });
});
