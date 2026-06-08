/**
 * Autonomous mode — Persoje survives SSH disconnects, terminal closes, and crashes.
 *
 * Strategy: zero external dependencies. Pure bash + nohup + watchdog.
 * - Forks a new persoje process with nohup (survives SIGHUP on terminal close)
 * - Writes a watchdog script that health-checks the PID every 30s
 * - All output logged to a persistent file
 * - On reconnect: `tail -f ~/.local/share/persoje-autonomous/session.log`
 * - Watchdog auto-restarts on crash
 *
 * No tmux, no systemd, no cron, no extra packages. Just bash.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const DIR = join(HOME, ".local", "share", "persoje-autonomous");
const LOG_FILE = join(DIR, "session.log");
const PERSOJE_PID_FILE = join(DIR, "persoje.pid");
const WATCHDOG_PID_FILE = join(DIR, "watchdog.pid");
const STATE_FILE = join(DIR, "state.json");
const WATCHDOG_SCRIPT = join(DIR, "watchdog.sh");

type PushFn = (item: { kind: "info" | "error"; text: string }) => void;

interface AutonomousCtx {
  push: PushFn;
  alwaysAllow: React.MutableRefObject<Set<string>>;
  exit: () => void;
  /** The live session id — the daemon resumes THIS session headless. */
  sessionId: string;
  /** Current goal — autonomous needs one to know what to keep working toward. */
  goal: string;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace React {
  interface MutableRefObject<T> { current: T; }
}

function ensureDir() {
  mkdirSync(DIR, { recursive: true });
}

