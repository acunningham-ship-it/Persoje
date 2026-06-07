import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { CommandMeta } from "./commands.ts";

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
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text>
        <Text color="cyan" bold>
          ✳ persoje
        </Text>
        <Text dimColor> v{version} — token-efficient agentic CLI</Text>
      </Text>
      <Text dimColor>
        model {model} · router {routerState}
      </Text>
      <Text dimColor>cwd {cwd}</Text>
      <Text dimColor>/help for commands · type / for the menu · esc cancels a turn</Text>
    </Box>
  );
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ label, startedAt }: { label: string; startedAt: number }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
      force((n) => n + 1); // refresh elapsed seconds
    }, 120);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  return (
    <Text>
      <Text color="cyan">{FRAMES[frame]} </Text>
      <Text>{label}</Text>
      <Text dimColor>
        {" "}
        ({elapsed}s · esc to interrupt)
      </Text>
    </Text>
  );
}

export function CommandMenu({
  items,
  selected,
}: {
  items: CommandMeta[];
  selected: number;
}): React.ReactElement {
  const width = Math.max(...items.map((c) => (c.name + " " + (c.args ?? "")).length)) + 2;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {items.slice(0, 8).map((c, i) => (
        <Text key={c.name} inverse={i === selected}>
          <Text color="cyan">{(c.name + (c.args ? " " + c.args : "")).padEnd(width)}</Text>
          <Text dimColor> {c.desc}</Text>
        </Text>
      ))}
      <Text dimColor>↑↓ select · tab/enter complete · esc dismiss</Text>
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
    return arr.length > lines ? [...arr.slice(0, lines), `… (${arr.length - lines} more lines)`] : arr;
  };

  let body: React.ReactElement;
  if (name === "bash") {
    body = <Text color="cyan">$ {String(args.command ?? "")}</Text>;
  } else if (name === "edit") {
    body = (
      <Box flexDirection="column">
        <Text bold>{String(args.path ?? "")}</Text>
        {clip(String(args.old_string ?? "")).map((l, i) => (
          <Text key={`o${i}`} color="red">
            - {l}
          </Text>
        ))}
        {clip(String(args.new_string ?? "")).map((l, i) => (
          <Text key={`n${i}`} color="green">
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
          {String(args.path ?? "")} <Text dimColor>({content.split("\n").length} lines, new/overwrite)</Text>
        </Text>
        {clip(content, 6).map((l, i) => (
          <Text key={i} color="green">
            + {l}
          </Text>
        ))}
      </Box>
    );
  } else {
    body = <Text>{JSON.stringify(args).slice(0, 200)}</Text>;
  }

  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text color="yellow" bold>
        {name} wants to run:
      </Text>
      {body}
      <Text dimColor>[y] allow · [n] deny · [a] always allow {name} this session</Text>
    </Box>
  );
}
