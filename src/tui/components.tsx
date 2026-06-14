import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { CommandMeta } from "./commands.ts";
import type { TodoItem } from "../tools/types.ts";
import { theme, getTheme, type Theme } from "./theme.ts";

/** The agent's live working plan — a compact checklist above the input box. */
export function TodoList({ items, activeTheme }: { items: TodoItem[]; activeTheme?: Theme }): React.ReactElement | null {
  const t = activeTheme ?? theme;
  if (items.length === 0) return null;
  const done = items.filter((i) => i.status === "done").length;
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Text dimColor>plan · {done}/{items.length} done</Text>
      {items.map((it, i) => {
        const mark = it.status === "done" ? "✔" : it.status === "in_progress" ? "▸" : "○";
        const color = it.status === "done" ? t.ok : it.status === "in_progress" ? t.accent : undefined;
        return (
          <Text key={i} color={color} strikethrough={it.status === "done"} dimColor={it.status === "pending"}>
            {"  "}{mark} {it.content}
          </Text>
        );
      })}
    </Box>
  );
}

// Dependency-free gradient: interpolate per-character between two hex stops.
function gradient(text: string, from: [number, number, number], to: [number, number, number]): React.ReactElement[] {
  const n = text.length;
  const hex = (c: number) => c.toString(16).padStart(2, "0");
  return [...text].map((ch, i) => {
    const t = n <= 1 ? 0 : i / (n - 1);
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);
    return (
      <Text key={i} color={`#${hex(r)}${hex(g)}${hex(b)}`} bold>
        {ch}
      </Text>
    );
  });
}

export function Banner({
  version,
  model,
  cwd,
  routerState,
  effort,
  sessionTitle,
  activeTheme,
}: {
  version: string;
  model: string;
  cwd: string;
  routerState: string;
  effort?: string;
  sessionTitle?: string;
  activeTheme?: Theme;
}): React.ReactElement {
  const t = activeTheme ?? theme;
  const home = process.env.HOME ?? "";
  const shortCwd = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
  const effortLabel = effort ? ` · effort ${effort}` : "";
  const titleSuffix = sessionTitle ? ` · ${sessionTitle}` : "";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box
        borderStyle="round"
        borderColor={t.accent2}
        paddingX={1}
        flexDirection="column"
        alignSelf="flex-start"
      >
        <Text>
          {gradient("◆ persoje", t.gradFrom, t.gradTo)}
          <Text dimColor> v{version}</Text>
          {sessionTitle ? <Text dimColor> · </Text> : null}
          {sessionTitle ? <Text color={t.accent}>{sessionTitle}</Text> : null}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>model </Text>
          <Text color={t.accent}>{model}</Text>
          <Text dimColor> · cwd </Text>
          <Text color={t.accent}>{shortCwd}</Text>
          <Text dimColor> · router {routerState}{effortLabel}</Text>
        </Box>
        <Text dimColor>/help · / for menu · esc interrupts · /effort low|mid|high|max</Text>
      </Box>
    </Box>
  );
}

// Effort-aware verbs — they reflect how hard the agent is working
const VERBS_BY_EFFORT = {
  low:  ["Thinking", "Quick check", "Scanning"],
  mid:  ["Working", "Thinking", "Crunching", "Reasoning"],
  high: ["Analyzing", "Investigating", "Reasoning deeply", "Exploring"],
  max:  ["Deep analysis", "Exhaustive search", "Full investigation", "Considering all paths"],
};
const FRAMES = ["◆", "◇", "◈", "◇", "◆", "⬡"];

export function Spinner({ detail, startedAt, effort }: { detail?: string; startedAt: number; effort?: string }): React.ReactElement {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 130);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const verbs = VERBS_BY_EFFORT[(effort as keyof typeof VERBS_BY_EFFORT) ?? "mid"] ?? VERBS_BY_EFFORT.mid;
  const verb = verbs[Math.floor(elapsed / 4) % verbs.length];
  return (
    <Box marginTop={1}>
      <Text color={theme.accent}>{FRAMES[tick % FRAMES.length]} </Text>
      <Text>{detail ? detail : verb + "…"}</Text>
      <Text dimColor> ({elapsed}s · esc)</Text>
    </Box>
  );
}

