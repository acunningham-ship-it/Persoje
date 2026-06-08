import { z } from "zod";
import { resolve } from "node:path";
import { ToolError, type Tool } from "./types.ts";

export const bashTool: Tool = {
  name: "bash",
  description: "Run a bash command. Output is capped — pipe through head/tail/grep for large output.",
  args: z.object({
    command: z.string(),
  }),
  maxResultTokens: 2000,
  async execute({ command }, ctx) {
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: ctx.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const timer = setTimeout(() => proc.kill(), ctx.bashTimeoutMs);
    const abort = () => proc.kill();
    ctx.signal?.addEventListener("abort", abort, { once: true });
    try {
      // Stream stdout so the spinner can show the latest line on long commands,
      // while accumulating the full text — the returned output is unchanged.
      const readStdout = async (): Promise<string> => {
        const reader = proc.stdout.getReader();
        const dec = new TextDecoder();
        let full = "";
        let buf = "";
        let lastReport = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = dec.decode(value, { stream: true });
          full += chunk;
          buf += chunk;
          const parts = buf.split("\n");
          buf = parts.pop() ?? "";
          const line = parts.reverse().find((l) => l.trim());
          if (line && ctx.onProgress && Date.now() - lastReport > 300) {
            ctx.onProgress(line.trim().slice(0, 80));
            lastReport = Date.now();
          }
        }
        return full;
      };
      const [stdout, stderr, exitCode] = await Promise.all([
        readStdout(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      let out = stdout;
      if (stderr.trim()) out += (out ? "\n" : "") + `[stderr]\n${stderr}`;
      if (exitCode !== 0) out += `\n[exit code: ${exitCode}]`;
      return out.trim() || "(no output)";
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", abort);
    }
  },
};

export const grepTool: Tool = {
  name: "grep",
  description: "Search file contents with a regex (ripgrep). Returns matching lines with file:line.",
  args: z.object({
    pattern: z.string().describe("Regex pattern"),
    path: z.string().optional().describe("File or directory (default: cwd)"),
    glob: z.string().optional().describe("Filter files, e.g. '*.ts'"),
  }),
  maxResultTokens: 2500,
  async execute({ pattern, path, glob }, ctx) {
    const target = resolve(ctx.cwd, path ?? ".");
    const args = ["rg", "--line-number", "--no-heading", "--max-count", "20", "--max-columns", "250"];
    if (glob) args.push("--glob", glob);
    args.push("--", pattern, target);

    const proc = Bun.spawn(args, { cwd: ctx.cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode === 1) return "No matches.";
    if (exitCode !== 0) {
      if (stderr.includes("command not found") || stderr.includes("No such file or directory") && stderr.includes("rg")) {
        throw new ToolError("ripgrep (rg) is not installed");
      }
      throw new ToolError(`grep failed: ${stderr.slice(0, 200)}`);
    }
    // Make paths relative to cwd for readability/token-lean output.
    return stdout.replaceAll(ctx.cwd + "/", "").trim() || "No matches.";
  },
};
