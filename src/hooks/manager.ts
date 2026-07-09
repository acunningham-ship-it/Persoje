import { readFileSync, existsSync } from "node:fs";
import { join, homedir } from "node:path";

export interface HookContext {
  task?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

export interface Hook {
  name: string;
  priority: number;
  onSessionStart?: () => string;
  onToolStart?: (ctx: HookContext) => string | null;
  onToolEnd?: (ctx: HookContext) => void;
  onSubagentStart?: (task: string) => string;
}

const SKILLS_DIR = join(homedir(), ".config", "persoje", "skills");

/** Parse ponytail SKILL.md and extract instructions for the given mode. */
function ponytailInstructions(mode: string): string {
  const path = join(SKILLS_DIR, "ponytail.md");
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  const body = content.replace(/^---[\s\S]*?---\s*/, "");
  const lines = body.split("\n");
  const result: string[] = [];
  let capturing = false;
  let currentMode = "full";
  for (const line of lines) {
    const modeMatch = line.match(/^\|?\s*\*\*(lite|full|ultra)\*\*/i);
    if (modeMatch) {
      currentMode = modeMatch[1]!.toLowerCase();
      capturing = currentMode === mode;
      if (capturing) result.push(line);
      continue;
    }
    if (capturing) {
      if (line.match(/^\|?\s*\*\*(lite|full|ultra)\*\*/i)) break;
      result.push(line);
    }
  }
  return result.join("\n").trim();
}

const builtinHooks: Hook[] = [
  {
    name: "ponytail",
    priority: 50,
    onSessionStart: () => {
      const mode = process.env.PONYTAIL_MODE || "full";
      const instructions = ponytailInstructions(mode);
      if (!instructions) return "";
      return `PONYTAIL MODE: ${mode}\n${instructions}`;
    },
    onSubagentStart: (task: string) => {
      const mode = process.env.PONYTAIL_MODE || "full";
      const instructions = ponytailInstructions(mode);
      if (!instructions) return "";
      return `PONYTAIL MODE: ${mode}\n${instructions}\n\nTask: ${task}`;
    },
  },
  {
    name: "ponytail-review",
    priority: 40,
    onSessionStart: () => {
      if (process.env.PONYTAIL_MODE !== "review") return "";
      const path = join(SKILLS_DIR, "ponytail-review.md");
      if (!existsSync(path)) return "";
      const content = readFileSync(path, "utf-8");
      return content.replace(/^---[\s\S]*?---\s*/, "").trim();
    },
  },
  {
    name: "ponytail-audit",
    priority: 30,
    onSessionStart: () => {
      if (process.env.PONYTAIL_MODE !== "audit") return "";
      const path = join(SKILLS_DIR, "ponytail-audit.md");
      if (!existsSync(path)) return "";
      const content = readFileSync(path, "utf-8");
      return content.replace(/^---[\s\S]*?---\s*/, "").trim();
    },
  },
];

export class HookManager {
  private hooks: Hook[] = [];

  constructor() {
    this.hooks = [...builtinHooks].sort((a, b) => a.priority - b.priority);
  }

  register(hook: Hook): void {
    this.hooks.push(hook);
    this.hooks.sort((a, b) => a.priority - b.priority);
  }

  runSessionStart(): string {
    return this.hooks
      .map((h) => h.onSessionStart?.() ?? "")
      .filter(Boolean)
      .join("\n\n");
  }

  runToolStart(ctx: HookContext): string | null {
    for (const h of this.hooks) {
      const result = h.onToolStart?.(ctx);
      if (result) return result;
    }
    return null;
  }

  runToolEnd(ctx: HookContext): void {
    for (const h of this.hooks) h.onToolEnd?.(ctx);
  }

  runSubagentStart(task: string): string {
    return this.hooks
      .map((h) => h.onSubagentStart?.(task) ?? "")
      .filter(Boolean)
      .join("\n\n");
  }
}