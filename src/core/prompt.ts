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

export type EffortLevel = "low" | "mid" | "high" | "max";

const EFFORT_PROMPTS: Record<EffortLevel, string> = {
  low: `Effort: LOW. Be fast. Give direct answers. Skip reading files you can guess. Minimal verification.`,
  mid: `Effort: MID. Be balanced. Read before editing. Verify after changes. Be concise.`,
  high: `Effort: HIGH. Be thorough. Explore broadly before acting. Verify every change. Explain your reasoning. Consider alternatives.`,
  max: `Effort: MAX. Be exhaustive. Full analysis before any action. Verify every step. Consider edge cases and failure modes. Never skip verification. Think step-by-step. Explore all relevant files before deciding.`,
};

export function buildSystemPrompt(
  cwd: string,
  repoMap = "",
  memory = "",
  effort: EffortLevel = "mid",
  personality?: Personality,
  skillCatalog?: string,
): string {
  const personalitySection = personality
    ? `\n\n${personalityPrompt(personality)}`
    : `\n\n${personalityPrompt(DEFAULT_PERSONALITY)}`;

  const skillSection = skillCatalog
    ? `\n\n${skillCatalog}`
    : "";

  return `You are Persoje, a coding agent in a terminal. cwd: ${cwd}

Work by calling tools. Rules:
- Read before you edit. Edits use exact search/replace: old_string must match the file exactly.
- Prefer narrow reads (offset/limit) and targeted grep over reading whole files.
- Tool output is capped; re-run with narrower scope rather than asking for everything.
- After editing, verify (run the relevant command/test) before claiming success.
- When the task is complete, reply with a short summary and stop calling tools.
- Be concise. No filler.
- Keep working until the task is fully done. Do not stop early or give up.
- If something fails, debug it and try again. Iterate until it works.
- You can create new skills with add_skill when you discover a reusable procedure.
- You can invoke skills with invoke_skill when you need to follow a known procedure.
- Skills are lazy-loaded: you see names + descriptions, but must invoke_skill to get the full content.
${EFFORT_PROMPTS[effort]}${personalitySection}${memory ? `\n\nMemory (fetch full facts with the read tool when relevant):\n${memory}` : ""}${repoMap ? `\n\n${repoMap}` : ""}${skillSection}`;
}
