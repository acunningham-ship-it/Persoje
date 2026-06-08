#!/usr/bin/env bun
/**
 * Persoje eval harness — does the agent actually *finish the task*?
 *
 * The token benchmark (bench/) proves Persoje is lean; this proves it's
 * capable. Each task runs the real agent headlessly in a throwaway workspace,
 * then scores completion two ways:
 *
 *   assert — deterministic: a shell command exits 0, and/or a JS check over the
 *            resulting files passes. Reproducible, free, CI-friendly.
 *   judge  — an LLM grades the result against a rubric. Handles open-ended
 *            tasks (research, explanations) that no assertion can. Opt-in with
 *            --judge (it costs real tokens on the judge model).
 *
 * Every task also reports tokens/turn and cost, so you see capability AND
 * efficiency in one table.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun run evals/run.ts [--model <id>] [--judge] [--only <name>]
 *
 * Defaults to your configured primary model; pass a free model id to run at $0
 * (judge tasks are skipped unless --judge is given).
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/core/agent.ts";
import { loadConfig } from "../src/config/config.ts";
import { OpenRouterClient } from "../src/models/openrouter.ts";
import { ToolRegistry } from "../src/tools/types.ts";
import { readTool, writeTool, editTool, multiEditTool, lsTool, globTool } from "../src/tools/file-tools.ts";
import { bashTool, grepTool } from "../src/tools/shell-tools.ts";
import { webFetchTool, webSearchTool } from "../src/tools/web-tools.ts";
import { setGoalTool } from "../src/tools/goal-tools.ts";
import { updateTodosTool } from "../src/tools/todo-tools.ts";

interface EvalTask {
  name: string;
  kind: "assert" | "judge";
  files?: Record<string, string>;
  prompt: string;
  /** assert: shell command in the task dir; exit 0 = pass. */
  verify?: string;
  /** assert: extra JS check over the workspace; return null to pass, else a reason. */
  check?: (dir: string) => string | null;
  /** judge: what "done well" means; the LLM grades the agent's final answer against this. */
  rubric?: string;
  /** judge tasks may need network (web tools). */
  needsWeb?: boolean;
  maxIterations?: number;
}

const read = (dir: string, f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf-8") : "");

const TASKS: EvalTask[] = [
  {
    name: "bugfix",
    kind: "assert",
    files: {
      "calc.py":
        "def average(nums):\n    # off-by-one in the denominator\n    return sum(nums) / (len(nums) + 1)\n\n" +
        'if __name__ == "__main__":\n    assert average([2, 4, 6]) == 4.0, average([2, 4, 6])\n    print("ok")\n',
    },
    prompt: "Run python3 calc.py, find why the assertion fails, fix the bug, and verify it prints ok.",
    verify: "python3 calc.py",
  },
  {
    name: "feature-add",
    kind: "assert",
    files: {
      "str_utils.js":
        "function reverse(s) { return [...s].reverse().join(''); }\nmodule.exports = { reverse };\n",
    },
    prompt:
      "Add an exported isPalindrome(s) function to str_utils.js (case-insensitive, ignore non-alphanumerics). Then create a test.js that requires it and asserts isPalindrome('A man, a plan, a canal: Panama') is true and isPalindrome('nope') is false, and run node test.js.",
    verify: "node test.js",
  },
  {
    name: "multi-edit-rename",
    kind: "assert",
    files: {
      "config.ts":
        "const oldName = 1;\nfunction useOldName() { return oldName + oldName; }\nexport { oldName, useOldName };\n",
    },
    prompt:
      "Rename the identifier oldName to maxRetries everywhere in config.ts (the const, both uses, the export, and the function name useOldName -> useMaxRetries). Keep it valid TypeScript.",
    check: (dir) => {
      const c = read(dir, "config.ts");
      if (c.includes("oldName") || c.includes("useOldName")) return "old identifier still present";
      if (!c.includes("maxRetries") || !c.includes("useMaxRetries")) return "new identifier missing";
      return null;
    },
  },
  {
    name: "explain-code",
    kind: "judge",
    files: {
      "mystery.py":
        "def f(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n",
    },
    prompt: "Read mystery.py and explain in 1-2 sentences what f computes.",
    rubric: "The answer should identify that f(n) returns the n-th Fibonacci number (0-indexed: f(0)=0, f(1)=1).",
  },
  {
    name: "web-lookup",
    kind: "judge",
    prompt:
      "Use web_search / web_fetch to find what command installs Bun on macOS/Linux via the official script, and state the exact one-line command.",
    rubric: "The answer should contain the official install command: curl -fsSL https://bun.sh/install | bash (or bun.com).",
    needsWeb: true,
  },
];

function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of [
    readTool, writeTool, editTool, multiEditTool, lsTool, globTool, bashTool, grepTool,
    webFetchTool, webSearchTool, setGoalTool, updateTodosTool,
  ]) {
    r.register(t);
  }
  return r;
}

