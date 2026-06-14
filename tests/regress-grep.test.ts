import { test, expect, describe, beforeEach } from "bun:test";
import { grepTool } from "../src/tools/shell-tools.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ctx = (cwd: string, over: Partial<ToolContext> = {}): ToolContext => ({
  cwd,
  bashTimeoutMs: 5000,
  ...over,
});

describe("grepTool truncation indicator", () => {
  let testDir: string;

  // Setup: create a temp dir with test files
  beforeEach(async () => {
    testDir = join(tmpdir(), `persoje-grep-test-${Date.now()}`);
    await Bun.write(`${testDir}/many-matches.txt`,
      Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
    await Bun.write(`${testDir}/few-matches.txt`,
      Array.from({ length: 5 }, (_, i) => `hello ${i + 1}`).join("\n"));
  });

  test("grep with many matches shows truncation marker", async () => {
    const result = await grepTool.execute(
      { pattern: "line", path: testDir },
      ctx(testDir),
    );

    // Should have 20 results (the cap) plus the truncation marker
    expect(result).toContain("[results capped — narrow the pattern to see more]");
    // Verify we have results before the marker
    const lines = result.split("\n");
    const markerIndex = lines.findIndex((l) => l.includes("[results capped"));
    expect(markerIndex).toBeGreaterThan(0); // marker is not the first line
  });

  test("grep with few matches does not show truncation marker", async () => {
    const result = await grepTool.execute(
      { pattern: "hello", path: testDir },
      ctx(testDir),
    );

    // Should have 5 results, no truncation marker
    expect(result).not.toContain("[results capped");
    const lines = result.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(5); // exactly 5 matches, no marker
  });

  test("grep with no matches returns 'No matches.'", async () => {
    const result = await grepTool.execute(
      { pattern: "nonexistent_pattern_xyz", path: testDir },
      ctx(testDir),
    );

    expect(result).toBe("No matches.");
  });

  test("grep with exactly 20 matches shows truncation marker (conservative approach)", async () => {
    // Create a file with exactly 20 matches
    const exactFile = `${testDir}/exact-20.txt`;
    await Bun.write(exactFile,
      Array.from({ length: 20 }, (_, i) => `match ${i + 1}`).join("\n"));

    const result = await grepTool.execute(
      { pattern: "match", path: testDir + "/exact-20.txt" },
      ctx(testDir),
    );

    // With exactly 20 matches at the cap, we show the marker (conservative:
    // better to warn about possible truncation than hide it).
    expect(result).toContain("[results capped — narrow the pattern to see more]");
  });

  test("grep output is relative to cwd and uses correct marker format", async () => {
    const result = await grepTool.execute(
      { pattern: "^line", path: testDir },
      ctx(testDir),
    );

    // Verify format: file:line notation (should see many-matches.txt results)
    expect(result).toContain(":");
    // Verify marker text matches glob tool pattern (different wording but same spirit)
    expect(result).toContain("[results capped");
    expect(result).toContain("narrow the pattern");
  });
});
