import { describe, it, expect, mock } from "bun:test";
import { OpenRouterClient } from "../src/models/openrouter.ts";

describe("retry delay parsing", () => {
  const client = new OpenRouterClient("sk-test", "http://localhost:0");
  const parseRetryWait = (body: string) => (client as any).parseRetryWaitFromBody(body);
  const extractSeconds = (text: string) => (client as any).extractSecondsFromText(text);

  describe("extractSecondsFromText", () => {
    it('parses "retry in 5 seconds"', () => {
      expect(extractSeconds("retry in 5 seconds")).toBe(5);
    });
    it('parses "retry in 5s"', () => {
      expect(extractSeconds("retry in 5s")).toBe(5);
    });
    it('parses "retry after 10 seconds"', () => {
      expect(extractSeconds("retry after 10 seconds")).toBe(10);
    });
    it('parses "wait 3 seconds"', () => {
      expect(extractSeconds("wait 3 seconds")).toBe(3);
    });
    it('parses "wait 3s"', () => {
      expect(extractSeconds("wait 3s")).toBe(3);
    });
    it('parses "try again in 30s"', () => {
      expect(extractSeconds("try again in 30s")).toBe(30);
    });
    it('parses "rate limit reset in 12.5 seconds"', () => {
      expect(extractSeconds("rate limit reset in 12.5 seconds")).toBe(12.5);
    });
    it('parses "please wait 8 seconds before retrying"', () => {
      expect(extractSeconds("please wait 8 seconds before retrying")).toBe(8);
    });
    it("returns null for text without retry hints", () => {
      expect(extractSeconds("internal server error")).toBeNull();
    });
    it("returns null for empty string", () => {
      expect(extractSeconds("")).toBeNull();
    });
  });

  describe("parseRetryWaitFromBody", () => {
    it("parses JSON with retry_after field", () => {
      expect(parseRetryWait('{"retry_after": 20}')).toBe(20);
    });
    it("parses JSON with retryAfter field", () => {
      expect(parseRetryWait('{"retryAfter": 15}')).toBe(15);
    });
    it("parses JSON with nested error.retry_after", () => {
      expect(parseRetryWait('{"error": {"retry_after": 10}}')).toBe(10);
    });
    it("parses JSON with error.message containing retry hint", () => {
      expect(parseRetryWait('{"error": {"message": "retry in 7 seconds"}}')).toBe(7);
    });
    it("parses JSON with message containing retry hint", () => {
      expect(parseRetryWait('{"message": "please wait 4 seconds before retrying"}')).toBe(4);
    });
    it("parses plain text with retry hint", () => {
      expect(parseRetryWait("Rate limited. Retry in 25 seconds.")).toBe(25);
    });
    it("returns null for body without hints", () => {
      expect(parseRetryWait('{"error": "unknown"}')).toBeNull();
    });
  });
});

describe("fetchWithRetry", () => {
  const mockFetch = (fn: () => Promise<Response>) => mock(fn) as any;
  const mockSleep = (fn: (ms: number) => Promise<void>) => mock(fn) as any;

  it("retries on 429 and succeeds on second attempt", async () => {
    let callCount = 0;
    const origFetch = globalThis.fetch;
    const origSleep = Bun.sleep;
    (Bun as any).sleep = mockSleep(async (_ms: number) => {});
    globalThis.fetch = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
      return new Response("ok", { status: 200 });
    });
    const c = new OpenRouterClient("sk-test", "http://localhost:0");
    try {
      const r = await (c as any).fetchWithRetry({}, undefined, 5);
      expect(r.ok).toBe(true);
      expect(callCount).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
      (Bun as any).sleep = origSleep;
    }
  });

  it("retries on 500 and succeeds on third attempt", async () => {
    let callCount = 0;
    const origFetch = globalThis.fetch;
    const origSleep = Bun.sleep;
    (Bun as any).sleep = mockSleep(async (_ms: number) => {});
    globalThis.fetch = mockFetch(async () => {
      callCount++;
      if (callCount <= 2) return new Response("server error", { status: 500 });
      return new Response("ok", { status: 200 });
    });
    const c = new OpenRouterClient("sk-test", "http://localhost:0");
    try {
      const r = await (c as any).fetchWithRetry({}, undefined, 5);
      expect(r.ok).toBe(true);
      expect(callCount).toBe(3);
    } finally {
      globalThis.fetch = origFetch;
      (Bun as any).sleep = origSleep;
    }
  });

  it("throws after max retries exhausted", async () => {
    const origFetch = globalThis.fetch;
    const origSleep = Bun.sleep;
    (Bun as any).sleep = mockSleep(async () => {});
    globalThis.fetch = mockFetch(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }));
    const c = new OpenRouterClient("sk-test", "http://localhost:0");
    try {
      await (c as any).fetchWithRetry({}, undefined, 2);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.status).toBe(429);
      expect(e.retryable).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      (Bun as any).sleep = origSleep;
    }
  });

  it("does not retry on 400 (client error)", async () => {
    let callCount = 0;
    const origFetch = globalThis.fetch;
    const origSleep = Bun.sleep;
    (Bun as any).sleep = mockSleep(async () => {});
    globalThis.fetch = mockFetch(async () => { callCount++; return new Response("bad request", { status: 400 }); });
    const c = new OpenRouterClient("sk-test", "http://localhost:0");
    try {
      await (c as any).fetchWithRetry({}, undefined, 5);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.status).toBe(400);
      expect(e.retryable).toBe(false);
      expect(callCount).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
      (Bun as any).sleep = origSleep;
    }
  });

  it("uses Retry-After header + 2s for delay", async () => {
    const delays: number[] = [];
    const origFetch = globalThis.fetch;
    const origSleep = Bun.sleep;
    (Bun as any).sleep = mockSleep(async (ms: number) => { delays.push(ms); });
    let callCount = 0;
    globalThis.fetch = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "5" } });
      return new Response("ok", { status: 200 });
    });
    const c = new OpenRouterClient("sk-test", "http://localhost:0");
    try {
      await (c as any).fetchWithRetry({}, undefined, 5);
      expect(delays[0]).toBe(7000); // 5s + 2s
    } finally {
      globalThis.fetch = origFetch;
      (Bun as any).sleep = origSleep;
    }
  });

  it("parses retry hint from body + 2s for delay", async () => {
    const delays: number[] = [];
    const origFetch = globalThis.fetch;
    const origSleep = Bun.sleep;
    (Bun as any).sleep = mockSleep(async (ms: number) => { delays.push(ms); });
    let callCount = 0;
    globalThis.fetch = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return new Response('{"error": {"message": "retry in 3 seconds"}}', { status: 429 });
      return new Response("ok", { status: 200 });
    });
    const c = new OpenRouterClient("sk-test", "http://localhost:0");
    try {
      await (c as any).fetchWithRetry({}, undefined, 5);
      expect(delays[0]).toBe(5000); // 3s + 2s
    } finally {
      globalThis.fetch = origFetch;
      (Bun as any).sleep = origSleep;
    }
  });
});
