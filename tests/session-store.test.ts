import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session/store.ts";

function freshStore(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), "persoje-db-"));
  return new SessionStore(join(dir, "sessions.db"));
}

test("create, append, and reload a session round-trips messages", () => {
  const store = freshStore();
  const id = store.create("/tmp/proj", "test/model");

  store.appendMessage(id, { role: "user", content: "fix the bug" });
  store.appendMessage(id, {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
  });
  store.appendMessage(id, { role: "tool", content: "1\tconst x = 1;", tool_call_id: "c1" });
  store.appendMessage(id, { role: "assistant", content: "Fixed." });

  const messages = store.loadMessages(id);
  expect(messages).toHaveLength(4);
  expect(messages[0]).toEqual({ role: "user", content: "fix the bug" });
  expect((messages[1] as any).tool_calls[0].function.name).toBe("read");
  expect((messages[2] as any).tool_call_id).toBe("c1");
  store.close();
});

test("list scopes to cwd and tracks usage cost", () => {
  const store = freshStore();
  const a = store.create("/proj/a", "m1");
  store.create("/proj/b", "m2");
  store.maybeSetTitle(a, "first task");
  store.recordUsage(a, { model: "m1", inputTokens: 100, outputTokens: 50, cachedTokens: 0, cost: 0.002, durationMs: 100 });
  store.recordUsage(a, { model: "m1", inputTokens: 200, outputTokens: 80, cachedTokens: 64, cost: 0.003, durationMs: 90 });

  const all = store.list();
  expect(all).toHaveLength(2);
  const scoped = store.list("/proj/a");
  expect(scoped).toHaveLength(1);
  expect(scoped[0]!.title).toBe("first-task");
  expect(scoped[0]!.totalCost).toBeCloseTo(0.005);
  store.close();
});

test("maybeSetTitle only sets the first time", () => {
  const store = freshStore();
  const id = store.create("/p", "m");
  store.maybeSetTitle(id, "original");
  store.maybeSetTitle(id, "overwrite attempt");
  expect(store.get(id)!.title).toBe("original");
  store.close();
});
