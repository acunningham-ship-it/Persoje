/** Slash-command metadata — single source of truth for the autocomplete menu and /help. */
export interface CommandMeta {
  name: string;
  args?: string;
  desc: string;
}

export const COMMANDS: CommandMeta[] = [
  { name: "/model", args: "[id]", desc: "show model + profile, or switch" },
  { name: "/router", args: "on|off|auto|offer", desc: "toggle model routing & escalation" },
  { name: "/canary", desc: "re-run the 3-prompt smoke test on the current model" },
  { name: "/cost", desc: "session token + cost totals" },
  { name: "/status", desc: "model, session, memory, router — everything at a glance" },
  { name: "/config", desc: "show resolved config" },
  { name: "/permissions", args: "[clear]", desc: "show or clear always-allowed tools" },
  { name: "/sessions", desc: "recent sessions in this directory" },
  { name: "/resume", args: "<id>", desc: "resume a session" },
  { name: "/compact", desc: "summarize old history now" },
  { name: "/clear", desc: "clear conversation history" },
  { name: "/init", desc: "explore the project and write .persoje/PERSOJE.md" },
  { name: "/memory", args: "[slug]", desc: "list memory facts, or show one" },
  { name: "/skills", desc: "list skills in the library" },
  { name: "/lessons", desc: "recent lessons from failed turns" },
  { name: "/quirks", desc: "known quirks of the current model" },
  { name: "/repomap", desc: "show the repo-map being sent to the model" },
  { name: "/dream", desc: "consolidate recent sessions into memory (free model)" },
  { name: "/help", desc: "all commands" },
  { name: "/exit", desc: "quit" },
];

export function filterCommands(input: string): CommandMeta[] {
  const query = input.trim().toLowerCase();
  if (!query.startsWith("/")) return [];
  // Only suggest while typing the command word itself, not its arguments.
  if (query.includes(" ")) return [];
  return COMMANDS.filter((c) => c.name.startsWith(query));
}

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => (c.name + " " + (c.args ?? "")).length)) + 2;
  return COMMANDS.map((c) => `  ${(c.name + (c.args ? " " + c.args : "")).padEnd(width)} ${c.desc}`).join("\n");
}
