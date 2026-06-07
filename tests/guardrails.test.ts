import { test, expect, describe } from "bun:test";
import { closestToolName } from "../src/guardrails/fuzzy";
import { rescueToolCalls } from "../src/guardrails/rescue";
import { LoopDetector } from "../src/guardrails/loops";

describe("closestToolName", () => {
  const available = ["read", "edit", "bash", "echo"];

  test("exact match (case-insensitive)", () => {
    expect(closestToolName("read", available)).toBe("read");
    expect(closestToolName("READ", available)).toBe("read");
    expect(closestToolName("Read", available)).toBe("read");
  });

  test("snake_case prefix matching", () => {
    expect(closestToolName("read_file", available)).toBe("read");
    expect(closestToolName("bash_command", available)).toBe("bash");
  });

  test("containment matching", () => {
    expect(closestToolName("editor", available)).toBe("edit");
  });

  test("typo correction (edit distance ≤ 2)", () => {
    expect(closestToolName("edti", available)).toBe("edit");
    expect(closestToolName("rad", available)).toBe("read");
  });

  test("garbage/unknown returns null", () => {
    expect(closestToolName("xyz123", available)).toBeNull();
  });

  test("empty string returns null", () => {
    expect(closestToolName("", available)).toBeNull();
  });
});

describe("rescueToolCalls", () => {
  const tools = ["read", "write", "bash"];

  test("Hermes <tool_call> XML tags", () => {
    const text = 'Do this:\n<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>\nDone.';
    const { calls, cleanedText } = rescueToolCalls(text, tools);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("read");
    expect(calls[0]!.argsJson).toContain("a.ts");
    expect(cleanedText).not.toContain("<tool_call>");
  });

  test("fenced ```json blocks", () => {
    const text = 'Here is my call:\n```json\n{"name":"bash","arguments":{"cmd":"ls"}}\n```\nDone.';
    const { calls, cleanedText } = rescueToolCalls(text, tools);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("bash");
    expect(cleanedText).not.toContain("```");
  });

  test("bare JSON as entire message", () => {
    const text = '{"name":"write","arguments":{"path":"file.ts","content":"code"}}';
    const { calls, cleanedText } = rescueToolCalls(text, tools);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("write");
    expect(cleanedText).toBe("");
  });

  test("ignores non-tool JSON", () => {
    const text = '{"foo":"bar","baz":123}'; // no "name" field
    const { calls, cleanedText } = rescueToolCalls(text, tools);
    expect(calls).toHaveLength(0);
    expect(cleanedText).toBe(text);
  });

  test("ignores unknown tool names", () => {
    const text = '<tool_call>{"name":"email","arguments":{}}</tool_call>';
    const { calls, cleanedText } = rescueToolCalls(text, tools);
    expect(calls).toHaveLength(0);
    expect(cleanedText).toBe(text);
  });

  test("handles multiple tool calls in one message", () => {
    const text =
      'First:\n<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>\nThen:\n<tool_call>{"name":"bash","arguments":{"cmd":"ls"}}</tool_call>';
    const { calls } = rescueToolCalls(text, tools);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.some((c) => c.name === "read")).toBe(true);
    expect(calls.some((c) => c.name === "bash")).toBe(true);
  });
});

describe("LoopDetector", () => {
  test("identical calls within window trigger at threshold", () => {
    const det = new LoopDetector(6, 3);
    expect(det.record("read", '{"path":"a.ts"}')).toBe(false);
    expect(det.record("read", '{"path":"a.ts"}')).toBe(false);
    expect(det.record("read", '{"path":"a.ts"}')).toBe(true); // 3rd = threshold
  });

  test("varied calls don't trigger", () => {
    const det = new LoopDetector(6, 3);
    expect(det.record("read", '{"path":"a.ts"}')).toBe(false);
    expect(det.record("read", '{"path":"b.ts"}')).toBe(false);
    expect(det.record("bash", '{"cmd":"ls"}')).toBe(false);
  });

  test("reset clears state", () => {
    const det = new LoopDetector(6, 3);
    det.record("read", '{"path":"a.ts"}');
    det.record("read", '{"path":"a.ts"}');
    det.record("read", '{"path":"a.ts"}');
    det.reset();
    expect(det.record("read", '{"path":"a.ts"}')).toBe(false);
  });

  test("sliding window forgets old calls", () => {
    const det = new LoopDetector(3, 3); // window size = 3
    det.record("read", '{"path":"a.ts"}');
    det.record("read", '{"path":"a.ts"}');
    det.record("bash", '{"cmd":"ls"}'); // bumped window to 3
    det.record("write", '{"path":"x.ts"}'); // window slides, first "read" falls out
    expect(det.record("read", '{"path":"a.ts"}')).toBe(false); // only 2 in window now
  });

  test("custom threshold", () => {
    const det = new LoopDetector(6, 2); // threshold = 2
    expect(det.record("echo", '{"text":"hi"}')).toBe(false);
    expect(det.record("echo", '{"text":"hi"}')).toBe(true); // 2nd = threshold
  });
});
