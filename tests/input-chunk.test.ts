import { test, expect, describe } from "bun:test";
import { isCompletedLine, completedLineText, stripPasteMarkers } from "../src/core/input-chunk.ts";

describe("isCompletedLine — terminal merged the text with its Enter", () => {
  test("the measured real case: char='text\\r' with key.return false", () => {
    // Exactly what an Ink probe recorded from `tmux send-keys "what is 2 plus 2" Enter`.
    expect(isCompletedLine("what is 2 plus 2\r")).toBe(true);
    expect(completedLineText("what is 2 plus 2\r")).toBe("what is 2 plus 2");
  });

  test("accepts \\n and \\r\\n endings too", () => {
    expect(isCompletedLine("hello\n")).toBe(true);
    expect(isCompletedLine("hello\r\n")).toBe(true);
    expect(completedLineText("hello\r\n")).toBe("hello");
  });

  test("⛔ a genuine MULTI-LINE paste is NOT a completed line", () => {
    // This is the behaviour the newline branch exists to protect: submitting a pasted
    // block line-by-line mangles code. Interior newlines must never auto-submit.
    expect(isCompletedLine("line one\nline two\nline three")).toBe(false);
    expect(isCompletedLine("line one\nline two\n")).toBe(false);
    expect(isCompletedLine("def f():\n    return 1\n")).toBe(false);
  });

  test("plain typing (no newline) is not a completed line", () => {
    expect(isCompletedLine("abc")).toBe(false);
    expect(isCompletedLine("")).toBe(false);
  });

  test("a bare newline is not a completed line — there is no text to submit", () => {
    // A lone \r is a real Enter keypress; key.return handles it, not this path.
    expect(isCompletedLine("\r")).toBe(false);
    expect(isCompletedLine("\n")).toBe(false);
  });

  test("strips bracketed-paste markers", () => {
    expect(stripPasteMarkers("\x1b[200~hello\x1b[201~")).toBe("hello");
    expect(isCompletedLine(stripPasteMarkers("\x1b[200~hello\r\x1b[201~"))).toBe(true);
  });
});
