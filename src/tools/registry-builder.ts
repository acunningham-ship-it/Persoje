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
export function lowFrequencyTools() {
  return [webFetchTool, webSearchTool, multiEditTool];
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
  // Self-learning skill tools. add_skill is always available (so it can create
  // the first one); invoke/list only matter once skills exist — gate them to
  // save tool-schema tokens on every call when the library is empty.
  registry.register(makeAddSkillTool(skills));
  // Monitor management — background watchers that fire between iterations
  registry.register(monitorTool);
  if (skills.list().length > 0) {
    registry.register(makeInvokeSkillTool(skills));
    registry.register(makeListSkillsTool(skills));
  }
  // Reveal path for gated low-frequency tools — flag-off never registers this, so the
  // tool set is unchanged from before gating existed at all.
  if (gateLowFrequency) {
    registry.register(makeMoreToolsTool(registry, lowFrequencyTools()));
  }
  // MCP tools
  if (mcp) {
    for (const tool of mcp.getTools()) registry.register(tool);
  }
  return registry;
}
