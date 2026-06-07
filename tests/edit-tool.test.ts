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
