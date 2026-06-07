import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { CommandMeta } from "./commands.ts";
import { theme } from "./theme.ts";

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
            ✻
          </Text>
          <Text bold> Welcome to persoje</Text>
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
