import type { TodoItem } from "../tools/types.ts";
import { renderTodos } from "../tools/todo-tools.ts";
import { existsSync } from "fs";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";

export function findProjectConventions(cwd: string): string {
  let current = cwd;

  while (true) {
    for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
      const path = resolve(current, filename);
      if (existsSync(path)) {
        try {
          return readFileSync(path, "utf-8");
        } catch {
          return "";
        }
      }
    }

    const parent = dirname(current);
    if (parent === current) break; // reached root
    current = parent;
  }

  return "";
}

/**
 * Build the reusable segment 3: repo-map section (stable prefix for primer mode).
 * For cloud providers, this is just embedded inline; for primer, it's a separate segment.
 */
export function buildRepoMapSection(repoMap: string): string {
  return repoMap ? `\n\n${repoMap}` : "";
}

/**
 * Build the volatile segment 5: goal + todos (pinned AFTER history in primer mode).
 * For cloud providers, this is bundled into the system prompt; for primer, it's injected
 * at message assembly time so changes don't invalidate the stable prefix cache.
 */
export function buildPinsSection(goal: string, todos: TodoItem[]): string {
  const goalSection = goal
    ? `\n\nSESSION GOAL (keep this in focus; everything you do should serve it):\n${goal}`
    : `\n\nNo session goal is set yet. Before substantial work: if the task is ambiguous, ask 1-3 clarifying questions first (reply in text, no tools). Once clear, call set_goal with a one-paragraph objective, then proceed. If the task is already clear, call set_goal and continue in the same turn.`;

  const todoSection = todos.length
    ? `\n\nWORKING PLAN (update_todos to revise; mark steps done as you go):\n${renderTodos(todos)}`
    : "";

  return goalSection + todoSection;
}

/**
 * Build the system prompt: stable segment 1 (base rules + quirks + conventions + personality + memory + skills).
 * REMOVED: goal and todos (those are now in buildPinsSection and injected separately).
 * REMOVED: repoMap is not bundled here (it's segment 3, built separately via buildRepoMapSection).
 *
 * For primer mode, the prompt is split:
 *   seg1 [system base-rules text] → seg3 [repo-map] → history → seg5 [goal+todos] → user message
 *
 * For cloud mode (current behavior), everything is bundled into systemPrompt:
 *   seg1 + seg5 (goal+todos) + tools + memory + repoMap + skills → sent as system prompt.
 */
export function buildSystemPrompt(
  cwd: string,
  skillCatalog?: string,
  conventions = "",
  quirks: string[] = [],
): string {
  const skillSection = skillCatalog ? `\n\n${skillCatalog}` : "";

  const quirksSection =
    quirks.length > 0
      ? `\n\nModel quirks:\n${quirks.slice(0, 3).map((q) => `• ${q}`).join("\n")}`
      : "";

  const projectConventionsSection = conventions
    ? `\n\nProject conventions:\n${conventions}`
    : "";

  return `You are Persoje, a coding agent. cwd: ${cwd}

Read before you edit. Edits use exact search/replace. Prefer narrow reads and grep.
Verify after editing. Don't guess — web_search then web_fetch. When done, stop.
Be concise. Keep working until fully done. Debug and retry on failure.
Use 'transcript' to search full history if you need dropped details.${quirksSection}${projectConventionsSection}${skillSection}`;
}
