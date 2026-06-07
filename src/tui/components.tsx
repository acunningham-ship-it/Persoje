import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { CommandMeta } from "./commands.ts";
import { theme } from "./theme.ts";

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
}: {
  version: string;
  model: string;
  cwd: string;
  routerState: string;
  effort?: string;
}): React.ReactElement {
  const home = process.env.HOME ?? "";
  const shortCwd = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
  const effortLabel = effort ? ` · effort ${effort}` : "";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box
        borderStyle="round"
        borderColor={theme.accent2}
        paddingX={1}
        flexDirection="column"
        alignSelf="flex-start"
      >
        <Text>
          {gradient("◆ persoje", [232, 163, 23], [199, 139, 13])}
          <Text dimColor> v{version}</Text>
        </Text>
        <Box marginTop={1}>
          <Text dimColor>model </Text>
          <Text color={theme.accent}>{model}</Text>
          <Text dimColor> · cwd </Text>
          <Text color={theme.accent}>{shortCwd}</Text>
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
}): React.ReactElement {
  const [, force] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const pct = Math.min(100, Math.round((ctxUsed / ctxBudget) * 100));
  const filled = Math.min(10, Math.round(pct / 10));
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const barColor = pct < 50 ? theme.ok : pct < 80 ? theme.warn : theme.err;
  const sep = <Text dimColor> │ </Text>;

  const effortColors: Record<string, string> = { low: theme.dim, mid: theme.accent, high: theme.warn, max: theme.err };

  return (
    <Box paddingX={1}>
      <Text color={theme.accent}>⬡ </Text>
      <Text dimColor>{model}</Text>
      {sep}
      <Text dimColor>{fmtTok(ctxUsed)}/{fmtTok(ctxBudget)} </Text>
      <Text color={barColor}>[{bar}]</Text>
      <Text dimColor> {pct}%</Text>
      {sep}
      <Text dimColor>${cost < 0.01 ? cost.toFixed(5) : cost.toFixed(3)}</Text>
      {effort ? (
        <>
          {sep}
          <Text color={effortColors[effort] ?? theme.accent}>▸ {effort}</Text>
        </>
      ) : null}
      {busy ? (
        <>
          {sep}
          <Text color={theme.accent}>⏱ {fmtSecs(Math.floor((Date.now() - turnStart) / 1000))}</Text>
          {iterations != null && iterations > 0 ? <Text dimColor> · iter {iterations}</Text> : null}
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
  return (
    <Box flexDirection="column" marginLeft={2}>
      {items.slice(0, 8).map((c, i) => (
        <Text key={c.name}>
          <Text color={i === selected ? theme.accent : "gray"}>{i === selected ? "▸ " : "  "}</Text>
          <Text color={i === selected ? theme.accent : undefined}>{c.name.padEnd(width)}</Text>
          <Text dimColor> {c.args ? c.args + "  " : ""}{c.desc}</Text>
        </Text>
      ))}
    </Box>
  );
}

/** Render an approval request with tool-appropriate detail. */
export function ApprovalPrompt({
  name,
  args,
}: {
  name: string;
  args: Record<string, unknown>;
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
    <Box borderStyle="round" borderColor={theme.warn} paddingX={1} flexDirection="column" marginTop={1}>
      <Text color={theme.warn} bold>
        ◆ {name}
      </Text>
      {body}
      <Box marginTop={1}>
        <Text dimColor>
          <Text color={theme.ok}>y</Text> allow · <Text color={theme.err}>n</Text> deny ·{" "}
          <Text color={theme.accent}>a</Text> always allow {name}
        </Text>
      </Box>
    </Box>
  );
}
