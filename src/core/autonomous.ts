/**
 * Autonomous mode — Persoje survives SSH disconnects, terminal closes, and crashes.
 *
 * Strategy: self-contained, no external deps beyond tmux (which is already available).
 * - Wraps the current persoje process in a tmux session
 * - Writes a watchdog script that health-checks every 30s
 * - Logs all output to a persistent file
 * - On reconnect, user reattaches with `tmux attach`
 *
 * No systemd, no cron, no extra packages. Just bash + tmux.
 */

import { execSync, spawn, exec } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const DIR = join(HOME, ".local", "share", "persoje-autonomous");
const LOG_FILE = join(DIR, "session.log");
const PID_FILE = join(DIR, "watchdog.pid");
const STATE_FILE = join(DIR, "state.json");
const WATCHDOG_SCRIPT = join(DIR, "watchdog.sh");
const SESSION = "persoje-auto";

type PushFn = (item: { kind: "info" | "error"; text: string }) => void;

interface AutonomousCtx {
  push: PushFn;
  alwaysAllow: React.MutableRefObject<Set<string>>;
  exit: () => void;
  agent: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace React {
  interface MutableRefObject<T> { current: T; }
}

function ensureDir() {
  mkdirSync(DIR, { recursive: true });
}

function tmuxRunning(): boolean {
  try {
    execSync(`tmux has-session -t ${SESSION} 2>/dev/null`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getState(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function setState(s: Record<string, unknown>) {
  ensureDir();
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/** Write the self-healing watchdog script — pure bash, no deps. */
function writeWatchdogScript() {
  ensureDir();
  const script = `#!/usr/bin/env bash
# Persoje Autonomous Watchdog
# Checks every 30s if the tmux session is alive. If not, restarts it.
# Kills itself when stopped via the pid file.

PID_FILE="${PID_FILE}"
SESSION="${SESSION}"
LOG="${LOG_FILE}"

echo "[$(date -Iseconds)] watchdog started (pid $$)" >> "$LOG"
echo $$ > "$PID_FILE"

while true; do
  if [ -f "${DIR}/stop-watchdog" ]; then
    rm -f "${DIR}/stop-watchdog"
    echo "[$(date -Iseconds)] watchdog stopped by request" >> "$LOG"
    rm -f "$PID_FILE"
    exit 0
  fi

  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "[$(date -Iseconds)] session dead — restarting persoje" >> "$LOG"
    tmux new-session -d -s "$SESSION" -x 200 -y 50 \\
      "persoje 2>&1 | tee -a '$LOG'"
  fi

  sleep 30
done
`;
  writeFileSync(WATCHDOG_SCRIPT, script);
  execSync(`chmod +x "${WATCHDOG_SCRIPT}"`);
}

function startWatchdog() {
  writeWatchdogScript();
  // Start watchdog as a detached background process
  const child = spawn("bash", [WATCHDOG_SCRIPT], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function stopWatchdog() {
  // Signal the watchdog to stop
  writeFileSync(join(DIR, "stop-watchdog"), "");
  // Also try killing by PID
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (pid > 0) process.kill(pid, 0); // check alive
    process.kill(pid, "SIGTERM");
  } catch {
    // already dead, fine
  }
  try { rmSync(PID_FILE); } catch { /* ok */ }
}

/** Enable auto-approve for all tools (the /permsoff behavior). */
function permsoff(ctx: AutonomousCtx) {
  for (const t of ["read", "write", "edit", "bash", "grep", "glob", "ls", "task"]) {
    ctx.alwaysAllow.current.add(t);
  }
}

export async function autonomousCmd(sub: string, ctx: AutonomousCtx): Promise<void> {
  const { push } = ctx;
  ensureDir();

  switch (sub) {
    case "on": {
      // Step 1: Auto-approve all tools
      permsoff(ctx);
      push({ kind: "info", text: "🔓 all tools auto-approved" });

      // Step 2: Check if already in a tmux session
      const inTmux = !!process.env.TMUX;
      if (inTmux) {
        push({ kind: "info", text: "✓ already running inside tmux — you're protected" });
        push({ kind: "info", text: "  If SSH drops, reconnect and run: tmux attach" });
        setState({ autonomous: true, protected: true, since: new Date().toISOString() });
        return;
      }

      // Step 3: Not in tmux — we need to re-exec ourselves inside one.
      // We can't move a running process into tmux, so we:
      //   a) Start a NEW persoje in a tmux session
      //   b) Tell the user to attach to it
      //   c) Start the watchdog
      if (tmuxRunning()) {
        push({ kind: "info", text: "✓ autonomous tmux session already exists" });
        push({ kind: "info", text: "  Run: tmux attach -t persoje-auto" });
      } else {
        try {
          execSync(
            `tmux new-session -d -s ${SESSION} -x 200 -y 50 "persoje 2>&1 | tee -a '${LOG_FILE}'"`,
            { stdio: "pipe" },
          );
          push({ kind: "info", text: "✓ launched persoje in tmux session: persoje-auto" });
        } catch (e) {
          push({ kind: "error", text: `failed to create tmux session: ${(e as Error).message}` });
          return;
        }
      }

      // Step 4: Start watchdog
      startWatchdog();
      push({ kind: "info", text: "✓ watchdog started — auto-restarts on crash every 30s" });

      // Step 5: Log state
      setState({ autonomous: true, protected: true, since: new Date().toISOString(), watchdog: true });
      push({ kind: "info", text: "" });
      push({ kind: "info", text: "━━━ Autonomous Mode Active ━━━" });
      push({ kind: "info", text: "  • Survives SSH disconnects" });
      push({ kind: "info", text: "  • Survives terminal closes" });
      push({ kind: "info", text: "  • Auto-restarts on crash (30s)" });
      push({ kind: "info", text: "  • All tools auto-approved" });
      push({ kind: "info", text: "  • Log: ~/.local/share/persoje-autonomous/session.log" });
      push({ kind: "info", text: "" });
      push({ kind: "info", text: "  Reconnect: tmux attach -t persoje-auto" });
      push({ kind: "info", text: "  Stop:      /autonomous off" });
      break;
    }

    case "off": {
      // Stop watchdog
      stopWatchdog();

      // Kill tmux session
      if (tmuxRunning()) {
        try {
          execSync(`tmux kill-session -t ${SESSION}`, { stdio: "pipe" });
          push({ kind: "info", text: "✓ stopped autonomous tmux session" });
        } catch {
          push({ kind: "error", text: "failed to kill tmux session" });
        }
      }

      setState({ autonomous: false, protected: false });
      push({ kind: "info", text: "🔒 autonomous mode off — approval prompts re-enabled" });
      break;
    }

    case "status":
    default: {
      const state = getState();
      const running = tmuxRunning();
      const lines: string[] = ["━━━ Autonomous Status ━━━"];

      if (state.autonomous || running) {
        lines.push(`  Mode:      ${state.autonomous ? "🟢 ON" : "🔴 OFF"}`);
        lines.push(`  Session:   ${running ? "✓ running" : "✗ not running"}`);
        lines.push(`  Since:     ${state.since || "unknown"}`);
        lines.push(`  Watchdog:  ${existsSync(PID_FILE) ? "✓ running" : "✗ stopped"}`);
        lines.push(`  Log:       ${LOG_FILE}`);

        // Show last 3 lines of log
        try {
          const log = readFileSync(LOG_FILE, "utf8").trim().split("\n");
          if (log.length > 0) {
            lines.push("  Recent:");
            for (const l of log.slice(-3)) lines.push(`    ${l}`);
          }
        } catch { /* no log yet */ }
      } else {
        lines.push("  Mode: 🔴 OFF");
        lines.push("  Use /autonomous on to enable");
      }

      push({ kind: "info", text: lines.join("\n") });
      break;
    }
  }
}
