import { test, expect } from "bun:test";
import { bashTool } from "../src/tools/shell-tools.ts";
import type { ToolContext } from "../src/tools/types.ts";

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/tmp",
  bashTimeoutMs: 1500,
  ...over,
});

test("bash returns normal command output", async () => {
  const out = await bashTool.execute({ command: "echo hello" }, ctx());
  expect(out).toBe("hello");
});

test("bash reports a non-zero exit code", async () => {
  const out = await bashTool.execute({ command: "exit 3" }, ctx());
  expect(out).toContain("[exit code: 3]");
});

test("a blocking foreground command times out and returns control with a hint", async () => {
  const start = Date.now();
  // A process that never exits and holds the pipe open — the exact shape that
  // used to hang the tool forever (server-start commands).
  const out = await bashTool.execute(
    { command: "echo starting; sleep 60" },
    ctx({ bashTimeoutMs: 800 }),
  );
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(4000); // returned, did not hang on the 60s sleep
  expect(out).toContain("starting"); // partial stdout preserved
  expect(out).toContain("background:true"); // tells the model how to recover
});

test("background:true returns immediately with a pid and does not block", async () => {
  const start = Date.now();
  const out = await bashTool.execute(
    { command: "sleep 30", background: true },
    ctx({ bashTimeoutMs: 10_000 }),
  );
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(3000); // did not wait for the 30s sleep
  expect(out).toContain("[background] started pid");
});
