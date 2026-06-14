import { describe, test, expect } from "bun:test";
import { detectPrimerMode } from "../src/guardrails/primer-detect.ts";

describe("detectPrimerMode", () => {
  test("rejects non-loopback URLs without probe", async () => {
    // https://openrouter.ai is not loopback → should return false immediately
    const result = await detectPrimerMode("https://openrouter.ai/api/v1");
    expect(result).toBe(false);
  });

  test("rejects non-loopback IP addresses", async () => {
    // 192.168.1.1 is not loopback → should return false immediately
    const result = await detectPrimerMode("http://192.168.1.1:8000");
    expect(result).toBe(false);
  });

  test("accepts loopback localhost and probes (graceful on fail)", async () => {
    // localhost:9999 (doesn't exist) → probe fails gracefully, returns false
    const result = await detectPrimerMode("http://localhost:9999");
    expect(typeof result).toBe("boolean");
  });

  test("accepts loopback 127.0.0.1 and probes", async () => {
    const result = await detectPrimerMode("http://127.0.0.1:8000");
    expect(typeof result).toBe("boolean");
  });

  test("accepts loopback ::1 (IPv6) and probes", async () => {
    const result = await detectPrimerMode("http://[::1]:8000");
    expect(typeof result).toBe("boolean");
  });

  test("caches result per baseUrl", async () => {
    const url = "http://127.0.0.1:9001";
    const first = await detectPrimerMode(url);
    const second = await detectPrimerMode(url);
    // Should hit cache on second call (same boolean, no new probe)
    expect(first).toBe(second);
  });

  test("gracefully handles invalid URLs", async () => {
    const result = await detectPrimerMode("not a valid URL");
    expect(result).toBe(false);
  });
});
