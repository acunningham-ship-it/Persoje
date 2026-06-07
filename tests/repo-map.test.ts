import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepoMap } from "../src/context/repo-map.ts";
import { estimateTokens } from "../src/core/tokens.ts";

test("builds a ranked symbol map within the token budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "persoje-map-"));
  mkdirSync(join(dir, "src"));
  // helper.ts: defines a heavily-referenced symbol
  writeFileSync(
    join(dir, "src", "helpers.ts"),
    "export function formatDate(d: Date) { return d.toISOString(); }\nexport class Logger { }\n",
  );
  // consumers reference formatDate a lot
  for (let i = 0; i < 3; i++) {
    writeFileSync(
      join(dir, "src", `consumer${i}.ts`),
      `import { formatDate } from "./helpers.ts";\nexport function consumerThing${i}() { return formatDate(new Date()) + formatDate(new Date()); }\n`,
    );
  }
  writeFileSync(join(dir, "src", "lonely.ts"), "export function neverUsedAnywhere() { return 1; }\n");

  const map = await buildRepoMap(dir, 500);
  expect(map).toContain("helpers.ts");
  expect(map).toContain("formatDate");
  expect(estimateTokens(map)).toBeLessThanOrEqual(500);
  // most-referenced file ranks above the lonely one
  const helperPos = map.indexOf("helpers.ts");
  const lonelyPos = map.indexOf("lonely.ts");
  if (lonelyPos !== -1) expect(helperPos).toBeLessThan(lonelyPos);
});

test("returns empty string for non-project directories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "persoje-empty-"));
  expect(await buildRepoMap(dir, 500)).toBe("");
});

test("budget 0 disables the map", async () => {
  expect(await buildRepoMap("/tmp", 0)).toBe("");
});

test("ignores node_modules and test files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "persoje-ignore-"));
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "dep", "index.ts"), "export function depFunction() {}\n");
  writeFileSync(join(dir, "app.test.ts"), "export function testOnlyFn() {}\n");
  writeFileSync(join(dir, "app.ts"), "export function realAppFunction() { return 42; }\n");

  const map = await buildRepoMap(dir, 500);
  expect(map).toContain("realAppFunction");
  expect(map).not.toContain("depFunction");
  expect(map).not.toContain("testOnlyFn");
});
