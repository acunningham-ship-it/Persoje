import { join } from "node:path";
import { estimateTokens } from "../core/tokens.ts";

/**
 * Repo-map v1 (Aider-style, regex-based): a ranked symbol map that gives the
 * model project awareness for ~1k tokens instead of file dumps. Tree-sitter
 * extraction can replace the regexes later without changing the interface.
 */

const SOURCE_GLOBS = ["**/*.{ts,tsx,js,jsx,py,go,rs,java,rb,php,c,h,cpp,hpp}"];
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor", "target", "__pycache__", ".venv"]);
const MAX_FILES = 400;

const SYMBOL_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/, // js/ts
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, // js/ts/py-ish/java
  /^\s*(?:export\s+)?interface\s+(\w+)/, // ts
  /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/, // arrow fns
  /^\s*def\s+(\w+)/, // python
  /^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/, // go
  /^\s*(?:pub\s+)?fn\s+(\w+)/, // rust
  /^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>[\]]+\s+(\w+)\s*\(/, // java
];

interface FileSymbols {
  path: string;
  symbols: string[];
  score: number;
}

function extractSymbols(content: string): string[] {
  const symbols: string[] = [];
  for (const line of content.split("\n")) {
    for (const pattern of SYMBOL_PATTERNS) {
      const m = line.match(pattern);
      if (m?.[1] && m[1].length > 2) {
        symbols.push(m[1]);
        break;
      }
    }
    if (symbols.length > 50) break;
  }
  return [...new Set(symbols)];
}

export async function buildRepoMap(cwd: string, maxTokens: number): Promise<string> {
  if (maxTokens <= 0) return "";

  // Collect candidate source files.
  const files: string[] = [];
  for (const pattern of SOURCE_GLOBS) {
    const glob = new Bun.Glob(pattern);
    for await (const entry of glob.scan({ cwd, dot: false })) {
      if (entry.split("/").some((part) => IGNORE_DIRS.has(part))) continue;
      if (/\.(test|spec|min)\.|\.d\.ts$/.test(entry)) continue;
      files.push(entry);
      if (files.length >= MAX_FILES) break;
    }
    if (files.length >= MAX_FILES) break;
  }
  if (files.length === 0) return "";

  // Parse symbols per file (cap read size — symbol defs live near the top anyway).
  const parsed: FileSymbols[] = [];
  const allContent: string[] = [];
  for (const path of files) {
    try {
      const content = await Bun.file(join(cwd, path)).text();
      const head = content.slice(0, 30_000);
      allContent.push(head);
      const symbols = extractSymbols(head);
      if (symbols.length > 0) parsed.push({ path, symbols, score: 0 });
    } catch {
      // unreadable file — skip
    }
  }
  if (parsed.length === 0) return "";

  // Rank: how often is each file's symbols referenced across the repo?
  const corpus = allContent.join("\n");
  for (const file of parsed) {
    for (const sym of file.symbols.slice(0, 20)) {
      // count occurrences cheaply (indexOf loop beats regex compile per symbol)
      let count = 0;
      let idx = corpus.indexOf(sym);
      while (idx !== -1 && count < 50) {
        count++;
        idx = corpus.indexOf(sym, idx + sym.length);
      }
      file.score += Math.max(0, count - 1); // minus the definition itself
    }
  }
  parsed.sort((a, b) => b.score - a.score);

  // Token-fit.
  const lines: string[] = ["Project map (top symbols by reference count):"];
  let used = estimateTokens(lines[0]!);
  for (const file of parsed) {
    const line = `${file.path}: ${file.symbols.slice(0, 8).join(", ")}`;
    const cost = estimateTokens(line);
    if (used + cost > maxTokens) break;
    lines.push(line);
    used += cost;
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
