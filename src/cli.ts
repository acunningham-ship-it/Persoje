#!/usr/bin/env bun
import chalk from "chalk";
import * as readline from "node:readline/promises";
import { join } from "node:path";
import { Agent } from "./core/agent.ts";
import { loadConfig, resolveApiKey, GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_PATH } from "./config/config.ts";
import { OpenRouterClient } from "./models/openrouter.ts";
import { ToolRegistry } from "./tools/types.ts";
import { readTool, writeTool, editTool, lsTool, globTool } from "./tools/file-tools.ts";
import { bashTool, grepTool } from "./tools/shell-tools.ts";
import { SessionStore } from "./session/store.ts";
import { buildRepoMap } from "./context/repo-map.ts";
import { ProfileStore, Router } from "./router/router.ts";
import { FactStore } from "./memory/facts.ts";
import { LessonLog } from "./memory/lessons.ts";
import { SkillLibrary } from "./memory/skills.ts";
import { makeTaskTool } from "./agents/subagent.ts";

const VERSION = "0.1.0";

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of [readTool, writeTool, editTool, lsTool, globTool, bashTool, grepTool]) registry.register(t);
  return registry;
}

function fmtCost(cost: number): string {
  return cost < 0.01 ? `$${cost.toFixed(5)}` : `$${cost.toFixed(3)}`;
}

