import { z } from "zod";
import { ToolError, type Tool, type TodoItem } from "./types.ts";

/**
 * update_todos — the working plan. For any task with more than a couple of
 * steps, the model writes the steps down once and keeps the list current,
 * marking exactly one item in_progress at a time. This is the goal anchor's
 * finer-grained sibling: the goal is the north star, the todos are the route.
 *
 * Why it earns its tokens: a weak model that re-derives "what's left" from
 * scrollback every turn drifts and repeats itself. A pinned checklist keeps it
 * on rails for a few dozen tokens, and the human can watch progress in the TUI.
 */
export const updateTodosTool: Tool = {
  name: "update_todos",
  description: "Checklist for multi-step tasks. Pass full list each time (replaces old). One step in_progress at a time.",
  args: z.object({
    todos: z
      .array(
        z.object({
          content: z.string().describe("Short imperative step"),
          status: z.enum(["pending", "in_progress", "done"]),
        }),
      )
      .describe("Complete ordered list of steps"),
  }),
  maxResultTokens: 120,
  async execute({ todos }, ctx) {
    if (!ctx.setTodos) throw new ToolError("todo tracking is not available in this mode");
    const items = todos as TodoItem[];
    const inProgress = items.filter((t) => t.status === "in_progress").length;
    if (inProgress > 1) {
      throw new ToolError(`keep exactly one step in_progress at a time (got ${inProgress})`);
    }
    ctx.setTodos(items);
    const done = items.filter((t) => t.status === "done").length;
    return `Plan updated: ${done}/${items.length} done.`;
  },
};

/** Compact one-line-per-step rendering used to pin the plan into the prompt. */
export function renderTodos(items: TodoItem[]): string {
  const mark = { done: "[x]", in_progress: "[~]", pending: "[ ]" } as const;
  return items.map((t) => `${mark[t.status]} ${t.content}`).join("\n");
}
