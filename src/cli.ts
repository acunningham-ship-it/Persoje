#!/usr/bin/env bun
import chalk from "chalk";
import * as readline from "node:readline/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Agent } from "./core/agent.ts";
import { formatToolCall } from "./core/tool-summary.ts";
import { loadConfig, resolveApiKey, resolveProvider, GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_PATH } from "./config/config.ts";
import { BUILTIN_PROVIDERS } from "./config/providers.ts";
import { extractPositional } from "./cli-args.ts";
import { OpenRouterClient } from "./models/openrouter.ts";
import { ToolRegistry } from "./tools/types.ts";
import { readTool, writeTool, editTool, multiEditTool, lsTool, globTool } from "./tools/file-tools.ts";
import { bashTool, grepTool } from "./tools/shell-tools.ts";
import { webFetchTool, webSearchTool } from "./tools/web-tools.ts";
import { SessionStore } from "./session/store.ts";
import { TranscriptWriter } from "./context/transcript.ts";
import { setGoalTool, transcriptTool } from "./tools/goal-tools.ts";
import { updateTodosTool } from "./tools/todo-tools.ts";
import { buildRepoMap } from "./context/repo-map.ts";
import { ProfileStore } from "./router/router.ts";
import { FactStore } from "./memory/facts.ts";
import { SkillLibrary } from "./memory/skills.ts";
import { makeTaskTool } from "./agents/subagent.ts";
import { makeAddSkillTool, makeInvokeSkillTool, makeListSkillsTool } from "./tools/skill-tools.ts";
import { monitorTool } from "./tools/monitor-tools.ts";
import { McpManager } from "./mcp/client.ts";

const VERSION = "0.4.0";

function buildRegistry(skills: SkillLibrary, mcp?: McpManager): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of [readTool, writeTool, editTool, multiEditTool, lsTool, globTool, bashTool, grepTool, webFetchTool, webSearchTool]) registry.register(t);
  // Goal anchor + working plan + transcript escape-hatch
  registry.register(setGoalTool);
  registry.register(updateTodosTool);
  registry.register(transcriptTool);
  // Self-learning skill tools. add_skill is always available (so it can create
  // the first one); invoke/list only matter once skills exist — gate them to
  // save tool-schema tokens on every call when the library is empty.
  registry.register(makeAddSkillTool(skills));
  // Monitor management — background watchers that fire between iterations
  registry.register(monitorTool);
  if (skills.list().length > 0) {
    registry.register(makeInvokeSkillTool(skills));
    registry.register(makeListSkillsTool(skills));
  }
  // MCP tools
  if (mcp) {
    for (const tool of mcp.getTools()) registry.register(tool);
  }
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
          process.stdout.write(chalk.dim(`  ⚙ ${formatToolCall(ev.name, ev.args)}\n`));
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
        // Per-call model/cost is NOT streamed — it glued a stat line onto the end
        // of every assistant sentence ("line spam"). Cost lives at end-of-turn
        // (session summary below), in /cost, and in the transcript. A model switch
        // still surfaces via the "router" event, so routing stays visible.
        case "usage":
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
        case "monitor-event":
          if (ev.exitCode !== 0 || ev.error) {
            process.stdout.write(chalk.yellow(`  ⚠ [monitor:${ev.name}] exit ${ev.exitCode}${ev.error ? ` ${ev.error.trim()}` : ""}\n`));
          } else {
            process.stdout.write(chalk.dim(`  ◦ [monitor:${ev.name}] fired\n`));
          }
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

/**
 * Headless continuation loop for autonomous mode. Resumes a session and keeps
 * working toward its goal, one continuation turn at a time, until the model
 * reports DONE (or it stops making progress). On completion it signals the
 * watchdog to stop so the daemon doesn't respawn into an idle loop.
 */
