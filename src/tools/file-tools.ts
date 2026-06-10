import { z } from "zod";
import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { ToolError, type Tool, type ToolContext } from "./types.ts";
import { applyEdit, nearMatchHint } from "./edit-match.ts";
import { ReadCache } from "./read-cache.ts";

/**
 * Apply one edit to in-memory content, translating a structured failure into a
 * model-facing ToolError. Shared by `edit` and `multi_edit` so there's exactly
 * one matching/messaging code path. Returns the new content + a short note;
 * does NOT touch disk (the caller decides when to write — key to multi_edit's
 * atomicity).
 */
function applyEditOrThrow(
  content: string,
  path: string,
  old_string: string,
  new_string: string,
  replace_all?: boolean,
): { content: string; note: string } {
  if (old_string === new_string) throw new ToolError("old_string and new_string are identical");
  const r = applyEdit(content, old_string, new_string, replace_all ?? false);
  if (r.ok) {
    const why =
      r.how === "exact"
        ? ""
        : `; matched ignoring ${r.how === "trailing-space" ? "trailing whitespace" : "indentation"} (old_string wasn't exact)`;
    return { content: r.content, note: `${r.count} replacement${r.count === 1 ? "" : "s"}${why}` };
  }
  if (r.reason === "ambiguous-exact") {
    throw new ToolError(
      `old_string matches ${r.count} times in ${path}. Add surrounding lines to make it unique, or set replace_all.`,
    );
  }
  if (r.reason === "ambiguous-flex") {
    throw new ToolError(
      `old_string isn't exact, and a whitespace-tolerant match found several candidates in ${path}. Add surrounding lines to disambiguate, or copy the exact text including indentation.`,
    );
  }
  throw new ToolError(
    `old_string not found in ${path}. Read the file first and copy the exact text, including whitespace.${nearMatchHint(content, old_string)}`,
  );
}

function resolveInCwd(path: string, ctx: ToolContext): string {
  return resolve(ctx.cwd, path);
}

export const readTool: Tool = {
  name: "read",
  description: "Read a file. Returns numbered lines. Use offset/limit for large files.",
  args: z.object({
    path: z.string().describe("File path (absolute or relative)"),
    offset: z.number().optional().describe("1-based start line"),
    limit: z.number().optional().describe("Max lines to return"),
  }),
  maxResultTokens: 4000,
  async execute({ path, offset, limit }, ctx) {
    const absPath = resolveInCwd(path, ctx);
    const file = Bun.file(absPath);
    if (!(await file.exists())) throw new ToolError(`File not found: ${path}`);

    // Partial reads always bypass cache (user is exploring large files).
    if (offset !== undefined || limit !== undefined) {
      const content = await file.text();
      const lines = content.split("\n");
      const start = Math.max(0, (offset ?? 1) - 1);
      const end = limit ? start + limit : lines.length;
      const slice = lines.slice(start, end);
      const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
      const suffix =
        end < lines.length ? `\n[file has ${lines.length} lines; showing ${start + 1}-${Math.min(end, lines.length)}]` : "";
      return numbered + suffix;
    }

    // Full read: use cache if available.
    const content = await file.text();
    const mtime = (await file.stat()).mtime?.getTime() ?? 0;
    const cache = ctx.readCache;

    if (cache) {
      const status = cache.checkStatus(absPath, mtime);

      if (status === "unchanged") {
        // File hasn't changed since last read this session — save tokens.
        const lines = content.split("\n");
        const estimatedTokens = Math.ceil((lines.length * 4 * 170) / 100); // ~4 chars/token, +70% for line numbers
        return `[already read this session, unchanged — ${estimatedTokens} tokens saved by not re-reading]`;
      }

      if (status === "changed") {
        const cachedContent = cache.getCachedContent(absPath);
        if (cachedContent) {
          const diff = cache.getDiff(cachedContent, content);
          if (diff) {
            // Diff is small enough — show just the changes.
            const estimatedTokens = Math.ceil((diff.length * 170) / 100);
            const response = `[${path} changed since last read — showing diff (${estimatedTokens} tokens vs full re-read)]\n\n${diff}`;
            cache.record(absPath, mtime, content);
            return response;
          }
        }
        // Diff too large or failed — fall through to full read.
      }

      // New file or diff failed — show full content and cache it.
      const lines = content.split("\n");
      const numbered = lines.map((l, i) => `${i + 1}\t${l}`).join("\n");
      cache.record(absPath, mtime, content);
      return numbered;
    }

    // No cache available — return full content (normal path for tests/legacy code).
    const lines = content.split("\n");
    const numbered = lines.map((l, i) => `${i + 1}\t${l}`).join("\n");
    return numbered;
  },
};

