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
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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
  // --- adversarial: tasks built to make a weak model thrash, so the guardrails
  // (loop detection, path grounding, claim verify) have something to catch. ---
  {
    name: "wrong-path-recovery",
    kind: "assert",
    files: {
      "lib/text_helpers.py":
        "def slugify(s):\n    # bug: forgets to lowercase\n    return s.strip().replace(' ', '-')\n\n" +
        'if __name__ == "__main__":\n    assert slugify("Hello World") == "hello-world", slugify("Hello World")\n    print("ok")\n',
    },
    // NOTE the prompt names lib/text_helper.py — singular, wrong. The real file is
    // text_helpers.py. The agent has to ground itself (ls/glob) instead of trusting
    // the path, then fix the actual bug.
    prompt:
      "There's a failing assertion in lib/text_helper.py — the slugify function. Locate the file, fix the bug, and make running it with python3 print ok.",
    verify: "python3 lib/text_helpers.py",
    maxIterations: 16,
  },
  {
    name: "mutable-default-trap",
    kind: "assert",
    files: {
      "accumulate.py":
        "def add_item(item, bucket=[]):\n    bucket.append(item)\n    return bucket\n\n" +
        'if __name__ == "__main__":\n    assert add_item(1) == [1], add_item(1)\n' +
        "    assert add_item(2) == [2], add_item(2)\n    print('ok')\n",
    },
    prompt:
      "python3 accumulate.py fails on the second assertion. Diagnose the real root cause and fix add_item so both assertions pass. Do not change the assertions. Run it to confirm it prints ok.",
    verify: "python3 accumulate.py",
    // guard against the weak-model cheat of "fixing" the test instead of the code.
    check: (dir) => {
      const c = read(dir, "accumulate.py");
      if (!c.includes("add_item(1) == [1]") || !c.includes("add_item(2) == [2]"))
        return "assertions were altered — fixed the test, not the bug";
      return null;
    },
    maxIterations: 16,
  },
  {
    name: "cross-file-refactor",
    kind: "assert",
    files: {
      "geometry.js": "function area(w, h) { return w * h; }\nmodule.exports = { area };\n",
      "main.js": "const { area } = require('./geometry');\nconsole.log(area(3, 4));\n",
      "report.js":
        "const { area } = require('./geometry');\nfunction summary() { return 'area=' + area(2, 5); }\nmodule.exports = { summary };\n",
    },
    prompt:
      "Refactor area(w, h) into area({ width, height }) (a single object argument). Update geometry.js and every caller — main.js and report.js — to match. main.js should still print 12.",
    // end-to-end: main prints 12 AND report's summary() returns area=10 through the
    // new signature. Catches a half-done refactor that updates one caller but not both.
    verify:
      "node main.js | grep -qx 12 && node -e \"const {summary} = require('./report'); process.exit(summary() === 'area=10' ? 0 : 1)\"",
    maxIterations: 16,
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
  /** how many times each guardrail kind fired this task (loop/rescue/fuzzy/syntax). */
  guardrails: Record<string, number>;
  /** router escalations + transport retries — the harness fighting a weak model. */
  escalations: number;
  retries: number;
  iterations: number;
  endReason: string;
}

/** flatten the per-kind guardrail tally into a compact cell like "loop×2 syntax×1". */
function fmtGuardrails(o: Outcome): string {
  const parts: string[] = [];
  for (const [k, n] of Object.entries(o.guardrails)) if (n) parts.push(`${k}×${n}`);
  if (o.escalations) parts.push(`esc×${o.escalations}`);
  if (o.retries) parts.push(`retry×${o.retries}`);
  return parts.length ? parts.join(" ") : "—";
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
    return { pass: null, reason: "judge task skipped (pass --judge)", calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, guardrails: {}, escalations: 0, retries: 0, iterations: 0, endReason: "skipped" };
  }
  const dir = mkdtempSync(join(tmpdir(), `eval-${task.name}-`));
  for (const [p, content] of Object.entries(task.files ?? {})) {
    const full = join(dir, p);
    mkdirSync(dirname(full), { recursive: true }); // tasks may use nested paths (e.g. lib/foo.py)
    writeFileSync(full, content);
  }

  const cfg = structuredClone(config);
  cfg.memory.enabled = false;
  cfg.loop.maxIterations = task.maxIterations ?? 12;
  cfg.loop.maxCostUsd = 0;

  const agent = new Agent({ client, tools: buildRegistry(), config: cfg, cwd: dir });
  let finalText = "";
  const guardrails: Record<string, number> = {};
  let escalations = 0;
  let retries = 0;
  let iterations = 0;
  let endReason = "?";
  try {
    for await (const ev of agent.run(task.prompt)) {
      if (ev.type === "text-end") finalText = ev.text;
      else if (ev.type === "guardrail") guardrails[ev.kind] = (guardrails[ev.kind] ?? 0) + 1;
      else if (ev.type === "router") escalations++;
      else if (ev.type === "retry") retries++;
      else if (ev.type === "turn-end") { iterations = ev.iterations; endReason = ev.reason; }
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    const t = agent.accounting.totals();
    return { pass: false, reason: `agent error: ${(e as Error).message}`, calls: t.calls, inputTokens: t.inputTokens, outputTokens: t.outputTokens, cost: t.cost, guardrails, escalations, retries, iterations, endReason: "error" };
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
  return { pass, reason, calls: t.calls, inputTokens: t.inputTokens, outputTokens: t.outputTokens, cost: t.cost, guardrails, escalations, retries, iterations, endReason };
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
  console.log("| task | kind | result | turns | tok/turn | guardrails | cost | note |");
  console.log("|---|---|:--:|--:|--:|---|--:|---|");

  let passed = 0;
  let scored = 0;
  const fired: Record<string, number> = {};
  for (const task of tasks) {
    const o = await runTask(task, base, client, useJudge);
    const mark = o.pass === null ? "—" : o.pass ? "✅" : "❌";
    const perTurn = o.calls ? Math.round(o.inputTokens / o.calls).toLocaleString() : "—";
    const cost = o.cost ? `$${o.cost.toFixed(4)}` : "$0";
    console.log(`| ${task.name} | ${task.kind} | ${mark} | ${o.calls || "—"} | ${perTurn} | ${fmtGuardrails(o)} | ${cost} | ${o.reason} |`);
    for (const [k, n] of Object.entries(o.guardrails)) fired[k] = (fired[k] ?? 0) + n;
    if (o.escalations) fired.esc = (fired.esc ?? 0) + o.escalations;
    if (o.retries) fired.retry = (fired.retry ?? 0) + o.retries;
    if (o.pass !== null) {
      scored++;
      if (o.pass) passed++;
    }
  }

  console.log(`\n**${passed}/${scored} tasks passed.**`);
  const firedSummary = Object.entries(fired).filter(([, n]) => n).map(([k, n]) => `${k}×${n}`).join(", ");
  console.log(`\nGuardrail activations: ${firedSummary || "none fired"}.`);
  if (passed < scored) process.exitCode = 1;
}

main();
