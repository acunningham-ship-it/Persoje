import { z } from "zod";
import { resolve } from "node:path";
import { ToolError, type Tool } from "./types.ts";

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a bash command. Output is capped — pipe through head/tail/grep for large output. " +
    "For processes that don't exit on their own (servers, watchers, daemons), pass background:true " +
    "so they run detached and return immediately instead of blocking the turn.",
  args: z.object({
    command: z.string(),
    background: z
      .boolean()
      .optional()
      .describe("Run detached, return immediately with the PID. Use for servers/daemons that keep running."),
  }),
  maxResultTokens: 2000,
  async execute({ command, background }, ctx) {
    // Detached path: the process outlives this turn (and the agent), so a server
    // started here is still up when something later connects to it. Returns at once.
    if (background) {
      const stamp = `${Date.now()}-${Math.floor(performance.now())}`;
      const script = `/tmp/persoje-bg-${stamp}.sh`;
      const log = `/tmp/persoje-bg-${stamp}.log`;
      await Bun.write(script, command + "\n");
      const proc = Bun.spawn(
        ["bash", "-c", `nohup setsid bash ${script} >${log} 2>&1 & echo $!`],
        { cwd: ctx.cwd, stdout: "pipe", stderr: "pipe", env: process.env },
      );
      const pid = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      return `[background] started pid ${pid}; output → ${log} (tail it to check progress)`;
    }

    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: ctx.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const abort = () => proc.kill();
    ctx.signal?.addEventListener("abort", abort, { once: true });

    // Accumulate stdout in an outer var so a timeout can still return partial output.
    let full = "";
    const readStdout = async (): Promise<void> => {
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
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
    };

    const TIMED_OUT = Symbol("timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((res) => {
      timer = setTimeout(() => res(TIMED_OUT), ctx.bashTimeoutMs);
    });

    try {
      const work = (async () => {
        const [, stderr, exitCode] = await Promise.all([
          readStdout(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stderr, exitCode };
      })();
      // Race the command against the timeout. Killing bash doesn't reap a foreground
      // child that holds the stdout pipe open, so awaiting `work` would hang forever
      // (this is exactly what stalled "start a server" commands). Return on timeout.
      const result = await Promise.race([work, timeout]);
      if (result === TIMED_OUT) {
        work.catch(() => {}); // we're abandoning it; don't leak an unhandled rejection
        proc.kill();
        const secs = Math.round(ctx.bashTimeoutMs / 1000);
        const partial = full.trim();
        return (
          (partial ? partial + "\n" : "") +
          `[timed out after ${secs}s and was terminated. If this is a server/daemon/watcher ` +
          `that doesn't return on its own, re-run it with background:true.]`
        );
      }
      let out = full;
      if (result.stderr.trim()) out += (out ? "\n" : "") + `[stderr]\n${result.stderr}`;
      if (result.exitCode !== 0) out += `\n[exit code: ${result.exitCode}]`;
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
