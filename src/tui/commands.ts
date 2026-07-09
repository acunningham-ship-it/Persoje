/** Slash-command metadata — single source of truth for the autocomplete menu and /help. */
export interface CommandMeta {
  name: string;
  args?: string;
  desc: string;
}

export const COMMANDS: CommandMeta[] = [
  { name: "/model", args: "[id]", desc: "show or switch model (interactive menu)" },
  { name: "/models", args: "[filter]", desc: "list tool-capable models (price + context) to pick from" },
  { name: "/provider", args: "[name]", desc: "pick a provider from a menu, or switch by name" },
  { name: "/retry", desc: "re-run the last task (e.g. after switching model)" },
  { name: "/copy", args: "[code]", desc: "copy last reply (or its last code block) to clipboard" },
  { name: "/diff", desc: "show uncommitted git changes (what changed this session)" },
  { name: "/undo", desc: "revert files the agent edited this session (git repo only)" },
  { name: "/cost", desc: "session token + cost totals" },
  { name: "/budget", args: "[usd|off]", desc: "show or set the session cost ceiling (halts the turn when hit)" },
  { name: "/status", desc: "model, session, memory — everything at a glance" },
  { name: "/config", desc: "show resolved config" },
  { name: "/permissions", args: "[clear]", desc: "show or clear always-allowed tools" },
  { name: "/resume", args: "[name|number]", desc: "interactive session picker, or resume by name/number" },
  { name: "/compact", desc: "summarize old history now" },
  { name: "/clear", desc: "clear conversation history" },
  { name: "/init", desc: "explore the project and write .persoje/PERSOJE.md" },
  { name: "/goal", args: "[text|clear]", desc: "show, set, or clear the pinned session goal" },
  { name: "/memory", args: "[slug]", desc: "list memory facts, or show one" },
  { name: "/skills", desc: "list skills in the library" },
  { name: "/stats", desc: "session stats: turns, facts, skills" },
  { name: "/repomap", desc: "show the repo-map being sent to the model" },
  { name: "/dream", desc: "consolidate recent sessions into memory (free model)" },
  { name: "/theme", args: "[name]", desc: "switch color theme (amber, ocean, forest, rose, ember, mono)" },
  { name: "/mcp", args: "add|remove|connect|list|tools", desc: "manage MCP servers" },
  { name: "/personality", args: "show|set|reset|custom", desc: "personality wizard" },
  { name: "/plan", args: "[on|off]", desc: "plan mode: think & spec before acting" },
  { name: "/autonomous", args: "on|off|status", desc: "toggle persistent mode (survives disconnect)" },
  { name: "/permsoff", desc: "auto-approve all tool calls (no confirmation)" },
  { name: "/help", desc: "all commands" },
  { name: "/exit", desc: "quit" },
];

/**
 * Commands safe to run WHILE a turn is in flight — read-only or flag-toggles
 * that don't call the model, mutate the conversation, touch files, or spawn a
 * turn. Everything else queues until the turn finishes.
 */
export const LIVE_SAFE = new Set<string>([
  "/help", "/cost", "/budget", "/status", "/config", "/permissions", "/sessions",
  "/memory", "/skills", "/repomap", "/stats",
  "/diff", "/copy", "/models", "/theme", "/goal",
  "/exit", "/quit",
]);

export function filterCommands(input: string): CommandMeta[] {
  const query = input.trim().toLowerCase();
  if (!query.startsWith("/")) return [];
  // Only suggest while typing the command word itself, not its arguments.
  if (query.includes(" ")) return [];
  return COMMANDS.filter((c) => c.name.startsWith(query));
}

export function helpText(): string {
  // Multi-line format: command on one line, description on the next.
  // This prevents Ink from hard-wrapping long description lines.
  return COMMANDS.map((c) => {
    const cmd = c.name + (c.args ? " " + c.args : "");
    return `  ${cmd}\n    ${c.desc}`;
  }).join("\n");
}
