import { describe, it, expect, afterEach } from "bun:test";
import { firstLocalModel } from "../src/config/providers.ts";

// firstLocalModel probes Ollama's native /api/tags + /api/show for a TOOL-capable model
// (persoje always sends tool schemas, so a vision/embed-only default 400s on turn one),
// and falls back to the OpenAI-compat /v1/models catalog for non-Ollama servers. These
// tests stub global fetch so the logic is checked without a live Ollama.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function ollamaStub(tagsInOrder: string[], caps: Record<string, string[]>) {
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: tagsInOrder.map((model) => ({ model })) }), { status: 200 });
    }
    if (u.endsWith("/api/show")) {
      const { model } = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ capabilities: caps[model] ?? [] }), { status: 200 });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

describe("firstLocalModel", () => {
  it("skips vision/embedding models and returns the first TOOL-capable one", async () => {
    ollamaStub(["llava:7b", "nomic-embed-text", "qwen2.5:1.5b", "qwen2.5:7b"], {
      "llava:7b": ["completion", "vision"],
      "nomic-embed-text": ["embedding"],
      "qwen2.5:1.5b": ["completion", "tools"],
      "qwen2.5:7b": ["completion", "tools"],
    });
    expect(await firstLocalModel("http://localhost:11434/v1")).toBe("qwen2.5:1.5b");
  });

  it("returns undefined when Ollama is up but nothing pulled supports tools", async () => {
    ollamaStub(["llava:7b", "gemma2:2b"], {
      "llava:7b": ["completion", "vision"],
      "gemma2:2b": ["completion"],
    });
    expect(await firstLocalModel("http://localhost:11434/v1")).toBeUndefined();
  });

  it("falls back to the OpenAI-compat catalog (first non-embed) when it isn't an Ollama server", async () => {
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.endsWith("/api/tags")) return new Response("no", { status: 404 });
      if (u.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "nomic-embed" }, { id: "local-chat" }] }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    expect(await firstLocalModel("http://localhost:11434/v1")).toBe("local-chat");
  });

  it("returns undefined when the endpoint is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await firstLocalModel("http://localhost:9/v1")).toBeUndefined();
  });
});
