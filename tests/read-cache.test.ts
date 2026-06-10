import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTool } from "../src/tools/file-tools.ts";
import { ReadCache } from "../src/tools/read-cache.ts";
import type { ToolContext } from "../src/tools/types.ts";

let dir: string;
let cache: ReadCache;
let ctx: ToolContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "persoje-read-cache-"));
  cache = new ReadCache();
  ctx = { cwd: dir, bashTimeoutMs: 5000, readCache: cache };
});

test("first read of a file returns full content", async () => {
  writeFileSync(join(dir, "test.txt"), "line 1\nline 2\nline 3\n");
  const result = await readTool.execute({ path: "test.txt" }, ctx);
  expect(result).toContain("1\tline 1");
  expect(result).toContain("2\tline 2");
  expect(result).toContain("3\tline 3");
  expect(result).not.toContain("already read");
});

test("re-reading unchanged file returns cache marker", async () => {
  writeFileSync(join(dir, "test.txt"), "line 1\nline 2\nline 3\n");
  // First read
  const result1 = await readTool.execute({ path: "test.txt" }, ctx);
  expect(result1).toContain("line 1");

  // Second read (file unchanged)
  const result2 = await readTool.execute({ path: "test.txt" }, ctx);
  expect(result2).toContain("already read this session, unchanged");
  expect(result2).toContain("tokens saved");
  expect(result2).not.toContain("line 1");
});

test("re-reading changed file returns diff", async () => {
  const file = join(dir, "test.ts");
  writeFileSync(file, "function foo() {\n  return 1;\n}\n");

  // First read
  const result1 = await readTool.execute({ path: "test.ts" }, ctx);
  expect(result1).toContain("function foo");

  // Wait for mtime to change (1 second resolution on many filesystems)
  await new Promise((r) => setTimeout(r, 1100));

  // Modify the file
  writeFileSync(file, "function foo() {\n  return 42;\n}\n");

  // Second read (file changed)
  const result2 = await readTool.execute({ path: "test.ts" }, ctx);
  expect(result2).toContain("changed since last read");
  expect(result2).toContain("showing diff");
  expect(result2).toContain("-  return 1;");
  expect(result2).toContain("+  return 42;");
});

test("partial reads (with offset) always bypass cache", async () => {
  writeFileSync(join(dir, "large.txt"), "line 1\nline 2\nline 3\nline 4\nline 5\n");

  // Full read first
  const result1 = await readTool.execute({ path: "large.txt" }, ctx);
  expect(result1).toContain("line 1");

  // Partial read (offset only)
  const result2 = await readTool.execute({ path: "large.txt", offset: 3 }, ctx);
  expect(result2).toContain("3\tline 3");
  expect(result2).not.toContain("already read");
});

test("partial reads (with limit) always bypass cache", async () => {
  writeFileSync(join(dir, "large.txt"), "line 1\nline 2\nline 3\nline 4\nline 5\n");

  // Full read first
  await readTool.execute({ path: "large.txt" }, ctx);

  // Partial read (limit only)
  const result = await readTool.execute({ path: "large.txt", limit: 2 }, ctx);
  expect(result).toContain("1\tline 1");
  expect(result).toContain("2\tline 2");
  expect(result).not.toContain("already read");
});

test("diff respects max line limit (falls back to full read if too large)", async () => {
  const file = join(dir, "large.ts");
  // Create a file with 50 lines
  const initial = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  writeFileSync(file, initial);

  // First read
  await readTool.execute({ path: "large.ts" }, ctx);

  // Wait for mtime to change
  await new Promise((r) => setTimeout(r, 1100));

  // Modify more than 40 lines
  const modified = Array.from({ length: 50 }, (_, i) => `CHANGED line ${i + 1}`).join("\n") + "\n";
  writeFileSync(file, modified);

  // Second read should fall back to full read (diff too large)
  const result = await readTool.execute({ path: "large.ts" }, ctx);
  // Should contain full content, not a diff marker
  expect(result).toContain("1\tCHANGED line 1");
});

