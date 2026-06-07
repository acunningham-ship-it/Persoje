#!/usr/bin/env bun
import chalk from "chalk";
import * as readline from "node:readline/promises";
import { Agent } from "./core/agent.ts";
import { loadConfig, resolveApiKey } from "./config/config.ts";
import { OpenRouterClient } from "./models/openrouter.ts";
import { ToolRegistry } from "./tools/types.ts";
import { readTool, writeTool, editTool, lsTool, globTool } from "./tools/file-tools.ts";
import { bashTool, grepTool } from "./tools/shell-tools.ts";
import { SessionStore } from "./session/store.ts";

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

  ctrl+c during a turn cancels it.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const config = await loadConfig();
  // --model flag overrides config
  const modelIdx = args.indexOf("--model");
  if (modelIdx !== -1 && args[modelIdx + 1]) config.model.primary = args[modelIdx + 1]!;

  const apiKey = resolveApiKey(config);
  const client = new OpenRouterClient(apiKey, config.openrouter.baseUrl);
  const cwd = process.cwd();
  const agent = new Agent({ client, tools: buildRegistry(), config, cwd });

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

    const { render } = await import("ink");
    const React = await import("react");
    const { App } = await import("./tui/app.tsx");
    const instance = render(React.createElement(App, { agent, store, sessionId, cwd }), { exitOnCtrlC: true });
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