export const writeTool: Tool = {
  name: "write",
  description: "Create or overwrite a file with the given content.",
  args: z.object({
    path: z.string(),
    content: z.string(),
  }),
  maxResultTokens: 200,
  async execute({ path, content }, ctx) {
    const abs = resolveInCwd(path, ctx);
    await mkdir(dirname(abs), { recursive: true });
    await Bun.write(abs, content);
    return `Wrote ${content.split("\n").length} lines to ${path}`;
  },
};

export const editTool: Tool = {
  name: "edit",
  description:
    "Edit a file by exact search/replace. old_string must match exactly once (include surrounding lines to disambiguate); set replace_all to replace every occurrence.",
  args: z.object({
    path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  maxResultTokens: 200,
  async execute({ path, old_string, new_string, replace_all }, ctx) {
    const abs = resolveInCwd(path, ctx);
    const file = Bun.file(abs);
    if (!(await file.exists())) throw new ToolError(`File not found: ${path}`);
    const content = await file.text();
    const { content: updated, note } = applyEditOrThrow(content, path, old_string, new_string, replace_all);
    await Bun.write(abs, updated);
    return `Edited ${path} (${note})`;
  },
};

export const multiEditTool: Tool = {
  name: "multi_edit",
  description:
    "Apply several search/replace edits to ONE file in order, atomically — all succeed or nothing is written. Each edit sees the result of the previous one. Use this instead of many separate edit calls to the same file.",
  args: z.object({
    path: z.string(),
    edits: z
      .array(
        z.object({
          old_string: z.string(),
          new_string: z.string(),
          replace_all: z.boolean().optional(),
        }),
      )
      .min(1)
      .describe("Edits applied in order; each sees the previous edit's result"),
  }),
  maxResultTokens: 300,
  async execute({ path, edits }, ctx) {
    const abs = resolveInCwd(path, ctx);
    const file = Bun.file(abs);
    if (!(await file.exists())) throw new ToolError(`File not found: ${path}`);

    // Apply every edit to an in-memory copy first; only write if ALL succeed.
    // A failure mid-sequence leaves the file untouched — no half-edited mess.
    let content = await file.text();
    const notes: string[] = [];
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i]!;
      try {
        const r = applyEditOrThrow(content, path, e.old_string, e.new_string, e.replace_all);
        content = r.content;
        notes.push(r.note);
      } catch (err) {
        throw new ToolError(`edit #${i + 1} of ${edits.length} failed (no changes written): ${(err as Error).message}`);
      }
    }
    await Bun.write(abs, content);
    return `Edited ${path} — ${edits.length} edits applied:\n${notes.map((n, i) => `  ${i + 1}. ${n}`).join("\n")}`;
  },
};

export const lsTool: Tool = {
  name: "ls",
  description: "List directory contents.",
  args: z.object({
    path: z.string().optional().describe("Directory (default: cwd)"),
  }),
  maxResultTokens: 1500,
  async execute({ path }, ctx) {
    const dir = resolveInCwd(path ?? ".", ctx);
    const glob = new Bun.Glob("*");
    const entries: string[] = [];
    for await (const entry of glob.scan({ cwd: dir, onlyFiles: false, dot: false })) {
      entries.push(entry);
    }
    if (entries.length === 0) return "(empty directory)";
    return entries.sort().join("\n");
  },
};

export const globTool: Tool = {
  name: "glob",
  description: "Find files matching a glob pattern, e.g. 'src/**/*.ts'.",
  args: z.object({
    pattern: z.string(),
    path: z.string().optional().describe("Base directory (default: cwd)"),
  }),
  maxResultTokens: 1500,
  async execute({ pattern, path }, ctx) {
    const cwd = resolveInCwd(path ?? ".", ctx);
    const glob = new Bun.Glob(pattern);
    const matches: string[] = [];
    for await (const entry of glob.scan({ cwd, dot: false })) {
      matches.push(entry);
      if (matches.length >= 200) break;
    }
    if (matches.length === 0) return "No matches.";
    const capped = matches.length >= 200 ? "\n[capped at 200 matches]" : "";
    return matches.sort().join("\n") + capped;
  },
};
