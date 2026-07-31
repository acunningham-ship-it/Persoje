import { describe, it, expect } from "bun:test";
import { COMMANDS, helpText, filterCommands } from "../src/tui/commands.ts";

describe("helpText", () => {
  it("lists EVERY command — grouping must never drop one", () => {
    // Load-bearing: /help is the full-discovery surface. If a command exists it
    // MUST appear here, whether it's in a group or fell through to the More
    // fallback. This is the test that fails if the grouping ever hides a command.
    const text = helpText();
    for (const c of COMMANDS) expect(text).toContain(c.name);
  });

  it("renders topic headers", () => {
    const text = helpText();
    expect(text).toContain("Model & routing");
    expect(text).toContain("Meta");
  });
});

describe("filterCommands", () => {
  it("prefix-matches the command word", () => {
    const names = filterCommands("/mo").map((c) => c.name);
    expect(names).toContain("/model");
    expect(names).toContain("/models");
    expect(names).toContain("/monitor");
    expect(names).not.toContain("/help");
  });

  it("stops suggesting once you start typing arguments", () => {
    expect(filterCommands("/model x")).toEqual([]);
  });

  it("returns nothing for non-slash input", () => {
    expect(filterCommands("hello")).toEqual([]);
  });
});
