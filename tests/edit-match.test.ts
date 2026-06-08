import { describe, test, expect } from "bun:test";
import { flexibleMatch, nearMatchHint } from "../src/tools/edit-match.ts";

describe("flexibleMatch", () => {
  test("matches ignoring trailing whitespace, returns the real span", () => {
    const m = flexibleMatch("a = 1;  \nb = 2;\n", "a = 1;");
    expect(m).not.toBeNull();
    expect(m).not.toBe("ambiguous");
    if (m && m !== "ambiguous") {
      expect(m.how).toBe("trailing-space");
      expect(m.original).toBe("a = 1;  "); // the actual text in the file, spaces and all
    }
  });

  test("matches ignoring indentation only when trailing-space fails", () => {
    const m = flexibleMatch("    return 1;\n", "  return 1;");
    expect(m).not.toBe("ambiguous");
    if (m && m !== "ambiguous") {
      expect(m.how).toBe("indentation");
      expect(m.original).toBe("    return 1;");
    }
  });

  test("returns ambiguous when a fallback level hits twice", () => {
    expect(flexibleMatch("  x();\n  x();\n", "x();")).toBe("ambiguous");
  });

  test("returns null when nothing is close", () => {
    expect(flexibleMatch("totally different\n", "no match here")).toBeNull();
  });

  test("multi-line block matched across indentation drift", () => {
    const content = "if (a) {\n        doThing();\n        doOther();\n}\n";
    const m = flexibleMatch(content, "    doThing();\n    doOther();");
    if (m && m !== "ambiguous") {
      expect(m.how).toBe("indentation");
      expect(m.original).toBe("        doThing();\n        doOther();");
    } else {
      throw new Error("expected a unique indentation match");
    }
  });
});

describe("nearMatchHint", () => {
  test("surfaces the closest line with its number", () => {
    const hint = nearMatchHint("line one\nconst total = compute();\nline three\n", "const total = compute( );");
    expect(hint).toContain("Nearest lines");
    expect(hint).toContain("2: const total = compute();");
  });

  test("empty when nothing resembles the target", () => {
    expect(nearMatchHint("apples\noranges\n", "zzzzzz qqqqqq")).toBe("");
  });
});
