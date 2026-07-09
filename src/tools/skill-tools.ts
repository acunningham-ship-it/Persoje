/**
 * Self-learning tools: add_skill, invoke_skill, list_skills.
 *
 * These let the AI build and manage its own skill library.
 * Skills are lazy-loaded — only the name + description are in context
 * until the skill is actually invoked.
 */

import { z } from "zod";
import type { Tool, ToolContext } from "./types.ts";
import type { SkillLibrary } from "../memory/skills.ts";

export function makeAddSkillTool(skills: SkillLibrary): Tool {
  return {
    name: "add_skill",
    description: "Create a reusable skill: name, description, step-by-step body.",
    args: z.object({
      name: z.string().describe("Skill name (kebab-case)"),
      description: z.string().describe("One-line description"),
      body: z.string().describe("Full body: instructions, snippets, patterns"),
    }),
    maxResultTokens: 200,
    execute: async (args, _ctx) => {
      skills.add(args.name, args.description, args.body);
      return `Skill "${args.name}" added to library. Invoke with /${args.name} or let the agent choose.`;
    },
  };
}

export function makeInvokeSkillTool(skills: SkillLibrary): Tool {
  return {
    name: "invoke_skill",
    description: "Load a skill's instructions from the library (content not pre-loaded).",
    args: z.object({
      name: z.string().describe("Name of the skill to invoke"),
    }),
    maxResultTokens: 4000,
    execute: async (args, _ctx) => {
      const skill = skills.load(args.name);
      if (!skill) {
        const available = skills.list().map((s) => s.name).join(", ");
        return `Skill "${args.name}" not found. Available: ${available || "(none)"}`;
      }
      return `## Skill: ${skill.name}\n${skill.description}\n\n${skill.content}`;
    },
  };
}

export function makeListSkillsTool(skills: SkillLibrary): Tool {
  return {
    name: "list_skills",
    description: "List all skills in the library (names and descriptions only — content not loaded).",
    args: z.object({}),
    maxResultTokens: 1000,
    execute: async (_args, _ctx) => {
      const skillsList = skills.list();
      if (skillsList.length === 0) return "No skills in library. Use add_skill to create one.";
      return skillsList
        .map((s) => `/${s.name} — ${s.description} (used ${s.useCount}x)`)
        .join("\n");
    },
  };
}
