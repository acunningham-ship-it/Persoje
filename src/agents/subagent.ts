import { z } from "zod";
import { Agent, type AgentDeps } from "../core/agent.ts";
import type { AgentEvent } from "../core/events.ts";
import { ToolRegistry, type Tool } from "../tools/types.ts";
import { truncate } from "../tools/truncate.ts";
import { estimateTokens } from "../core/tokens.ts";
import type { PersojeConfig } from "../config/config.ts";
import { OpenRouterClient } from "../models/openrouter.ts";

export interface SubAgentSpec {
  task: string;
  /** Tool names allowed (read-only default: read, grep, glob, ls). */
  tools?: string[];
  /** Model to use (defaults to parent config.model.primary). */
  model?: string;
  /** Max iterations for the sub-agent (defaults to 10). */
  maxIterations?: number;
  /** Token budget for summary truncation (defaults to 500). */
  summaryMaxTokens?: number;
}

export interface SubAgentResult {
  summary: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
    calls: number;
  };
}

/**
 * Run an isolated child Agent on a task with limited tools and no transcript leakage.
 * Returns only a capped summary + usage metrics.
 */
export async function runSubAgent(
  spec: SubAgentSpec,
  parent: {
    client: OpenRouterClient;
    tools: ToolRegistry;
    config: PersojeConfig;
    cwd: string;
  },
  signal?: AbortSignal,
): Promise<SubAgentResult> {
  // Clone parent config via JSON round-trip; override model and budget.
  const childConfig = JSON.parse(JSON.stringify(parent.config));
  childConfig.model.primary = spec.model ?? parent.config.model.primary;
  childConfig.loop.maxIterations = spec.maxIterations ?? 10;
  childConfig.context.budgetTokens = Math.min(parent.config.context.budgetTokens, 20_000);

  // Subset tools: read-only default is [read, grep, glob, ls].
  const allowedTools = spec.tools ?? ["read", "grep", "glob", "ls"];
  const childRegistry = parent.tools.subset(allowedTools);

  // Build child agent without approval hook (subset is read-only by default).
  const child = new Agent({
    client: parent.client,
    tools: childRegistry,
    config: childConfig,
    cwd: parent.cwd,
  });

  // Run the child with task prompt + isolation directive.
  const taskPrompt =
    spec.task +
    "\n\nYou are a sub-agent. Work autonomously; your final text reply is returned to the caller — make it a dense, self-contained summary (no questions).";

  let finalText = "";
  let usage = { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };

  for await (const ev of child.run(taskPrompt, signal)) {
    if (ev.type === "text-end") {
      finalText = ev.text;
    } else if (ev.type === "usage") {
      usage.inputTokens += ev.usage.inputTokens;
      usage.outputTokens += ev.usage.outputTokens;
      usage.cost += ev.usage.cost;
      usage.calls++;
    }
  }

  // Truncate summary to budget.
  const summaryMaxTokens = spec.summaryMaxTokens ?? 500;
  const { text: truncatedSummary } = truncate(finalText, summaryMaxTokens);

  return {
    summary: truncatedSummary,
    usage,
  };
}

/** Semaphore for limiting concurrent sub-agent calls. */
export class SubAgentPool {
  private queue: Array<(value: void) => void> = [];
  private active = 0;

  constructor(private maxConcurrent = 3) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// Module-level pool for makeTaskTool.
let sharedPool: SubAgentPool | null = null;

function getSharedPool(): SubAgentPool {
  if (!sharedPool) sharedPool = new SubAgentPool(3);
  return sharedPool;
}

/**
 * Export a "task" Tool that the main agent can call to spawn sub-agents.
 * Returns summary + usage footer.
 */
export function makeTaskTool(parent: {
  client: OpenRouterClient;
  tools: ToolRegistry;
  config: PersojeConfig;
  cwd: string;
}): Tool {
  return {
    name: "task",
    description:
      "Delegate work to a sub-agent. Specify the task and optionally allowed tools; the sub-agent returns only a summary.",
    args: z.object({
      task: z.string().describe("What to do and what to return"),
      tools: z.array(z.string()).optional().describe("Allowed tool names (default: read-only)"),
    }),
    maxResultTokens: 600,
    async execute({ task, tools }, _ctx) {
      const pool = getSharedPool();
      const result = await pool.run(() =>
        runSubAgent(
          { task, tools, summaryMaxTokens: 600 },
          parent,
        ),
      );

      const footer = `\n[sub-agent: ${result.usage.calls} calls, $${result.usage.cost.toFixed(5)}]`;
      return result.summary + footer;
    },
  };
}
