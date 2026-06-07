import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import type { Agent } from "../core/agent.ts";
import type { SessionStore } from "../session/store.ts";
import { renderMarkdown } from "./markdown.ts";

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
}

function fmtCost(cost: number): string {
  return cost < 0.01 ? `$${cost.toFixed(5)}` : `$${cost.toFixed(3)}`;
}

function argsPreview(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
}

const HELP = `commands:
  /model [id]    show or switch model
  /cost          session totals
  /sessions      recent sessions in this directory
  /resume <id>   resume a session
  /clear         clear history
  /exit          quit
keys: enter send · up/down history · esc cancel turn · y/n/a on permission prompts`;

let nextId = 1;

export function App({ agent, store, sessionId: initialSession, cwd }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [sessionId, setSessionId] = useState(initialSession);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [stream, setStream] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [statusCost, setStatusCost] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const alwaysAllow = useRef(new Set<string>());
  const streamBuf = useRef("");
  const flushTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const push = useCallback((item: DistOmit<DisplayItem, "id">) => {
    setItems((prev) => [...prev, { ...item, id: nextId++ } as DisplayItem]);
  }, []);

  // Approval hook: pause the agent until the user answers y/n/a.
  useEffect(() => {
    agent.setApprover(async (name, args) => {
      if (alwaysAllow.current.has(name)) return true;
      return new Promise<boolean>((resolve) => setPending({ name, args, resolve }));
    });
  }, [agent]);

  // Batch streaming deltas: flush at 80ms so Ink isn't re-rendering per token.
  useEffect(() => {
    flushTimer.current = setInterval(() => {
      if (streamBuf.current) {
        const chunk = streamBuf.current;
        streamBuf.current = "";
        setStream((s) => s + chunk);
      }
    }, 80);
    return () => {
      if (flushTimer.current) clearInterval(flushTimer.current);
    };
  }, []);

  const runTurn = useCallback(
    async (text: string) => {
      setBusy(true);
      push({ kind: "user", text });
      store.maybeSetTitle(sessionId, text);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        for await (const ev of agent.run(text, controller.signal)) {
          switch (ev.type) {
            case "text-delta":
              streamBuf.current += ev.delta;
              break;
            case "text-end":
              streamBuf.current = "";
              setStream("");
              push({ kind: "assistant", text: ev.text });
              break;
            case "tool-start":
              setActiveTool(ev.name);
              break;
            case "tool-result": {
              setActiveTool(null);
              const lines = ev.result.split("\n").length;
              push({
                kind: "tool",
                name: ev.name,
                argsPreview: "",
                note: ev.isError
                  ? ev.result.split("\n")[0]!.slice(0, 100)
                  : `${lines} line${lines === 1 ? "" : "s"}${ev.truncated ? " (truncated)" : ""} · ${ev.durationMs}ms`,
                isError: ev.isError,
              });
              break;
            }
            case "usage":
              store.recordUsage(sessionId, ev.usage);
              setStatusCost(agent.accounting.totals().cost);
              break;
            case "error":
              push({ kind: "error", text: ev.message });
              break;
            case "turn-end":
              if (ev.reason === "max-iterations") push({ kind: "info", text: `stopped after ${ev.iterations} iterations` });
              if (ev.reason === "cancelled") push({ kind: "info", text: "turn cancelled" });
              break;
          }
        }
      } finally {
        streamBuf.current = "";
        setStream("");
        setActiveTool(null);
        setBusy(false);
        abortRef.current = null;
      }
    },
    [agent, push, sessionId, store],
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
          push({ kind: "info", text: HELP });
          break;
        case "/model":
          if (rest[0]) {
            agent.model = rest[0];
            push({ kind: "info", text: `model → ${rest[0]}` });
          } else {
            push({ kind: "info", text: `model: ${agent.model}` });
          }
          break;
        case "/cost": {
          const t = agent.accounting.totals();
          push({
            kind: "info",
            text: `calls: ${t.calls} · in: ${t.inputTokens} · out: ${t.outputTokens} · cached: ${t.cachedTokens} · cost: ${fmtCost(t.cost)}\nhistory: ~${agent.context.estimateTokensUsed()} tok`,
          });
          break;
        }
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
        case "/clear":
          agent.context.clear();
          push({ kind: "info", text: "history cleared" });
          break;
        default:
          push({ kind: "info", text: `unknown command ${cmd} — /help` });
      }
    },
    [agent, cwd, exit, push, store],
  );

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

    if (busy) {
      if (key.escape) abortRef.current?.abort();
      return;
    }

    const submit = (raw: string) => {
      const line = raw.trim();
      setInput("");
      setHistoryIdx(-1);
      if (!line) return;
      setHistory((h) => [line, ...h].slice(0, 100));
      if (line.startsWith("/")) handleCommand(line);
      else void runTurn(line);
    };

    if (key.return) {
      submit(input);
      return;
    }
    if (key.upArrow) {
      const idx = Math.min(historyIdx + 1, history.length - 1);
      if (history[idx] !== undefined) {
        setHistoryIdx(idx);
        setInput(history[idx]!);
      }
      return;
    }
    if (key.downArrow) {
      const idx = historyIdx - 1;
      setHistoryIdx(idx);
      setInput(idx >= 0 ? (history[idx] ?? "") : "");
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }
    if (key.escape) {
      setInput("");
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
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) => {
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
                <Text key={item.id} dimColor={!item.isError} color={item.isError ? "red" : undefined}>
                  {"  "}⚙ {item.name} → {item.note}
                </Text>
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
      {activeTool ? <Text dimColor>⚙ {activeTool}…</Text> : null}

      {pending ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text color="yellow" bold>
            {pending.name} wants to run:
          </Text>
          <Text>{argsPreview(pending.args)}</Text>
          <Text dimColor>[y] allow · [n] deny · [a] always allow {pending.name} this session</Text>
        </Box>
      ) : null}

      {!busy && !pending ? (
        <Box>
          <Text color="cyan">› </Text>
          <Text>{input}</Text>
          <Text inverse> </Text>
        </Box>
      ) : null}

      <Box marginTop={busy ? 1 : 0}>
        <Text dimColor>
          {agent.model} · {sessionId} · ~{agent.context.estimateTokensUsed()} tok · {fmtCost(statusCost)}
          {busy ? " · esc to cancel" : ""}
        </Text>
      </Box>
    </Box>
  );
}
