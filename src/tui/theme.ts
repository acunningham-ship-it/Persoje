/**
 * One accent, everything else dim or default — the Claude Code palette
 * philosophy. Change the accent here and the whole TUI follows.
 */
export const theme = {
  accent: "#fa7921", // Claude Code peach-orange — star, caret, active selection ONLY
  bullet: "gray", // assistant ⏺ and tool ⏺ are medium gray, never the accent
  border: "gray", // all chrome borders stay quiet
  ok: "#00c853",
  err: "#f44336",
  warn: "#ffc107",
} as const;
