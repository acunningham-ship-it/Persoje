import { mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { ChatMessage } from "../models/openrouter.ts";

export const TRANSCRIPT_DIR = join(homedir(), ".config", "persoje", "transcripts");

export function transcriptPathFor(sessionId: string): string {
  return join(TRANSCRIPT_DIR, `${sessionId}.md`);
}

/**
 * Mirrors the full conversation to a human/AI-readable .md, appended per message.
 * This is the "swap to disk" for the goal-anchored context model: working context
 * stays lean (goal + recent + summary), and the complete record is always here for
 * the transcript tool to consult when the summary dropped a detail.
 */
export class TranscriptWriter {
  private path: string;

  constructor(sessionId: string) {
    this.path = transcriptPathFor(sessionId);
    mkdirSync(dirname(this.path), { recursive: true });
  }

  append(msg: ChatMessage): void {
    let block: string;
    if (msg.role === "user") {
      block = `\n## user\n${msg.content}\n`;
    } else if (msg.role === "assistant") {
      const calls =
        "tool_calls" in msg && msg.tool_calls?.length
          ? "\n" + msg.tool_calls.map((c) => `→ ${c.function.name}(${c.function.arguments})`).join("\n")
          : "";
      block = `\n## assistant\n${msg.content ?? ""}${calls}\n`;
    } else if (msg.role === "tool") {
      block = `\n### tool result\n\`\`\`\n${msg.content}\n\`\`\`\n`;
    } else {
      return; // system messages aren't part of the transcript
    }
    try {
      appendFileSync(this.path, block);
    } catch {
      // best-effort; a missing transcript only loses the escape hatch, not the session
    }
  }

  get filePath(): string {
    return this.path;
  }
}
