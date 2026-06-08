/**
 * Edit matching with a safety-first flexible fallback.
 *
 * The single most common weak-model edit failure isn't bad logic — it's an
 * `old_string` that's *almost* right: a trailing space the model didn't copy,
 * or indentation off by a few columns. Exact-match-only turns that into a retry
 * loop that burns tokens. So: try exact first, then fall back to a line-level
 * match that ignores trailing whitespace, then one that ignores indentation —
 * but only ever apply a fallback when it matches EXACTLY ONCE. A non-unique
 * fuzzy match is refused, never guessed, so we can't silently edit the wrong
 * place.
 */

export type MatchHow = "exact" | "trailing-space" | "indentation";

export interface FlexMatch {
  /** The exact substring of `content` to replace. */
  original: string;
  /** Character offset of `original` in `content` — so the caller splices the
   *  matched span exactly, never a same-looking substring at an earlier spot. */
  index: number;
  how: MatchHow;
}

/** Strip a single trailing newline-induced empty element from a split block. */
function trimTrailingBlank(lines: string[]): string[] {
  const out = lines.slice();
  if (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * Locate the text to replace. Returns the original substring + how it matched,
 * "ambiguous" if a fallback level matched more than once, or null if no match.
 * Exact matches are reported by the caller's own counting — this handles only
 * the line-based fallbacks (so it always works on whole-line boundaries).
 */
export function flexibleMatch(content: string, oldStr: string): FlexMatch | "ambiguous" | null {
  const cLines = content.split("\n");
  const oLines = trimTrailingBlank(oldStr.split("\n"));
  const k = oLines.length;
  if (k === 0 || (k === 1 && oLines[0] === "")) return null;

  const levels: Array<[MatchHow, (s: string) => string]> = [
    ["trailing-space", (s) => s.replace(/[ \t]+$/, "")],
    ["indentation", (s) => s.trim()],
  ];

  for (const [how, norm] of levels) {
    const normO = oLines.map(norm);
    const hits: number[] = [];
    for (let i = 0; i + k <= cLines.length; i++) {
      let ok = true;
      for (let j = 0; j < k; j++) {
        if (norm(cLines[i + j]!) !== normO[j]) {
          ok = false;
          break;
        }
      }
      if (ok) hits.push(i);
    }
    if (hits.length === 1) {
      const i = hits[0]!;
      // Char offset of line i = sum of preceding line lengths + their newlines.
      let index = 0;
      for (let j = 0; j < i; j++) index += cLines[j]!.length + 1;
      return { original: cLines.slice(i, i + k).join("\n"), index, how };
    }
    if (hits.length > 1) return "ambiguous";
  }
  return null;
}

export type ApplyResult =
  | { ok: true; content: string; how: MatchHow; count: number }
  | { ok: false; reason: "missing" | "ambiguous-exact" | "ambiguous-flex"; count: number };

/**
 * Apply one search/replace to a string, with the same exact-then-flexible logic
 * the edit tool uses. Pure: returns the new content or a structured failure, so
 * both `edit` (one) and `multi_edit` (many, atomic) share exactly one code path.
 * `count` is the exact-match occurrence count (for messaging).
 */
export function applyEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll = false,
): ApplyResult {
  const count = content.split(oldStr).length - 1;
  if (count > 1 && !replaceAll) return { ok: false, reason: "ambiguous-exact", count };
  if (count >= 1) {
    const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    return { ok: true, content: updated, how: "exact", count: replaceAll ? count : 1 };
  }
  const flex = flexibleMatch(content, oldStr);
  if (flex === "ambiguous") return { ok: false, reason: "ambiguous-flex", count: 0 };
  if (flex) {
    // Splice at the matched offset — NOT content.replace(), which would hit the
    // first same-looking substring (e.g. inside a longer line) earlier in the file.
    const updated = content.slice(0, flex.index) + newStr + content.slice(flex.index + flex.original.length);
    return { ok: true, content: updated, how: flex.how, count: 1 };
  }
  return { ok: false, reason: "missing", count: 0 };
}

/**
 * Build a short "did you mean here?" hint when nothing matched at all: find the
 * content lines whose trimmed text equals the trimmed first/any line of the
 * target, and show them with line numbers so the model can re-copy precisely.
 */
export function nearMatchHint(content: string, oldStr: string, maxLines = 6): string {
  const cLines = content.split("\n");
  const firstO = trimTrailingBlank(oldStr.split("\n"))[0]?.trim();
  if (!firstO) return "";
  const needle = firstO.length > 12 ? firstO.slice(0, 12) : firstO;
  const hits: string[] = [];
  for (let i = 0; i < cLines.length && hits.length < maxLines; i++) {
    const line = cLines[i]!;
    if (line.trim() === firstO || (needle.length >= 4 && line.includes(needle))) {
      hits.push(`${i + 1}: ${line}`);
    }
  }
  return hits.length ? `\nNearest lines in the file:\n${hits.join("\n")}` : "";
}
