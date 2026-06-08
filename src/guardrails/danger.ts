import { resolve } from "node:path";
import { homedir } from "node:os";

/**
 * The hard floor under autonomy. No matter the trust level — even full yolo /
 * permsoff — these operations ALWAYS require explicit confirmation, because a
 * weak model getting one of them wrong is unrecoverable (wiped repo, leaked
 * keys, force-pushed history). High-signal only: routine destructive ops inside
 * the project (rm -rf node_modules, git reset of a local file) are NOT flagged,
 * or yolo would be pointless.
 */
export interface DangerVerdict {
  dangerous: boolean;
  reason: string;
}

const SAFE: DangerVerdict = { dangerous: false, reason: "" };

const BASH_PATTERNS: Array<[RegExp, string]> = [
  [/\bsudo\b/, "sudo / privilege escalation"],
  [/\bmkfs\b/, "filesystem format (mkfs)"],
  [/\bdd\b[^|]*\bof=/, "raw disk write (dd of=)"],
  [/>\s*\/dev\/(sd|nvme|disk|hd)/, "write to raw disk device"],
  [/\b(shutdown|reboot|halt|poweroff)\b/, "shutdown / reboot"],
  [/\binit\s+[06]\b/, "init runlevel change"],
  [/:\s*\(\s*\)\s*\{[^}]*:[^}]*\}\s*;\s*:/, "fork bomb"],
  [/\b(curl|wget)\b[^|;]*\|\s*(sudo\s+)?\w*sh\b/, "pipe-to-shell (curl … | sh)"],
  [/\bgit\s+push\b[^&|;]*(--force(-with-lease)?\b|\s-f\b)/, "git force-push"],
  [/\bgit\s+reset\s+--hard\b/, "git reset --hard (discards changes)"],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, "git clean -f (deletes untracked files)"],
  [/\bchmod\s+(-R\s+)?[0-7]*777\b/, "chmod 777"],
  [/\bchown\s+-R\b/, "recursive chown"],
  [/\bfind\b[^|;]*-delete\b/, "find … -delete"],
  [/\b(npm|yarn|pnpm|bun)\s+publish\b/, "package publish"],
  [/\bkillall\b|\bkill\s+-9\s+-1\b/, "mass process kill"],
];

/** rm is only catastrophic when its target is root/home or escapes the project. */
function rmDanger(cmd: string, cwd: string): string | null {
  if (!/\brm\b/.test(cmd)) return null;
  const recursive = /\brm\b[^|;&]*\s-[a-zA-Z]*[rR]/.test(cmd) || /\brm\b[^|;&]*--recursive/.test(cmd);
  const home = homedir();
  // Collect bare (non-flag) tokens after each `rm`.
  const targets: string[] = [];
  for (const seg of cmd.split(/[|;&]+/)) {
    const mm = seg.match(/\brm\b(.*)/);
    if (!mm) continue;
    for (const tok of (mm[1] ?? "").trim().split(/\s+/)) {
      if (tok && !tok.startsWith("-")) targets.push(tok);
    }
  }
  for (const t of targets) {
    if (["/", "/*", "~", "~/", "$HOME", "$HOME/", "~/*", "$HOME/*", ".."].includes(t)) return `rm targeting ${t}`;
    const abs = resolve(cwd, t.replace(/^~/, home).replace(/^\$HOME/, home));
    if (recursive && /^(\/|~|\$HOME)/.test(t) && abs !== cwd && !abs.startsWith(cwd + "/")) {
      return `recursive rm outside the project (${t})`;
    }
  }
  return null;
}

/** Writes/edits to secrets, shell configs, or anywhere outside the project. */
function pathDanger(p: string, cwd: string): string | null {
  if (!p) return null;
  const home = homedir();
  const abs = resolve(cwd, p.replace(/^~/, home));
  if (/(^|\/)\.(ssh|aws|gnupg)\//.test(abs)) return "credentials directory";
  if (/\.env($|\.)|\.pem$|\bid_(rsa|ed25519)\b|(^|\/)credentials$|\.git-credentials$|(^|\/)\.npmrc$/.test(abs))
    return "secret / credential file";
  if (/(^|\/)\.(bashrc|bash_profile|zshrc|profile)$/.test(abs)) return "shell startup file";
  if (/^\/(etc|usr|bin|sbin|boot|sys|proc)\//.test(abs)) return "system path";
  if (abs !== cwd && !abs.startsWith(cwd + "/")) return "path outside the project directory";
  return null;
}

export function assessDanger(name: string, args: Record<string, unknown>, cwd: string): DangerVerdict {
  if (name === "bash") {
    const cmd = String(args.command ?? "");
    const rm = rmDanger(cmd, cwd);
    if (rm) return { dangerous: true, reason: rm };
    for (const [re, reason] of BASH_PATTERNS) if (re.test(cmd)) return { dangerous: true, reason };
    return SAFE;
  }
  if (name === "write" || name === "edit" || name === "multi_edit") {
    const pd = pathDanger(String(args.path ?? ""), cwd);
    if (pd) return { dangerous: true, reason: pd };
  }
  return SAFE;
}
