import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session/store.ts";
import { setGoalTool, transcriptTool } from "../src/tools/goal-tools.ts";
import type { ToolContext } from "../src/tools/types.ts";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "persoje-goal-"));
  return new SessionStore(join(dir, "s.db"));
}

test("session store persists and re-reads the goal", () => {
  const store = freshStore();
  const id = store.create("/p", "m");
  expect(store.getGoal(id)).toBe("");
  store.setGoal(id, "ship the parser");
  expect(store.getGoal(id)).toBe("ship the parser");
  store.close();
});

test("set_goal tool records via ctx.setGoal", async () => {
  let captured = "";
  const ctx = { cwd: "/tmp", bashTimeoutMs: 1000, setGoal: (g: string) => (captured = g) } as ToolContext;
  const out = await setGoalTool.execute({ goal: "  build X  " }, ctx);
  expect(captured).toBe("build X");
  expect(out).toContain("pinned");
});

test("set_goal errors when goal tracking unavailable", async () => {
  const ctx = { cwd: "/tmp", bashTimeoutMs: 1000 } as ToolContext;
  await expect(setGoalTool.execute({ goal: "x" }, ctx)).rejects.toThrow();
});

test("transcript tool searches and tails the .md", async () => {
  const dir = mkdtempSync(join(tmpdir(), "persoje-tr-"));
  const path = join(dir, "t.md");
  const body = Array.from({ length: 50 }, (_, i) => `line ${i}: content`).join("\n") + "\nSPECIAL_TOKEN here\n";
  await Bun.write(path, body);
  const ctx = { cwd: dir, bashTimeoutMs: 1000, transcriptPath: path } as ToolContext;

  const search = await transcriptTool.execute({ action: "search", query: "SPECIAL_TOKEN" }, ctx);
  expect(search).toContain("SPECIAL_TOKEN");

  const miss = await transcriptTool.execute({ action: "search", query: "nope-not-here" }, ctx);
  expect(miss).toContain("No transcript lines match");

  const tail = await transcriptTool.execute({ action: "tail", lines: 3 }, ctx);
  expect(tail).toContain("SPECIAL_TOKEN");
  expect(tail).not.toContain("line 0:");
});

test("transcript tool reports empty / unavailable cleanly", async () => {
  const ctx = { cwd: "/tmp", bashTimeoutMs: 1000 } as ToolContext;
  await expect(transcriptTool.execute({ action: "tail" }, ctx)).rejects.toThrow();
});

test("TranscriptWriter mirrors messages to markdown", async () => {
  const { TranscriptWriter } = await import("../src/context/transcript.ts");
  // point HOME-derived path is global; instead test the writer's file directly
  const w = new TranscriptWriter("test-" + Math.random().toString(36).slice(2));
  w.append({ role: "user", content: "do the thing" });
  w.append({ role: "assistant", content: "ok", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] });
  w.append({ role: "tool", content: "file contents", tool_call_id: "c1" });
  const md = readFileSync(w.filePath, "utf-8");
  expect(md).toContain("## user");
  expect(md).toContain("do the thing");
  expect(md).toContain("→ read(");
  expect(md).toContain("file contents");
});
