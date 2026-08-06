/**
 * Monitors — background watchers that fire mid-conversation.
 *
 * A monitor is a named, periodic check (shell command) that runs between
 * tool-call iterations inside the agent loop. When it fires (non-zero exit
 * or non-empty stderr), a MonitorEvent is injected into the agent's context
 * so the agent can see and handle it during the active session.
 *
 * Usage from the TUI:
 *   /monitor add n8n-health "curl -sf localhost:5678/healthz" 30
 *   /monitor list
 *   /monitor rm n8n-health
 *
 * Monitors persist to ~/.config/persoje/monitors.json and survive restarts.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";

export interface MonitorConfig {
  /** Unique name, kebab-case, e.g. "n8n-health" */
  name: string;
  /** Shell command to run. Non-zero exit = alert. */
  cmd: string;
  /** Minimum interval between checks in seconds (default 30) */
  intervalSec: number;
  /** Optional cooldown: don't fire again for this many seconds (default = intervalSec) */
  cooldownSec: number;
  /** Human-readable description of what this monitors */
  description: string;
  /** Whether this monitor is active */
  enabled: boolean;
}

export interface MonitorState {
  config: MonitorConfig;
  /** Last time we checked (epoch ms) */
  lastCheck: number;
  /** Last time this monitor fired (epoch ms) — for cooldown */
  lastFired: number;
  /** Number of times it has fired */
  fireCount: number;
  /** Last output (stdout) */
  lastOutput: string;
  /** Last error (stderr) */
  lastError: string;
  /** Last exit code (null = not yet run) */
  lastExitCode: number | null;
}

export interface MonitorTick {
  /** The monitor that fired */
  name: string;
  /** Its stdout output */
  output: string;
  /** Its stderr */
  error: string;
  /** Exit code */
  exitCode: number;
  /** Whether this is a new fire (non-zero exit or stderr) vs a clean check */
  fired: boolean;
}

// PERSOJE_CONFIG_DIR overrides the base dir — see mcp/client.ts's mcpConfigPath
// for why this is a function, not a module-load-time const (vault task #13).
function monitorsPath(): string {
  return join(process.env.PERSOJE_CONFIG_DIR || join(homedir(), ".config", "persoje"), "monitors.json");
}

function loadMonitors(): MonitorState[] {
  try {
    const path = monitorsPath();
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // Corrupted file — start fresh
  }
  return [];
}

function saveMonitors(monitors: MonitorState[]): void {
  const path = monitorsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(monitors, null, 2), "utf-8");
}

export class MonitorManager {
  private monitors: MonitorState[] = [];
  /** Running child processes keyed by monitor name, so we can kill them. */
  private running = new Map<string, { process: ReturnType<typeof spawn>; started: number }>();

  constructor() {
    this.monitors = loadMonitors();
  }

  /** Add a new monitor. Replaces one with the same name. */
  add(config: MonitorConfig): void {
    const existing = this.monitors.findIndex((m) => m.config.name === config.name);
    const state: MonitorState = {
      config,
      lastCheck: 0,
      lastFired: 0,
      fireCount: 0,
      lastOutput: "",
      lastError: "",
      lastExitCode: null,
    };
    if (existing >= 0) {
      // Preserve fire history across config updates (existing >= 0 ⇒ defined)
      const old = this.monitors[existing]!;
      state.fireCount = old.fireCount;
      state.lastFired = old.lastFired;
      this.monitors[existing] = state;
    } else {
      this.monitors.push(state);
    }
    saveMonitors(this.monitors);
  }

  /** Remove a monitor by name. Returns true if found. */
  remove(name: string): boolean {
    const idx = this.monitors.findIndex((m) => m.config.name === name);
    if (idx < 0) return false;
    this.monitors.splice(idx, 1);
    this.running.delete(name);
    saveMonitors(this.monitors);
    return true;
  }

  /** List all monitors. */
  list(): MonitorState[] {
    return this.monitors;
  }

  /** Get a single monitor by name. */
  get(name: string): MonitorState | undefined {
    return this.monitors.find((m) => m.config.name === name);
  }

  /** Enable/disable a monitor. */
  setEnabled(name: string, enabled: boolean): boolean {
    const m = this.monitors.find((m) => m.config.name === name);
    if (!m) return false;
    m.config.enabled = enabled;
    saveMonitors(this.monitors);
    return true;
  }

  /**
   * Check all monitors whose interval has elapsed.
   * Returns an array of MonitorTick for any that FIRED (non-zero exit or
   * non-empty stderr), respecting cooldown.
   *
   * This is called from the agent loop between iterations. It's async and
   * runs checks concurrently (up to 4 at a time).
   */
  async checkAll(): Promise<MonitorTick[]> {
    const now = Date.now();
    const due = this.monitors.filter((m) => {
      if (!m.config.enabled) return false;
      // Don't re-check if a check is already running
      if (this.running.has(m.config.name)) return false;
      return now - m.lastCheck >= m.config.intervalSec * 1000;
    });

    if (due.length === 0) return [];

    const results = await Promise.all(
      due.map((m) => this.checkOne(m))
    );

    return results.filter((r): r is MonitorTick => r !== null);
  }

  /**
   * Check a single monitor. Returns a MonitorTick if it fired, null otherwise.
   * Safe to call concurrently.
   */
  private async checkOne(m: MonitorState): Promise<MonitorTick | null> {
    const now = Date.now();
    m.lastCheck = now;

    try {
      const result = await this.runCmd(m.config.cmd);
      m.lastOutput = result.stdout;
      m.lastError = result.stderr;
      m.lastExitCode = result.exitCode;

      const fired = result.exitCode !== 0 || result.stderr.trim().length > 0;

      if (fired) {
        // Check cooldown
        if (now - m.lastFired < m.config.cooldownSec * 1000) {
          return null; // Still in cooldown
        }
        m.lastFired = now;
        m.fireCount++;
        saveMonitors(this.monitors);
        return {
          name: m.config.name,
          output: result.stdout,
          error: result.stderr,
          exitCode: result.exitCode,
          fired: true,
        };
      }
    } catch (e) {
      m.lastError = (e as Error).message;
      m.lastExitCode = -1;
      // Error during execution counts as a fire
      if (now - m.lastFired >= m.config.cooldownSec * 1000) {
        m.lastFired = now;
        m.fireCount++;
        saveMonitors(this.monitors);
        return {
          name: m.config.name,
          output: "",
          error: (e as Error).message,
          exitCode: -1,
          fired: true,
        };
      }
    }

    saveMonitors(this.monitors);
    return null;
  }

  /**
   * Run a shell command with a 10s timeout.
   */
  private runCmd(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn("bash", ["-c", cmd], {
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const key = `${cmd.slice(0, 40)}...`;
      this.running.set(key, { process: proc, started: Date.now() });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        // Give it a second to die, then SIGKILL
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
        }, 1000);
      }, 10_000);

      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      proc.on("close", (code) => {
        clearTimeout(timer);
        this.running.delete(key);
        if (timedOut) {
          reject(new Error(`Monitor timed out after 10s: ${cmd.slice(0, 60)}`));
        } else {
          resolve({ stdout, stderr, exitCode: code ?? -1 });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        this.running.delete(key);
        reject(err);
      });
    });
  }

  /** Kill any running monitor processes. */
  dispose(): void {
    for (const [key, { process: proc }] of this.running) {
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 500);
    }
    this.running.clear();
  }
}

/** Singleton for the session */
let _instance: MonitorManager | null = null;

export function getMonitorManager(): MonitorManager {
  if (!_instance) _instance = new MonitorManager();
  return _instance;
}