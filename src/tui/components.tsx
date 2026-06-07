import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { CommandMeta } from "./commands.ts";
import { theme } from "./theme.ts";

// Dependency-free gradient: interpolate per-character between two hex stops.
// (ink-gradient pulls in chroma/tinygradient — not worth the bundle for one word.)
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
}: {
  version: string;
  model: string;
  cwd: string;
  routerState: string;
}): React.ReactElement {
  // Short home-relative cwd to keep the line tight.
  const home = process.env.HOME ?? "";
  const shortCwd = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Contained welcome box — hugs content (alignSelf), not full terminal width. */}
      <Box
        borderStyle="round"
        borderColor={theme.border}
        paddingX={1}
        flexDirection="column"
        alignSelf="flex-start"
      >
        <Text>
          <Text color={theme.accent} bold>
            ✻{" "}
          </Text>
          {gradient("persoje", [250, 121, 33], [255, 207, 107])}
          <Text dimColor> v{version}</Text>
        </Text>
        <Box marginTop={1}>
          <Text dimColor>/help for commands · / for the menu · esc interrupts</Text>
        </Box>
        <Text dimColor>
          {"  "}model {model}
        </Text>
        <Text dimColor>
          {"  "}cwd {shortCwd} · router {routerState}
        </Text>
      </Box>
      <Box marginTop={1} marginLeft={1}>
        <Text color={theme.accent}>★ </Text>
        <Text dimColor>token-efficient — every model runs lean here. Try a task, or /init this project.</Text>
      </Box>
    </Box>
  );
}

// Cycling verbs give the wait some personality without a token ticker fighting for space.
const VERBS = ["Thinking", "Working", "Pondering", "Crunching", "Reasoning", "Brewing"];
const FRAMES = ["·", "✢", "✳", "✶", "✳", "✢"];

export function Spinner({ detail, startedAt }: { detail?: string; startedAt: number }): React.ReactElement {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 130);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const verb = VERBS[Math.floor(elapsed / 4) % VERBS.length];
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
 * Hermes-style titled message block: a top rule carrying the speaker's name,
 * indented content, and a bottom rule. No side bars — so rendered markdown
 * (code blocks especially) wraps naturally instead of fighting a border.
 */
export function AssistantBlock({ body }: { body: React.ReactNode }): React.ReactElement {
  const width = termWidth();
  const head = "╭─ ✦ persoje ";
  const topFill = "─".repeat(Math.max(0, width - head.length - 1));
  const bottom = "─".repeat(Math.max(0, width - 2));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text dimColor>╭─ </Text>
        <Text color={theme.accent}>✦ persoje </Text>
        <Text dimColor>{topFill}╮</Text>
      </Text>
      <Box marginLeft={2} flexDirection="column">
        {body}
      </Box>
      <Text dimColor>╰{bottom}╯</Text>
    </Box>
  );
}

const fmtTok = (n: number): string => (n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n));
const fmtSecs = (s: number): string => (s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`);

/**
 * The hermes-style bottom gauge — and persoje's whole thesis made visible:
 * a live context meter showing how lean the session is staying.
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
}: {
  model: string;
  ctxUsed: number;
  ctxBudget: number;
  cost: number;
  busy: boolean;
  turnStart: number;
  queued: number;
  routerOff: boolean;
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

  return (
    <Box paddingX={1}>
      <Text color={theme.accent}>⬡ </Text>
      <Text dimColor>{model}</Text>
      {sep}
      <Text dimColor>
        {fmtTok(ctxUsed)}/{fmtTok(ctxBudget)} </Text>
      <Text color={barColor}>[{bar}]</Text>
      <Text dimColor> {pct}%</Text>
      {sep}
      <Text dimColor>${cost < 0.01 ? cost.toFixed(5) : cost.toFixed(3)}</Text>
      {busy ? (
        <>
          {sep}
          <Text color={theme.accent}>⏱ {fmtSecs(Math.floor((Date.now() - turnStart) / 1000))}</Text>
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
          <Text color={i === selected ? theme.accent : "gray"}>{i === selected ? "❯ " : "  "}</Text>
          <Text color={i === selected ? theme.accent : undefined}>{c.name.padEnd(width)}</Text>
          <Text dimColor> {c.args ? c.args + "  " : ""}{c.desc}</Text>
        </Text>
      ))}
    </Box>
  );
}

/** Render an approval request with tool-appropriate detail: diffs for edits, the command for bash. */
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
        {name}
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
