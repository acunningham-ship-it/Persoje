import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { estimateTokens } from "../core/tokens.ts";

/** Facts are self-referential markdown: first line is title, rest is body. */
export interface Fact {
  title: string;
  body: string;
}

/** Convert title to filename slug: lowercase, replace spaces/special chars with hyphens. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .slice(0, 40);
}

/**
 * File-based fact store. Stores facts in a dir with MEMORY.md index
 * and one .md file per fact, plus model-quirks.json for model-specific quirks.
 */
export class FactStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Get the MEMORY.md index or empty string if not present. */
  index(): string {
    const path = join(this.dir, "MEMORY.md");
    if (!existsSync(path)) return "";
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return "";
    }
  }

  /**
   * Load the index (MEMORY.md) clipped to a token budget.
   * Facts are fetched lazily by the agent via the read tool.
   */
  loadForSession(maxTokens: number): string {
    const idx = this.index();
    if (!idx) return "";
    const tokens = estimateTokens(idx);
    if (tokens > maxTokens) {
      // Clip lines from the end to fit budget
      const lines = idx.split("\n");
      let result = "";
      for (const line of lines) {
        const candidate = result ? `${result}\n${line}` : line;
        if (estimateTokens(candidate) <= maxTokens) {
          result = candidate;
        } else {
          break;
        }
      }
      return result;
    }
    return idx;
  }

  /**
   * Add a fact: slugify title, write file, append index line if not present.
   * Returns the path to the fact file.
   */
  addFact(title: string, body: string): string {
    mkdirSync(this.dir, { recursive: true });

    const slug = slugify(title);
    const path = join(this.dir, `${slug}.md`);

    // Write the fact file: first line is title, rest is body.
    const content = `# ${title}\n${body}`;
    writeFileSync(path, content, "utf-8");

    // Update MEMORY.md index if the slug isn't already listed.
    const idx = this.index();
    const indexLine = `- [${title}](${slug}.md) — `;
    if (!idx.includes(indexLine) && !idx.includes(`(${slug}.md)`)) {
      const newIndex = idx ? `${idx}\n${indexLine}` : indexLine;
      const indexPath = join(this.dir, "MEMORY.md");
      writeFileSync(indexPath, newIndex, "utf-8");
    }

    return path;
  }

  /** Get a fact by slug; returns null if not found. */
  getFact(slug: string): Fact | null {
    const path = join(this.dir, `${slug}.md`);
    if (!existsSync(path)) return null;
    try {
      const content = readFileSync(path, "utf-8");
      const lines = content.split("\n");
      const titleLine = lines[0] ?? "";
      const title = titleLine.replace(/^#\s*/, "");
      const body = lines.slice(1).join("\n").trim();
      return { title, body };
    } catch {
      return null;
    }
  }

  /** Remove a fact by slug. */
  removeFact(slug: string): void {
    const path = join(this.dir, `${slug}.md`);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        // Ignore if already gone
      }
    }

    // Remove from index
    const indexPath = join(this.dir, "MEMORY.md");
    if (existsSync(indexPath)) {
      const idx = readFileSync(indexPath, "utf-8");
      const lines = idx.split("\n").filter((line) => !line.includes(`(${slug}.md)`));
      writeFileSync(indexPath, lines.join("\n"), "utf-8");
    }
  }

  /** Get model-specific quirks. */
  getQuirks(modelId: string): string[] {
    const quirksPath = join(this.dir, "model-quirks.json");
    if (!existsSync(quirksPath)) return [];
    try {
      const content = JSON.parse(readFileSync(quirksPath, "utf-8")) as Record<string, string[]>;
      return content[modelId] ?? [];
    } catch {
      return [];
    }
  }

  /** Add a quirk to a model (dedup, cap at 8 per model). */
  addQuirk(modelId: string, quirk: string): void {
    mkdirSync(this.dir, { recursive: true });

    const quirksPath = join(this.dir, "model-quirks.json");
    let quirks: Record<string, string[]> = {};
    if (existsSync(quirksPath)) {
      try {
        quirks = JSON.parse(readFileSync(quirksPath, "utf-8"));
      } catch {
        quirks = {};
      }
    }

    const modelQuirks = quirks[modelId] ?? [];
    if (!modelQuirks.includes(quirk)) {
      modelQuirks.push(quirk);
      if (modelQuirks.length > 8) {
        modelQuirks.pop(); // Keep only 8 most recent
      }
    }
    quirks[modelId] = modelQuirks;
    writeFileSync(quirksPath, JSON.stringify(quirks, null, 2), "utf-8");
  }
}
