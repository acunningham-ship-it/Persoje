import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { estimateTokens } from "../core/tokens.ts";

export interface Lesson {
  timestamp: number;
  task: string;
  error: string;
  lesson: string;
  model: string;
}

/**
 * JSONL-based lesson log. Each line is a JSON lesson object.
 * Handles corrupt/missing lines gracefully (skip them).
 */
export class LessonLog {
  constructor(private path: string) {}

  /** Append a lesson to the log (adds timestamp). */
  append(lesson: Omit<Lesson, "timestamp">): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const withTimestamp: Lesson = { ...lesson, timestamp: Date.now() };
    const line = JSON.stringify(withTimestamp);
    const current = existsSync(this.path) ? readFileSync(this.path, "utf-8") : "";
    const newContent = current ? `${current}\n${line}` : line;
    writeFileSync(this.path, newContent, "utf-8");
  }

  /** Get the most recent n lessons (newest first). */
  recent(n = 5): Lesson[] {
    const all = this.all();
    return all.slice(-n).reverse();
  }

  /** Get all lessons (skips corrupt lines gracefully). */
  all(): Lesson[] {
    if (!existsSync(this.path)) return [];
    try {
      const content = readFileSync(this.path, "utf-8");
      const lessons: Lesson[] = [];
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          lessons.push(JSON.parse(line) as Lesson);
        } catch {
          // Skip corrupt lines
        }
      }
      return lessons;
    } catch {
      return [];
    }
  }

  /**
   * Load lessons for session context: format as compact bullets,
   * newest-first, clipped to budget. Returns empty string if no lessons.
   */
  loadForSession(maxTokens: number): string {
    const lessons = this.recent();
    if (lessons.length === 0) return "";

    // Reverse to show newest first
    const reversed = [...lessons].reverse();
    let result = "";
    for (const lesson of reversed) {
      const bullet = `- [${lesson.model}] ${lesson.lesson}`;
      const candidate = result ? `${result}\n${bullet}` : bullet;
      if (estimateTokens(candidate) <= maxTokens) {
        result = candidate;
      } else {
        break;
      }
    }
    return result;
  }

  /** Replace all lessons with a new list. Used by consolidation. */
  replaceAll(lessons: Lesson[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const lines = lessons.map((l) => JSON.stringify(l));
    writeFileSync(this.path, lines.join("\n"), "utf-8");
  }
}
