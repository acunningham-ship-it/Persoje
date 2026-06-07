import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

let configured = false;

/** Render markdown → ANSI for terminal display. Falls back to raw text on any failure. */
export function renderMarkdown(text: string): string {
  try {
    if (!configured) {
      marked.use(markedTerminal({ reflowText: false }) as any);
      configured = true;
    }
    return (marked.parse(text) as string).trimEnd();
  } catch {
    return text;
  }
}
