#!/usr/bin/env bun
/**
 * Reproducible token benchmark: LEAN vs NAIVE on the *same* harness, model, and
 * tasks — so the only variable is Persoje's token discipline (tool-result caps
 * + bounded/compacted context). This isolates what the harness actually saves,
 * with no cross-tool or cross-model confounds.
 *
 *   NAIVE  = caps off (untruncated tool output) + no compaction (full replay)
 *   LEAN   = Persoje defaults
 *
 * Usage:  OPENROUTER_API_KEY=... bun run bench/run.ts [--model <id>]
 * Output: a markdown table of tokens/turn and task success per mode.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/core/agent.ts";
import { loadConfig } from "../src/config/config.ts";
import { OpenRouterClient } from "../src/models/openrouter.ts";
import { ToolRegistry } from "../src/tools/types.ts";
import { readTool, writeTool, editTool, lsTool, globTool } from "../src/tools/file-tools.ts";
import { bashTool, grepTool } from "../src/tools/shell-tools.ts";

interface Task {
  name: string;
  files: Record<string, string>;
  prompt: string;
  verify?: string; // shell command in the task dir; exit 0 = success
}

// Tasks chosen to exercise both truncation (large tool output) and history
// accumulation (multiple turns). Deterministic + auto-verifiable where possible.
const TASKS: Task[] = [
  {
    name: "bugfix",
    files: {
      "calc.py":
        "def add(a, b):\n    return a + b\n\n" +
        "def average(nums):\n    # BUG: off-by-one denominator\n    return sum(nums) / (len(nums) + 1)\n\n" +
        'if __name__ == "__main__":\n    assert add(2, 3) == 5\n    assert average([2, 4, 6]) == 4.0, average([2, 4, 6])\n    print("ok")\n',
    },
    prompt: "Run python3 calc.py, find why it fails, fix the bug, and verify it passes.",
    verify: "python3 calc.py",
  },
  {
    name: "feature",
    files: {
      "math.py":
        "def square(x):\n    return x * x\n\n" + 'if __name__ == "__main__":\n    assert square(3) == 9\n    print("ok")\n',
    },
    prompt:
      "Add a cube(x) function to math.py and an assertion that cube(3)==27 in the __main__ block, then run python3 math.py to verify.",
    verify: "python3 math.py",
  },
  {
    name: "search-large", // stresses tool-result truncation: a big file + verbose commands
    files: {
      "log.txt":
        Array.from({ length: 1600 }, (_, i) => `2026-06-08 line ${i} ${i % 17 === 0 ? "ERROR boom" : "info ok"}`).join("\n") + "\n",
      "app.py": "def handler():\n    return 42\n",
    },
    prompt:
      "Read log.txt and report how many lines contain the word ERROR. Also run `wc -l log.txt`. Give the count in one sentence.",
  },
];

function naiveConfig(base: any): any {
  const c = structuredClone(base);
  c.context.budgetTokens = 1_000_000_000; // never compact → full history replay
  c.context.repoMapTokens = 0;
  c.memory.enabled = false;
  // caps off → untruncated tool output
  c.toolResultCaps = { read: 1e7, write: 1e7, edit: 1e7, bash: 1e7, grep: 1e7, glob: 1e7, ls: 1e7 };
  c.loop.maxIterations = 15;
  return c;
}
function leanConfig(base: any): any {
  const c = structuredClone(base);
  c.memory.enabled = false; // bench dirs have no memory; keep it out of both
  c.loop.maxIterations = 15;
  return c;
}

function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of [readTool, writeTool, editTool, lsTool, globTool, bashTool, grepTool]) r.register(t);
  return r;
}

interface RunResult {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  peakInput: number;
  cost: number;
  success: boolean | null;
}

async function runTask(task: Task, config: any, client: OpenRouterClient): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), `bench-${task.name}-`));
  for (const [p, content] of Object.entries(task.files)) writeFileSync(join(dir, p), content);

  const agent = new Agent({ client, tools: buildRegistry(), config, cwd: dir });
  let peakInput = 0;
  try {
    for await (const ev of agent.run(task.prompt)) {
      if (ev.type === "usage") peakInput = Math.max(peakInput, ev.usage.inputTokens);
    }
  } catch {
    /* record whatever tokens accrued */
  }
  const t = agent.accounting.totals();

  let success: boolean | null = null;
  if (task.verify) {
    const proc = Bun.spawnSync(["bash", "-c", task.verify], { cwd: dir });
    success = proc.exitCode === 0;
  }
  rmSync(dir, { recursive: true, force: true });
  return { calls: t.calls, inputTokens: t.inputTokens, outputTokens: t.outputTokens, peakInput, cost: t.cost, success };
}

async function main() {
  const argv = process.argv.slice(2);
  const mi = argv.indexOf("--model");
  const base = await loadConfig();
  const model = mi !== -1 ? argv[mi + 1]! : base.model.primary;
  base.model.primary = model;
  const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? base.openrouter.apiKey ?? "", base.openrouter.baseUrl);

  console.log(`# Persoje token benchmark\n\nmodel: \`${model}\` · lean = defaults · naive = caps off + no compaction\n`);
  console.log("| task | mode | turns | input tok | avg/turn | peak turn | success |");
  console.log("|---|---|--:|--:|--:|--:|:--:|");

  const totals = { lean: { inp: 0, turns: 0 }, naive: { inp: 0, turns: 0 } };
  for (const task of TASKS) {
    for (const mode of ["naive", "lean"] as const) {
      const cfg = mode === "naive" ? naiveConfig(base) : leanConfig(base);
      const r = await runTask(task, cfg, client);
      const avg = r.calls ? Math.round(r.inputTokens / r.calls) : 0;
      const ok = r.success === null ? "—" : r.success ? "✓" : "✗";
      console.log(`| ${task.name} | ${mode} | ${r.calls} | ${r.inputTokens.toLocaleString()} | ${avg.toLocaleString()} | ${r.peakInput.toLocaleString()} | ${ok} |`);
      totals[mode].inp += r.inputTokens;
      totals[mode].turns += r.calls;
    }
  }

  const leanAvg = totals.lean.turns ? totals.lean.inp / totals.lean.turns : 0;
  const naiveAvg = totals.naive.turns ? totals.naive.inp / totals.naive.turns : 0;
  const reduction = naiveAvg ? Math.round((1 - leanAvg / naiveAvg) * 100) : 0;
  console.log(
    `\n**Totals** — naive: ${totals.naive.inp.toLocaleString()} input tok over ${totals.naive.turns} turns (avg ${Math.round(naiveAvg).toLocaleString()}/turn) · ` +
      `lean: ${totals.lean.inp.toLocaleString()} over ${totals.lean.turns} turns (avg ${Math.round(leanAvg).toLocaleString()}/turn) → ` +
      `**${reduction}% fewer input tokens per turn.**`,
  );
}

main();
