import { test, expect } from "bun:test";
import { truncate } from "../src/tools/truncate.ts";

test("passes through small output untouched", () => {
  const r = truncate("hello world", 100);
  expect(r.truncated).toBe(false);
  expect(r.text).toBe("hello world");
});

test("caps oversized output and keeps head + tail", () => {
  const big = "A".repeat(10_000) + "ERROR_AT_THE_END";
  const r = truncate(big, 500); // 500 tokens ≈ 2000 chars
  expect(r.truncated).toBe(true);
  expect(r.text.length).toBeLessThan(2500);
  expect(r.text).toContain("omitted");
  expect(r.text).toContain("ERROR_AT_THE_END"); // tail survives — errors live at the end
  expect(r.text.startsWith("AAAA")).toBe(true); // head survives
});

test("exact boundary is not truncated", () => {
  const text = "B".repeat(400); // exactly 100 tokens at 4 chars/token
  const r = truncate(text, 100);
  expect(r.truncated).toBe(false);
});