async function runHeadless(agent: Agent, maxRounds = 25): Promise<void> {
  const log = (s: string) => process.stdout.write(`[${new Date().toISOString()}] ${s}\n`);
  log(`headless start — goal: ${agent.goal || "(no goal set; nothing to continue)"}`);
  if (!agent.goal) {
    log("no goal — exiting. Set a goal before enabling autonomous mode.");
    return;
  }

  for (let round = 1; round <= maxRounds; round++) {
    let finalText = "";
    let madeToolCall = false;
    for await (const ev of agent.run(
      "Continue working toward the SESSION GOAL using tools as needed. " +
        "When the goal is fully achieved AND verified, reply with the single word DONE and stop.",
    )) {
      if (ev.type === "tool-start") {
        madeToolCall = true;
        log(`  ⚙ ${formatToolCall(ev.name, ev.args)}`);
      } else if (ev.type === "tool-result" && ev.isError) {
        log(`  ✗ ${ev.result.split("\n")[0]}`);
      } else if (ev.type === "text-end") {
        finalText = ev.text;
      } else if (ev.type === "error") {
        log(`  error: ${ev.message}`);
      } else if (ev.type === "monitor-event") {
        if (ev.exitCode !== 0 || ev.error) {
          log(`  ⚠ [monitor:${ev.name}] exit ${ev.exitCode}${ev.error ? ` ${ev.error.trim()}` : ""}`);
        }
      }
    }
    log(`round ${round}: ${finalText.slice(0, 200)}`);
    // Done when the model says so, or when it just talks without doing anything.
    if (/\bDONE\b/.test(finalText) || (!madeToolCall && finalText)) {
      log("goal complete — stopping autonomous daemon");
      try {
        const dir = join(homedir(), ".local", "share", "persoje-autonomous");
        await Bun.write(join(dir, "stop-watchdog"), "");
      } catch {
        /* best-effort */
      }
      return;
    }
  }
  log(`reached ${maxRounds} continuation rounds — pausing`);
}

/**
 * Print/headless runner (`persoje -p`). Streams tool activity to STDERR so it
 * stays out of the way, and writes ONLY the final result to STDOUT — plain text,
 * or a JSON object with --json. Built for piping and scripts.
 */
async function runPrint(agent: Agent, input: string, json: boolean): Promise<void> {
  let finalText = "";
  const tools: string[] = [];
  let errored = false;
  for await (const ev of agent.run(input)) {
    if (ev.type === "text-end") finalText = ev.text;
    else if (ev.type === "tool-start") {
      tools.push(ev.name);
      process.stderr.write(chalk.dim(`  ⚙ ${ev.name}\n`));
    } else if (ev.type === "error") {
      errored = true;
      process.stderr.write(chalk.red(`error: ${ev.message}\n`));
    } else if (ev.type === "monitor-event" && (ev.exitCode !== 0 || ev.error)) {
      process.stderr.write(chalk.yellow(`  ⚠ [monitor:${ev.name}] exit ${ev.exitCode}${ev.error ? ` ${ev.error.trim()}` : ""}\n`));
    }
  }
  const t = agent.accounting.totals();
  if (json) {
    process.stdout.write(
      JSON.stringify({ text: finalText, tools, tokens: t.inputTokens + t.outputTokens, cost: t.cost }) + "\n",
    );
  } else {
    process.stdout.write(finalText + "\n");
  }
  if (errored && !finalText) process.exit(1);
}

