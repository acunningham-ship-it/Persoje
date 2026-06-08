import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool } from "../src/tools/file-tools.ts";
import type { ToolContext } from "../src/tools/types.ts";

let dir: string;
let ctx: ToolContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "persoje-test-"));
  ctx = { cwd: dir, bashTimeoutMs: 5000 };
});

test("applies a unique search/replace", async () => {
  writeFileSync(join(dir, "a.ts"), "const x = 1;\nconst y = 2;\n");
  const result = await editTool.execute(
    { path: "a.ts", old_string: "const y = 2;", new_string: "const y = 42;" },
    ctx,
  );
  expect(result).toContain("1 replacement");
  expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("const x = 1;\nconst y = 42;\n");
});

test("rejects ambiguous match without replace_all", async () => {
  writeFileSync(join(dir, "b.ts"), "let a = 0;\nlet a = 0;\n");
  await expect(
    editTool.execute({ path: "b.ts", old_string: "let a = 0;", new_string: "let a = 1;" }, ctx),
  ).rejects.toThrow(/matches 2 times/);
});

test("replace_all replaces every occurrence", async () => {
  writeFileSync(join(dir, "c.ts"), "foo();\nfoo();\nfoo();\n");
  const result = await editTool.execute(
    { path: "c.ts", old_string: "foo()", new_string: "bar()", replace_all: true },
    ctx,
  );
  expect(result).toContain("3 replacements");
  expect(readFileSync(join(dir, "c.ts"), "utf-8")).toBe("bar();\nbar();\nbar();\n");
});

test("errors clearly when old_string is missing", async () => {
  writeFileSync(join(dir, "d.ts"), "nothing here\n");
  await expect(
    editTool.execute({ path: "d.ts", old_string: "absent", new_string: "x" }, ctx),
  ).rejects.toThrow(/not found/);
});

test("falls back when old_string adds a trailing space the file lacks", async () => {
  writeFileSync(join(dir, "e.ts"), "const a = 1;\nconst b = 2;\n");
  // Model copied the line but tacked on a trailing space — no exact substring.
  const result = await editTool.execute(
    { path: "e.ts", old_string: "const a = 1; ", new_string: "const a = 9;" },
    ctx,
  );
  expect(result).toContain("trailing whitespace");
  expect(readFileSync(join(dir, "e.ts"), "utf-8")).toBe("const a = 9;\nconst b = 2;\n");
});

test("falls back when indentation differs entirely", async () => {
  writeFileSync(join(dir, "f.ts"), "return 1;\n");
  // Model added 4 spaces of indent the flat file doesn't have — no exact substring.
  const result = await editTool.execute(
    { path: "f.ts", old_string: "    return 1;", new_string: "return 2;" },
    ctx,
  );
  expect(result).toContain("indentation");
  expect(readFileSync(join(dir, "f.ts"), "utf-8")).toBe("return 2;\n");
});

test("refuses an ambiguous whitespace-tolerant match", async () => {
  // No exact substring (trailing space), but two lines match once normalized.
  writeFileSync(join(dir, "g.ts"), "log();\nlog();\n");
  await expect(
    editTool.execute({ path: "g.ts", old_string: "log(); ", new_string: "warn();" }, ctx),
  ).rejects.toThrow(/several candidates/);
});

test("near-match hint points at the right line on a real miss", async () => {
  writeFileSync(join(dir, "h.ts"), "const total = compute();\n");
  await expect(
    editTool.execute({ path: "h.ts", old_string: "const total = compute( );", new_string: "x" }, ctx),
  ).rejects.toThrow(/Nearest lines/);
});
