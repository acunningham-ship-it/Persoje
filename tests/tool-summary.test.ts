import { test, expect, describe } from "bun:test";
import { summarizeToolArgs, formatToolCall } from "../src/core/tool-summary.ts";

describe("summarizeToolArgs", () => {
  test("write shows the path and line count, NOT the file content", () => {
    const args = { path: "a.txt", content: "line one\nline two" };
    const out = summarizeToolArgs("write", args);
    expect(out).toBe("a.txt · 2 lines");
    // The whole point: the payload must not reach the transcript.
    expect(out).not.toContain("line one");
    expect(out).not.toContain("line two");
  });

  test("a large write stays one short line", () => {
    const content = Array.from({ length: 500 }, (_, i) => `row ${i}`).join("\n");
    const out = summarizeToolArgs("write", { path: "src/big.ts", content });
    expect(out).toBe("src/big.ts · 500 lines");
    expect(out.length).toBeLessThan(40);
  });

  test("singular line", () => {
    expect(summarizeToolArgs("write", { path: "a", content: "x" })).toBe("a · 1 line");
  });

  test("edit names the file and edit count, never the replacement text", () => {
    const out = summarizeToolArgs("multi_edit", {
      path: "src/cli.ts",
      edits: [{ old: "a", new: "SECRET" }, { old: "b", new: "MORE" }],
    });
    expect(out).toBe("src/cli.ts · 2 edits");
    expect(out).not.toContain("SECRET");
  });

  test("bash shows the command, flattened to one line", () => {
    expect(summarizeToolArgs("bash", { command: "git status\n  --short" })).toBe("git status --short");
  });

  test("grep shows pattern and location", () => {
    expect(summarizeToolArgs("grep", { pattern: "TODO", path: "src/" })).toBe('"TODO" in src/');
  });

  test("read shows an offset when one is given", () => {
    expect(summarizeToolArgs("read", { path: "a.ts", offset: 120 })).toBe("a.ts @120");
  });

  test("long paths keep the identifying tail", () => {
    const p = "/very/deeply/nested/project/source/directory/module/thing.ts";
    const out = summarizeToolArgs("read", { path: p });
    expect(out.length).toBeLessThanOrEqual(48);
    expect(out).toContain("thing.ts"); // the part that identifies the file survives
  });

  test("unknown tool falls back to an identifying scalar, not a JSON blob", () => {
    const out = summarizeToolArgs("some_new_tool", { query: "find the thing", nested: { a: 1 } });
    expect(out).toBe("find the thing");
    expect(out).not.toContain("{");
  });

  test("never throws on hostile or missing args", () => {
    // Args come from a model: assume nothing.
    expect(() => summarizeToolArgs("write", null)).not.toThrow();
    expect(() => summarizeToolArgs("write", undefined)).not.toThrow();
    expect(() => summarizeToolArgs("write", { path: 42 as unknown as string })).not.toThrow();
    expect(summarizeToolArgs("read", {})).toBe("");
  });

  test("formatToolCall omits the separator when there is no detail", () => {
    expect(formatToolCall("read", {})).toBe("read");
    expect(formatToolCall("read", { path: "a.ts" })).toBe("read a.ts");
  });
});
