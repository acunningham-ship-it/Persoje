import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { truncate } from "../tools/truncate.ts";
import type { Agent } from "../core/agent.ts";
import type { SessionStore } from "../session/store.ts";
import type { Router, ProfileStore } from "../router/router.ts";
import { OpenRouterClient } from "../models/openrouter.ts";
import type { PersojeConfig } from "../config/config.ts";
import { setDefaultModel, setConfigValue, setActiveProvider, resolveProvider, saveProvider } from "../config/config.ts";
import { BUILTIN_PROVIDERS, buildProviderMenu, presetHasKey, PRIMER_PROVIDER, type ProviderMenuItem, type ProviderPreset } from "../config/providers.ts";
import type { LessonLog } from "../memory/lessons.ts";
import type { FactStore } from "../memory/facts.ts";
import type { SkillLibrary } from "../memory/skills.ts";
import { runCanary, qualityFromScore } from "../router/canary.ts";
import { renderMarkdown } from "./markdown.ts";
import { COMMANDS, filterCommands, helpText, LIVE_SAFE } from "./commands.ts";
import { Banner, Spinner, CommandMenu, ApprovalPrompt, StatusBar, AssistantBlock, TodoList } from "./components.tsx";
import { editDiffLines, type DiffLine } from "./diff.ts";
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

const VERSION = "0.4.0";
const HISTORY_PATH = join(homedir(), ".config", "persoje", "history.json");

type DisplayItem =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string }
  | { kind: "tool"; id: number; name: string; argsPreview: string; note: string; isError: boolean; diff?: DiffLine[] }
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

/** Copy text to the clipboard via OSC52 — works locally and over SSH (iTerm). */
function osc52Copy(text: string): void {
  const b64 = Buffer.from(text).toString("base64");
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
}

