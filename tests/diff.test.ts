import { describe, test, expect } from "bun:test";
import { editDiffLines } from "../src/tui/diff.ts";

describe("editDiffLines", () => {
  test("shows only the changed line, trimming common context", () => {
    const d = editDiffLines("a\nb\nc", "a\nB\nc");
    expect(d).toEqual([
      { sign: "-", text: "b" },
      { sign: "+", text: "B" },
    ]);
  });

  test("pure addition has no removed lines", () => {
    const d = editDiffLines("x = 1;", "x = 1;\ny = 2;");
    // common leading "x = 1;" trimmed; only the new line remains
    expect(d).toEqual([{ sign: "+", text: "y = 2;" }]);
  });

  test("caps long diffs with a marker", () => {
    const oldStr = Array.from({ length: 20 }, (_, i) => `old${i}`).join("\n");
    const newStr = Array.from({ length: 20 }, (_, i) => `new${i}`).join("\n");
    const d = editDiffLines(oldStr, newStr, 6);
    expect(d).toHaveLength(7); // 6 + the marker
    expect(d[6]!.sign).toBe(" ");
    expect(d[6]!.text).toContain("more line");
  });

  test("identical strings produce an empty diff", () => {
    expect(editDiffLines("same\ntext", "same\ntext")).toEqual([]);
  });
});
