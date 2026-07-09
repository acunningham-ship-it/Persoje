import { z } from "zod";
import { ToolError, type Tool } from "./types.ts";
import { getMonitorManager } from "../core/monitors.ts";

/**
 * monitor — manage background monitors that check shell commands periodically
 * and inject alerts into the conversation when they fire.
 *
 * The model can add, remove, list, and temporarily silence monitors.
 */
export const monitorTool: Tool = {
  name: "monitor",
  description: "Manage background monitors: add, remove, list, or silence periodic checks that fire alerts mid-conversation.",
  args: z.object({
    action: z.enum(["add", "remove", "list", "silence"]).describe("add=create a monitor, remove=delete one, list=show all, silence=defer alerts for N iterations"),
    name: z.string().optional().describe("Monitor name (kebab-case, e.g. 'n8n-health')"),
    cmd: z.string().optional().describe("Shell command to run periodically (for add)"),
    intervalSec: z.number().optional().describe("Check interval in seconds (for add, default 30)"),
    description: z.string().optional().describe("Human-readable description of what this monitors (for add)"),
    iterations: z.number().optional().describe("Number of iterations to silence (for silence action)"),
  }),
  maxResultTokens: 500,
  async execute(args, _ctx) {
    const mgr = getMonitorManager();

    switch (args.action) {
      case "add": {
        if (!args.name || !args.cmd) {
          throw new ToolError("add requires name and cmd");
        }
        mgr.add({
          name: args.name,
          cmd: args.cmd,
          intervalSec: args.intervalSec ?? 30,
          cooldownSec: args.intervalSec ?? 30,
          description: args.description ?? "",
          enabled: true,
        });
        return `Monitor "${args.name}" added: \`${args.cmd}\` every ${args.intervalSec ?? 30}s.`;
      }

      case "remove": {
        if (!args.name) throw new ToolError("remove requires name");
        const removed = mgr.remove(args.name);
        if (!removed) throw new ToolError(`Monitor "${args.name}" not found`);
        return `Monitor "${args.name}" removed.`;
      }

      case "list": {
        const monitors = mgr.list();
        if (monitors.length === 0) return "No monitors configured.";
        return monitors
          .map(
            (m) =>
              `- ${m.config.name}: \`${m.config.cmd}\` every ${m.config.intervalSec}s` +
              (m.config.description ? ` — ${m.config.description}` : "") +
              ` (fired ${m.fireCount}x, last: ${m.lastCheck ? new Date(m.lastCheck).toISOString() : "never"})` +
              (m.config.enabled ? "" : " [disabled]"),
          )
          .join("\n");
      }

      case "silence": {
        if (!args.name) throw new ToolError("silence requires name");
        const m = mgr.get(args.name);
        if (!m) throw new ToolError(`Monitor "${args.name}" not found`);
        const n = args.iterations ?? 1;
        return `Monitor "${args.name}" silenced for ${n} iteration(s). (TODO: implement silence tracking)`;
      }

      default:
        throw new ToolError(`Unknown action: ${args.action}`);
    }
  },
};