/** Expand `@path` mentions in a prompt by inlining the (truncated) file contents. */
async function expandFileRefs(text: string, cwd: string): Promise<string> {
  const refs = [...new Set([...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map((m) => m[1]!))];
  if (refs.length === 0) return text;
  let appended = "";
  for (const ref of refs) {
    try {
      const f = Bun.file(resolve(cwd, ref.replace(/^~/, homedir())));
      if (await f.exists()) {
        const { text: clipped } = truncate(await f.text(), 2000);
        appended += `\n\n[@${ref}]\n${clipped}`;
      }
    } catch {
      /* unreadable — leave the literal @ref in the prompt */
    }
  }
  return appended ? text + appended : text;
}

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
  const [turnTools, setTurnTools] = useState(0);
  const [todos, setTodos] = useState<import("../tools/types.ts").TodoItem[]>([]);
  const [turnsOk, setTurnsOk] = useState(0);
  const [turnsFailed, setTurnsFailed] = useState(0);
  const [pickerSessions, setPickerSessions] = useState<import("../session/store.ts").SessionMeta[]>([]);
  const [pickerSelected, setPickerSelected] = useState(0);
  // /provider interactive flow: pick from a menu, then (if needed) type a URL or key.
  type ProvFlow =
    | { step: "pick"; items: ProviderMenuItem[] }
    | { step: "url" }
    | { step: "key"; preset: ProviderPreset };
  const [provFlow, setProvFlow] = useState<ProvFlow | null>(null);
  const [provSel, setProvSel] = useState(0);
  const [provInput, setProvInput] = useState("");
  // Generic single-choice menu overlay — backs the fixed-option commands
  // (/theme, /router, /autonomous). The pattern for "any input command → menu".
  type MenuOpt = { label: string; value: string; hint?: string };
  const [optMenu, setOptMenu] = useState<{ title: string; items: MenuOpt[]; onPick: (v: string) => void } | null>(null);
  const [optSel, setOptSel] = useState(0);
  const [activeTheme, setActiveTheme] = useState<Theme>(() => getTheme((config as any).theme?.name ?? "amber"));
  const [sessionTitle, setSessionTitle] = useState<string>(() => store.get(initialSession)?.title ?? "");
  const [greeted, setGreeted] = useState(false);
  const [cursorBlink, setCursorBlink] = useState(true);

  // Cursor blink every 530ms
  useEffect(() => {
    const t = setInterval(() => setCursorBlink((n) => !n), 530);
    return () => clearInterval(t);
  }, []);

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
  const toolDiffs = useRef(new Map<string, DiffLine[]>()); // call id → inline edit diff
  const lastTaskRef = useRef(""); // most recent user task, for /good /bad /retry
  const lastAssistantRef = useRef(""); // most recent assistant reply, for /copy
  const editedFilesRef = useRef(new Set<string>()); // files the agent wrote/edited, for /undo

  // The command menu is available even while a turn runs (so you can see and
  // fire the read-only commands); only an approval prompt suppresses it.
  const menuItems = !pending ? filterCommands(input) : [];
  const menuVisible = menuItems.length > 0;

  // Sync terminal title with session name
  useEffect(() => {
    process.title = sessionTitle ? `persoje · ${sessionTitle}` : "persoje";
    // Also set the xterm escape sequence for terminals that support it
    if (process.stdout.isTTY) {
      process.stdout.write(`\x1b]0;${process.title}\x07`);
    }
  }, [sessionTitle]);

  // Clean repaint on terminal resize. Ink under-clears full-width borders when
  // the terminal shrinks (the old, wider frame wraps and throws off its line
  // count), leaving stacked ghost boxes. Debounced clear-screen + remount fixes
  // it — the debounce means a drag-resize only repaints once it settles.
  // Bracketed paste: ask the terminal to wrap pasted text in markers so a
  // multi-line paste arrives as one chunk instead of a flurry of Enter presses.
  useEffect(() => {
    if (!process.stdout.isTTY) return;
    process.stdout.write("\x1b[?2004h");
    return () => {
      process.stdout.write("\x1b[?2004l");
    };
  }, []);

  const [resizeNonce, setResizeNonce] = useState(0);
  useEffect(() => {
    if (!process.stdout.isTTY) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // clear screen + scrollback
        setResizeNonce((n) => n + 1);
      }, 120);
    };
    process.stdout.on("resize", onResize);
    return () => {
      if (timer) clearTimeout(timer);
      process.stdout.off("resize", onResize);
    };
  }, []);

  const push = useCallback((item: DistOmit<DisplayItem, "id">) => {
    setItems((prev) => [...prev, { ...item, id: nextId++ } as DisplayItem]);
  }, []);

  // --- /provider switching (shared by `/provider <name>` and the interactive menu) ---
  // Rebuild the client so the switch takes effect THIS session — it was built once
  // at startup with the old provider's baseUrl. resetPrimerDetection re-probes /health
  // for the new endpoint (local → prefix-cache primer mode; else plain requests).
  const switchProvider = useCallback((name: string) => {
    config.activeProvider = name;
    void setActiveProvider(name).catch(() => {});
    try {
      const resolved = resolveProvider(config);
      agent.deps.client = new OpenRouterClient(resolved.apiKey, resolved.baseUrl, resolved.extraHeaders);
      if (resolved.model) agent.model = resolved.model;
      agent.resetPrimerDetection();
      push({ kind: "info", text: `▸ provider → ${name} · ${resolved.baseUrl}${resolved.model ? ` · ${agent.model}` : ""} (live this session)` });
    } catch (e: any) {
      push({ kind: "error", text: `provider "${name}" — ${e?.message ?? e}` });
    }
  }, [agent, config, push]);

  // Persist a provider entry, mirror it into the in-memory config, then switch.
  const materializeAndSwitch = useCallback((name: string, def: { baseUrl: string; apiKey?: string; apiKeyEnv?: string; model?: string }) => {
    if (!config.providers) (config as any).providers = {};
    (config.providers as any)[name] = { type: "openai-compat", ...def };
    void saveProvider(name, def).catch(() => {});
    switchProvider(name);
  }, [config, switchProvider]);

  // Menu selection → switch now, or advance to a URL / key prompt.
  const onPickProvider = useCallback((item: ProviderMenuItem) => {
    if (item.kind === "custom") { setProvFlow({ step: "url" }); setProvInput(""); return; }
    if (item.kind === "existing") { setProvFlow(null); switchProvider(item.name); return; }
    const p = item.preset;
    if (p.name === "openrouter") { setProvFlow(null); switchProvider("openrouter"); return; } // legacy block resolves
    if (presetHasKey(config, p)) {
      setProvFlow(null);
      materializeAndSwitch(p.name, { baseUrl: p.baseUrl, apiKeyEnv: p.apiKeyEnv, model: p.defaultModel });
      return;
    }
    setProvFlow({ step: "key", preset: p }); // no key in env/config → ask for one
    setProvInput("");
  }, [config, switchProvider, materializeAndSwitch]);

  // URL / key prompt submitted.
  const onSubmitProvText = useCallback((flow: ProvFlow, value: string) => {
    if (!value) { setProvFlow(null); setProvInput(""); return; }
    if (flow.step === "url") {
      // local endpoints usually need no auth ("local"); primer-detect probes /health
      // and enables prefix-cache mode for local URLs only, else falls back to plain requests.
      materializeAndSwitch(PRIMER_PROVIDER, { baseUrl: value, apiKey: "local" });
    } else if (flow.step === "key") {
      const p = flow.preset;
      materializeAndSwitch(p.name, { baseUrl: p.baseUrl, apiKey: value, model: p.defaultModel });
    }
    setProvFlow(null);
    setProvInput("");
  }, [materializeAndSwitch]);

  // Open the generic single-choice menu for a fixed-option command.
  const openMenu = useCallback((title: string, items: MenuOpt[], onPick: (v: string) => void) => {
    setOptMenu({ title, items, onPick });
    setOptSel(0);
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

  // Live tool progress (e.g. bash stdout tail) → spinner label.
  useEffect(() => {
    agent.setToolProgress((name, line) => setBusyLabel(`${name}: ${line}`));
  }, [agent]);

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

      // Emit router event to the stream (for history rendering)
      agent.deps?.onRouterEvent?.({
        message: esc.reason,
        target: esc.target,
        mode: router.mode,
        currentModel: model,
      });

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

  // Wire onRouterEvent: pre-canary the escalation target ONLY on an actual
  // auto-switch. In "offer" mode the user hasn't adopted the model yet (/model
  // canaries it when they switch), so we don't spend tokens probing a model
  // they may never use. Dedup via the canaried Set; never canary the current model.
  useEffect(() => {
    agent.deps.onRouterEvent = async (event) => {
      if (
        event.mode === "auto" &&
        event.target &&
        event.target !== event.currentModel &&
        !canaried.current.has(event.target)
      ) {
        void maybeCanary(event.target, false);
      }
    };
  }, [agent, maybeCanary]);

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

  // Reflexion: turn a failure or a user correction into a real lesson + model
  // quirk, via the cheap model. Shared by auto-failure handling and /bad.
  const learnFromTurn = useCallback(
    async (task: string, error: string, problem: string) => {
      try {
        const { lesson, quirk } = await agent.reflect(problem);
        if (lesson) {
          lessons.append({ task: task.slice(0, 120), error, lesson, model: agent.model });
          push({ kind: "info", text: `📝 learned: ${lesson}` });
        }
        if (quirk) {
          profiles.addQuirk(agent.model, quirk);
          facts.addQuirk(agent.model, quirk);
          push({ kind: "info", text: `🧠 noted about ${agent.model}: ${quirk}` });
        }
      } catch {
        /* reflection is best-effort */
      }
    },
    [agent, lessons, profiles, facts, push],
  );

  const runTurn = useCallback(
    async (task: string) => {
      setBusy(true);
      setBusyLabel("thinking");
      setBusyStart(Date.now());
      push({ kind: "user", text: task });
      lastTaskRef.current = task;
      store.maybeSetTitle(sessionId, task);
      // Update session title state for terminal header + banner
      const meta = store.get(sessionId);
      if (meta?.title) setSessionTitle(meta.title);
      const controller = new AbortController();
      abortRef.current = controller;

      // Inline @file references (display showed the original task above).
      const prompt = await expandFileRefs(task, cwd);

      try {
        for await (const ev of agent.run(prompt, controller.signal)) {
          switch (ev.type) {
            case "turn-start":
              setTurnIterations(ev.turn); // real model rounds, distinct from tool count
              break;
            case "text-delta":
              streamBuf.current += ev.delta;
              break;
            case "text-end":
              streamBuf.current = "";
              setStream("");
              push({ kind: "assistant", text: ev.text });
              lastAssistantRef.current = ev.text; // for /copy
              break;
            case "tool-start": {
              const preview = compactArgs(ev.name, ev.args);
              toolArgs.current.set(ev.id, preview);
              setBusyLabel(`${ev.name}(${preview})`);
              setTurnTools((n) => n + 1);
              // Track files the agent changed, for /undo.
              if ((ev.name === "write" || ev.name === "edit" || ev.name === "multi_edit") && typeof ev.args.path === "string") {
                editedFilesRef.current.add(ev.args.path);
              }
              // Stash an inline diff for edits — rendered under the tool row,
              // never sent to the model (it already wrote the change).
              if (ev.name === "edit" && typeof ev.args.old_string === "string" && typeof ev.args.new_string === "string") {
                toolDiffs.current.set(ev.id, editDiffLines(ev.args.old_string, ev.args.new_string));
              } else if (ev.name === "multi_edit" && Array.isArray(ev.args.edits)) {
                // Concatenate each edit's diff, separated by a faint rule.
                const lines: DiffLine[] = [];
                (ev.args.edits as Array<{ old_string?: unknown; new_string?: unknown }>).forEach((e, i) => {
                  if (typeof e.old_string === "string" && typeof e.new_string === "string") {
                    if (i > 0) lines.push({ sign: " ", text: "─" });
                    lines.push(...editDiffLines(e.old_string, e.new_string, 6));
                  }
                });
                if (lines.length) toolDiffs.current.set(ev.id, lines);
              }
              break;
            }
            case "tool-result": {
              setBusyLabel("thinking");
              const lines = ev.result.split("\n").length;
              const diff = !ev.isError ? toolDiffs.current.get(ev.id) : undefined;
              toolDiffs.current.delete(ev.id);
              push({
                kind: "tool",
                name: ev.name,
                argsPreview: toolArgs.current.get(ev.id) ?? "",
                note: ev.isError
                  ? ev.result.split("\n")[0]!.slice(0, 110)
                  : `${lines} line${lines === 1 ? "" : "s"}${ev.truncated ? " (truncated)" : ""} · ${ev.durationMs}ms`,
                isError: ev.isError,
                diff,
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
            case "todos":
              setTodos(ev.items);
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
              setTurnTools(0);
              if (ev.reason === "done") {
                // Success: confirm any recalled skills as actually useful (ties
                // useCount/pruning to outcome) and count it toward effectiveness.
                const used = skills.confirmInjectedUsed();
                if (used.length) push({ kind: "info", text: `↑ used skill: ${used.join(", ")}` });
                setTurnsOk((n) => n + 1);
              }
              // Failed turns get a real reflexion lesson (not telemetry), plus a
              // model quirk if the model itself misbehaved. `persoje dream` curates later.
              if (ev.reason === "max-iterations" || ev.reason === "error") {
                setTurnsFailed((n) => n + 1);
                const problem =
                  ev.reason === "max-iterations"
                    ? `ran ${ev.iterations} iterations without finishing the task`
                    : "the turn errored out";
                void learnFromTurn(task, ev.reason, problem);
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
    [agent, learnFromTurn, push, sessionId, store, skills],
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
            push({ kind: "info", text: `model → ${rest[0]} (this session; /dmodel to make it the default)` });
            void maybeCanary(rest[0]);
          } else {
            const p = profiles.get(agent.model);
            const canary = p.canary ? ` · canary ${p.canary.score}/${p.canary.total}` : " · not canaried";
            push({ kind: "info", text: `model: ${agent.model} (${p.toolQuality}${canary})` });
          }
          break;
        case "/dmodel":
          if (!rest[0]) {
            push({ kind: "info", text: `default model: ${config.model.primary} — usage: /dmodel <id> to change it for all new sessions` });
            break;
          }
          agent.model = rest[0]; // apply now too
          void setDefaultModel(rest[0]).then(
            () => push({ kind: "info", text: `default model → ${rest[0]} (saved; used in every new session)` }),
            (e) => push({ kind: "error", text: `couldn't save default: ${(e as Error).message}` }),
          );
          void maybeCanary(rest[0]);
          break;
        case "/recap":
          push({ kind: "info", text: "recapping…" });
          void agent.recap().then(
            (r) => push({ kind: "info", text: r }),
            (e) => push({ kind: "error", text: `recap failed: ${(e as Error).message}` }),
          );
          break;
        case "/retry":
          if (!lastTaskRef.current) {
            push({ kind: "info", text: "nothing to retry yet" });
            break;
          }
          push({ kind: "info", text: `retrying: ${lastTaskRef.current.slice(0, 60)}` });
          void runTurn(lastTaskRef.current);
          break;
        case "/copy": {
          const last = lastAssistantRef.current;
          if (!last) {
            push({ kind: "info", text: "nothing to copy yet" });
            break;
          }
          const blocks = [...last.matchAll(/```[\w-]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
          const text = rest[0] === "code" && blocks.length ? blocks[blocks.length - 1]! : last;
          osc52Copy(text);
          push({ kind: "info", text: `📋 copied ${text.length} chars${rest[0] === "code" ? " (last code block)" : ""} to clipboard` });
          break;
        }
        case "/diff": {
          const isRepo = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"]).exitCode === 0;
          if (!isRepo) {
            push({ kind: "info", text: "not a git repo — nothing to diff" });
            break;
          }
          const stat = new TextDecoder().decode(Bun.spawnSync(["git", "-C", cwd, "diff", "--stat"]).stdout).trim();
          const full = new TextDecoder().decode(Bun.spawnSync(["git", "-C", cwd, "diff"]).stdout);
          push({
            kind: "info",
            text: stat ? `${stat}\n\n${truncate(full, 1500).text}` : "no uncommitted changes",
          });
          break;
        }
        case "/models": {
          const filter = rest.join(" ").toLowerCase();
          push({ kind: "info", text: "fetching model catalog…" });
          void client.catalog().then(
            (cat) => {
              let list = cat.filter((m) => m.tools);
              if (filter) list = list.filter((m) => m.id.toLowerCase().includes(filter));
              list.sort((a, b) => a.inPrice - b.inPrice);
              const lines = list
                .slice(0, 25)
                .map((m) => `  ${m.id}  ${m.inPrice === 0 ? "free" : "$" + m.inPrice.toFixed(2) + "/M"} · ${Math.round(m.context / 1000)}k ctx`);
              push({
                kind: "info",
                text: lines.length
                  ? `tool-capable models${filter ? ` matching "${filter}"` : ""} (cheapest first) — /dmodel <id> to set:\n${lines.join("\n")}`
                  : `no tool-capable models matched "${filter}"`,
              });
            },
            () => push({ kind: "error", text: "couldn't fetch the model catalog" }),
          );
          break;
        }
        case "/undo": {
          const files = [...editedFilesRef.current];
          if (!files.length) {
            push({ kind: "info", text: "no files edited this session" });
            break;
          }
          if (Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"]).exitCode !== 0) {
            push({ kind: "error", text: "/undo needs a git repo to restore from" });
            break;
          }
          const restored: string[] = [];
          const skipped: string[] = [];
          for (const f of files) {
            const tracked = Bun.spawnSync(["git", "-C", cwd, "ls-files", "--error-unmatch", "--", f]).exitCode === 0;
            if (tracked) {
              Bun.spawnSync(["git", "-C", cwd, "checkout", "HEAD", "--", f]);
              restored.push(f);
            } else {
              skipped.push(f);
            }
          }
          editedFilesRef.current.clear();
          push({
            kind: "info",
            text: `↩ reverted ${restored.length} file(s) to HEAD${skipped.length ? `; left ${skipped.length} new/untracked (delete manually): ${skipped.join(", ")}` : ""}`,
          });
          break;
        }
        case "/router": {
          const apply = (v: string) => {
            if (v === "on") router.enabled = true;
            else if (v === "off") router.enabled = false;
            else if (v === "auto" || v === "offer") router.mode = v;
            push({ kind: "info", text: `router: ${router.enabled ? "on" : "off"} · mode: ${router.mode}` });
          };
          if (!rest[0]) {
            openMenu("model routing", [
              { label: "on", value: "on", hint: "routing & escalation" },
              { label: "off", value: "off", hint: "pin current model" },
              { label: "auto", value: "auto", hint: "escalate automatically" },
              { label: "offer", value: "offer", hint: "ask before escalating" },
            ], apply);
            break;
          }
          apply(rest[0]);
          break;
        }
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
        case "/budget": {
          const arg = (rest[0] ?? "").toLowerCase();
          const cur = config.loop.maxCostUsd ?? 0;
          const spent = agent.accounting.totals().cost;
          if (!arg) {
            push({
              kind: "info",
              text:
                cur > 0
                  ? `cost ceiling: $${cur.toFixed(2)} · spent this session: ${fmtCost(spent)} (${Math.round((spent / cur) * 100)}%)\nthe turn halts when spend hits the ceiling — /budget <usd> to change, /budget off to disable`
                  : `no cost ceiling set (unlimited) · spent this session: ${fmtCost(spent)}\n/budget <usd> sets a hard cap that halts the turn when reached`,
            });
            break;
          }
          const next = arg === "off" || arg === "0" ? 0 : Number(arg.replace(/^\$/, ""));
          if (!Number.isFinite(next) || next < 0) {
            push({ kind: "error", text: `invalid amount "${rest[0]}" — usage: /budget 5  or  /budget off` });
            break;
          }
          config.loop.maxCostUsd = next;
          void setConfigValue("loop", "maxCostUsd", next).catch(() => {});
          push({
            kind: "info",
            text: next > 0 ? `▸ cost ceiling → $${next.toFixed(2)} (saved)` : "▸ cost ceiling disabled (unlimited, saved)",
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
              `session    ${sessionId} · ~${stats.totalTokens} tok (msgs) · ${stats.schemaTokens} tok (schemas) · ${fmtCost(t.cost)}`,
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
          setTodos([]);
          push({ kind: "info", text: "history cleared" });
          break;
        case "/bad": {
          // strongest learning signal: a human says the last turn was wrong.
          const why = rest.join(" ").trim();
          push({ kind: "info", text: "reflecting on what went wrong…" });
          void learnFromTurn(lastTaskRef.current, "user-flagged", why || "the user said the last response was wrong or unhelpful");
          break;
        }
        case "/good": {
          // positive signal — record what worked so `dream` can promote it.
          const note = rest.join(" ").trim();
          lessons.append({
            task: lastTaskRef.current.slice(0, 120),
            error: "success",
            lesson: `worked${note ? " (" + note + ")" : ""}: ${lastTaskRef.current.slice(0, 100)}`,
            model: agent.model,
          });
          push({ kind: "info", text: "👍 noted — saved as a positive signal for the next dream pass" });
          break;
        }
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
        case "/stats": {
          // Is self-improvement actually paying off? Show recall → outcome.
          const all = lessons.all();
          const wins = all.filter((l) => l.error === "success").length;
          const losses = all.length - wins;
          const sk = skills.list().sort((a, b) => b.useCount - a.useCount);
          const usedSkills = sk.filter((s) => s.useCount > 0);
          const factCount = facts.index().split("\n").filter((l) => l.trim().startsWith("- [")).length;
          const lines = [
            `this session   ${turnsOk} ok · ${turnsFailed} failed`,
            `memory         ${factCount} facts · ${all.length} lessons (${wins} worked / ${losses} from failures)`,
            `skills         ${sk.length} total · ${usedSkills.length} have earned their keep`,
          ];
          if (sk.length) {
            lines.push("");
            for (const s of sk.slice(0, 8)) lines.push(`  ${s.useCount}× /${s.name}${s.useCount === 0 ? " (unused — prunes after 30d)" : ""}`);
          }
          push({ kind: "info", text: lines.join("\n") });
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
                judgeModel: (config as any).model?.judge || undefined,
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
        case "/provider": {
          const name = rest[0];
          if (!name) {
            setProvFlow({ step: "pick", items: buildProviderMenu(config) }); // interactive menu
            setProvSel(0);
            break;
          }
          // Direct switch by name. Materialize a known preset (so its baseUrl/model resolve)
          // if it isn't configured yet and a key is reachable.
          const preset = BUILTIN_PROVIDERS.find((p) => p.name === name);
          const configured = !!config.providers?.[name] || name === "openrouter";
          if (preset && preset.name !== "openrouter" && !configured) {
            if (!presetHasKey(config, preset)) {
              push({ kind: "error", text: `no key for "${name}" — set ${preset.apiKeyEnv} or run /provider (menu) to enter one` });
              break;
            }
            materializeAndSwitch(name, { baseUrl: preset.baseUrl, apiKeyEnv: preset.apiKeyEnv, model: preset.defaultModel });
            break;
          }
          if (!configured) {
            const available = [...new Set([...BUILTIN_PROVIDERS.map((p) => p.name), ...Object.keys(config.providers ?? {})])];
            push({ kind: "error", text: `unknown provider "${name}" — try: ${available.join(", ")} (or /provider for the menu)` });
            break;
          }
          switchProvider(name);
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
          const run = (sub: string) =>
            void import("../core/autonomous.ts")
              .then(({ autonomousCmd }) => autonomousCmd(sub, { push, alwaysAllow, exit, sessionId, goal: agent.goal }))
              .catch((e) => push({ kind: "error", text: `autonomous: ${(e as Error).message}` }));
          if (!rest[0]) {
            openMenu("autonomous mode", [
              { label: "on", value: "on", hint: "persist across disconnect" },
              { label: "off", value: "off" },
              { label: "status", value: "status", hint: "show current state" },
            ], run);
            break;
          }
          run(rest[0]);
          break;
        }
        case "/theme": {
          const apply = (name: string) => {
            if (!themeNames.includes(name)) {
              push({ kind: "error", text: `unknown theme "${name}" — available: ${themeNames.join(", ")}` });
              return;
            }
            if (!(config as any).theme) (config as any).theme = {};
            (config as any).theme.name = name;
            setActiveTheme(getTheme(name));
            void setConfigValue("theme", "name", name).catch(() => {});
            push({ kind: "info", text: `▸ theme → ${name} (saved)` });
          };
          const name = rest[0];
          if (!name) {
            const cur = (config as any).theme?.name ?? "amber";
            openMenu("switch theme", themeNames.map((n) => ({ label: n, value: n, hint: n === cur ? "current" : undefined })), apply);
            break;
          }
          apply(name);
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
    [agent, client, config, cwd, exit, facts, lessons, learnFromTurn, maybeCanary, profiles, push, router, runTurn, sessionId, skills, store, mcp],
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

    // Provider flow: pick a provider, or type a custom URL / API key.
    if (provFlow) {
      if (provFlow.step === "pick") {
        const items = provFlow.items;
        if (key.upArrow) { setProvSel((s) => (s - 1 + items.length) % items.length); return; }
        if (key.downArrow) { setProvSel((s) => (s + 1) % items.length); return; }
        if (key.escape) { setProvFlow(null); setProvSel(0); return; }
        if (key.return) { onPickProvider(items[Math.min(provSel, items.length - 1)]!); return; }
        return; // swallow other keys while the menu is open
      }
      // text step (custom URL / API key)
      if (key.escape) { setProvFlow(null); setProvInput(""); return; }
      if (key.return) { onSubmitProvText(provFlow, provInput.trim()); return; }
      if (key.backspace || key.delete) { setProvInput((v) => v.slice(0, -1)); return; }
      if (char && !key.ctrl && !key.meta) { setProvInput((v) => v + char.replace(/\x1b\[20[01]~/g, "")); return; }
      return;
    }

    // Generic single-choice menu (theme / router / autonomous).
    if (optMenu) {
      const n = optMenu.items.length;
      if (key.upArrow) { setOptSel((s) => (s - 1 + n) % n); return; }
      if (key.downArrow) { setOptSel((s) => (s + 1) % n); return; }
      if (key.escape) { setOptMenu(null); return; }
      if (key.return) { const it = optMenu.items[Math.min(optSel, n - 1)]!; setOptMenu(null); optMenu.onPick(it.value); return; }
      return; // swallow other keys while open
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
        // Read-only commands run immediately mid-turn; everything else queues.
        if (line.startsWith("/")) {
          const cmd = line.split(/\s+/)[0]!;
          if (LIVE_SAFE.has(cmd)) {
            handleCommand(line);
            return;
          }
          setQueue((q) => [...q, line]);
          push({ kind: "info", text: `queued (runs after turn): ${cmd}` });
          return;
        }
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
      // Option/Alt+Enter, or a trailing backslash, inserts a newline instead of
      // submitting — so you can write multi-line prompts.
      if (key.meta) {
        setInput((v) => v + "\n");
        return;
      }
      if (input.endsWith("\\")) {
        setInput((v) => v.slice(0, -1) + "\n");
        return;
      }
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
        // wrap to bottom when going up past the top
        setMenuSelected((s) => (s - 1 + menuItems.length) % menuItems.length);
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
        // wrap to top when going down past the bottom
        setMenuSelected((s) => (s + 1) % menuItems.length);
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
      // Strip bracketed-paste markers. A chunk that still contains newlines is a
      // multi-line paste — insert it whole (preserving the newlines) rather than
      // submitting line-by-line, which used to mangle pasted code.
      const cleaned = char.replace(/\x1b\[20[01]~/g, "");
      if (!cleaned) return;
      if (cleaned.includes("\n") || cleaned.includes("\r")) {
        setInput((v) => v + cleaned.replace(/\r\n?/g, "\n"));
      } else {
        setInput((v) => v + cleaned);
        setMenuSelected(0);
      }
    }
  });

  return (
    // key on resizeNonce → remount + repaint the whole tree (incl. Static) at
    // the new width after a resize, so no ghost frames are left behind.
    <Box flexDirection="column" key={resizeNonce}>
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
                sessionTitle={sessionTitle || undefined}
                activeTheme={activeTheme}
              />
            );
          }
          switch (item.kind) {
            case "user":
              return (
                <Box key={item.id}>
                  <Text color={activeTheme.accent}>{"▸ "}</Text>
                  <Text>{item.text}</Text>
                </Box>
              );
            case "assistant":
              return <AssistantBlock key={item.id} body={<Text>{renderMarkdown(item.text)}</Text>} />;
            case "tool":
              // Dense scannable row: icon · name(args) · result
              return item.isError ? (
                <Box key={item.id} flexDirection="column">
                  <Text>
                    <Text color={activeTheme.err}>◆ </Text>
                    <Text bold>{item.name}</Text>
                    <Text dimColor>({item.argsPreview})</Text>
                  </Text>
                  <Text color={activeTheme.err}>  {item.note}</Text>
                </Box>
              ) : (
                <Box key={item.id} flexDirection="column">
                  <Box>
                    <Text color={activeTheme.accent}>{TOOL_ICON[item.name] ?? "▸"} </Text>
                    <Text>{item.name}</Text>
                    <Text dimColor>({item.argsPreview}) </Text>
                    <Text dimColor>{item.note}</Text>
                  </Box>
                  {item.diff && item.diff.length > 0
                    ? item.diff.map((d, di) => (
                        <Text
                          key={di}
                          color={d.sign === "+" ? activeTheme.ok : d.sign === "-" ? activeTheme.err : undefined}
                          dimColor={d.sign === " "}
                        >
                          {"    "}
                          {d.sign}
                          {d.sign === " " ? "" : " "}
                          {d.text}
                        </Text>
                      ))
                    : null}
                </Box>
              );
            case "info":
              return (
                <Box key={item.id}>
                  <Text dimColor>{item.text}</Text>
                </Box>
              );
            case "error":
              return (
                <Box key={item.id}>
                  <Text color={activeTheme.err}>✗ {item.text}</Text>
                </Box>
              );
          }
        }}
      </Static>

      {stream ? (
        <Box>
          <Text>{stream}</Text>
        </Box>
      ) : null}
      {busy ? <Spinner detail={busyLabel === "thinking" ? undefined : busyLabel} startedAt={busyStart} /> : null}

      {pending ? <ApprovalPrompt name={pending.name} args={pending.args} dangerReason={pending.dangerReason} /> : null}

      <TodoList items={todos} activeTheme={activeTheme} />

      {!pending ? (
        <Box flexDirection="column">
          <Box>
            <Text color={activeTheme.accent}>{"▸ "}</Text>
            {input ? <Text>{input}</Text> : <Text dimColor>{busy ? "type to queue…" : "task, or / for commands"}</Text>}
            <Text color={cursorBlink ? activeTheme.accent : "transparent"}>▌</Text>
          </Box>
          {menuVisible ? (
            <CommandMenu items={menuItems} selected={menuSelected} />
          ) : provFlow ? (
            <Box flexDirection="column" marginLeft={2} marginTop={1}>
              {provFlow.step === "pick" ? (
                <>
                  <Text color={activeTheme.accent} bold>choose provider  <Text dimColor>(↑↓ navigate · ↵ select · esc cancel)</Text></Text>
                  {provFlow.items.map((it, i) => {
                    const selected = i === provSel;
                    const keyStr = it.kind === "preset" ? it.preset.name : it.kind === "existing" ? it.name : "custom";
                    return (
                      <Text key={keyStr}>
                        <Text color={selected ? activeTheme.accent : "gray"}>{selected ? "▸ " : "  "}</Text>
                        <Text color={selected ? activeTheme.accent : undefined}>{it.label}</Text>
                      </Text>
                    );
                  })}
                </>
              ) : (
                <>
                  <Text color={activeTheme.accent} bold>
                    {provFlow.step === "url" ? "primer / custom endpoint URL" : `API key for ${provFlow.preset.name}`}
                    <Text dimColor>  (↵ save · esc cancel)</Text>
                  </Text>
                  <Text>
                    <Text color={activeTheme.accent}>{"▸ "}</Text>
                    {provFlow.step === "key" ? (
                      <Text>{"•".repeat(provInput.length)}</Text>
                    ) : provInput ? (
                      <Text>{provInput}</Text>
                    ) : (
                      <Text dimColor>http://localhost:8000/v1</Text>
                    )}
                    <Text color={activeTheme.accent}>▌</Text>
                  </Text>
                </>
              )}
            </Box>
          ) : optMenu ? (
            <Box flexDirection="column" marginLeft={2} marginTop={1}>
              <Text color={activeTheme.accent} bold>{optMenu.title}  <Text dimColor>(↑↓ navigate · ↵ select · esc cancel)</Text></Text>
              {optMenu.items.map((it, i) => {
                const sel = i === optSel;
                return (
                  <Text key={it.value}>
                    <Text color={sel ? activeTheme.accent : "gray"}>{sel ? "▸ " : "  "}</Text>
                    <Text color={sel ? activeTheme.accent : undefined}>{it.label}</Text>
                    {it.hint ? <Text dimColor>  {it.hint}</Text> : null}
                  </Text>
                );
              })}
            </Box>
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
              ctxUsed={agent.context.effectiveTokens()}
              ctxBudget={modelWindows.get(agent.model) ?? config.context.budgetTokens}
              cost={statusCost}
              busy={busy}
              turnStart={busyStart}
              queued={queue.length}
              routerOff={!router.enabled}
              iterations={turnIterations}
              toolsThisTurn={turnTools}
              cacheHit={agent.context.cacheHitRatio}
              schemasTokens={agent.context.buildStats().schemaTokens}
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
