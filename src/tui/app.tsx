import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Agent } from "../core/agent.ts";
import type { SessionStore } from "../session/store.ts";
import type { Router, ProfileStore } from "../router/router.ts";
import type { OpenRouterClient } from "../models/openrouter.ts";
import type { PersojeConfig } from "../config/config.ts";
import type { LessonLog } from "../memory/lessons.ts";
import type { FactStore } from "../memory/facts.ts";
import type { SkillLibrary } from "../memory/skills.ts";
import { runCanary, qualityFromScore } from "../router/canary.ts";
import { renderMarkdown } from "./markdown.ts";
import { COMMANDS, filterCommands, helpText } from "./commands.ts";
import { Banner, Spinner, CommandMenu, ApprovalPrompt, StatusBar, AssistantBlock } from "./components.tsx";
import { theme, getTheme, themeNames, type Theme } from "./theme.ts";
import { loadPersonality, savePersonality, formatPersonality, PERSONALITY_OPTIONS, type Personality } from "../core/personality.ts";
import type { McpManager } from "../mcp/client.ts";

/** Single-width glyphs per tool — Persoje's geometric style. */
const TOOL_ICON: Record<string, string> = {
  read: "◇",
  write: "✎",
  edit: "✎",
  bash: "▸",
  grep: "⌕",
  glob: "⌕",
  ls: "▸",
  task: "◆",
};

const VERSION = "0.1.0";
const HISTORY_PATH = join(homedir(), ".config", "persoje", "history.json");

type DisplayItem =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string }
  | { kind: "tool"; id: number; name: string; argsPreview: string; note: string; isError: boolean }
  | { kind: "info"; id: number; text: string }
  | { kind: "error"; id: number; text: string };

/** Omit that distributes over union members (plain Omit collapses the union). */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type TrustLevel = "normal" | "auto-edit" | "yolo";
const TRUST_CYCLE: TrustLevel[] = ["normal", "auto-edit", "yolo"];
const TRUST_LABEL: Record<TrustLevel, string> = {
  normal: "normal (confirm edits & commands)",
  "auto-edit": "auto-edit (edits auto-run, commands confirm)",
  yolo: "yolo (auto-run all; danger still confirms)",
};

interface PendingApproval {
  name: string;
  args: Record<string, unknown>;
  /** Set when the danger guard flagged this — confirmed even in yolo. */
  dangerReason?: string;
  resolve: (ok: boolean) => void;
}

export interface AppProps {
  agent: Agent;
  store: SessionStore;
  sessionId: string;
  cwd: string;
  router: Router;
  profiles: ProfileStore;
  client: OpenRouterClient;
  config: PersojeConfig;
  lessons: LessonLog;
  facts: FactStore;
  skills: SkillLibrary;
  mcp?: McpManager;
  /** model id → real context-window size, for the status gauge. */
  modelWindows: Map<string, number>;
}

