import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import MiniSearch from "minisearch";
import { estimateTokens } from "../core/tokens.ts";

export interface SkillMeta {
  name: string;
  description: string;
  /** Token estimate for lazy loading decisions */
  tokenEstimate: number;
  /** Last time this skill was invoked (epoch ms) */
  lastUsed: number;
  /** Number of times this skill has been invoked */
  useCount: number;
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
 * Markdown-based skill library with lazy loading and self-learning.
 *
 * Skills are stored as .md files with metadata in YAML-like front matter:
 * ---
 * name: skill-name
 * description: one-line description
 * lastUsed: 1234567890
 * useCount: 5
 * ---
 * [skill body]
 *
 * Key design decisions:
 * - The AI sees skill NAMES + 1-sentence descriptions only (not full content)
 * - Full content is loaded ONLY when the skill is invoked
 * - Skills are auto-pruned: unused for 30 days → removed
 * - The AI can create new skills via the `add_skill` tool
 * - Skills can be invoked directly via /skillname
 */

const PRUNE_AFTER_DAYS = 30;
const MIN_USES_TO_KEEP = 1; // Skills never used get pruned first

export class SkillLibrary {
  private dir: string;
  private index: MiniSearch<SkillDocument> | null = null;
  /** Cache of loaded skill content (lazy — only loaded on invocation) */
  private contentCache = new Map<string, string>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** List all skills (metadata only — no content loaded). */
  list(): SkillMeta[] {
    mkdirSync(this.dir, { recursive: true });
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith(".md"));
      const skills: SkillMeta[] = [];
      for (const file of files) {
        const raw = readFileSync(join(this.dir, file), "utf-8");
        const meta = this.parseMeta(raw);
        if (meta) skills.push(meta);
      }
      return skills;
    } catch {
      return [];
    }
  }

  /** Get a skill catalog for the AI — names + descriptions only, no content. */
  catalog(): string {
    const skills = this.list();
    if (skills.length === 0) return "";
    return skills
      .map((s) => `  /${s.name} — ${s.description}`)
      .join("\n");
  }

  /** Get a compact skill summary for system prompt injection (names + 1-line desc only). */
  summaryForPrompt(): string {
    const skills = this.list();
    if (skills.length === 0) return "";
    const lines = skills.map((s) => `${s.name}: ${s.description}`);
    return `Available skills (invoke with /name or let the agent choose):\n${lines.join("\n")}`;
  }

  /** Load a skill's full content (lazy — only when invoked). */
  load(name: string): SkillResult | null {
    const fileName = `${name.replace(/\s+/g, "-").toLowerCase()}.md`;
    const filePath = join(this.dir, fileName);

    if (!existsSync(filePath)) return null;
    let content = readFileSync(filePath, "utf-8");

    // Track usage (updates file on disk)
    this.recordUse(name);
    // Re-read after recording use to get updated meta
    content = readFileSync(filePath, "utf-8");
    this.contentCache.set(name, content);

    const meta = this.parseMeta(content);
    if (!meta) return null;

    return { ...meta, content };
  }

  /** Add a skill (self-learning — the AI can call this). */
  add(name: string, description: string, body: string): void {
    mkdirSync(this.dir, { recursive: true });
    const fileName = `${name.replace(/\s+/g, "-").toLowerCase()}.md`;
    const now = Date.now();
    const frontMatter = [
      `---`,
      `name: ${name}`,
      `description: ${description}`,
      `lastUsed: ${now}`,
      `useCount: 0`,
      `---`,
    ].join("\n");
    const content = `${frontMatter}\n${body}`;
    writeFileSync(join(this.dir, fileName), content, "utf-8");
    // Invalidate index and cache
    this.index = null;
    this.contentCache.delete(name);
  }

  /** Remove a skill. */
  remove(name: string): boolean {
    const fileName = `${name.replace(/\s+/g, "-").toLowerCase()}.md`;
    const filePath = join(this.dir, fileName);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    this.index = null;
    this.contentCache.delete(name);
    return true;
  }

  /** Record that a skill was used (updates lastUsed + useCount). */
  recordUse(name: string): void {
    const fileName = `${name.replace(/\s+/g, "-").toLowerCase()}.md`;
    const filePath = join(this.dir, fileName);
    if (!existsSync(filePath)) return;

    const raw = readFileSync(filePath, "utf-8");
    const meta = this.parseMeta(raw);
    if (!meta) return;

    const now = Date.now();
    const updated = raw
      .replace(/lastUsed: \d+/, `lastUsed: ${now}`)
      .replace(/useCount: \d+/, `useCount: ${meta.useCount + 1}`);
    writeFileSync(filePath, updated, "utf-8");
    this.contentCache.set(name, updated);
  }

  /**
   * Auto-prune skills that haven't been used in PRUNE_AFTER_DAYS days
   * and have fewer than MIN_USES_TO_KEEP uses.
   * Returns names of pruned skills.
   */
  prune(): string[] {
    const skills = this.list();
    const now = Date.now();
    const threshold = PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    const pruned: string[] = [];

    for (const skill of skills) {
      const age = now - skill.lastUsed;
      if (age > threshold && skill.useCount < MIN_USES_TO_KEEP) {
        this.remove(skill.name);
        pruned.push(skill.name);
      }
    }
    return pruned;
  }

  /**
   * Search for skills using minisearch (BM25-ish).
   * Returns top K results with full content (loaded lazily).
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

      const files = readdirSync(this.dir).filter((f) => f.endsWith(".md"));
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file) continue;
        const content = readFileSync(join(this.dir, file), "utf-8");
        const meta = this.parseMeta(content);
        if (!meta) continue;
        this.index.add({
          id: `skill-${i}`,
          name: meta.name,
          description: meta.description,
          content,
        });
      }
    }

    const results = this.index.search(query, { prefix: true });
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
          tokenEstimate: estimateTokens(doc.content),
          lastUsed: 0,
          useCount: 0,
        };
      });
  }

  /**
   * Inject skills relevant to the task, clipped to token budget.
   * LAZY: only loads content for matched skills, not all.
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

  /** Parse metadata from a skill file. */
  private parseMeta(raw: string): SkillMeta | null {
    const lines = raw.split("\n");
    if (lines[0] !== "---") {
      // Legacy format: "# name: description"
      const match = raw.match(/^#\s+([^:]+):\s*(.*)/);
      if (match && match[1] && match[2]) {
        return {
          name: match[1],
          description: match[2],
          tokenEstimate: estimateTokens(raw),
          lastUsed: 0,
          useCount: 0,
        };
      }
      return null;
    }

    // Parse front matter
    let name = "";
    let description = "";
    let lastUsed = 0;
    let useCount = 0;
    let endFrontMatter = -1;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === "---") {
        endFrontMatter = i;
        break;
      }
      const [key, ...rest] = line.split(":");
      const value = rest.join(":").trim();
      if (key === "name") name = value;
      else if (key === "description") description = value;
      else if (key === "lastUsed") lastUsed = Number(value) || 0;
      else if (key === "useCount") useCount = Number(value) || 0;
    }

    if (!name) return null;
    return {
      name,
      description,
      tokenEstimate: estimateTokens(raw),
      lastUsed,
      useCount,
    };
  }
}
