/**
 * more_tools — the reveal mechanism for gated low-frequency tools.
 *
 * Only exists when config.tools.gateLowFrequency is on. Low-frequency tools
 * (web_fetch, web_search, multi_edit) are held OUT of the registry to cut
 * fixed per-turn schema cost; this tool lets the model pull them in on
 * demand, once, for the rest of the session — no capability is permanently
 * lost, just deferred until it's actually needed.
 */

import { z } from "zod";
import type { Tool } from "./types.ts";
import type { ToolRegistry } from "./types.ts";

export function makeMoreToolsTool(registry: ToolRegistry, gated: Tool[]): Tool {
  return {
    name: "more_tools",
    description:
      "Reveal additional tools not shown by default (web fetch/search, multi-file edit) — " +
      "call this once if you need one of them, then use it directly.",
    args: z.object({}),
    maxResultTokens: 200,
    async execute(_args, _ctx) {
      for (const t of gated) registry.register(t);
      registry.invalidateSchemaCache();
      return (
        `Now available: ${gated.map((t) => `${t.name} (${t.description})`).join("; ")}. ` +
        `Call them directly on your next turn.`
      );
    },
  };
}
