import { test, expect } from "bun:test";
import { OpenRouterClient, isTransientStreamError } from "../src/models/openrouter.ts";
import type { StreamEvent } from "../src/models/openrouter.ts";

test("isTransientStreamError retries upstream failures, not client errors", () => {
  expect(isTransientStreamError("Provider returned error", 0)).toBe(true);
  expect(isTransientStreamError("upstream request timeout", 0)).toBe(true);
  expect(isTransientStreamError("Internal server error", 502)).toBe(true);
  expect(isTransientStreamError("rate limit exceeded", 429)).toBe(true);
  // genuine client errors must NOT be retried
  expect(isTransientStreamError("invalid request: bad tool schema", 400)).toBe(false);
  expect(isTransientStreamError("context length exceeded", 400)).toBe(false);
});

function sseResponse(objects: object[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const o of objects) c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("a mid-stream provider error is retried, then the turn succeeds", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      // the exact shape that used to end the whole turn: a 200 then an error chunk
      return sseResponse([{ error: { message: "Provider returned error", code: 502 } }]);
    }
    return sseResponse([{ choices: [{ delta: { content: "hello" } }] }]);
  }) as unknown as typeof fetch;

  try {
    const client = new OpenRouterClient("k", "http://test");
    const events: StreamEvent[] = [];
    for await (const ev of client.stream({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxRetries: 3,
    } as any)) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(calls).toBe(2); // one retry
    expect(text).toBe("hello");
    expect(events.some((e) => e.type === "retry")).toBe(true);
  } finally {
    globalThis.fetch = orig;
  }
});

test("a non-transient stream error is not retried", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return sseResponse([{ error: { message: "context length exceeded", code: 400 } }]);
  }) as unknown as typeof fetch;

  try {
    const client = new OpenRouterClient("k", "http://test");
    let threw = false;
    try {
      for await (const _ of client.stream({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        maxRetries: 3,
      } as any)) {
        // drain
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(calls).toBe(1); // no retry on a client error
  } finally {
    globalThis.fetch = orig;
  }
});
