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
import { Banner, Spinner, CommandMenu, ApprovalPrompt } from "./components.tsx";

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

interface PendingApproval {
  name: string;
  args: Record<string, unknown>;
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
}

function fmtCost(cost: number): string {
  return cost < 0.01 ? `$${cost.toFixed(5)}` : `$${cost.toFixed(3)}`;
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
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [sessionId, setSessionId] = useState(initialSession);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [stream, setStream] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("thinking");
  const [busyStart, setBusyStart] = useState(Date.now());
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [menuSelected, setMenuSelected] = useState(0);
  const [queue, setQueue] = useState<string[]>([]);
  const [statusCost, setStatusCost] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const alwaysAllow = useRef(new Set<string>());
  const streamBuf = useRef("");
  const toolArgs = useRef(new Map<string, string>()); // call id → args preview

  const menuItems = !busy && !pending ? filterCommands(input) : [];
  const menuVisible = menuItems.length > 0;

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

  // Approval hook: pause the agent until the user answers y/n/a.
  useEffect(() => {
    agent.setApprover(async (name, args) => {
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
            case "error":
              push({ kind: "error", text: ev.message });
              break;
            case "turn-end":
              if (ev.reason === "max-iterations") push({ kind: "info", text: `stopped after ${ev.iterations} iterations` });
              if (ev.reason === "cancelled") push({ kind: "info", text: "turn cancelled" });
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
          push({
            kind: "info",
            text: [
              `model      ${agent.model} (${p.toolQuality}${p.canary ? `, canary ${p.canary.score}/${p.canary.total}` : ""})`,
              `router     ${router.enabled ? "on" : "off"} · ${router.mode} · ${router.failureCount(agent.model)} recent failures`,
              `session    ${sessionId} · ~${agent.context.estimateTokensUsed()} tok history · ${fmtCost(t.cost)}`,
              `memory     ${factCount} facts · ${lessons.recent(100).length} lessons · ${skills.list().length} skills`,
              `repo-map   ${agent.repoMap ? `~${Math.ceil(agent.repoMap.length / 4)} tok` : "none"}`,
              `config     ~/.config/persoje/config.json · budget ${config.context.budgetTokens} tok`,
            ].join("\n"),
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
        case "/sessions": {
          const sessions = store.list(cwd, 10);
          push({
            kind: "info",
            text:
              sessions.length === 0
                ? "no sessions in this directory"
                : sessions.map((s) => `${s.id}  ${s.title || "(untitled)"}  ${s.messageCount} msgs  ${fmtCost(s.totalCost)}`).join("\n"),
          });
          break;
        }
        case "/resume": {
          const id = rest[0];
          if (!id) {
            push({ kind: "info", text: "usage: /resume <session-id> (see /sessions)" });
            break;
          }
          const meta = store.get(id);
          if (!meta) {
            push({ kind: "error", text: `no session ${id}` });
            break;
          }
          agent.context.restore(store.loadMessages(id));
          setSessionId(id);
          push({ kind: "info", text: `resumed ${id} (${meta.messageCount} messages, ~${agent.context.estimateTokensUsed()} tok)` });
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
        default:
          push({ kind: "info", text: `unknown command ${cmd} — /help` });
      }
    },
    [agent, client, config, cwd, exit, facts, lessons, maybeCanary, profiles, push, router, runTurn, sessionId, skills, store],
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
              />
            );
          }
          switch (item.kind) {
            case "user":
              return (
                <Box key={item.id} marginTop={1}>
                  <Text color="cyan" bold>
                    › {item.text}
                  </Text>
                </Box>
              );
            case "assistant":
              return (
                <Box key={item.id} marginTop={1} flexDirection="column">
                  <Text>{renderMarkdown(item.text)}</Text>
                </Box>
              );
            case "tool":
              return (
                <Box key={item.id} flexDirection="column">
                  <Text>
                    <Text color={item.isError ? "red" : "green"}>⏺ </Text>
                    <Text bold>{item.name}</Text>
                    <Text dimColor>({item.argsPreview})</Text>
                  </Text>
                  <Text dimColor={!item.isError} color={item.isError ? "red" : undefined}>
                    {"  ⎿ "}
                    {item.note}
                  </Text>
                </Box>
              );
            case "info":
              return (
                <Text key={item.id} dimColor>
                  {item.text}
                </Text>
              );
            case "error":
              return (
                <Text key={item.id} color="red">
                  ✗ {item.text}
                </Text>
              );
          }
        }}
      </Static>

      {stream ? <Text>{stream}</Text> : null}
      {busy ? <Spinner label={busyLabel} startedAt={busyStart} /> : null}

      {pending ? <ApprovalPrompt name={pending.name} args={pending.args} /> : null}

      {!pending ? (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor={busy ? "gray" : "cyan"} paddingX={1}>
            <Text color="cyan">› </Text>
            {input ? <Text>{input}</Text> : <Text dimColor>{busy ? "type to queue a message…" : "task, or / for commands"}</Text>}
            <Text inverse> </Text>
          </Box>
          {menuVisible ? <CommandMenu items={menuItems} selected={menuSelected} /> : null}
        </Box>
      ) : null}

      <Box>
        <Text dimColor>
          {agent.model} · {sessionId} · ~{agent.context.estimateTokensUsed()} tok · {fmtCost(statusCost)}
          {router.enabled ? "" : " · router off"}
          {queue.length ? ` · ${queue.length} queued` : ""}
        </Text>
      </Box>
    </Box>
  );
}
