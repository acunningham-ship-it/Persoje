/**
 * One-line, human-readable summary of a tool call for the UI.
 *
 * Both UIs used to print `JSON.stringify(args)` truncated at 120 chars, which meant a
 * `write` dumped the file's CONTENT into the transcript:
 *
 *   ⚙ write {"path":"a.txt","content":"line one\nline two"}
 *
 * For a real edit that is a wall of text with the one useful token — the path — buried at
 * the front and the rest pure noise. The reader wants "what did it touch", not the payload.
 *
 *   ⚙ write a.txt · 2 lines
 *
 * Pure string formatting, no Ink and no chalk, so `core` stays UI-agnostic and the Ink TUI
 * and the plain REPL can share exactly one implementation instead of drifting apart.
 */

/** Args arrive from the model, so assume nothing: any key may be missing or the wrong type. */
type Args = Record<string, unknown> | null | undefined;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Collapse a path to something readable without losing which file it is. */
function shortPath(p: string, max = 48): string {
  if (p.length <= max) return p;
  const parts = p.split("/");
  if (parts.length <= 2) return "…" + p.slice(-(max - 1));
  // Keep the last two segments — the filename plus its directory is what identifies it.
  const tail = parts.slice(-2).join("/");
  return tail.length >= max ? "…" + tail.slice(-(max - 1)) : "…/" + tail;
}

/** A one-line preview of free text (a command, a pattern), with newlines flattened. */
function oneLine(s: string, max = 60): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

function lineCount(s: string): number {
  return s === "" ? 0 : s.split("\n").length;
}

/**
 * @returns the detail shown after the tool name, or "" when the tool takes no
 * arguments worth showing. Never throws — a summary is cosmetic and must not be
 * able to break a turn.
 */
export function summarizeToolArgs(name: string, args: Args): string {
  try {
    const a = (args ?? {}) as Record<string, unknown>;
    const path = str(a.path) ?? str(a.file_path) ?? str(a.file);

    switch (name) {
      case "read": {
        const range = typeof a.offset === "number" ? ` @${a.offset}` : "";
        return path ? shortPath(path) + range : "";
      }
      case "write": {
        const content = str(a.content) ?? "";
        const n = lineCount(content);
        return path ? `${shortPath(path)} · ${n} line${n === 1 ? "" : "s"}` : "";
      }
      case "edit":
      case "multi_edit": {
        // Show WHICH file and how many edits, never the replacement text — that is the
        // thing the diff renderer exists to show properly.
        const edits = Array.isArray(a.edits) ? a.edits.length : 1;
        return path ? `${shortPath(path)}${edits > 1 ? ` · ${edits} edits` : ""}` : "";
      }
      case "bash": {
        const cmd = str(a.command) ?? str(a.cmd);
        return cmd ? oneLine(cmd) : "";
      }
      case "grep": {
        const pat = str(a.pattern) ?? str(a.query);
        const where = str(a.path) ?? str(a.glob);
        return pat ? `"${oneLine(pat, 32)}"${where ? ` in ${shortPath(where, 28)}` : ""}` : "";
      }
      case "glob":
        return str(a.pattern) ? oneLine(str(a.pattern)!, 40) : "";
      case "ls":
        return path ? shortPath(path) : "";
      case "web_fetch":
        return str(a.url) ? oneLine(str(a.url)!, 56) : "";
      case "web_search":
        return str(a.query) ? `"${oneLine(str(a.query)!, 44)}"` : "";
      case "task": {
        // The TUI's own summarizer read `task`, this one read `description`. Neither was
        // wrong — the key has varied — so accept both rather than silently rendering
        // nothing for whichever spelling the caller happens to use.
        const t = str(a.description) ?? str(a.task) ?? str(a.prompt);
        return t ? oneLine(t, 52) : "";
      }
      default: {
        // Unknown tool: fall back to the most identifying scalar rather than the whole
        // object. A nested blob tells the reader nothing at a glance.
        if (path) return shortPath(path);
        for (const k of ["name", "query", "pattern", "command", "url", "id"]) {
          const v = str(a[k]);
          if (v) return oneLine(v, 48);
        }
        const keys = Object.keys(a);
        return keys.length ? `${keys.length} arg${keys.length === 1 ? "" : "s"}` : "";
      }
    }
  } catch {
    return ""; // cosmetic only — never let a summary break a turn
  }
}

/** Full display line minus styling: `write a.txt · 2 lines`. */
export function formatToolCall(name: string, args: Args): string {
  const detail = summarizeToolArgs(name, args);
  return detail ? `${name} ${detail}` : name;
}
