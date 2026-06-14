import { describe, test, expect } from "bun:test";
import { ContextManager } from "../src/context/manager.ts";

describe("ContextManager.buildForPrimer", () => {
  test("real verbatim messages: [system:seg1] [system:seg3] [...history...]", () => {
    const cm = new ContextManager(1000, 0.8, 4);
    cm.addUser("task 1");
    cm.addAssistant("working");
    cm.addUser("what's next?"); // current turn (already in context before the build)

    const seg1 = "You are an agent.";
    const seg3 = "## Files\nindex.ts";
    const pins = "\n\nSESSION GOAL: ship it";

    const messages = cm.buildForPrimer(seg1, seg3, pins);

    // seg1 and seg3 are their own stable system segments.
    expect(messages[0]).toEqual({ role: "system", content: seg1 });
    expect(messages[1]).toEqual({ role: "system", content: seg3 });

    // History is REAL messages, not one flattened user blob.
    const userContents = messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(userContents).toContain("task 1");
    expect(userContents).toContain("what's next?");
    // current turn present exactly once (no raw-input duplication)
    expect(userContents.filter((c) => c === "what's next?").length).toBe(1);
  });

  test("history content is verbatim, never truncated to 300 chars", () => {
    const cm = new ContextManager(8000, 0.8, 8);
    const long = "x".repeat(800); // exceeds the old 300-char slice
    cm.addUser(long);
    cm.addUser("now");

    const messages = cm.buildForPrimer("sys", "", "");
    const verbatim = messages.some((m) => m.role === "user" && m.content === long);
    expect(verbatim).toBe(true);
  });

  test("seg1 is byte-identical across calls with different pins", () => {
    const cm = new ContextManager(1000, 0.8, 4);
    cm.addUser("work");
    const seg1 = "You are Persoje";

    const a = cm.buildForPrimer(seg1, "", "\n\nSESSION GOAL: goal1");
    const b = cm.buildForPrimer(seg1, "", "\n\nSESSION GOAL: goal2");

    expect(a[0]!.content).toBe(seg1);
    expect(b[0]!.content).toBe(seg1);
    expect(a[0]!.content).toBe(b[0]!.content);
  });

  test("pins ride as the LAST message, after the current turn (max append-only reuse)", () => {
    const cm = new ContextManager(1000, 0.8, 4);
    cm.addUser("continue");
    const pins = "\n\nSESSION GOAL: ship it\n\nWORKING PLAN:\n[~] step 1";

    const messages = cm.buildForPrimer("sys", "", pins);

    const pinIdx = messages.findIndex(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("SESSION GOAL: ship it"),
    );
    const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
    // Pins are the final, most-volatile segment — placed AFTER the current turn so the whole prefix
    // through it stays byte-identical next build (no one-turn reuse lag).
    expect(pinIdx).toBe(messages.length - 1);
    expect(pinIdx).toBeGreaterThan(lastUserIdx);
  });

  test("no seg3 message when repo-map is empty", () => {
    const cm = new ContextManager(1000, 0.8, 4);
    cm.addUser("work");

    const messages = cm.buildForPrimer("sys", "", "");
    expect(messages[0]).toEqual({ role: "system", content: "sys" });
    // No empty seg3 system block sneaks in as message[1].
    expect(messages[1]?.content).not.toBe("");
  });
});
