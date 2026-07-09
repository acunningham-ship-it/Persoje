import { z } from "zod";
import { Agent, type AgentDeps } from "../core/agent.ts";
import { ToolRegistry, type Tool } from "../tools/types.ts";
import { truncate } from "../tools/truncate.ts";
import type { PersojeConfig } from "../config/config.ts";
import { OpenRouterClient } from "../models/openrouter.ts";

export interface SubAgentSpec {
  task: string;
  /** Tool names allowed. Default: read + grep + glob + ls (read-only).
   *  For mutating subagents, include write/edit/bash as needed. */
  tools?: string[];
  /** Model to use (defaults to parent config.model.primary). */
  model?: string;
  /** Max iterations for the sub-agent (defaults to 10). */
  maxIterations?: number;
  /** Token budget for summary truncation (defaults to 800). */
  summaryMaxTokens?: number;
  /** Context budget for the sub-agent (defaults to 40,000). */
  contextBudget?: number;
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
 *
 * Fixes vs v1:
 * - Child inherits parent's repoMap + memoryContext so it knows the project
 * - Larger default context budget (40k vs 20k)
 * - Captures ALL text output, not just the last text-end event
 * - If the agent hits max-iterations without a final text, synthesizes a summary
 *   from the tool calls it made
 */
export async function runSubAgent(
  spec: SubAgentSpec,
  parent: AgentDeps & { cwd: string },
  signal?: AbortSignal,
): Promise<SubAgentResult> {
  // Clone parent config via JSON round-trip; override model and budget.
  const childConfig = JSON.parse(JSON.stringify(parent.config));
  // Prefer an explicitly faster sub-agent model; delegation is the slowest path.
  childConfig.model.primary = spec.model ?? (parent.config.model.subagent || parent.config.model.primary);
  // Sub-agents are focused (search/research/review) — cap turns low so a single
  // delegation can't balloon into a 10-turn sub-session on a slow model.
  childConfig.loop.maxIterations = spec.maxIterations ?? 5;
  childConfig.context.budgetTokens = Math.min(
    spec.contextBudget ?? 40_000,
    parent.config.context.budgetTokens,
  );

  // Subset tools: read-only default is [read, grep, glob, ls] plus web research.
  // subset() silently drops names the parent doesn't have, so web_* is safe to
  // list even though it costs nothing when the tools aren't registered.
  const allowedTools = spec.tools ?? ["read", "grep", "glob", "ls", "web_search", "web_fetch"];
  const childRegistry = parent.tools.subset(allowedTools);

  // Build child agent — inherit repoMap + memoryContext from parent so the
  // subagent knows what project it's working in.
  const child = new Agent({
    client: parent.client,
    tools: childRegistry,
    config: childConfig,
    cwd: parent.cwd,
    repoMap: parent.repoMap,
    memoryContext: parent.memoryContext,
    skills: parent.skills,
    // No approval hook — subagents are isolated and auto-approved
    // (the parent already decided to delegate).
  });

  // Run the child with task prompt + isolation directive.
  const taskPrompt =
    spec.task +
    "\n\nYou are a sub-agent. Work autonomously; your final text reply is returned to the caller — make it a dense, self-contained summary (no questions).";

  let allText = "";
  let lastText = "";
  let usage = { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
  let toolCallLog: string[] = [];
  let endReason = "";

  for await (const ev of child.run(taskPrompt, signal)) {
    if (ev.type === "text-delta") {
      // Stream text as it comes — accumulate for the summary
    } else if (ev.type === "text-end") {
      lastText = ev.text;
      allText += (allText ? "\n" : "") + ev.text;
    } else if (ev.type === "usage") {
      usage.inputTokens += ev.usage.inputTokens;
      usage.outputTokens += ev.usage.outputTokens;
      usage.cost += ev.usage.cost;
      usage.calls++;
    } else if (ev.type === "tool-start") {
      toolCallLog.push(`${ev.name}(${JSON.stringify(ev.args).slice(0, 100)})`);
    } else if (ev.type === "turn-end") {
      endReason = ev.reason;
    }
  }

  // If the agent produced text, use it. Otherwise synthesize from tool calls.
  let summary = allText || lastText;
  if (!summary && toolCallLog.length > 0) {
    summary = `Sub-agent completed (${endReason}) after ${toolCallLog.length} tool calls:\n` +
      toolCallLog.map((l, i) => `${i + 1}. ${l}`).join("\n");
  } else if (!summary) {
    summary = `Sub-agent completed (${endReason}) with no output.`;
  }

  // Truncate summary to budget.
  const summaryMaxTokens = spec.summaryMaxTokens ?? 800;
  const { text: truncatedSummary } = truncate(summary, summaryMaxTokens);

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
 *
 * The `parent` arg now takes full AgentDeps so the subagent inherits
 * repo-map, memory context, and skills from the parent.
 */
export function makeTaskTool(parent: AgentDeps & { cwd: string }): Tool {
  return {
    name: "task",
    description:
      "Delegate work to a sub-agent. Specify the task and optionally allowed tools; the sub-agent returns only a summary.",
    args: z.object({
      task: z.string().describe("What to do and what to return"),
      tools: z.array(z.string()).optional().describe("Allowed tool names (default: read-only)"),
    }),
    maxResultTokens: 1000,
    async execute({ task, tools }, _ctx) {
      const pool = getSharedPool();
      const result = await pool.run(() =>
        runSubAgent(
          { task, tools, summaryMaxTokens: 1000 },
          parent,
        ),
      );

      const footer = `\n[sub-agent: ${result.usage.calls} calls, $${result.usage.cost.toFixed(5)}]`;
      parent.recordExternalUsage?.(result.usage);
      return result.summary + footer;
    },
  };
}
