import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { CommandMeta } from "./commands.ts";
import type { TodoItem } from "../tools/types.ts";
import { theme, getTheme, type Theme } from "./theme.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function TodoList({ items, activeTheme }: { items: TodoItem[]; activeTheme?: Theme }): React.ReactElement | null {
  const t = activeTheme ?? theme;
  if (items.length === 0) return null;
  const done = items.filter((i) => i.status === "done").length;
  return (
    <Box flexDirection="column" marginLeft={2}>
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
  activeTheme,
}: {
  version: string;
  model: string;
  cwd: string;
  activeTheme?: Theme;
}): React.ReactElement {
  const t = activeTheme ?? theme;
  const home = process.env.HOME ?? "";
  const shortCwd = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
  const truncate = (s: string, max = 65): string => s.length > max ? s.slice(0, max - 1) + "…" : s;

  return (
    <Box>
      <Text>
        {gradient("persoje", t.gradFrom, t.gradTo)}
        <Text dimColor> v{version} · {truncate(model)} · {truncate(shortCwd)}</Text>
      </Text>
    </Box>
  );
}

export function Spinner({ detail, startedAt }: { detail?: string; startedAt: number }): React.ReactElement {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 130);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  return (
    <Box>
      <Text color={theme.accent}>{FRAMES[tick % FRAMES.length]} </Text>
      <Text>{detail ?? "working…"}</Text>
      <Text dimColor> ({elapsed}s)</Text>
    </Box>
  );
}

export function AssistantBlock({ body }: { body: React.ReactNode }): React.ReactElement {
  return (
    <Box marginLeft={2} flexDirection="column">
      {body}
    </Box>
  );
}

const fmtSecs = (s: number): string => (s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`);

export function StatusBar({
  model,
  ctxUsed,
  ctxBudget,
  cost,
  busy,
  turnStart,
  trust,
  planMode,
  activeTheme,
}: {
  model: string;
  ctxUsed: number;
  ctxBudget: number;
  cost: number;
  busy: boolean;
  turnStart: number;
  trust?: string;
  planMode?: boolean;
  activeTheme?: Theme;
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
  const bar = "▮".repeat(filled) + "▯".repeat(10 - filled);
  const barColor = pct < 50 ? t.ok : pct < 80 ? t.warn : t.err;

  return (
    <Box>
      <Text dimColor>{model}</Text>
      <Text color={barColor}> {bar}</Text>
      <Text dimColor> {pct}%</Text>
      <Text dimColor> ${cost < 0.01 ? cost.toFixed(5) : cost.toFixed(3)}</Text>
      {busy ? <Text color={t.accent}> ⏱{fmtSecs(Math.floor((Date.now() - turnStart) / 1000))}</Text> : null}
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
    body = <Text>$ {String(args.command ?? "")}</Text>;
  } else if (name === "edit") {
    body = (
      <Box flexDirection="column">
        <Text bold>{String(args.path ?? "")}</Text>
        {clip(String(args.old_string ?? "")).map((l, i) => (
          <Text key={`o${i}`} color={theme.err}>- {l}</Text>
        ))}
        {clip(String(args.new_string ?? "")).map((l, i) => (
          <Text key={`n${i}`} color={theme.ok}>+ {l}</Text>
        ))}
      </Box>
    );
  } else if (name === "write") {
    const content = String(args.content ?? "");
    body = (
      <Box flexDirection="column">
        <Text bold>{String(args.path ?? "")} <Text dimColor>({content.split("\n").length} lines)</Text></Text>
        {clip(content, 6).map((l, i) => (
          <Text key={i} color={theme.ok}>+ {l}</Text>
        ))}
      </Box>
    );
  } else {
    body = <Text>{JSON.stringify(args).slice(0, 200)}</Text>;
  }

  return (
    <Box borderStyle="round" borderColor={dangerReason ? theme.err : theme.warn} paddingX={1} flexDirection="column">
      {dangerReason ? (
        <Text color={theme.err} bold>⚠ DANGER — {dangerReason}</Text>
      ) : null}
      <Text bold color={dangerReason ? theme.err : theme.warn}>◆ {name}</Text>
      {body}
      <Box>
        <Text dimColor>
          <Text color={theme.ok}>y</Text> allow · <Text color={theme.err}>n</Text> deny
          {dangerReason ? "" : <> · <Text color={theme.accent}>a</Text> always allow</>}
        </Text>
      </Box>
    </Box>
  );
}