function termWidth(): number {
  return Math.min(process.stdout.columns || 80, 100);
}

/**
 * Persoje's response block — clean, scannable, own identity.
 * Top rule with ◆ marker, indented body, bottom rule.
 */
export function AssistantBlock({ body }: { body: React.ReactNode }): React.ReactElement {
  const width = termWidth();
  const head = "── ◆ ";
  const topFill = "─".repeat(Math.max(0, width - head.length - 10));
  const bottom = "─".repeat(Math.max(0, width - 2));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.accent}>── ◆ </Text>
        <Text dimColor>{topFill}</Text>
      </Text>
      <Box marginLeft={2} flexDirection="column">
        {body}
      </Box>
      <Text dimColor>──{bottom}</Text>
    </Box>
  );
}

const fmtTok = (n: number): string =>
  n >= 1_000_000
    ? (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1).replace(/\.0$/, "") + "M"
    : n >= 1000
      ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1).replace(/\.0$/, "") + "K"
      : String(n);
const fmtSecs = (s: number): string => (s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`);

/**
 * Dashboard-style status bar — Persoje's thesis made visible:
 * context meter, cost, effort, time, queue depth.
 */
export function StatusBar({
  model,
  ctxUsed,
  ctxBudget,
  cost,
  busy,
  turnStart,
  queued,
  routerOff,
  effort,
  iterations,
  planMode,
  trust,
  activeTheme,
  cacheHit,
  toolsThisTurn,
  schemasTokens,
}: {
  model: string;
  ctxUsed: number;
  ctxBudget: number;
  cost: number;
  busy: boolean;
  turnStart: number;
  queued: number;
  routerOff: boolean;
  effort?: string;
  iterations?: number;
  planMode?: boolean;
  trust?: string;
  activeTheme?: Theme;
  /** Fraction (0–1) of last call's input served from cache. */
  cacheHit?: number;
  /** Tool calls made during the current turn. */
  toolsThisTurn?: number;
  /** Token cost of serialized tool schemas. */
  schemasTokens?: number;
}): React.ReactElement {
  const t = activeTheme ?? theme;
  const [, force] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const iv = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [busy]);

  const pct = Math.min(100, Math.round((ctxUsed / ctxBudget) * 100));
  const filled = Math.min(10, Math.round(pct / 10));
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const barColor = pct < 50 ? t.ok : pct < 80 ? t.warn : t.err;
  const sep = <Text dimColor> │ </Text>;

  const effortColors: Record<string, string> = { low: t.dim, mid: t.accent, high: t.warn, max: t.err };

  return (
    <Box paddingX={1}>
      <Text color={t.accent}>⬡ </Text>
      <Text dimColor>{model}</Text>
      {sep}
      <Text dimColor>{fmtTok(ctxUsed)}/{fmtTok(ctxBudget)} </Text>
      <Text color={barColor}>[{bar}]</Text>
      <Text dimColor> {pct}%</Text>
      {cacheHit && cacheHit > 0 ? (
        <Text color={cacheHit >= 0.5 ? t.ok : t.dim}> ⚡{Math.round(cacheHit * 100)}%</Text>
      ) : null}
      {schemasTokens ? <Text dimColor> ~{schemasTokens}📋</Text> : null}
      {sep}
      <Text dimColor>${cost < 0.01 ? cost.toFixed(5) : cost.toFixed(3)}</Text>
      {effort ? (
        <>
          {sep}
          <Text color={effortColors[effort] ?? t.accent}>▸ {effort}</Text>
        </>
      ) : null}
      {planMode ? (
        <>
          {sep}
          <Text color={t.warn}>📋 PLAN</Text>
        </>
      ) : null}
      {trust && trust !== "normal" ? (
        <>
          {sep}
          <Text color={trust === "yolo" ? t.err : t.warn}>{trust === "yolo" ? "🔓 YOLO" : "✎ auto-edit"}</Text>
        </>
      ) : null}
      {busy ? (
        <>
          {sep}
          <Text color={t.accent}>⏱ {fmtSecs(Math.floor((Date.now() - turnStart) / 1000))}</Text>
          {iterations != null && iterations > 0 ? <Text dimColor> · iter {iterations}</Text> : null}
          {toolsThisTurn != null && toolsThisTurn > 0 ? <Text dimColor> · {toolsThisTurn} tool{toolsThisTurn === 1 ? "" : "s"}</Text> : null}
        </>
      ) : null}
      {queued ? <Text dimColor> · {queued} queued</Text> : null}
      {routerOff ? <Text dimColor> · router off</Text> : null}
    </Box>
  );
}

export function CommandMenu({
  items,
  selected,
}: {
  items: CommandMeta[];
  selected: number;
}): React.ReactElement {
  const width = Math.max(...items.map((c) => c.name.length)) + 1;
  const WINDOW = 8;
  // Scroll the visible window so the selected row is always shown (it can run
  // past WINDOW when many commands match, e.g. typing just "/").
  const start =
    items.length <= WINDOW ? 0 : Math.min(Math.max(0, selected - Math.floor(WINDOW / 2)), items.length - WINDOW);
  const visible = items.slice(start, start + WINDOW);
  return (
    <Box flexDirection="column" marginLeft={2}>
      {start > 0 ? <Text dimColor>{`  ↑ ${start} more`}</Text> : null}
      {visible.map((c, i) => {
        const idx = start + i;
        const sel = idx === selected;
        return (
          <Text key={c.name}>
            <Text color={sel ? theme.accent : "gray"}>{sel ? "▸ " : "  "}</Text>
            <Text color={sel ? theme.accent : undefined}>{c.name.padEnd(width)}</Text>
            <Text dimColor> {c.args ? c.args + "  " : ""}{c.desc}</Text>
          </Text>
        );
      })}
      {start + WINDOW < items.length ? <Text dimColor>{`  ↓ ${items.length - start - WINDOW} more`}</Text> : null}
    </Box>
  );
}

/** Render an approval request with tool-appropriate detail. */
export function ApprovalPrompt({
  name,
  args,
  dangerReason,
}: {
  name: string;
  args: Record<string, unknown>;
  dangerReason?: string;
}): React.ReactElement {
  const clip = (s: string, lines = 8): string[] => {
    const arr = s.split("\n");
    return arr.length > lines ? [...arr.slice(0, lines), `… +${arr.length - lines} more`] : arr;
  };

  let body: React.ReactElement;
  if (name === "bash") {
    body = <Text color={theme.accent}>$ {String(args.command ?? "")}</Text>;
  } else if (name === "edit") {
    body = (
      <Box flexDirection="column">
        <Text bold>{String(args.path ?? "")}</Text>
        {clip(String(args.old_string ?? "")).map((l, i) => (
          <Text key={`o${i}`} color={theme.err}>
            - {l}
          </Text>
        ))}
        {clip(String(args.new_string ?? "")).map((l, i) => (
          <Text key={`n${i}`} color={theme.ok}>
            + {l}
          </Text>
        ))}
      </Box>
    );
  } else if (name === "write") {
    const content = String(args.content ?? "");
    body = (
      <Box flexDirection="column">
        <Text bold>
          {String(args.path ?? "")} <Text dimColor>({content.split("\n").length} lines)</Text>
        </Text>
        {clip(content, 6).map((l, i) => (
          <Text key={i} color={theme.ok}>
            + {l}
          </Text>
        ))}
      </Box>
    );
  } else {
    body = <Text>{JSON.stringify(args).slice(0, 200)}</Text>;
  }

  return (
    <Box borderStyle="round" borderColor={dangerReason ? theme.err : theme.warn} paddingX={1} flexDirection="column" marginTop={1}>
      {dangerReason ? (
        <Text color={theme.err} bold>
          ⚠ DANGER — {dangerReason} (confirmed even in yolo)
        </Text>
      ) : null}
      <Text color={dangerReason ? theme.err : theme.warn} bold>
        ◆ {name}
      </Text>
      {body}
      <Box marginTop={1}>
        <Text dimColor>
          <Text color={theme.ok}>y</Text> allow · <Text color={theme.err}>n</Text> deny
          {dangerReason ? "" : (
            <>
              {" "}· <Text color={theme.accent}>a</Text> always allow {name}
            </>
          )}
        </Text>
      </Box>
    </Box>
  );
}