interface Outcome {
  pass: boolean | null; // null = skipped
  reason: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

async function judge(
  client: OpenRouterClient,
  model: string,
  rubric: string,
  answer: string,
): Promise<{ pass: boolean; reason: string }> {
  let raw = "";
  for await (const ev of client.stream({
    model,
    messages: [
      {
        role: "user",
        content:
          `You are grading an AI coding agent's answer. Rubric for a PASS:\n${rubric}\n\n` +
          `Agent's answer:\n"""\n${answer.slice(0, 4000)}\n"""\n\n` +
          `Reply ONLY JSON: {"pass": true|false, "reason": "<one short sentence>"}`,
      },
    ],
    maxTokens: 200,
    temperature: 0,
  })) {
    if (ev.type === "text") raw += ev.delta;
  }
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    const o = JSON.parse(m ? m[0] : raw);
    return { pass: !!o.pass, reason: String(o.reason ?? "") };
  } catch {
    return { pass: false, reason: "judge returned unparseable output" };
  }
}

async function runTask(
  task: EvalTask,
  config: any,
  client: OpenRouterClient,
  useJudge: boolean,
): Promise<Outcome> {
  if (task.kind === "judge" && !useJudge) {
    return { pass: null, reason: "judge task skipped (pass --judge)", calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  }
  const dir = mkdtempSync(join(tmpdir(), `eval-${task.name}-`));
  for (const [p, content] of Object.entries(task.files ?? {})) writeFileSync(join(dir, p), content);

  const cfg = structuredClone(config);
  cfg.memory.enabled = false;
  cfg.loop.maxIterations = task.maxIterations ?? 12;
  cfg.loop.maxCostUsd = 0;

  const agent = new Agent({ client, tools: buildRegistry(), config: cfg, cwd: dir });
  let finalText = "";
  try {
    for await (const ev of agent.run(task.prompt)) {
      if (ev.type === "text-end") finalText = ev.text;
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    const t = agent.accounting.totals();
    return { pass: false, reason: `agent error: ${(e as Error).message}`, calls: t.calls, inputTokens: t.inputTokens, outputTokens: t.outputTokens, cost: t.cost };
  }
  const t = agent.accounting.totals();

  let pass = true;
  let reason = "ok";
  if (task.kind === "assert") {
    if (task.verify) {
      const proc = Bun.spawnSync(["bash", "-c", task.verify], { cwd: dir });
      if (proc.exitCode !== 0) {
        pass = false;
        reason = `verify failed (exit ${proc.exitCode}): ${task.verify}`;
      }
    }
    if (pass && task.check) {
      const fail = task.check(dir);
      if (fail) {
        pass = false;
        reason = fail;
      }
    }
  } else {
    const verdict = await judge(client, config.model.judge || config.model.primary, task.rubric ?? "", finalText);
    pass = verdict.pass;
    reason = verdict.reason;
  }

  rmSync(dir, { recursive: true, force: true });
  return { pass, reason, calls: t.calls, inputTokens: t.inputTokens, outputTokens: t.outputTokens, cost: t.cost };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(name);
  const val = (name: string) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const base = await loadConfig();
  const model = val("--model") ?? base.model.primary;
  base.model.primary = model;
  const useJudge = flag("--judge");
  const only = val("--only");
  const tasks = only ? TASKS.filter((t) => t.name === only) : TASKS;

  const apiKey = process.env.OPENROUTER_API_KEY ?? base.openrouter.apiKey ?? "";
  if (!apiKey) {
    console.error("No OPENROUTER_API_KEY — evals run real model calls and need a key.");
    process.exit(1);
  }
  const client = new OpenRouterClient(apiKey, base.openrouter.baseUrl);

  console.log(`# Persoje eval — task completion\n\nmodel: \`${model}\`  ·  judge: ${useJudge ? `\`${base.model.judge || model}\`` : "off"}\n`);
  console.log("| task | kind | result | turns | tok/turn | cost | note |");
  console.log("|---|---|:--:|--:|--:|--:|---|");

  let passed = 0;
  let scored = 0;
  for (const task of tasks) {
    const o = await runTask(task, base, client, useJudge);
    const mark = o.pass === null ? "—" : o.pass ? "✅" : "❌";
    const perTurn = o.calls ? Math.round(o.inputTokens / o.calls).toLocaleString() : "—";
    const cost = o.cost ? `$${o.cost.toFixed(4)}` : "$0";
    console.log(`| ${task.name} | ${task.kind} | ${mark} | ${o.calls || "—"} | ${perTurn} | ${cost} | ${o.reason} |`);
    if (o.pass !== null) {
      scored++;
      if (o.pass) passed++;
    }
  }

  console.log(`\n**${passed}/${scored} tasks passed.**`);
  if (passed < scored) process.exitCode = 1;
}

main();
