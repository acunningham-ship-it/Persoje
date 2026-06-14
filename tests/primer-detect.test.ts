import { describe, test, expect } from "bun:test";
import { detectPrimerMode, isLocalUrl } from "../src/guardrails/primer-detect.ts";

describe("isLocalUrl (the local-only pre-filter)", () => {
  test("accepts loopback", () => {
    expect(isLocalUrl("http://localhost:8799/v1")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:8000")).toBe(true);
    expect(isLocalUrl("http://[::1]:8000")).toBe(true);
  });

  test("accepts RFC1918 private LAN (primer can run on another box on your network)", () => {
    expect(isLocalUrl("http://192.168.1.40:8799/v1")).toBe(true); // the M2 in this test
    expect(isLocalUrl("http://10.0.0.5:8799")).toBe(true);
    expect(isLocalUrl("http://172.16.3.2:8799")).toBe(true);
    expect(isLocalUrl("http://172.31.255.1:8799")).toBe(true);
    expect(isLocalUrl("http://machine.local:8799")).toBe(true);
  });

  test("rejects PUBLIC hosts (never primer-mode against cloud)", () => {
    expect(isLocalUrl("https://openrouter.ai/api/v1")).toBe(false);
    expect(isLocalUrl("http://8.8.8.8:8000")).toBe(false);
    expect(isLocalUrl("http://172.15.0.1:8799")).toBe(false); // just below the 172.16-31 private block
    expect(isLocalUrl("http://172.32.0.1:8799")).toBe(false); // just above it
    expect(isLocalUrl("not a valid url")).toBe(false);
  });
});

describe("detectPrimerMode", () => {
  test("rejects public hosts without probing", async () => {
    expect(await detectPrimerMode("https://openrouter.ai/api/v1")).toBe(false);
  });

  test("probes loopback, graceful false when nothing is listening", async () => {
    expect(await detectPrimerMode("http://localhost:9999")).toBe(false);
    expect(typeof (await detectPrimerMode("http://127.0.0.1:9998"))).toBe("boolean");
  });

  test("caches result per baseUrl", async () => {
    const url = "http://127.0.0.1:9001";
    const first = await detectPrimerMode(url);
    const second = await detectPrimerMode(url);
    expect(first).toBe(second);
  });

  test("gracefully handles invalid URLs", async () => {
    expect(await detectPrimerMode("not a valid URL")).toBe(false);
  });
});