async function runTurn(agent: Agent, input: string): Promise<void> {
  const controller = new AbortController();
  const onSigint = () => {
    controller.abort();
    process.stdout.write(chalk.yellow("\n[cancelling...]\n"));
  };
  process.on("SIGINT", onSigint);

  try {
    for await (const ev of agent.run(input, controller.signal)) {
      switch (ev.type) {
        case "text-delta":
          process.stdout.write(ev.delta);
          break;
        case "text-end":
          process.stdout.write("\n");
          break;
        case "tool-start": {
          const argStr = JSON.stringify(ev.args);
          process.stdout.write(chalk.dim(`  ⚙ ${ev.name} ${argStr.length > 120 ? argStr.slice(0, 120) + "…" : argStr}\n`));
          break;
        }
        case "tool-result": {
          const lines = ev.result.split("\n").length;
          const note = ev.isError
            ? chalk.red(ev.result.split("\n")[0])
            : chalk.dim(`→ ${lines} line${lines === 1 ? "" : "s"}${ev.truncated ? " (truncated)" : ""} in ${ev.durationMs}ms`);
          process.stdout.write(`    ${note}\n`);
          break;
        }
        case "usage":
          process.stdout.write(
            chalk.dim(
              `  ◦ ${ev.usage.model} in:${ev.usage.inputTokens} out:${ev.usage.outputTokens}` +
                (ev.usage.cachedTokens ? ` cached:${ev.usage.cachedTokens}` : "") +
                ` ${fmtCost(ev.usage.cost)}\n`,
            ),
          );
          break;
        case "compaction":
          process.stdout.write(chalk.dim(`  ⇣ compacted ~${ev.beforeTokens} → ~${ev.afterTokens} tok\n`));
          break;
        case "guardrail":
          process.stdout.write(chalk.yellow(`  ⛨ ${ev.kind}: ${ev.message}\n`));
          break;
        case "router":
          process.stdout.write(chalk.magenta(`  ⇄ router: ${ev.message}\n`));
          break;
        case "error":
          process.stdout.write(chalk.red(`\n✗ ${ev.message}\n`));
          break;
        case "turn-end":
          if (ev.reason === "max-iterations")
            process.stdout.write(chalk.yellow(`\n[stopped: hit ${ev.iterations} iterations]\n`));
          if (ev.reason === "cancelled") process.stdout.write(chalk.yellow("[turn cancelled]\n"));
          break;
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  const t = agent.accounting.totals();
  process.stdout.write(
    chalk.dim(`  session: ${t.calls} calls · ${t.inputTokens + t.outputTokens} tok · ${fmtCost(t.cost)}\n`),
  );
}

function printHelp(): void {
  console.log(`
${chalk.bold("Persoje")} v${VERSION} — token-efficient agentic CLI

  /model [id]   show or switch model
  /cost         session token + cost totals
  /clear        clear conversation history
  /help         this help
  /exit         quit (or ctrl+d)

  --no-update   skip auto-update check
  ctrl+c during a turn cancels it.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Pre-launch auto-update: fetch, pull, rebuild, exec new binary if needed.
  // Runs before anything else so the user always runs the latest version.
  // Skipped with --no-update or PERSOJE_NO_UPDATE=1 env var.
  if (!args.includes("--no-update") && !process.env.PERSOJE_NO_UPDATE) {
    const { preLaunchUpdate } = await import("./core/updater.ts");
    await preLaunchUpdate(process.argv, (msg) => {
      process.stderr.write(`  ↻ ${msg}\n`);
    });
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  // First run: no config and no key → interactive setup.
  if (!(await Bun.file(GLOBAL_CONFIG_PATH).exists()) && !process.env.OPENROUTER_API_KEY && process.stdout.isTTY) {
    const { runSetupWizard } = await import("./setup/wizard.ts");
    if (!(await runSetupWizard())) return;
  }

  // `persoje dream` — offline memory consolidation on a free model.
  if (args[0] === "dream") {
    const config = await loadConfig();
    const client = new OpenRouterClient(resolveApiKey(config), config.openrouter.baseUrl);
    const { runDream } = await import("./memory/dream.ts");
    const result = await runDream({
      client,
      model: config.memory.dreamModel || config.model.compactor || config.model.primary,
      store: new SessionStore(),
      facts: new FactStore(join(GLOBAL_CONFIG_DIR, "memory")),
      lessons: new LessonLog(join(GLOBAL_CONFIG_DIR, "memory", "lessons.jsonl")),
      log: (line) => console.log(chalk.dim(line)),
    });
    console.log(chalk.bold(`dream complete: ${result.factsAdded} new facts, ${result.lessonsCompacted} lessons kept`));
    return;
  }

  const config = await loadConfig();
  // --model flag overrides config
  const modelIdx = args.indexOf("--model");
  if (modelIdx !== -1 && args[modelIdx + 1]) config.model.primary = args[modelIdx + 1]!;

  const apiKey = resolveApiKey(config);
  const client = new OpenRouterClient(apiKey, config.openrouter.baseUrl);
  const cwd = process.cwd();
  const repoMap = await buildRepoMap(cwd, config.context.repoMapTokens).catch(() => "");

  // Memory: bounded index + lessons at session start; skills injected per turn.
  const facts = new FactStore(join(GLOBAL_CONFIG_DIR, "memory"));
  const lessons = new LessonLog(join(GLOBAL_CONFIG_DIR, "memory", "lessons.jsonl"));
  const skills = new SkillLibrary(join(GLOBAL_CONFIG_DIR, "skills"));
  // Project guide written by /init — loaded whole (it's capped at ~60 lines).
  const projectGuide = await Bun.file(join(cwd, ".persoje", "PERSOJE.md"))
    .text()
    .catch(() => "");
  const memoryContext = config.memory.enabled
    ? [
        projectGuide,
        facts.loadForSession(Math.floor(config.memory.budgetTokens * 0.6)),
        lessons.loadForSession(Math.floor(config.memory.budgetTokens * 0.4)),
      ]
        .filter(Boolean)
        .join("\n")
    : projectGuide;

  const tools = buildRegistry();
  const agent = new Agent({ client, tools, config, cwd, repoMap, memoryContext, skills });
  // The task tool lets the main model delegate to isolated sub-agents.
  // Pass full AgentDeps so subagents inherit repo-map, memory, skills.
  tools.register(makeTaskTool({ client, tools, config, cwd, repoMap, memoryContext, skills }));

  // One-shot mode: persoje "do the thing" (no persistence, auto-approve)
  const flagsWithValue = new Set(["--model", "--resume"]);
  const positional = args.filter((a, i) => !a.startsWith("-") && !flagsWithValue.has(args[i - 1] ?? ""));
  if (positional.length > 0) {
    await runTurn(agent, positional.join(" "));
    return;
  }

  // Interactive: Ink TUI by default, --plain for the bare REPL.
  if (!args.includes("--plain") && process.stdout.isTTY) {
    const store = new SessionStore();
    const resumeIdx = args.indexOf("--resume");
    let sessionId: string;
    if (resumeIdx !== -1 && args[resumeIdx + 1]) {
      sessionId = args[resumeIdx + 1]!;
      const meta = store.get(sessionId);
      if (!meta) {
        console.error(chalk.red(`no session ${sessionId}`));
        process.exit(1);
      }
      agent.context.restore(store.loadMessages(sessionId));
    } else {
      sessionId = store.create(cwd, config.model.primary);
    }
    agent.context.onAppend = (msg) => store.appendMessage(sessionId, msg);
    agent.context.onCompact = (messages) => store.replaceMessages(sessionId, messages);

    // Real context windows for the status gauge (owl-alpha = 1M, not the 40k compaction budget).
    const modelWindows = await client.modelContextWindows();

    const profiles = new ProfileStore();
    const router = new Router({
      enabled: config.router.enabled,
      mode: config.router.mode,
      failureThreshold: config.router.failureThreshold,
      profiles,
    });

    const { render } = await import("ink");
    const React = await import("react");
    const { App } = await import("./tui/app.tsx");
    const instance = render(
      React.createElement(App, { agent, store, sessionId, cwd, router, profiles, client, config, lessons, facts, skills, modelWindows }),
      { exitOnCtrlC: true },
    );

    await instance.waitUntilExit();
    store.close();
    return;
  }

  // Plain REPL
  console.log(chalk.bold(`persoje v${VERSION}`) + chalk.dim(` · ${config.model.primary} · ${cwd}`));
  console.log(chalk.dim("type a request, /help for commands\n"));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  while (true) {
    let line: string;
    try {
      line = (await rl.question(chalk.cyan("› "))).trim();
    } catch {
      break; // ctrl+d / closed
    }
    if (!line) continue;

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.split(/\s+/);
      switch (cmd) {
        case "/exit":
        case "/quit":
          rl.close();
          return;
        case "/help":
          printHelp();
          break;
        case "/model":
          if (rest[0]) {
            agent.model = rest[0];
            console.log(chalk.dim(`model → ${rest[0]}`));
          } else {
            console.log(chalk.dim(`model: ${agent.model}`));
          }
          break;
        case "/cost": {
          const t = agent.accounting.totals();
          console.log(
            chalk.dim(
              `calls: ${t.calls}  in: ${t.inputTokens}  out: ${t.outputTokens}  cached: ${t.cachedTokens}  cost: ${fmtCost(t.cost)}\n` +
                `history: ~${agent.context.estimateTokensUsed()} tok`,
            ),
          );
          break;
        }
        case "/clear":
          agent.context.clear();
          console.log(chalk.dim("history cleared"));
          break;
        default:
          console.log(chalk.yellow(`unknown command ${cmd} — /help`));
      }
      continue;
    }

    await runTurn(agent, line);
  }
}

main().catch((e) => {
  console.error(chalk.red(`fatal: ${(e as Error).message}`));
  process.exit(1);
});
