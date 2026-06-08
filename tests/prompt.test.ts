import { describe, test, expect } from "bun:test";
import { buildSystemPrompt } from "../src/core/prompt.ts";

describe("buildSystemPrompt", () => {
  test("pins the goal when set", () => {
    const p = buildSystemPrompt("/repo", "", "", "mid", undefined, undefined, "Ship the web tools");
    expect(p).toContain("SESSION GOAL");
    expect(p).toContain("Ship the web tools");
  });

  test("pins the working plan when todos exist", () => {
    const p = buildSystemPrompt("/repo", "", "", "mid", undefined, undefined, "", [
      { content: "Add tool", status: "done" },
      { content: "Wire UI", status: "in_progress" },
    ]);
    expect(p).toContain("WORKING PLAN");
    expect(p).toContain("[x] Add tool");
    expect(p).toContain("[~] Wire UI");
  });

  test("omits the plan section when there are no todos", () => {
    const p = buildSystemPrompt("/repo", "", "", "mid");
    expect(p).not.toContain("WORKING PLAN");
  });
});
