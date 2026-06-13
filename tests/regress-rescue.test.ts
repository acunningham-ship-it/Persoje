import { test, expect, describe } from "bun:test";
import { rescueToolCalls } from "../src/guardrails/rescue";

describe("rescueToolCalls ID collision regression", () => {
  const tools = ["read", "write", "bash"];

  test("many rescued calls in tight loop have distinct IDs", () => {
    const ids = new Set<string>();
    const count = 100;

    // Generate 100 rescued tool calls in rapid succession
    for (let i = 0; i < count; i++) {
      const text = `<tool_call>{"name":"read","arguments":{"path":"file${i}.ts"}}</tool_call>`;
      const { calls } = rescueToolCalls(text, tools);
      expect(calls).toHaveLength(1);
      const id = calls[0]!.id;
      ids.add(id);
    }

    // All IDs must be unique (no collisions from Date.now() timestamp)
    expect(ids.size).toBe(count);
  });

  test("multiple rescued calls in same invocation have distinct IDs", () => {
    const text = `
      <tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>
      <tool_call>{"name":"write","arguments":{"path":"b.ts","content":"x"}}</tool_call>
      <tool_call>{"name":"bash","arguments":{"cmd":"ls"}}</tool_call>
    `;
    const { calls } = rescueToolCalls(text, tools);
    expect(calls).toHaveLength(3);

    const ids = calls.map((c) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3); // All three must be unique
  });

  test("ID format is collision-proof UUID-based", () => {
    const text = '<tool_call>{"name":"read","arguments":{"path":"test.ts"}}</tool_call>';
    const { calls } = rescueToolCalls(text, tools);
    expect(calls).toHaveLength(1);

    const id = calls[0]!.id;
    expect(id).toMatch(/^rescued_[0-9a-f\-]{36}$/); // UUID format
  });
});
