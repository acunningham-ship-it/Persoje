/**
 * Classifying a chunk of terminal input.
 *
 * A terminal does not always deliver "text" and "Enter" as two events. When input is
 * pasted, or written by a driver like `tmux send-keys "text" Enter`, the terminal
 * coalesces them into ONE write. Ink then reports:
 *
 *     char="what is 2 plus 2\r"   key.return === false
 *
 * so a handler keyed on `key.return` never fires and the text silently accumulates in the
 * input instead of being submitted. Measured against a real terminal with an Ink probe.
 *
 * The distinction that matters is WHERE the newline is:
 *   - trailing only  -> a finished line. Submit it.
 *   - interior       -> a genuine multi-line paste. Insert whole; submitting line-by-line
 *                       mangles pasted code, which is why that branch exists at all.
 */

/** Bracketed-paste markers the terminal wraps a paste in; never part of the text. */
const PASTE_MARKERS = /\x1b\[20[01]~/g;

export function stripPasteMarkers(chunk: string): string {
  return chunk.replace(PASTE_MARKERS, "");
}

/**
 * True when the chunk is exactly one line followed by newline(s) — i.e. the terminal
 * merged a line of text with the Enter that ended it.
 */
export function isCompletedLine(chunk: string): boolean {
  return /^[^\n\r]+[\r\n]+$/.test(chunk);
}

/** The text of a completed line, without its trailing newline(s). */
export function completedLineText(chunk: string): string {
  return chunk.replace(/[\r\n]+$/, "");
}
