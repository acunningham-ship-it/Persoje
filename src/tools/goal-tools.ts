import { z } from "zod";
import { ToolError, type Tool } from "./types.ts";
import { truncate } from "./truncate.ts";

/**
 * set_goal — the model crystallizes the session objective once it understands
 * the task (after asking clarifying questions if it was ambiguous). The goal is
 * pinned in context for the whole session, so the model never loses the plot.
 */
export const setGoalTool: Tool = {
  name: "set_goal",
  description:
    "Record the session goal once you understand the task. One short paragraph: the objective + any key constraints. Call this before starting real work; call again to refine it.",
  args: z.object({
    goal: z.string().describe("The objective and constraints, one short paragraph"),
  }),
  maxResultTokens: 80,
  async execute({ goal }, ctx) {
    if (!ctx.setGoal) throw new ToolError("goal tracking is not available in this mode");
    ctx.setGoal(goal.trim());
    return "Goal recorded. It will stay pinned for the rest of this session.";
  },
};

/**
 * transcript — the escape hatch. Working context only carries the goal, recent
 * turns, and a summary of the rest; when the model needs a detail the summary
 * dropped, it searches or reads the full on-disk transcript here instead of us
 * keeping everything in context.
 */
export const transcriptTool: Tool = {
  name: "transcript",
  description:
    "Consult the full session transcript when you're missing earlier detail the summary dropped. action 'search' finds matching lines; 'tail' shows the most recent N lines.",
  args: z.object({
    action: z.enum(["search", "tail"]),
    query: z.string().optional().describe("substring to search for (action=search)"),
    lines: z.number().optional().describe("how many lines for tail (default 80)"),
  }),
  maxResultTokens: 2500,
  async execute({ action, query, lines }, ctx) {
    if (!ctx.transcriptPath) throw new ToolError("no transcript available in this mode");
    const file = Bun.file(ctx.transcriptPath);
    if (!(await file.exists())) return "Transcript is empty so far.";
    const all = (await file.text()).split("\n");

    if (action === "search") {
      if (!query) throw new ToolError("search requires a query");
      const q = query.toLowerCase();
      const hits: string[] = [];
      for (let i = 0; i < all.length; i++) {
        if (all[i]!.toLowerCase().includes(q)) {
          // include one line of context on each side
          const start = Math.max(0, i - 1);
          hits.push(all.slice(start, i + 2).join("\n"));
        }
      }
      if (hits.length === 0) return `No transcript lines match "${query}".`;
      return truncate(`${hits.length} match(es):\n\n${hits.join("\n---\n")}`, transcriptTool.maxResultTokens).text;
    }

    const n = lines ?? 80;
    return truncate(all.slice(-n).join("\n"), transcriptTool.maxResultTokens).text;
  },
};