function fmtCost(cost: number): string {
  return cost < 0.01 ? `${cost.toFixed(5)}` : `${cost.toFixed(3)}`;
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/** One-glance argument summary per tool — what Claude Code shows in its ⏺ lines. */
function compactArgs(name: string, args: Record<string, unknown>): string {
  const clip = (s: unknown, n = 60) => {
    const str = String(s ?? "");
    return str.length > n ? str.slice(0, n) + "…" : str;
  };
  switch (name) {
    case "read":
      return clip(args.path) + (args.offset ? `:${args.offset}` : "");
    case "edit":
    case "write":
      return clip(args.path);
    case "bash":
      return clip(args.command, 70);
    case "grep":
      return clip(args.pattern, 40) + (args.path ? ` in ${clip(args.path, 25)}` : "");
    case "glob":
      return clip(args.pattern, 50);
    case "ls":
      return clip(args.path ?? ".");
    case "task":
      return clip(args.task, 70);
    default:
      return clip(JSON.stringify(args), 60);
  }
}

let nextId = 1;

export function App({
  agent,
  store,
  sessionId: initialSession,
  cwd,
  router,
  profiles,
  client,
  config,
  lessons,
  facts,
  skills,
  mcp,
  modelWindows,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [sessionId, setSessionId] = useState(initialSession);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [stream, setStream] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("thinking");
  const [busyStart, setBusyStart] = useState(Date.now());
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [trust, setTrust] = useState<TrustLevel>("normal");
  const trustRef = useRef<TrustLevel>("normal");
  trustRef.current = trust;
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [menuSelected, setMenuSelected] = useState(0);
  const [queue, setQueue] = useState<string[]>([]);
  const [statusCost, setStatusCost] = useState(0);
  const [turnIterations, setTurnIterations] = useState(0);
  const [pickerSessions, setPickerSessions] = useState<import("../session/store.ts").SessionMeta[]>([]);
  const [pickerSelected, setPickerSelected] = useState(0);
  const [activeTheme, setActiveTheme] = useState<Theme>(() => getTheme((config as any).theme?.name ?? "amber"));
  const [sessionTitle, setSessionTitle] = useState<string>(() => store.get(initialSession)?.title ?? "");
  const [greeted, setGreeted] = useState(false);

  // Pleasant greeting on first render
  useEffect(() => {
    if (greeted) return;
    setGreeted(true);
    const greetings = [
      "ready to build something great",
      "what are we working on today",
      "let's get to it",
      "at your service",
      "what's on your mind",
      "let's make something happen",
      "firing up the engines",
      "what shall we create",
    ];
    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
    push({ kind: "info", text: `◆ ${greeting}` });
  }, []);
  const abortRef = useRef<AbortController | null>(null);
  const alwaysAllow = useRef(new Set<string>());
  const streamBuf = useRef("");
  const toolArgs = useRef(new Map<string, string>()); // call id → args preview

  const menuItems = !busy && !pending ? filterCommands(input) : [];
  const menuVisible = menuItems.length > 0;

  // Sync terminal title with session name
  useEffect(() => {
    process.title = sessionTitle ? `persoje · ${sessionTitle}` : "persoje";
    // Also set the xterm escape sequence for terminals that support it
    if (process.stdout.isTTY) {
      process.stdout.write(`\x1b]0;${process.title}\x07`);
    }
  }, [sessionTitle]);

  const push = useCallback((item: DistOmit<DisplayItem, "id">) => {
    setItems((prev) => [...prev, { ...item, id: nextId++ } as DisplayItem]);
  }, []);

  // Persistent input history.
  useEffect(() => {
    Bun.file(HISTORY_PATH)
      .json()
      .then((h) => Array.isArray(h) && setHistory(h.slice(0, 100)))
      .catch(() => {});
  }, []);
  const saveHistory = (h: string[]) => {
    void Bun.write(HISTORY_PATH, JSON.stringify(h.slice(0, 100))).catch(() => {});
  };

  // Approval hook. Danger always prompts (core flags it); otherwise the trust
  // level decides: yolo auto-runs everything, auto-edit auto-runs write/edit,
  // normal confirms all mutations. `a` adds a per-tool always-allow.
  useEffect(() => {
    agent.setApprover(async (name, args, dangerReason) => {
      if (dangerReason) {
        return new Promise<boolean>((resolve) => setPending({ name, args, dangerReason, resolve }));
      }
      const level = trustRef.current;
      if (level === "yolo") return true;
      if (level === "auto-edit" && (name === "write" || name === "edit")) return true;
      if (alwaysAllow.current.has(name)) return true;
      return new Promise<boolean>((resolve) => setPending({ name, args, resolve }));
    });
  }, [agent]);

  // Router: guardrail failures feed escalation. "offer" suggests, "auto" switches.
  useEffect(() => {
    agent.setFailureSink((kind, model) => {
      router.recordFailure(model, kind);
      const esc = router.shouldEscalate(model);
      if (!esc) return;
      if (router.mode === "auto" && esc.target) {
        agent.model = esc.target;
        push({ kind: "info", text: `⇄ router: ${esc.reason} — auto-switched to ${esc.target}` });
      } else {
        push({
          kind: "info",
          text: `⇄ router: ${esc.reason}${esc.target ? ` — consider /model ${esc.target}` : " — consider a stronger model"}`,
        });
      }
    });
  }, [agent, router, push]);

  // Canary: first use of an unknown/variable model gets a 3-prompt smoke test;
  // the verdict persists to ~/.config/persoje/models.json and tunes strictness.
  const canaried = useRef(new Set<string>());
  const maybeCanary = useCallback(
    async (modelId: string, force = false) => {
      if (!force && (!router.enabled || !config.router.canary || canaried.current.has(modelId))) return;
      const profile = profiles.get(modelId);
      if (!force && (profile.canary || profile.toolQuality === "excellent" || profile.toolQuality === "good")) return;
      canaried.current.add(modelId);
      push({ kind: "info", text: `testing ${modelId} (3-prompt canary)…` });
      try {
        const result = await runCanary(client, modelId);
        const quality = qualityFromScore(result.score);
        profiles.upsert({
          ...profile,
          toolQuality: quality,
          canary: { score: result.score, total: result.total, testedAt: Date.now(), notes: result.notes },
        });
        const notes = result.notes.length ? ` (${result.notes.join("; ")})` : "";
        push({ kind: "info", text: `canary: ${result.score}/${result.total} → ${quality}${notes}` });
      } catch (e) {
        push({ kind: "info", text: `canary failed: ${(e as Error).message}` });
      }
    },
    [client, config, profiles, push, router],
  );
  useEffect(() => {
    void maybeCanary(agent.model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Batch streaming deltas: flush at 80ms so Ink isn't re-rendering per token.
  useEffect(() => {
    const t = setInterval(() => {
      if (streamBuf.current) {
        const chunk = streamBuf.current;
        streamBuf.current = "";
        setStream((s) => s + chunk);
      }
    }, 80);
    return () => clearInterval(t);
  }, []);

  const runTurn = useCallback(
    async (task: string) => {
      setBusy(true);
      setBusyLabel("thinking");
      setBusyStart(Date.now());
      push({ kind: "user", text: task });
      store.maybeSetTitle(sessionId, task);
      // Update session title state for terminal header + banner
      const meta = store.get(sessionId);
      if (meta?.title) setSessionTitle(meta.title);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        for await (const ev of agent.run(task, controller.signal)) {
          switch (ev.type) {
            case "text-delta":
              streamBuf.current += ev.delta;
              break;
            case "text-end":
              streamBuf.current = "";
              setStream("");
              push({ kind: "assistant", text: ev.text });
              break;
            case "tool-start": {
              const preview = compactArgs(ev.name, ev.args);
              toolArgs.current.set(ev.id, preview);
              setBusyLabel(`${ev.name}(${preview})`);
              setTurnIterations((n) => n + 1);
              break;
            }
            case "tool-result": {
              setBusyLabel("thinking");
              const lines = ev.result.split("\n").length;
              push({
                kind: "tool",
                name: ev.name,
                argsPreview: toolArgs.current.get(ev.id) ?? "",
                note: ev.isError
                  ? ev.result.split("\n")[0]!.slice(0, 110)
                  : `${lines} line${lines === 1 ? "" : "s"}${ev.truncated ? " (truncated)" : ""} · ${ev.durationMs}ms`,
                isError: ev.isError,
              });
              break;
            }
            case "usage":
              store.recordUsage(sessionId, ev.usage);
              setStatusCost(agent.accounting.totals().cost);
              break;
            case "guardrail":
              push({ kind: "info", text: `⛨ ${ev.kind}: ${ev.message}` });
              break;
            case "router":
              push({ kind: "info", text: `⇄ ${ev.message}${ev.target ? ` — switch with /model ${ev.target}` : ""}` });
              break;
            case "compaction":
              push({ kind: "info", text: `⇣ compacted history: ~${ev.beforeTokens} → ~${ev.afterTokens} tok` });
              break;
            case "retry": {
              const delaySec = (ev.delayMs / 1000).toFixed(1);
              setBusyLabel(`retry ${ev.attempt}/${ev.maxRetries} (${ev.reason}, ${delaySec}s)`);
              break;
            }
            case "error":
              push({ kind: "error", text: ev.message });
              break;
            case "turn-end":
              if (ev.reason === "max-iterations") push({ kind: "info", text: `stopped after ${ev.iterations} iterations` });
              if (ev.reason === "cancelled") push({ kind: "info", text: "turn cancelled" });
              setTurnIterations(0);
              // Failed turns become lessons; `persoje dream` curates them later.
              if (ev.reason === "max-iterations" || ev.reason === "error") {
                lessons.append({
                  task: task.slice(0, 120),
                  error: ev.reason,
                  lesson: `Turn ended with ${ev.reason} after ${ev.iterations} iterations`,
                  model: agent.model,
                });
              }
              break;
          }
        }
      } finally {
        streamBuf.current = "";
        setStream("");
        setBusy(false);
        abortRef.current = null;
      }
    },
    [agent, lessons, push, sessionId, store],
  );

  const handleCommand = useCallback(
    (line: string) => {
      const [cmd, ...rest] = line.split(/\s+/);
      switch (cmd) {
        case "/exit":
        case "/quit":
          exit();
          break;
        case "/help":
          push({ kind: "info", text: helpText() + "\nkeys: ↑↓ history · tab completes · esc cancels · y/n/a on prompts" });
          break;
        case "/model":
          if (rest[0]) {
            agent.model = rest[0];
            push({ kind: "info", text: `model → ${rest[0]}` });
            void maybeCanary(rest[0]);
          } else {
            const p = profiles.get(agent.model);
            const canary = p.canary ? ` · canary ${p.canary.score}/${p.canary.total}` : " · not canaried";
            push({ kind: "info", text: `model: ${agent.model} (${p.toolQuality}${canary})` });
          }
          break;
        case "/router":
          if (rest[0] === "on") router.enabled = true;
          else if (rest[0] === "off") router.enabled = false;
          else if (rest[0] === "auto" || rest[0] === "offer") router.mode = rest[0];
          push({
            kind: "info",
            text: `router: ${router.enabled ? "on" : "off"} · mode: ${router.mode} (usage: /router on|off|auto|offer)`,
          });
          break;
        case "/canary":
          void maybeCanary(agent.model, true);
          break;
        case "/cost": {
          const t = agent.accounting.totals();
          push({
            kind: "info",
            text: `calls: ${t.calls} · in: ${t.inputTokens} · out: ${t.outputTokens} · cached: ${t.cachedTokens} · cost: ${fmtCost(t.cost)}\nhistory: ~${agent.context.estimateTokensUsed()} tok`,
          });
          break;
        }
        case "/status": {
          const p = profiles.get(agent.model);
          const t = agent.accounting.totals();
          const factCount = facts.index().split("\n").filter(Boolean).length;
          const stats = agent.context.buildStats();
          push({
            kind: "info",
            text: [
              `model      ${agent.model} (${p.toolQuality}${p.canary ? `, canary ${p.canary.score}/${p.canary.total}` : ""})`,
              `router     ${router.enabled ? "on" : "off"} · ${router.mode} · ${router.failureCount(agent.model)} recent failures`,
              `session    ${sessionId} · ~${stats.totalTokens} tok history · ${fmtCost(t.cost)}`,
              `context    ${stats.totalMessages} msgs · ${stats.elidedCount} elided · ${stats.cacheBreakpoints} cache pts · prefix ${stats.prefixStable ? "stable ✓" : "dirty"}`,
              `memory     ${factCount} facts · ${lessons.recent(100).length} lessons · ${skills.list().length} skills`,
              `repo-map   ${agent.repoMap ? `~${Math.ceil(agent.repoMap.length / 4)} tok` : "none"}`,
              `config     ~/.config/persoje/config.json · budget ${config.context.budgetTokens} tok`,
              (config as any).planMode ? `plan       📋 ON — will spec before acting` : null,
            ].filter(Boolean).join("\n"),
          });
          break;
        }
        case "/config":
          push({ kind: "info", text: JSON.stringify(config, null, 2) });
          break;
        case "/permissions":
          if (rest[0] === "clear") {
            alwaysAllow.current.clear();
            push({ kind: "info", text: "always-allow list cleared" });
          } else {
            push({
              kind: "info",
              text: alwaysAllow.current.size
                ? `always allowed this session: ${[...alwaysAllow.current].join(", ")} (/permissions clear to reset)`
                : "nothing always-allowed yet — answer [a] on a prompt to add",
            });
          }
          break;
        case "/resume": {
          if (!rest[0]) {
            // Enter interactive session picker
            const sessions = store.list(cwd, 20);
            if (sessions.length === 0) {
              push({ kind: "info", text: "no sessions in this directory" });
            } else {
              setPickerSessions(sessions);
              setPickerSelected(0);
            }
            break;
          }
          // Resume by number or title substring (direct, no picker)
          const sessions = store.list(cwd, 20);
          const query = rest.join(" ");
          let target: string | null = null;
          const num = parseInt(query, 10);
          if (num > 0 && num <= sessions.length) {
            target = sessions[num - 1]!.id;
          } else {
            const lower = query.toLowerCase();
            const match = sessions.find((s) => s.title.toLowerCase().includes(lower));
            if (match) target = match.id;
          }
          if (!target) {
            push({ kind: "error", text: `no session matching "${query}" — use /resume to pick` });
            break;
          }
          const meta = store.get(target);
          agent.context.restore(store.loadMessages(target));
          setSessionId(target);
          if (meta?.title) setSessionTitle(meta.title);
          push({ kind: "info", text: `resumed '${meta?.title || target}' (${meta?.messageCount} messages, ~${agent.context.estimateTokensUsed()} tok)` });
          break;
        }
        case "/compact":
          void agent.compact().then(
            (r) =>
              push(
                r
                  ? { kind: "info", text: `compacted: ~${r.before} → ~${r.after} tok` }
                  : { kind: "info", text: "not enough history to compact" },
              ),
            (e) => push({ kind: "error", text: `compaction failed: ${(e as Error).message}` }),
          );
          break;
        case "/clear":
          agent.context.clear();
          push({ kind: "info", text: "history cleared" });
          break;
        case "/init":
          void runTurn(
            "Explore this project (ls, glob, read the key files) and then use the write tool to create .persoje/PERSOJE.md: " +
              "a concise guide (max 60 lines) for AI agents working here — what the project is, directory layout, " +
              "build/run/test commands, and conventions to follow. Then confirm what you wrote.",
          );
          break;
        case "/goal": {
          const arg = rest.join(" ").trim();
          if (arg === "clear") {
            agent.setGoal("");
            push({ kind: "info", text: "goal cleared — it'll be re-established on your next task" });
          } else if (arg) {
            agent.setGoal(arg);
            push({ kind: "info", text: `goal set:\n${arg}` });
          } else {
            push({ kind: "info", text: agent.goal ? `current goal:\n${agent.goal}` : "no goal set yet — it's established (with clarifying questions if needed) on your first task" });
          }
          break;
        }
        case "/memory": {
          if (rest[0]) {
            const fact = facts.getFact(rest[0]);
            push(fact ? { kind: "info", text: `# ${fact.title}\n${fact.body}` } : { kind: "error", text: `no fact "${rest[0]}"` });
          } else {
            const idx = facts.index().trim();
            push({ kind: "info", text: idx || "no facts yet — run /dream after a few sessions" });
          }
          break;
        }
        case "/skills": {
          const list = skills.list();
          push({
            kind: "info",
            text: list.length
              ? list.map((s) => `${s.name} — ${s.description}`).join("\n")
              : "no skills yet — drop markdown files in ~/.config/persoje/skills/ (first line: # name: description)",
          });
          break;
        }
        case "/lessons": {
          const recent = lessons.recent(8);
          push({
            kind: "info",
            text: recent.length
              ? recent.map((l) => `[${l.model}] ${l.lesson} (${l.task.slice(0, 50)})`).join("\n")
              : "no lessons recorded yet",
          });
          break;
        }
        case "/quirks": {
          const p = profiles.get(agent.model);
          push({
            kind: "info",
            text: p.quirks.length ? `${agent.model}:\n` + p.quirks.map((q) => `- ${q}`).join("\n") : `no recorded quirks for ${agent.model}`,
          });
          break;
        }
        case "/repomap":
          push({
            kind: "info",
            text: agent.repoMap ? `${agent.repoMap}\n(~${Math.ceil(agent.repoMap.length / 4)} tok, sent with every call)` : "no repo-map for this directory",
          });
          break;
        case "/dream": {
          setBusy(true);
          setBusyLabel("dreaming (consolidating memory)");
          setBusyStart(Date.now());
          void import("../memory/dream.ts")
            .then(({ runDream }) =>
              runDream({
                client,
                model: config.memory.dreamModel || config.model.compactor || config.model.primary,
                store,
                facts,
                lessons,
                log: (line) => push({ kind: "info", text: line }),
              }),
            )
            .then((r) => push({ kind: "info", text: `dream complete: ${r.factsAdded} new facts, ${r.lessonsCompacted} lessons kept` }))
            .catch((e) => push({ kind: "error", text: `dream failed: ${(e as Error).message}` }))
            .finally(() => setBusy(false));
          break;
        }
        case "/permsoff": {
          // yolo: auto-run everything. The core danger guard still confirms
          // catastrophic ops (rm -rf /, force-push, secrets, etc.).
          setTrust("yolo");
          push({ kind: "info", text: "🔓 yolo — all tools auto-run (danger ops still confirm). shift+tab to cycle, or set trust normal." });
          break;
        }
        case "/effort": {
          const level = rest[0];
          if (!level || !["low", "mid", "high", "max"].includes(level)) {
            push({ kind: "info", text: `effort: ${(config as any).effort?.level ?? "mid"} — usage: /effort low|mid|high|max\n  low  = quick answers, minimal verification\n  mid  = balanced (default)\n  high = thorough, verify everything\n  max  = exhaustive, full analysis` });
            break;
          }
          if (!(config as any).effort) (config as any).effort = {};
          (config as any).effort.level = level;
          // Adjust temperature with effort: low=0.1, mid=0.3, high=0.5, max=0.7
          const temps: Record<string, number> = { low: 0.1, mid: 0.3, high: 0.5, max: 0.7 };
          config.model.temperature = temps[level] ?? 0.3;
          push({ kind: "info", text: `▸ effort → ${level} (temperature ${config.model.temperature})` });
          break;
        }
        case "/plan": {
          const sub = rest[0];
          if (sub === "on") {
            (config as any).planMode = true;
            push({ kind: "info", text: "📋 plan mode ON — will generate implementation spec before executing" });
          } else if (sub === "off") {
            (config as any).planMode = false;
            push({ kind: "info", text: "📋 plan mode OFF" });
          } else {
            // Toggle
            (config as any).planMode = !(config as any).planMode;
            push({ kind: "info", text: `📋 plan mode ${(config as any).planMode ? "ON — will spec before acting" : "OFF"}` });
          }
          break;
        }
        case "/autonomous": {
          const sub = rest[0] || "status";
          void import("../core/autonomous.ts")
            .then(({ autonomousCmd }) => autonomousCmd(sub, { push, alwaysAllow, exit, sessionId, goal: agent.goal }))
            .catch((e) => push({ kind: "error", text: `autonomous: ${(e as Error).message}` }));
          break;
        }
        case "/theme": {
          const name = rest[0];
          if (!name) {
            const current = (config as any).theme?.name ?? "amber";
            push({ kind: "info", text: `theme: ${current}\navailable: ${themeNames.join(", ")}\nusage: /theme <name>` });
            break;
          }
          if (!themeNames.includes(name)) {
            push({ kind: "error", text: `unknown theme "${name}" — available: ${themeNames.join(", ")}` });
            break;
          }
          if (!(config as any).theme) (config as any).theme = {};
          (config as any).theme.name = name;
          setActiveTheme(getTheme(name));
          push({ kind: "info", text: `▸ theme → ${name}` });
          break;
        }
        case "/mcp": {
          const sub = rest[0];
          if (!sub || sub === "list") {
            const servers = mcp?.listServers() ?? {};
            const names = Object.keys(servers);
            if (names.length === 0) {
              push({ kind: "info", text: "No MCP servers configured.\nusage: /mcp add <name> <command> [args...]\n       /mcp remove <name>\n       /mcp connect <name>\n       /mcp tools" });
            } else {
              const lines = names.map((n) => {
                const s = servers[n]!;
                return `  ${n}: ${s.command} ${(s.args ?? []).join(" ")}`;
              });
              push({ kind: "info", text: `MCP servers:\n${lines.join("\n")}` });
            }
            break;
          }
          if (sub === "add") {
            const name = rest[1];
            const command = rest[2];
            if (!name || !command) {
              push({ kind: "error", text: "usage: /mcp add <name> <command> [args...]" });
              break;
            }
            const args = rest.slice(3);
            mcp?.addServer(name, { command, args });
            push({ kind: "info", text: `▸ MCP server "${name}" added: ${command} ${args.join(" ")}` });
            break;
          }
          if (sub === "remove") {
            const name = rest[1];
            if (!name) { push({ kind: "error", text: "usage: /mcp remove <name>" }); break; }
            const ok = mcp?.removeServer(name);
            push({ kind: ok ? "info" : "error", text: ok ? `▸ MCP server "${name}" removed` : `MCP server "${name}" not found` });
            break;
          }
          if (sub === "connect") {
            const name = rest[1];
            if (!name) { push({ kind: "error", text: "usage: /mcp connect <name>" }); break; }
            mcp?.connect(name)
              .then((conn: any) => push({ kind: "info", text: `▸ connected "${name}" — ${conn?.tools?.length ?? 0} tools discovered` }))
              .catch((e: any) => push({ kind: "error", text: `MCP connect failed: ${e.message}` }));
            break;
          }
          if (sub === "tools") {
            const toolNames = mcp?.getToolNames() ?? [];
            push({ kind: "info", text: toolNames.length ? `MCP tools:\n${toolNames.map((t: string) => `  ${t}`).join("\n")}` : "No MCP tools available. Connect servers first." });
            break;
          }
          push({ kind: "error", text: `unknown /mcp subcommand: ${sub}` });
          break;
        }
        case "/personality": {
          const sub = rest[0];
          const current = loadPersonality();
          if (!sub || sub === "show") {
            push({ kind: "info", text: `Current personality:\n${formatPersonality(current)}\n\n/personality set <trait> <value> — change a trait\n/personality reset — reset to defaults\n/personality custom <text> — set custom instructions` });
            break;
          }
          if (sub === "set") {
            const trait = rest[1] as keyof Personality;
            const value = rest[2];
            if (!trait || !value) {
              const traits = Object.keys(PERSONALITY_OPTIONS).join(", ");
              push({ kind: "error", text: `usage: /personality set <trait> <value>\ntraits: ${traits}` });
              break;
            }
            const options = PERSONALITY_OPTIONS[trait as keyof typeof PERSONALITY_OPTIONS];
            if (options && !options.includes(value)) {
              push({ kind: "error", text: `"${value}" not valid for ${trait}. Options: ${options.join("/")}` });
              break;
            }
            (current as any)[trait] = value;
            savePersonality(current);
            push({ kind: "info", text: `▸ personality.${trait} → ${value}` });
            break;
          }
          if (sub === "reset") {
            savePersonality({ tone: "professional", verbosity: "concise", workEthic: "driven", formality: "neutral", humor: "subtle", codeStyle: "clean", explanations: "brief", custom: "" });
            push({ kind: "info", text: "▸ personality reset to defaults" });
            break;
          }
          if (sub === "custom") {
            const text = rest.slice(1).join(" ");
            if (!text) { push({ kind: "error", text: "usage: /personality custom <text>" }); break; }
            current.custom = text;
            savePersonality(current);
            push({ kind: "info", text: `▸ personality.custom → "${text}"` });
            break;
          }
          push({ kind: "error", text: `unknown /personality subcommand: ${sub}` });
          break;
        }
        default: {
          // Check if it's a skill invocation: /skillname
          const skillName = (cmd ?? "").slice(1); // remove leading /
          const skill = skills.load(skillName);
          if (skill) {
            // Inject skill content as the task
            void runTurn(`[Following skill: ${skill.name}]\n${skill.content}`);
            break;
          }
          push({ kind: "info", text: `unknown command ${cmd} — /help` });
          break;
        }
      }
    },
    [agent, client, config, cwd, exit, facts, lessons, maybeCanary, profiles, push, router, runTurn, sessionId, skills, store, mcp],
  );

  // Queued messages run as soon as the agent frees up.
  useEffect(() => {
    if (!busy && !pending && queue.length > 0) {
      const [next, ...restQ] = queue;
      setQueue(restQ);
      if (next!.startsWith("/")) handleCommand(next!);
      else void runTurn(next!);
    }
  }, [busy, pending, queue, handleCommand, runTurn]);

  useInput((char, key) => {
    // Permission prompt has priority.
    if (pending) {
      if (char === "y" || key.return) {
        pending.resolve(true);
        setPending(null);
      } else if (char === "n" || key.escape) {
        pending.resolve(false);
        setPending(null);
      } else if (char === "a") {
        alwaysAllow.current.add(pending.name);
        pending.resolve(true);
        setPending(null);
      }
      return;
    }

    // Session picker: arrow keys navigate, Enter selects, Escape cancels.
    if (pickerSessions.length > 0) {
      if (key.upArrow) {
        setPickerSelected((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setPickerSelected((s) => Math.min(pickerSessions.length - 1, s + 1));
        return;
      }
      if (key.escape) {
        setPickerSessions([]);
        setPickerSelected(0);
        return;
      }
      if (key.return) {
        const chosen = pickerSessions[pickerSelected]!;
        const meta = store.get(chosen.id);
        agent.context.restore(store.loadMessages(chosen.id));
        setSessionId(chosen.id);
        if (meta?.title) setSessionTitle(meta.title);
        setPickerSessions([]);
        setPickerSelected(0);
        push({ kind: "info", text: `resumed '${meta?.title || chosen.id}' (${meta?.messageCount} messages, ~${agent.context.estimateTokensUsed()} tok)` });
        return;
      }
      return; // swallow all other keys while picker is open
    }

    const submit = (raw: string) => {
      const line = raw.trim();
      setInput("");
      setHistoryIdx(-1);
      setMenuSelected(0);
      if (!line) return;
      const newHistory = [line, ...history].slice(0, 100);
      setHistory(newHistory);
      saveHistory(newHistory);
      if (busy) {
        setQueue((q) => [...q, line]);
        push({ kind: "info", text: `queued: ${line.slice(0, 60)}` });
        return;
      }
      if (line.startsWith("/")) handleCommand(line);
      else void runTurn(line);
    };

    // shift+tab cycles the trust level (normal → auto-edit → yolo → …).
    if (key.tab && key.shift) {
      const next = TRUST_CYCLE[(TRUST_CYCLE.indexOf(trustRef.current) + 1) % TRUST_CYCLE.length]!;
      setTrust(next);
      push({ kind: "info", text: `trust: ${TRUST_LABEL[next]}` });
      return;
    }

    if (key.escape) {
      if (busy) abortRef.current?.abort();
      else setInput("");
      setMenuSelected(0);
      return;
    }

    if (key.return) {
      // Menu: enter completes (and runs no-arg commands immediately).
      if (menuVisible) {
        const chosen = menuItems[Math.min(menuSelected, menuItems.length - 1)]!;
        if (chosen.args && input.trim() !== chosen.name) {
          setInput(chosen.name + " ");
          setMenuSelected(0);
          return;
        }
        submit(chosen.name);
        return;
      }
      submit(input);
      return;
    }
    if (key.tab && menuVisible) {
      const chosen = menuItems[Math.min(menuSelected, menuItems.length - 1)]!;
      setInput(chosen.name + (chosen.args ? " " : ""));
      setMenuSelected(0);
      return;
    }
    if (key.upArrow) {
      if (menuVisible) {
        setMenuSelected((s) => Math.max(0, s - 1));
      } else {
        const idx = Math.min(historyIdx + 1, history.length - 1);
        if (history[idx] !== undefined) {
          setHistoryIdx(idx);
          setInput(history[idx]!);
        }
      }
      return;
    }
    if (key.downArrow) {
      if (menuVisible) {
        setMenuSelected((s) => Math.min(menuItems.length - 1, s + 1));
      } else {
        const idx = historyIdx - 1;
        setHistoryIdx(idx);
        setInput(idx >= 0 ? (history[idx] ?? "") : "");
      }
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      setMenuSelected(0);
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      // Pasted/piped text can contain newlines that never arrive as key.return —
      // treat the first newline as submission and keep the remainder typed.
      if (char.includes("\n") || char.includes("\r")) {
        const norm = char.replace(/\r\n?/g, "\n");
        const nl = norm.indexOf("\n");
        const line = input + norm.slice(0, nl);
        setInput(norm.slice(nl + 1));
        submit(line);
      } else {
        setInput((v) => v + char);
        setMenuSelected(0);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Static items={[{ id: 0 } as { id: number }, ...items] as Array<{ id: number } | DisplayItem>}>
        {(item) => {
          if (!("kind" in item)) {
            return (
              <Banner
                key="banner"
                version={VERSION}
                model={agent.model}
                cwd={cwd}
                routerState={`${router.enabled ? "on" : "off"} (${router.mode})`}
                effort={(config as any).effort?.level ?? "mid"}
                sessionTitle={sessionTitle || undefined}
                activeTheme={activeTheme}
              />
            );
          }
          switch (item.kind) {
            case "user":
              return (
                <Box key={item.id} marginTop={1}>
                  <Text color={activeTheme.accent}>{"▸ "}</Text>
                  <Text>{item.text}</Text>
                </Box>
              );
            case "assistant":
              return <AssistantBlock key={item.id} body={<Text>{renderMarkdown(item.text)}</Text>} />;
            case "tool":
              // Dense scannable row: icon · name(args) · result
              return item.isError ? (
                <Box key={item.id} flexDirection="column" marginTop={1}>
                  <Text>
                    <Text color={activeTheme.err}>  ◆ </Text>
                    <Text color={activeTheme.err}>{TOOL_ICON[item.name] ?? "▸"} </Text>
                    <Text bold>{item.name}</Text>
                    <Text dimColor>({item.argsPreview})</Text>
                  </Text>
                  <Text color={activeTheme.err}>    ⌐ {item.note}</Text>
                </Box>
              ) : (
                <Box key={item.id} marginTop={1}>
                  <Text dimColor>  │ </Text>
                  <Text color={activeTheme.accent}>{TOOL_ICON[item.name] ?? "▸"} </Text>
                  <Text>{item.name}</Text>
                  <Text dimColor>({item.argsPreview}) </Text>
                  <Text dimColor>· {item.note}</Text>
                </Box>
              );
            case "info":
              return (
                <Box key={item.id} marginTop={1}>
                  <Text dimColor>{item.text}</Text>
                </Box>
              );
            case "error":
              return (
                <Box key={item.id} marginTop={1}>
                  <Text color={activeTheme.err}>✗ {item.text}</Text>
                </Box>
              );
          }
        }}
      </Static>

      {stream ? (
        <Box marginTop={1}>
          <Text>{stream}</Text>
        </Box>
      ) : null}
      {busy ? <Spinner detail={busyLabel === "thinking" ? undefined : busyLabel} startedAt={busyStart} effort={(config as any).effort?.level ?? "mid"} /> : null}

      {pending ? <ApprovalPrompt name={pending.name} args={pending.args} dangerReason={pending.dangerReason} /> : null}

      {!pending ? (
        <Box flexDirection="column" marginTop={1}>
          <Box borderStyle="round" borderColor={busy ? activeTheme.border : activeTheme.accent} paddingX={1}>
            <Text color={activeTheme.accent}>{"▸ "}</Text>
            {input ? <Text>{input}</Text> : <Text dimColor>{busy ? "type to queue…" : "task, or / for commands"}</Text>}
            <Text color={activeTheme.accent}>▌</Text>
          </Box>
          {menuVisible ? (
            <CommandMenu items={menuItems} selected={menuSelected} />
          ) : pickerSessions.length > 0 ? (
            <Box flexDirection="column" marginLeft={2} marginTop={1}>
              <Text color={activeTheme.accent} bold>resume session  <Text dimColor>(↑↓ navigate · ↵ select · esc cancel)</Text></Text>
              {pickerSessions.map((s, i) => {
                const ago = timeAgo(s.updatedAt);
                const title = s.title || "(untitled)";
                const selected = i === pickerSelected;
                return (
                  <Text key={s.id}>
                    <Text color={selected ? activeTheme.accent : "gray"}>{selected ? "▸ " : "  "}</Text>
                    <Text color={selected ? activeTheme.accent : undefined}>{title}</Text>
                    <Text dimColor>  {s.messageCount} msgs  {fmtCost(s.totalCost)}  {ago}</Text>
                  </Text>
                );
              })}
            </Box>
          ) : (
            <StatusBar
              model={agent.model}
              ctxUsed={agent.context.estimateTokensUsed()}
              ctxBudget={modelWindows.get(agent.model) ?? config.context.budgetTokens}
              cost={statusCost}
              busy={busy}
              turnStart={busyStart}
              queued={queue.length}
              routerOff={!router.enabled}
              effort={(config as any).effort?.level ?? "mid"}
              iterations={turnIterations}
              planMode={(config as any).planMode ?? false}
              trust={trust}
              activeTheme={activeTheme}
            />
          )}
        </Box>
      ) : null}
    </Box>
  );
}