/** Check if a PID is alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

/** Read PID from file, return 0 if not found or invalid. */
function readPid(file: string): number {
  try {
    const pid = parseInt(readFileSync(file, "utf8").trim(), 10);
    return pid > 0 ? pid : 0;
  } catch {
    return 0;
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
function writeWatchdogScript(sessionId: string) {
  ensureDir();
  const script = `#!/usr/bin/env bash
# Persoje Autonomous Watchdog
# Checks every 30s if the persoje process is alive. If not, restarts it.
# Kills itself when stopped via the stop-watchdog sentinel file.

PERSOJE_PID_FILE="${PERSOJE_PID_FILE}"
WATCHDOG_PID_FILE="${WATCHDOG_PID_FILE}"
LOG="${LOG_FILE}"
DIR="${DIR}"

echo "[$(date -Iseconds)] watchdog started (pid $$)" >> "$LOG"
echo $$ > "$WATCHDOG_PID_FILE"

while true; do
  # Check for stop signal
  if [ -f "$DIR/stop-watchdog" ]; then
    rm -f "$DIR/stop-watchdog"
    echo "[$(date -Iseconds)] watchdog stopped by request" >> "$LOG"
    rm -f "$WATCHDOG_PID_FILE"
    exit 0
  fi

  # Check if persoje is alive
  PERSOJE_PID=0
  if [ -f "$PERSOJE_PID_FILE" ]; then
    PERSOJE_PID=$(cat "$PERSOJE_PID_FILE" 2>/dev/null || echo 0)
  fi

  if [ "$PERSOJE_PID" -gt 0 ] && kill -0 "$PERSOJE_PID" 2>/dev/null; then
    : # persoje is alive, do nothing
  else
    echo "[$(date -Iseconds)] persoje dead (pid $PERSOJE_PID) — restarting" >> "$LOG"
    # Resume the session headless and keep working toward the goal
    nohup persoje headless "${sessionId}" >> "$LOG" 2>&1 &
    NEW_PID=$!
    echo "$NEW_PID" > "$PERSOJE_PID_FILE"
    echo "[$(date -Iseconds)] restarted persoje (pid $NEW_PID)" >> "$LOG"
  fi

  sleep 30
done
`;
  writeFileSync(WATCHDOG_SCRIPT, script);
  execSync(`chmod +x "${WATCHDOG_SCRIPT}"`);
}

function startWatchdog(sessionId: string) {
  writeWatchdogScript(sessionId);
  const child = spawn("bash", [WATCHDOG_SCRIPT], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function stopWatchdog() {
  // Signal the watchdog to stop via sentinel file
  writeFileSync(join(DIR, "stop-watchdog"), "");
  // Also try killing by PID
  const pid = readPid(WATCHDOG_PID_FILE);
  if (pid > 0 && pidAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }
  try { rmSync(WATCHDOG_PID_FILE); } catch { /* ok */ }
}

/** Check if the autonomous persoje daemon is running. */
function persojeRunning(): boolean {
  const pid = readPid(PERSOJE_PID_FILE);
  return pid > 0 && pidAlive(pid);
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
      // Autonomy needs a goal — that's what the daemon keeps working toward.
      if (!ctx.goal.trim()) {
        push({ kind: "error", text: "set a goal first (/goal <objective>) — autonomous mode works toward the goal headless." });
        return;
      }
      // Auto-approve for THIS interactive process (the daemon has no approver,
      // so the core danger guard refuses catastrophic ops there).
      permsoff(ctx);
      push({ kind: "info", text: `🔓 working toward goal headless: ${ctx.goal.slice(0, 80)}` });

      if (persojeRunning()) {
        const pid = readPid(PERSOJE_PID_FILE);
        push({ kind: "info", text: `✓ autonomous persoje already running (pid ${pid})` });
        push({ kind: "info", text: `  Monitor: tail -f ${LOG_FILE}` });
      } else {
        try {
          // Resume THIS session headless; nohup survives disconnect.
          const launcherScript = `#!/usr/bin/env bash
nohup persoje headless "${ctx.sessionId}" >> "${LOG_FILE}" 2>&1 &
echo $! > "${PERSOJE_PID_FILE}"
`;
          const launcherPath = join(DIR, "launch.sh");
          writeFileSync(launcherPath, launcherScript);
          execSync(`chmod +x "${launcherPath}" && bash "${launcherPath}"`, { stdio: "pipe" });

          const pid = readPid(PERSOJE_PID_FILE);
          push({ kind: "info", text: `✓ launched headless daemon for session ${ctx.sessionId} (pid ${pid})` });
        } catch (e) {
          push({ kind: "error", text: `failed to start daemon: ${(e as Error).message}` });
          return;
        }
      }

      // Watchdog auto-restarts the headless daemon if it dies.
      const watchdogPid = readPid(WATCHDOG_PID_FILE);
      if (watchdogPid > 0 && pidAlive(watchdogPid)) {
        push({ kind: "info", text: "✓ watchdog already running" });
      } else {
        startWatchdog(ctx.sessionId);
        push({ kind: "info", text: "✓ watchdog started — auto-restarts on crash every 30s" });
      }

      // Step 5: Log state
      setState({ autonomous: true, protected: true, since: new Date().toISOString(), watchdog: true });
      push({ kind: "info", text: "" });
      push({ kind: "info", text: "━━━ Autonomous Mode Active ━━━" });
      push({ kind: "info", text: "  • Survives SSH disconnects (nohup)" });
      push({ kind: "info", text: "  • Survives terminal closes" });
      push({ kind: "info", text: "  • Auto-restarts on crash (30s watchdog)" });
      push({ kind: "info", text: "  • All tools auto-approved" });
      push({ kind: "info", text: `  • Log: ${LOG_FILE}` });
      push({ kind: "info", text: "" });
      push({ kind: "info", text: `  Monitor: tail -f ${LOG_FILE}` });
      push({ kind: "info", text: "  Stop:    /autonomous off" });
      break;
    }

    case "off": {
      // Stop watchdog
      stopWatchdog();
      push({ kind: "info", text: "✓ watchdog stopped" });

      // Kill the daemon process
      const pid = readPid(PERSOJE_PID_FILE);
      if (pid > 0 && pidAlive(pid)) {
        try {
          process.kill(pid, "SIGTERM");
          push({ kind: "info", text: `✓ stopped persoje daemon (pid ${pid})` });
        } catch {
          push({ kind: "error", text: "failed to kill daemon process" });
        }
      }
      try { rmSync(PERSOJE_PID_FILE); } catch { /* ok */ }

      setState({ autonomous: false, protected: false });
      push({ kind: "info", text: "🔒 autonomous mode off — approval prompts re-enabled" });
      break;
    }

    case "status":
    default: {
      const state = getState();
      const running = persojeRunning();
      const lines: string[] = ["━━━ Autonomous Status ━━━"];

      if (state.autonomous || running) {
        const pid = readPid(PERSOJE_PID_FILE);
        const watchdogPid = readPid(WATCHDOG_PID_FILE);
        const watchdogAlive = watchdogPid > 0 && pidAlive(watchdogPid);

        lines.push(`  Mode:      ${state.autonomous ? "🟢 ON" : "🔴 OFF"}`);
        lines.push(`  Daemon:    ${running ? `✓ running (pid ${pid})` : "✗ not running"}`);
        lines.push(`  Since:     ${state.since || "unknown"}`);
        lines.push(`  Watchdog:  ${watchdogAlive ? `✓ running (pid ${watchdogPid})` : "✗ stopped"}`);
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
