import { test, expect } from "bun:test";
import { Agent } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/tools/types.ts";
import { readTool } from "../src/tools/file-tools.ts";
import type { ChatRequest, StreamEvent } from "../src/models/openrouter.ts";
import type { AgentEvent } from "../src/core/events.ts";
import { z } from "zod";

/** Scripted fake client: each entry is the stream for one model call. */
function fakeClient(scripts: StreamEvent[][]) {
  let call = 0;
  return {
    stream: async function* (_req: ChatRequest): AsyncGenerator<StreamEvent> {
      const script = scripts[Math.min(call, scripts.length - 1)]!;
      call++;
      for (const ev of script) yield ev;
    },
  } as any;
}

function makeConfig() {
  return {
    model: { primary: "test/model", fallbacks: [], temperature: 0 },
    context: { budgetTokens: 40000, compactionThreshold: 0.8, keepFullTurns: 4 },
    loop: { maxIterations: 5, bashTimeoutMs: 5000 },
    toolResultCaps: {},
    openrouter: { baseUrl: "http://test", apiKey: "x" },
  } as any;
}

const usage = {
  type: "usage" as const,
  usage: { model: "test/model", inputTokens: 10, outputTokens: 5, cachedTokens: 0, cost: 0.0001, durationMs: 10 },
};

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

test("plain text response ends the turn", async () => {
  const client = fakeClient([[{ type: "text", delta: "All done." }, usage]]);
  const agent = new Agent({ client, tools: new ToolRegistry(), config: makeConfig(), cwd: "/tmp" });
  const events = await collect(agent.run("hi"));

  expect(events.find((e) => e.type === "text-delta")).toBeTruthy();
  const end = events.find((e) => e.type === "turn-end");
  expect(end).toMatchObject({ reason: "done", iterations: 1 });
  expect(agent.accounting.totals().cost).toBeCloseTo(0.0001);
});

test("executes a tool call then continues to completion", async () => {
  const registry = new ToolRegistry();
  registry.register(readTool);
  const client = fakeClient([
    [
      { type: "tool-calls", calls: [{ id: "c1", name: "read", argsJson: JSON.stringify({ path: "/etc/hostname" }) }] },
      usage,
    ],
    [{ type: "text", delta: "Read it." }, usage],
  ]);
  const agent = new Agent({ client, tools: registry, config: makeConfig(), cwd: "/tmp" });
  const events = await collect(agent.run("read the hostname"));

  const toolResult = events.find((e) => e.type === "tool-result") as any;
  expect(toolResult).toBeTruthy();
  expect(events.find((e) => e.type === "turn-end")).toMatchObject({ reason: "done", iterations: 2 });
  // History must contain the tool message tied to the call id (API requirement).
  const toolMsg = agent.context.history().find((m) => m.role === "tool") as any;
  expect(toolMsg?.tool_call_id).toBe("c1");
});

test("unknown tool returns an error result to the model instead of crashing", async () => {
  const client = fakeClient([
    [{ type: "tool-calls", calls: [{ id: "c1", name: "made_up_tool", argsJson: "{}" }] }, usage],
    [{ type: "text", delta: "ok" }, usage],
  ]);
  const agent = new Agent({ client, tools: new ToolRegistry(), config: makeConfig(), cwd: "/tmp" });
  const events = await collect(agent.run("go"));

  const result = events.find((e) => e.type === "tool-result") as any;
  expect(result.isError).toBe(true);
  expect(result.result).toContain("unknown tool");
  expect(events.find((e) => e.type === "turn-end")).toMatchObject({ reason: "done" });
});

test("invalid args are rejected by zod and fed back as an error result", async () => {
  const registry = new ToolRegistry();
  registry.register(readTool);
  const client = fakeClient([
    [{ type: "tool-calls", calls: [{ id: "c1", name: "read", argsJson: JSON.stringify({ wrong: true }) }] }, usage],
    [{ type: "text", delta: "fixed" }, usage],
  ]);
  const agent = new Agent({ client, tools: registry, config: makeConfig(), cwd: "/tmp" });
  const events = await collect(agent.run("go"));

  const result = events.find((e) => e.type === "tool-result") as any;
  expect(result.isError).toBe(true);
  expect(result.result).toContain("invalid arguments");
});

test("max iterations stops a tool-calling loop", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "noop",
    description: "noop",
    args: z.object({}),
    maxResultTokens: 100,
    execute: async () => "ok",
  });
  // Model calls the tool forever.
  const client = fakeClient([
    [{ type: "tool-calls", calls: [{ id: "c", name: "noop", argsJson: "{}" }] }, usage],
  ]);
  const agent = new Agent({ client, tools: registry, config: makeConfig(), cwd: "/tmp" });
  const events = await collect(agent.run("loop forever"));

  expect(events.find((e) => e.type === "turn-end")).toMatchObject({ reason: "max-iterations", iterations: 5 });
});

test("oversized tool results are truncated before entering history", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "big",
    description: "big output",
    args: z.object({}),
    maxResultTokens: 100,
    execute: async () => "X".repeat(50_000),
  });
  const client = fakeClient([
    [{ type: "tool-calls", calls: [{ id: "c", name: "big", argsJson: "{}" }] }, usage],
    [{ type: "text", delta: "done" }, usage],
  ]);
  const agent = new Agent({ client, tools: registry, config: makeConfig(), cwd: "/tmp" });
  const events = await collect(agent.run("go"));

  const result = events.find((e) => e.type === "tool-result") as any;
  expect(result.truncated).toBe(true);
  const toolMsg = agent.context.history().find((m) => m.role === "tool") as any;
  expect(toolMsg.content.length).toBeLessThan(1000); // 100 tokens ≈ 400 chars + marker
});