test("cache tracks multiple files independently", async () => {
  writeFileSync(join(dir, "a.txt"), "content A\n");
  writeFileSync(join(dir, "b.txt"), "content B\n");

  // Read both files
  await readTool.execute({ path: "a.txt" }, ctx);
  await readTool.execute({ path: "b.txt" }, ctx);

  // Re-read a.txt (unchanged)
  const resultA = await readTool.execute({ path: "a.txt" }, ctx);
  expect(resultA).toContain("already read");

  // Wait for mtime to change
  await new Promise((r) => setTimeout(r, 1100));

  // Modify only b.txt and re-read
  writeFileSync(join(dir, "b.txt"), "modified B\n");
  const resultB = await readTool.execute({ path: "b.txt" }, ctx);
  expect(resultB).toContain("changed since last read");
  expect(resultB).not.toContain("already read");
});

test("ReadCache.checkStatus works correctly", () => {
  const cache2 = new ReadCache();

  // First check: new file
  let status = cache2.checkStatus("/path/to/file", 12345);
  expect(status).toBe("new");

  // Record the file
  cache2.record("/path/to/file", 12345, "some content");

  // Same mtime: unchanged
  status = cache2.checkStatus("/path/to/file", 12345);
  expect(status).toBe("unchanged");

  // Different mtime: changed
  status = cache2.checkStatus("/path/to/file", 99999);
  expect(status).toBe("changed");
});

test("ReadCache.getDiff computes unified diff correctly", () => {
  const cache2 = new ReadCache();
  const old = "line 1\nline 2\nline 3\n";
  const newer = "line 1\nmodified 2\nline 3\n";

  const diff = cache2.getDiff(old, newer);
  expect(diff).toBeTruthy();
  expect(diff).toContain("-line 2");
  expect(diff).toContain("+modified 2");
});

test("ReadCache.getDiff returns null when diff is too large", () => {
  const cache2 = new ReadCache();
  const old = Array.from({ length: 100 }, (_, i) => `old line ${i}`).join("\n") + "\n";
  const newer = Array.from({ length: 100 }, (_, i) => `new line ${i}`).join("\n") + "\n";

  const diff = cache2.getDiff(old, newer, 40); // max 40 lines
  expect(diff).toBeNull(); // Diff is ~100 lines, exceeds limit
});

test("cache estimation includes line numbers in token count", async () => {
  writeFileSync(join(dir, "test.txt"), "line 1\nline 2\nline 3\n");

  // First read
  await readTool.execute({ path: "test.txt" }, ctx);

  // Second read (cache hit) should mention saved tokens
  const result = await readTool.execute({ path: "test.txt" }, ctx);
  expect(result).toContain("tokens saved");
  // Token estimate: ~18 chars * 1.7 (line numbers) / 4 chars per token ≈ 7-8 tokens
  const match = result.match(/(\d+) tokens saved/);
  expect(match).toBeTruthy();
  if (match && match[1]) {
    const tokensSaved = parseInt(match[1]);
    expect(tokensSaved).toBeGreaterThan(0);
  }
});

test("cache is invalidated on compaction (safety guard)", async () => {
  writeFileSync(join(dir, "test.txt"), "line 1\nline 2\nline 3\n");

  // First read
  const result1 = await readTool.execute({ path: "test.txt" }, ctx);
  expect(result1).toContain("line 1");

  // Second read (cache hit)
  const result2 = await readTool.execute({ path: "test.txt" }, ctx);
  expect(result2).toContain("already read this session");

  // Simulate compaction by clearing the cache
  // (In real agent, compaction would trigger via ContextManager.onCompact hook)
  cache.clear();

  // Third read (after cache clear) should return full content, not marker
  const result3 = await readTool.execute({ path: "test.txt" }, ctx);
  expect(result3).toContain("line 1");
  expect(result3).not.toContain("already read");
  expect(result3).toContain("1\tline 1");
  expect(result3).toContain("2\tline 2");
  expect(result3).toContain("3\tline 3");
});
