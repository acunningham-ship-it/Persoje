import { describe, test, expect } from "bun:test";
import { ContextManager } from "../src/context/manager.ts";

// Regression tests for the two defects the review caught in the first buildForPrimer:
//   (1) current turn duplicated (raw userInput appended on top of skill-injected history message)
//   (2) history flattened + truncated into one user blob
describe("primer build — no duplication, verbatim turns", () => {
  test("current turn is not duplicated", () => {
    const cm = new ContextManager(1000, 0.8, 4);
    cm.addUser("task 1");
    cm.addAssistant("working");
    cm.addUser("task 1"); // current turn happens to repeat earlier text

    const messages = cm.buildForPrimer("sys", "", "");

    // Exactly the two real user turns — NOT a third appended copy.
    const task1Count = messages.filter((m) => m.role === "user" && m.content === "task 1").length;
    expect(task1Count).toBe(2);
  });

  test("skill-injected current turn is sent verbatim (as stored), exactly once", () => {
    const cm = new ContextManager(1000, 0.8, 4);
    const withSkill = "find files\n\n[relevant skill from memory]\ngrep tip: use -r for recursive";
    const rawInput = "find files";
    cm.addUser(withSkill); // context holds the skill-injected message

    const messages = cm.buildForPrimer("sys", "", "");
    const userMsgs = messages.filter((m) => m.role === "user").map((m) => m.content);

    // The stored (skill-injected) message appears once...
    expect(userMsgs.filter((c) => c === withSkill).length).toBe(1);
    // ...and the bare raw input is NOT appended as a separate duplicate turn.
    expect(userMsgs).not.toContain(rawInput);
  });
});
