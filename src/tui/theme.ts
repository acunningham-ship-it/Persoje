/**
 * One accent, everything else dim or default — the Claude Code palette
 * philosophy. Change the accent here and the whole TUI follows.
 */
export const theme = {
  accent: "#fd9a4d", // warm orange — banner star, prompt caret, selection
  border: "gray", // all chrome borders stay quiet
  ok: "green",
  err: "red",
  warn: "yellow",
} as const;
