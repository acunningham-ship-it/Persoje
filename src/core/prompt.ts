/**
 * System prompt builder. Effort-aware, identity-driven, personality-infused.
 *
 * Effort levels control how the agent reasons:
 *   low  — quick answers, minimal tool use, skip verification
 *   mid  — balanced (default): read before edit, verify after, concise
 *   high — thorough: explore broadly, verify every step, explain reasoning
 *   max  — exhaustive: full analysis, consider edge cases, never skip verification
 *
 * Personality controls tone, verbosity, work ethic, formality, humor, code style.
 *
 * Skills are listed by name + description only (lazy-loaded on invocation).
 */

import type { Personality } from "./personality.ts";
import { personalityPrompt, DEFAULT_PERSONALITY } from "./personality.ts";
import type { TodoItem } from "../tools/types.ts";
import { renderTodos } from "../tools/todo-tools.ts";
import { existsSync } from "fs";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";

export type EffortLevel = "low" | "mid" | "high" | "max";

const EFFORT_PROMPTS: Record<EffortLevel, string> = {
  low: `Effort: LOW. Speed over precision. Skip reading whole files—grep for what you need. Assume common patterns. Make one attempt and move on. No verification pass.`,
  mid: `Effort: MID. Balanced. Read the file before editing (full read if <500 lines, else grep + targeted sections). Test after edits. Be concise—one paragraph per message. Verify your changes work.`,
  high: `Effort: HIGH. Thorough and deliberate. (1) PLAN: read broadly, identify all affected files, state assumptions. (2) EXECUTE: make targeted, confident changes. (3) VERIFY: run tests, confirm no regressions. Explain non-obvious choices. Consider edge cases.`,
  max: `Effort: MAX. Exhaustive verification loop. (1) EXPLORE: read every relevant file, understand the entire context tree. (2) PLAN in detail: state all assumptions, identify failure modes. (3) EXECUTE with precision. (4) VERIFY thoroughly: tests, edge cases, integration points. (5) AUDIT: review your own changes for correctness. Tolerate slowness for certainty.`,
};

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
 * Build the system prompt: stable segment 1 (base rules + effort + quirks + conventions + personality + memory + skills).
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
  // repoMap is built separately as seg3 (buildRepoMapSection) and kept OUT of seg1,
  // so the system base stays byte-stable — it's primer's disk-cache key. Param retained
  // for call-site compatibility but intentionally unused here.
  _repoMap = "",
  memory = "",
  effort: EffortLevel = "mid",
  personality?: Personality,
  skillCatalog?: string,
  conventions = "",
  quirks: string[] = [],
): string {
  const personalitySection = personality
    ? `\n\n${personalityPrompt(personality)}`
    : `\n\n${personalityPrompt(DEFAULT_PERSONALITY)}`;

  const skillSection = skillCatalog
    ? `\n\n${skillCatalog}`
    : "";

  // Known quirks of this model: brief coaching to avoid known failure modes.
  // Render top 3 only, capped at ~100 tokens for cache stability.
  const quirksSection =
    quirks.length > 0
      ? `\n\nKnown quirks of this model:\n${quirks
          .slice(0, 3)
          .map((q) => `• ${q}`)
          .join("\n")}`
      : "";

  // Use cached project conventions (loaded once at Agent initialization).
  const projectConventionsSection = conventions
    ? `\n\nPROJECT CONVENTIONS (auto-loaded):\n${conventions}\n\n---\nBOOT INSTRUCTION: Call get_context (if available) on first run to load shared state across the team/workspace.`
    : "";

  return `You are Persoje, a coding agent in a terminal. cwd: ${cwd}

Work by calling tools. Rules:
- Read before you edit. Edits use exact search/replace: old_string must match the file exactly.
- Prefer narrow reads (offset/limit) and targeted grep over reading whole files.
- Tool output is capped; re-run with narrower scope rather than asking for everything.
- After editing, verify (run the relevant command/test) before claiming success.
- Don't guess at an unfamiliar library/API/error — web_search for it, then web_fetch the docs.
- When the task is complete, reply with a short summary and stop calling tools.
- Be concise. No filler.
- Keep working until the task is fully done. Do not stop early or give up.
- If something fails, debug it and try again. Iterate until it works.
- You can create new skills with add_skill when you discover a reusable procedure.
- You can invoke skills with invoke_skill when you need to follow a known procedure.
- Skills are lazy-loaded: you see names + descriptions, but must invoke_skill to get the full content.
${EFFORT_PROMPTS[effort]}${quirksSection}${projectConventionsSection}${personalitySection}${memory ? `\n\nMemory (fetch full facts with the read tool when relevant):\n${memory}` : ""}${skillSection}`;
}
