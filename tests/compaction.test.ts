import { test, expect } from "bun:test";
import { ContextManager } from "../src/context/manager.ts";

function filledManager(turns: number, keepFull = 2): ContextManager {
  const cm = new ContextManager(1000, 0.8, keepFull);
  for (let i = 1; i <= turns; i++) {
    cm.addUser(`task ${i}: ` + "x".repeat(200));
    cm.addAssistant(`working on task ${i}`, [
      { id: `c${i}`, name: "read", argsJson: `{"path":"f${i}.ts"}` },
    ]);
    cm.addToolResult(`c${i}`, `contents of f${i}`, 100);
    cm.addAssistant(`finished task ${i}`);
  }
  return cm;
}

test("compacts old turns and keeps recent ones at full fidelity", async () => {
  const cm = filledManager(6, 2);
  const before = cm.estimateTokensUsed();
  const result = await cm.compact(async (transcript) => {
    expect(transcript).toContain("task 1");
    expect(transcript).toContain("task 4");
    expect(transcript).not.toContain("task 5"); // kept turns are NOT in summarizer input
    return "summary: did tasks 1-4";
  });

  expect(result).not.toBeNull();
  expect(result!.after).toBeLessThan(before);
  const history = cm.history();
  expect(history[0]!.content).toContain("[Summary of earlier conversation]");
  expect(history[0]!.content).toContain("did tasks 1-4");
  // Last 2 turns survive: user 5, asst, tool, asst, user 6, asst, tool, asst = 8 + summary
  expect(history).toHaveLength(9);
  // tool messages in the kept tail keep their pairing
  expect(history.some((m) => m.role === "tool" && (m as any).tool_call_id === "c6")).toBe(true);
});

test("refuses to compact when history is short", async () => {
  const cm = filledManager(2, 4);
  const result = await cm.compact(async () => "nope");
  expect(result).toBeNull();
});

test("second compaction does not re-summarize its own summary marker turn boundary", async () => {
  const cm = filledManager(6, 2);
  await cm.compact(async () => "first summary");
  // add more turns, compact again
  for (let i = 7; i <= 10; i++) {
    cm.addUser(`task ${i}: ` + "y".repeat(200));
    cm.addAssistant(`done ${i}`);
  }
  const result = await cm.compact(async (t) => {
    expect(t).toContain("first summary"); // old summary is part of the new transcript
    return "merged summary";
  });
  expect(result).not.toBeNull();
  const summaries = cm.history().filter((m) => m.content.startsWith("[Summary of earlier conversation]"));
  expect(summaries).toHaveLength(1); // summaries merge, never stack up
});

test("elideOldToolResults squashes old tool output but keeps recent ones", () => {
  const cm = new ContextManager(1000, 0.8, 4);
  cm.addUser("one long agentic turn");
  for (let i = 1; i <= 10; i++) {
    cm.addAssistant("", [{ id: `c${i}`, name: "read", argsJson: "{}" }]);
    cm.addToolResult(`c${i}`, `result ${i}: ` + "z".repeat(800), 500);
  }
  const before = cm.estimateTokensUsed();
  const result = cm.elideOldToolResults(3);
  expect(result).not.toBeNull();
  expect(result!.after).toBeLessThan(before);

  const tools = cm.history().filter((m) => m.role === "tool");
  expect(tools[0]!.content).toEndWith("[elided]");
  expect(tools[9]!.content).not.toContain("[elided]"); // recent results untouched
  // pairing intact
  expect((tools[0] as any).tool_call_id).toBe("c1");

  // second call with nothing left to elide is a no-op
  expect(cm.elideOldToolResults(3)).toBeNull();
});

test("onCompact fires with the rewritten history", async () => {
  const cm = filledManager(6, 2);
  let captured = 0;
  cm.onCompact = (messages) => {
    captured = messages.length;
  };
  await cm.compact(async () => "s");
  expect(captured).toBe(9);
});
