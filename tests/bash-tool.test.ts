import { test, expect } from "bun:test";
import { bashTool, looksLikeServer } from "../src/tools/shell-tools.ts";
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

test("looksLikeServer recognizes common launchers and ignores lookalikes", () => {
  // real server launches
  for (const c of [
    "node server.js",
    "node /app/src/server.mjs",
    "python3 -m http.server 8000",
    "python manage.py runserver 0.0.0.0:3000",
    "flask run --port 3000",
    "gunicorn app:app",
    "uvicorn main:app --port 8000",
    "jupyter notebook --allow-root",
    "npm start",
    "pip install gunicorn && gunicorn wsgi:app",
    "php -S localhost:3000",
  ]) {
    expect(looksLikeServer(c)).toBe(true);
  }
  // not servers — must not get auto-detached
  for (const c of [
    "cat server.js",
    "grep -r flask .",
    "pip install gunicorn flask",
    "ls -la",
    "python3 calc.py",
    "node --version",
  ]) {
    expect(looksLikeServer(c)).toBe(false);
  }
});

test("a foreground server command is auto-backgrounded (no block, no kill)", async () => {
  const start = Date.now();
  // node may not exist in the test env, but the routing happens before exec —
  // it should detach and return a pid line immediately regardless.
  const out = await bashTool.execute(
    { command: "python3 -m http.server 0" },
    ctx({ bashTimeoutMs: 10_000 }),
  );
  expect(Date.now() - start).toBeLessThan(3000);
  expect(out).toContain("[background] started pid");
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
