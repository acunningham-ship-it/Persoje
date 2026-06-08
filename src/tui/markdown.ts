import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
// cli-highlight is used internally by marked-terminal for fenced code blocks
// (gated on a color-capable TTY). Listed as a direct dep so it's bundled into
// the compiled binary.
import "cli-highlight";

let configured = false;

/** Render markdown → ANSI for terminal display. Falls back to raw text on any failure. */
export function renderMarkdown(text: string): string {
  try {
    if (!configured) {
      marked.use(markedTerminal({ reflowText: false, tab: 2 }) as any);
      configured = true;
    }
    // marked-terminal pads everything with double newlines — collapse the air
    // out of it so replies read as prose, not a sparse wall.
    return (marked.parse(text) as string).replace(/\n{2,}/g, "\n\n").replace(/[ \t]+$/gm, "").trim();
  } catch {
    return text;
  }
}
