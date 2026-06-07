import { z } from "zod";
import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { ToolError, type Tool, type ToolContext } from "./types.ts";

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
    const file = Bun.file(resolveInCwd(path, ctx));
    if (!(await file.exists())) throw new ToolError(`File not found: ${path}`);
    const lines = (await file.text()).split("\n");
    const start = Math.max(0, (offset ?? 1) - 1);
    const end = limit ? start + limit : lines.length;
    const slice = lines.slice(start, end);
    const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
    const suffix =
      end < lines.length ? `\n[file has ${lines.length} lines; showing ${start + 1}-${Math.min(end, lines.length)}]` : "";
    return numbered + suffix;
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
    if (old_string === new_string) throw new ToolError("old_string and new_string are identical");
    const content = await file.text();

    const count = content.split(old_string).length - 1;
    if (count === 0) {
      throw new ToolError(
        `old_string not found in ${path}. Read the file first and copy the exact text, including whitespace.`,
      );
    }
    if (count > 1 && !replace_all) {
      throw new ToolError(
        `old_string matches ${count} times in ${path}. Add surrounding lines to make it unique, or set replace_all.`,
      );
    }

    const updated = replace_all
      ? content.split(old_string).join(new_string)
      : content.replace(old_string, new_string);
    await Bun.write(abs, updated);
    return `Edited ${path} (${replace_all ? count : 1} replacement${(replace_all ? count : 1) === 1 ? "" : "s"})`;
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
