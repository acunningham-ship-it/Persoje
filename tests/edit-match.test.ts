import { describe, test, expect } from "bun:test";
import { flexibleMatch, nearMatchHint, applyEdit } from "../src/tools/edit-match.ts";

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

describe("applyEdit", () => {
  test("exact single replacement", () => {
    const r = applyEdit("a\nb\nc", "b", "B");
    expect(r).toEqual({ ok: true, content: "a\nB\nc", how: "exact", count: 1 });
  });

  test("replace_all counts every occurrence", () => {
    const r = applyEdit("x x x", "x", "y", true);
    expect(r.ok && r.content).toBe("y y y");
    expect(r.ok && r.count).toBe(3);
  });

  test("refuses ambiguous exact match without replace_all", () => {
    expect(applyEdit("x x", "x", "y")).toEqual({ ok: false, reason: "ambiguous-exact", count: 2 });
  });

  test("flexible match when exact fails", () => {
    // old_string has indent the flat file lacks → no exact substring → falls back.
    const r = applyEdit("return 1;\n", "    return 1;", "return 2;");
    expect(r.ok && r.how).toBe("indentation");
  });

  test("reports missing when nothing matches", () => {
    expect(applyEdit("nothing\n", "absent", "x")).toEqual({ ok: false, reason: "missing", count: 0 });
  });

  test("flexible match splices the matched line, not an earlier look-alike substring", () => {
    // Line "prefix_x = 1;" contains "x = 1;" as a suffix and comes first. The
    // model's old_string has a trailing space (so exact fails) and the real,
    // unique target is the standalone "x = 1;" line. A naive content.replace()
    // would clobber the prefix line; splice-by-offset must hit the right one.
    const content = "prefix_x = 1;\nfoo();\nx = 1;\nbar();\n";
    const r = applyEdit(content, "x = 1; ", "x = 99;");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.how).toBe("trailing-space");
      expect(r.content).toBe("prefix_x = 1;\nfoo();\nx = 99;\nbar();\n");
    }
  });

  test("flexible match returns a correct character offset", () => {
    const m = flexibleMatch("aa\nbb \ncc", "bb");
    if (m && m !== "ambiguous") {
      expect("aa\nbb \ncc".slice(m.index, m.index + m.original.length)).toBe(m.original);
    } else {
      throw new Error("expected a match");
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
