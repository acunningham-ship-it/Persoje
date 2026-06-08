import { describe, test, expect } from "bun:test";
import { updateTodosTool, renderTodos } from "../src/tools/todo-tools.ts";
import type { TodoItem, ToolContext } from "../src/tools/types.ts";

function ctxWith(captured: { items?: TodoItem[] }): ToolContext {
  return {
    cwd: process.cwd(),
    bashTimeoutMs: 5000,
    setTodos: (items) => {
      captured.items = items;
    },
  };
}

describe("renderTodos", () => {
  test("marks status with checkboxes", () => {
    const out = renderTodos([
      { content: "a", status: "done" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ]);
    expect(out).toBe("[x] a\n[~] b\n[ ] c");
  });
});

describe("updateTodosTool", () => {
  test("records the list and reports progress", async () => {
    const cap: { items?: TodoItem[] } = {};
    const res = await updateTodosTool.execute(
      { todos: [
        { content: "one", status: "done" },
        { content: "two", status: "in_progress" },
        { content: "three", status: "pending" },
      ] },
      ctxWith(cap),
    );
    expect(res).toBe("Plan updated: 1/3 done.");
    expect(cap.items).toHaveLength(3);
    expect(cap.items![1]!.status).toBe("in_progress");
  });

  test("rejects more than one in_progress step", async () => {
    const cap: { items?: TodoItem[] } = {};
    await expect(
      updateTodosTool.execute(
        { todos: [
          { content: "a", status: "in_progress" },
          { content: "b", status: "in_progress" },
        ] },
        ctxWith(cap),
      ),
    ).rejects.toThrow(/one step in_progress/);
    expect(cap.items).toBeUndefined();
  });

  test("errors when todo tracking is unavailable", async () => {
    await expect(
      updateTodosTool.execute({ todos: [{ content: "x", status: "pending" }] }, {
        cwd: ".",
        bashTimeoutMs: 5000,
      } as ToolContext),
    ).rejects.toThrow(/not available/);
  });
});
