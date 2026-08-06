import { ToolRegistry } from "./types.ts";
import { readTool, writeTool, editTool, multiEditTool, lsTool, globTool } from "./file-tools.ts";
import { bashTool, grepTool } from "./shell-tools.ts";
import { webFetchTool, webSearchTool } from "./web-tools.ts";
import { setGoalTool, transcriptTool } from "./goal-tools.ts";
import { updateTodosTool } from "./todo-tools.ts";
import { monitorTool } from "./monitor-tools.ts";
import { makeAddSkillTool, makeInvokeSkillTool, makeListSkillsTool } from "./skill-tools.ts";
import { makeMoreToolsTool } from "./gating-tools.ts";
import type { SkillLibrary } from "../memory/skills.ts";
import type { McpManager } from "../mcp/client.ts";

// Low-frequency tools eligible for gating behind config.tools.gateLowFrequency. Core tools
// (read/write/edit/bash/ls/glob/grep) are NEVER in this list — they're too commonly needed
// on a trivial turn to defer, and gating them would be a real capability regression, not a
// token trim. multi_edit is here (not core edit) because most turns touch one edit at a time.
// monitor joins them: measured 0 calls across 95 real sessions — the single priciest schema
// (~170 tok/turn) for a capability the agent never reached for. (add_skill is gated too when the
// flag is on, but it's constructed with the skills library, so it's added to the gated set in
// buildRegistry rather than this static list.)
export function lowFrequencyTools() {
  return [webFetchTool, webSearchTool, multiEditTool, monitorTool];
}

export function buildRegistry(skills: SkillLibrary, mcp?: McpManager, gateLowFrequency = false): ToolRegistry {
  const registry = new ToolRegistry();
  const always = gateLowFrequency
    ? [readTool, writeTool, editTool, lsTool, globTool, bashTool, grepTool]
    : [readTool, writeTool, editTool, multiEditTool, lsTool, globTool, bashTool, grepTool, webFetchTool, webSearchTool];
  for (const t of always) registry.register(t);
  // Goal anchor + working plan + transcript escape-hatch
  registry.register(setGoalTool);
  registry.register(updateTodosTool);
  registry.register(transcriptTool);
  // Self-learning skill tools. add_skill is the SOLE skill-creation path (nothing auto-creates
  // skills — dream doesn't), so when it's gated the model must call more_tools before the FIRST
  // skill: a deferral of the self-learning bootstrap, not a no-op. Measured 0 calls / 95 sessions,
  // so nil in practice, but it's a real trade (reveal round-trip) — called out for review. When the
  // flag is off, add_skill + monitor register exactly as before (order preserved → OFF byte-identical).
  const addSkillTool = makeAddSkillTool(skills);
  if (!gateLowFrequency) {
    registry.register(addSkillTool);
    // Monitor management — background watchers that fire between iterations
    registry.register(monitorTool);
  }
  // invoke/list only matter once skills exist — gate them to save tool-schema tokens on every
  // call when the library is empty (unchanged by the flag).
  if (skills.list().length > 0) {
    registry.register(makeInvokeSkillTool(skills));
    registry.register(makeListSkillsTool(skills));
  }
  // Reveal path for gated low-frequency tools — flag-off never registers this, so the tool set is
  // unchanged from before gating existed at all. add_skill joins the static low-freq set here
  // (web_fetch/web_search/multi_edit/monitor) because it needs the skills library.
  if (gateLowFrequency) {
    registry.register(makeMoreToolsTool(registry, [...lowFrequencyTools(), addSkillTool]));
  }
  // MCP tools
  if (mcp) {
    for (const tool of mcp.getTools()) registry.register(tool);
  }
  return registry;
}
