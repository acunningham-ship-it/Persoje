/**
 * Auto-update — runs BEFORE the app launches.
 *
 * Flow:
 * 1. Find the git repo root
 * 2. `git fetch origin` (quiet, 15s timeout)
 * 3. Compare local HEAD vs origin/<branch>
 * 4. If behind: `git pull --ff-only` + rebuild binary
 * 5. If we updated: `execv` the new binary (replaces current process — no restart needed)
 *
 * This is a BLOCKING pre-launch step. The user sees a brief "updating…" message
 * only when an update is actually applied. When already up-to-date, it's silent
 * and takes ~1-2s (just the fetch).
 *
 * Safety:
 * - Only `git pull --ff-only` (never merge/rebase)
 * - Only runs if working tree is clean
 * - Timeouts on all git ops (never hangs)
 * - `--no-update` flag skips entirely
 * - If fetch fails (offline), silently continues with current version
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const CHECK_STAMP = join(homedir(), ".config", "persoje", ".last-update-check");
const CHECK_THROTTLE_MS = 4 * 60 * 60 * 1000; // at most once per 4h — keep launches fast

/** Find the project root by walking up looking for .git */
export function findProjectRoot(): string | null {
  let dir = import.meta.dir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: check common locations
  const home = homedir();
  const candidates = [
    join(home, "projects", "persoje"),
    join(home, "src", "persoje"),
    join(home, "persoje"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, ".git"))) return c;
  }
  return null;
}

function git(args: string, cwd: string, timeout = 10_000): string | null {
  try {
    return execSync(`git ${args}`, { cwd, timeout, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

export interface UpdateResult {
  updated: boolean;
  fromRev?: string;
  toRev?: string;
  skipped?: string; // reason it was skipped (offline, dirty, etc.)
}

/**
 * Pre-launch update check. BLOCKING — call before anything else.
 *
 * If an update is applied, this function does NOT return — it replaces
 * the current process with the newly built binary via process.execPath.
 * If no update is needed, returns silently.
 *
 * @param args - process.argv (checked for --no-update)
 * @param onStatus - callback for status messages (e.g., "checking for updates…")
 */
export async function preLaunchUpdate(args: string[], onStatus?: (msg: string) => void): Promise<void> {
  // Allow skipping
  if (args.includes("--no-update") || process.env.PERSOJE_NO_UPDATE) return;

  const root = findProjectRoot();
  if (!root) return; // not a git repo — skip silently

  // Throttle: at most one network check per CHECK_THROTTLE_MS so we don't add
  // a git fetch to the latency of every single launch.
  try {
    const last = parseInt(readFileSync(CHECK_STAMP, "utf8").trim(), 10);
    if (last && Date.now() - last < CHECK_THROTTLE_MS) return;
  } catch {
    // no stamp yet — proceed with the check
  }

  // Check working tree
  const status = git("status --porcelain", root);
  if (status === null || status !== "") return; // dirty or git failed — skip silently

  // Find current branch
  const branch = git("rev-parse --abbrev-ref HEAD", root);
  if (!branch) return;

  // Fetch
  onStatus?.("checking for updates…");
  const fetchResult = git(`fetch origin ${branch} --quiet`, root, 15_000);
  if (fetchResult === null) return; // offline — skip silently (retry next launch)
  // Record the check so the next few hours of launches stay network-free.
  try {
    writeFileSync(CHECK_STAMP, String(Date.now()));
  } catch {
    /* best-effort */
  }

  // Only update when we're genuinely BEHIND origin. Checking local !== remote
  // alone would fire during development (local ahead, unpushed) and spuriously
  // rebuild/re-exec on every launch. HEAD..origin counts commits we're missing.
  const behind = git(`rev-list --count HEAD..origin/${branch}`, root);
  if (!behind || behind === "0") return; // up to date or ahead — nothing to pull

  const local = git("rev-parse HEAD", root);
  const remote = git(`rev-parse origin/${branch}`, root);
  if (!local || !remote) return;

  // We're behind — pull + rebuild
  onStatus?.(`updating (${behind} commit${behind === "1" ? "" : "s"} behind)…`);

  const pull = git(`pull --ff-only origin ${branch}`, root, 30_000);
  if (pull === null) return; // diverged — skip silently

  // Rebuild the binary. Must match the install symlink target + the
  // `bun run compile` script (dist/persoje) so the update sticks for the
  // persistent `persoje` command, not just this re-exec'd session.
  try {
    execSync("bun build --compile --minify src/cli.ts --outfile dist/persoje", {
      cwd: root,
      timeout: 60_000,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch {
    return; // rebuild failed — skip silently, run old version
  }

  // The install symlink (~/.local/bin/persoje → <root>/dist/persoje) already
  // points at what we just rebuilt — no extra install step needed.

  onStatus?.(`updated ${local.slice(0, 7)} → ${remote.slice(0, 7)}`);

  // Replace current process with the new binary.
  // Bun's process.execPath points to the running binary.
  // We re-exec with the same args (minus --no-update if present).
  const cleanArgs = args.filter((a) => a !== "--no-update");
  try {
    // On Linux/macOS, Bun supports Bun.spawn + process.exit pattern,
    // but the cleanest approach is execv via spawn + exit:
    const binaryPath = resolve(root, "dist", "persoje");
    const proc = Bun.spawn([binaryPath, ...cleanArgs.slice(2)], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    process.exit(exitCode);
  } catch {
    // If exec fails, just continue with the current (old) version
    return;
  }
}