function printHelp(): void {
  console.log(`
${chalk.bold("Persoje")} v${VERSION} — token-efficient agentic CLI

  persoje                 start the interactive TUI
  persoje "do the thing"  one-shot: run once, stream to the terminal
  persoje -p "..."        print mode: run once, only the final result on stdout
  cat task.md | persoje -p   read the prompt from stdin
  persoje -p "..." --json    final result as JSON {text,tools,tokens,cost}

  /model [id]   show or switch model
  /cost         session token + cost totals
  /clear        clear conversation history
  /help         this help
  /exit         quit (or ctrl+d)

  --no-update   skip auto-update check
  -p, --print   headless print mode (no TUI, no auto-update, no wizard)
  --json        with -p: emit a JSON result object instead of plain text
  --model <id>       override the primary model for this run
  --provider <name>  override the active provider for this run
  --preset <name>    apply a provider preset (freebee = free models, $0)
  ctrl+c during a turn cancels it.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Print/headless mode (`persoje -p "prompt"` or piped stdin): run once, print
  // only the final result to stdout for scripting. Implies no-update + no wizard.
  const printMode = args.includes("-p") || args.includes("--print");
  const jsonOut = args.includes("--json");

  // Pre-launch auto-update: fetch, pull, rebuild, exec new binary if needed.
  // Runs before anything else so the user always runs the latest version.
  // Skipped with --no-update, PERSOJE_NO_UPDATE=1, or print mode (deterministic scripts).
  if (!args.includes("--no-update") && !process.env.PERSOJE_NO_UPDATE && !printMode) {
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

  // First run: no config and no key → interactive setup (never in print mode).
  if (!printMode && !(await Bun.file(GLOBAL_CONFIG_PATH).exists()) && !process.env.OPENROUTER_API_KEY && process.stdout.isTTY) {
    const { runSetupWizard } = await import("./setup/wizard.ts");
    if (!(await runSetupWizard())) return;
  }

  // `persoje dream` — offline memory consolidation on a free model.
  if (args[0] === "dream") {
    const config = await loadConfig();
    const provider = resolveProvider(config);
    const client = new OpenRouterClient(provider.apiKey, provider.baseUrl, provider.extraHeaders);
    const { runDream } = await import("./memory/dream.ts");
    const { LessonLog } = await import("./memory/lessons.ts");
    const result = await runDream({
      client,
      model: config.memory.dreamModel || config.model.compactor || config.model.primary,
      judgeModel: config.model.judge || undefined,
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
  // --provider flag overrides config
  const providerIdx = args.indexOf("--provider");
  if (providerIdx !== -1 && args[providerIdx + 1]) config.activeProvider = args[providerIdx + 1]!;
  // --preset flag applies a built-in provider preset non-interactively (the CLI twin of the
  // `/provider` menu), e.g. `--preset freebee` = OpenRouter + a free model. openrouter-family
  // presets keep the synthesized openrouter provider (attribution headers/routing) and just pin
  // the model; other endpoints materialize so resolveProvider picks up their baseUrl/key.
  const presetIdx = args.indexOf("--preset");
  if (presetIdx !== -1 && args[presetIdx + 1]) {
    const wanted = args[presetIdx + 1]!;
    const preset = BUILTIN_PROVIDERS.find((p) => p.name === wanted);
    if (!preset) {
      console.error(`unknown preset "${wanted}" — options: ${BUILTIN_PROVIDERS.map((p) => p.name).join(", ")}`);
      process.exit(1);
    }
    if (preset.defaultModel) config.model.primary = preset.defaultModel;
    if (preset.baseUrl !== "https://openrouter.ai/api/v1") {
      config.activeProvider = preset.name;
      config.providers = { ...config.providers, [preset.name]: { type: "openai-compat", baseUrl: preset.baseUrl, apiKeyEnv: preset.apiKeyEnv, model: preset.defaultModel } };
    }
  }

  const provider = resolveProvider(config);
  const client = new OpenRouterClient(provider.apiKey, provider.baseUrl, provider.extraHeaders);
  const cwd = process.cwd();

  // Kick off the slow, independent startup work concurrently — file scan,
  // MCP connect (network), and the project-guide read all overlap instead of
  // serializing. Local memory/skill setup happens while they're in flight.
  const mcp = new McpManager();
  const repoMapP = buildRepoMap(cwd, config.context.repoMapTokens).catch(() => "");
  const mcpReadyP = mcp.connectAll().catch(() => {});
  const projectGuideP = Bun.file(join(cwd, ".persoje", "PERSOJE.md"))
    .text()
    .catch(() => "");

  // Memory: bounded index at session start; skills injected per turn.
  const facts = new FactStore(join(GLOBAL_CONFIG_DIR, "memory"));
  const skills = new SkillLibrary(join(GLOBAL_CONFIG_DIR, "skills"));
  // Auto-prune unused skills only if the library is bloated (avoids pruning on every boot with new skills).
  if (skills.list().length > 20) {
    const pruned = skills.prune();
    if (pruned.length > 0 && !printMode) console.log(`Pruned ${pruned.length} unused skill(s): ${pruned.join(", ")}`);
  }

  const [repoMap] = await Promise.all([repoMapP, projectGuideP]);
  await mcpReadyP; // MCP tools must be connected before we build the registry

  // Clamp the self-imposed context budget to the active model's real window (× 0.8 leaves
  // headroom for the system prompt, tools, repo-map + response). A large default is right for
  // a 1M-window model like owl-alpha but must never exceed a smaller model's window. The
  // window list is disk-cached (24h), so this is ~free.
  try {
    const win = (await client.modelContextWindows()).get(config.model.primary);
    if (win && win > 0) {
      config.context.budgetTokens = Math.min(config.context.budgetTokens, Math.floor(win * 0.8));
    }
  } catch {
    // window unknown — keep the configured budget
  }

  const tools = buildRegistry(skills, mcp);
  const agent = new Agent({ client, tools, config, cwd, repoMap, skills });
  // The task tool lets the main model delegate to isolated sub-agents.
  // Pass full AgentDeps so subagents inherit repo-map, skills.
  tools.register(makeTaskTool({ client, tools, config, cwd, repoMap, skills }));

  // Headless mode: `persoje headless <sessionId>` — the autonomous daemon runs
  // this. It resumes the session + goal and works toward the goal turn-by-turn
  // until DONE, with no approver (so the core danger guard refuses catastrophic
  // ops rather than auto-running them). Output is captured by the daemon log.
  if (args[0] === "headless" && args[1]) {
    const sessionId = args[1];
    const store = new SessionStore();
    const meta = store.get(sessionId);
    if (!meta) {
      console.error(`headless: no session ${sessionId}`);
      process.exit(1);
    }
    agent.context.restore(store.loadMessages(sessionId));
    agent.context.goal = store.getGoal(sessionId);
    const transcript = new TranscriptWriter(sessionId);
    agent.context.onAppend = (m) => {
      store.appendMessage(sessionId, m);
      transcript.append(m);
    };
    agent.context.onCompact = (m) => store.replaceMessages(sessionId, m);
    agent.setSessionContext({ transcriptPath: transcript.filePath, onGoalSet: (g) => store.setGoal(sessionId, g) });
    await runHeadless(agent);
    store.close();
    return;
  }

  // One-shot mode: persoje "do the thing" (no persistence, auto-approve)
  const positional = extractPositional(args);

  // Print/headless mode: prompt from args or piped stdin, only the final result
  // on stdout (clean for `persoje -p "..." | pbcopy` or `… | persoje -p`).
  if (printMode) {
    let prompt = positional.join(" ").trim();
    if (!prompt && !process.stdin.isTTY) prompt = (await Bun.stdin.text()).trim();
    if (!prompt) {
      process.stderr.write('usage: persoje -p "prompt"  (or pipe the prompt on stdin) [--json]\n');
      process.exit(1);
    }
    await runPrint(agent, prompt, jsonOut);
    return;
  }

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
      agent.context.goal = store.getGoal(sessionId); // re-pin the goal on resume
    } else {
      sessionId = store.create(cwd, config.model.primary);
    }
    // Full transcript mirror (append-only — never truncated by compaction).
    const transcript = new TranscriptWriter(sessionId);
    agent.context.onAppend = (msg) => {
      store.appendMessage(sessionId, msg);
      transcript.append(msg);
    };
    agent.context.onCompact = (messages) => store.replaceMessages(sessionId, messages);
    // Persist the goal whenever the model (set_goal) or /goal sets it; give the
    // transcript tool the path to consult.
    agent.setSessionContext({
      transcriptPath: transcript.filePath,
      onGoalSet: (g) => store.setGoal(sessionId, g),
    });

    // Real context windows for the status gauge (owl-alpha = 1M, not the 40k compaction budget).
    const modelWindows = await client.modelContextWindows();

    const profiles = new ProfileStore();

    const { render } = await import("ink");
    const React = await import("react");
    const { App } = await import("./tui/app.tsx");
    const instance = render(
      React.createElement(App, { agent, store, sessionId, cwd, profiles, client, config, facts, skills, mcp, modelWindows }),
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
