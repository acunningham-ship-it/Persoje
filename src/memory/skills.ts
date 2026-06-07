import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import MiniSearch from "minisearch";
import { estimateTokens } from "../core/tokens.ts";

export interface SkillMeta {
  name: string;
  description: string;
}

export interface SkillResult extends SkillMeta {
  content: string;
}

interface SkillDocument {
  id: string;
  name: string;
  description: string;
  content: string;
}

/**
 * Markdown-based skill library. Stores skills as name.md files
 * with format: first line "# name: one-line description", rest is content.
 */
export class SkillLibrary {
  private dir: string;
  private index: MiniSearch<SkillDocument> | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** List all skills. */
  list(): SkillMeta[] {
    mkdirSync(this.dir, { recursive: true });
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith(".md"));
      const skills: SkillMeta[] = [];
      for (const file of files) {
        const content = readFileSync(join(this.dir, file), "utf-8");
        const [titleLine] = content.split("\n");
        if (titleLine?.startsWith("#")) {
          const match = titleLine.match(/^#\s+([^:]+):\s*(.*)/);
          if (match && match[1] && match[2]) {
            skills.push({ name: match[1], description: match[2] });
          }
        }
      }
      return skills;
    } catch {
      return [];
    }
  }

  /** Add a skill (name, description, body). */
  add(name: string, description: string, body: string): void {
    mkdirSync(this.dir, { recursive: true });
    const fileName = `${name.replace(/\s+/g, "-").toLowerCase()}.md`;
    const content = `# ${name}: ${description}\n${body}`;
    writeFileSync(join(this.dir, fileName), content, "utf-8");
    // Invalidate index
    this.index = null;
  }

  /**
   * Search for skills using minisearch (BM25-ish).
   * Returns top K results, skipping weak-relevance hits.
   */
  search(query: string, topK = 2): SkillResult[] {
    if (!query.trim()) return [];

    // Build index if not present
    if (!this.index) {
      this.index = new MiniSearch({
        fields: ["name", "description", "content"],
        storeFields: ["name", "description", "content"],
        idField: "id",
      });

      const skills = this.list();
      for (let i = 0; i < skills.length; i++) {
        const skill = skills[i];
        if (!skill) continue;
        const filePath = join(
          this.dir,
          `${skill.name.replace(/\s+/g, "-").toLowerCase()}.md`,
        );
        const content = readFileSync(filePath, "utf-8");
        this.index.add({
          id: `skill-${i}`,
          name: skill.name,
          description: skill.description,
          content,
        });
      }
    }

    const results = this.index.search(query, { prefix: true });
    // Score threshold: minisearch scores can be low; keep only reasonably relevant hits (>0.1)
    const threshold = 0.1;
    return results
      .filter((r) => r.score > threshold)
      .slice(0, topK)
      .map((r) => {
        const doc = r as unknown as SkillDocument;
        return {
          name: doc.name,
          description: doc.description,
          content: doc.content,
        };
      });
  }

  /**
   * Inject skills relevant to the task, clipped to token budget.
   * Returns formatted markdown concatenation of top hits, or empty string.
   */
  injectFor(taskText: string, maxTokens: number): string {
    if (!taskText.trim()) return "";

    const results = this.search(taskText);
    if (results.length === 0) return "";

    let injected = "";
    for (const skill of results) {
      const skillContent = `## ${skill.name}\n${skill.description}\n\n${skill.content}`;
      const candidate = injected ? `${injected}\n\n${skillContent}` : skillContent;
      if (estimateTokens(candidate) <= maxTokens) {
        injected = candidate;
      } else {
        break;
      }
    }
    return injected;
  }
}
