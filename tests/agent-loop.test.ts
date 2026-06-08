import { test, expect } from "bun:test";
import { Agent } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/tools/types.ts";
import { readTool } from "../src/tools/file-tools.ts";
import { bashTool } from "../src/tools/shell-tools.ts";
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

test("rescues tool calls embedded in text (Hermes-style) and executes them", async () => {
  const registry = new ToolRegistry();
  registry.register(readTool);
  const client = fakeClient([
    [
      { type: "text", delta: 'Let me read that.\n<tool_call>{"name": "read", "arguments": {"path": "/etc/hostname"}}</tool_call>' },
      usage,
    ],
    [{ type: "text", delta: "Got it." }, usage],
  ]);
  const failures: string[] = [];
  const agent = new Agent({
    client,
    tools: registry,
    config: makeConfig(),
    cwd: "/tmp",
    onFailure: (kind) => failures.push(kind),
  });
  const events = await collect(agent.run("read hostname"));

  expect(events.find((e) => e.type === "guardrail" && (e as any).kind === "rescue")).toBeTruthy();
  expect(events.find((e) => e.type === "tool-result" && !(e as any).isError)).toBeTruthy();
  expect(failures).toContain("rescue");
  expect(events.find((e) => e.type === "turn-end")).toMatchObject({ reason: "done" });
});

test("fuzzy-corrects hallucinated tool names (read_file → read)", async () => {
  const registry = new ToolRegistry();
  registry.register(readTool);
  const client = fakeClient([
    [{ type: "tool-calls", calls: [{ id: "c1", name: "read_file", argsJson: '{"path":"/etc/hostname"}' }] }, usage],
    [{ type: "text", delta: "done" }, usage],
  ]);
  const agent = new Agent({ client, tools: registry, config: makeConfig(), cwd: "/tmp" });
  const events = await collect(agent.run("go"));

  const fuzzy = events.find((e) => e.type === "guardrail" && (e as any).kind === "fuzzy") as any;
  expect(fuzzy?.message).toContain("read");
  const result = events.find((e) => e.type === "tool-result") as any;
  expect(result.isError).toBe(false);
});

test("blocks identical repeated calls via loop detector", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "noop",
    description: "noop",
    args: z.object({}),
    maxResultTokens: 100,
    execute: async () => "same answer",
  });
  const client = fakeClient([
    [{ type: "tool-calls", calls: [{ id: "c", name: "noop", argsJson: "{}" }] }, usage],
  ]);
  const agent = new Agent({ client, tools: registry, config: makeConfig(), cwd: "/tmp" });
  const events = await collect(agent.run("loop"));

  const loopEvents = events.filter((e) => e.type === "guardrail" && (e as any).kind === "loop");
  expect(loopEvents.length).toBeGreaterThan(0); // detector fired and blocked execution
});

test("post-edit syntax check warns the model about broken files", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "persoje-syntax-"));

  const registry = new ToolRegistry();
  const { writeTool } = await import("../src/tools/file-tools.ts");
  registry.register(writeTool);
  const client = fakeClient([
    [
      {
        type: "tool-calls",
        calls: [{ id: "c1", name: "write", argsJson: JSON.stringify({ path: "broken.ts", content: "const x = {;" }) }],
      },
      usage,
    ],
    [{ type: "text", delta: "hmm" }, usage],
  ]);
  const agent = new Agent({ client, tools: registry, config: makeConfig(), cwd: dir });
  const events = await collect(agent.run("write it"));

  expect(events.find((e) => e.type === "guardrail" && (e as any).kind === "syntax")).toBeTruthy();
  const result = events.find((e) => e.type === "tool-result") as any;
  expect(result.result).toContain("WARNING");
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

test("danger guard: dangerous bash routes through approve with a reason", async () => {
  const registry = new ToolRegistry();
  registry.register(bashTool);
  const client = fakeClient([
    [{ type: "tool-calls", calls: [{ id: "c1", name: "bash", argsJson: JSON.stringify({ command: "git push --force" }) }] }, usage],
    [{ type: "text", delta: "ok" }, usage],
  ]);
  let sawReason: string | undefined;
  const agent = new Agent({
    client,
    tools: registry,
    config: makeConfig(),
    cwd: "/tmp",
    approve: async (_n, _a, dangerReason) => {
      sawReason = dangerReason;
      return false; // user denies
    },
  });
  const events = await collect(agent.run("force push"));
  expect(sawReason).toContain("force-push");
  const result = events.find((e) => e.type === "tool-result") as any;
  expect(result.isError).toBe(true);
  expect(result.result).toContain("Denied");
});

test("danger guard: refused when no approver (headless)", async () => {
  const registry = new ToolRegistry();
  registry.register(bashTool);
  const client = fakeClient([
    [{ type: "tool-calls", calls: [{ id: "c1", name: "bash", argsJson: JSON.stringify({ command: "sudo rm -rf /etc" }) }] }, usage],
    [{ type: "text", delta: "ok" }, usage],
  ]);
  const agent = new Agent({ client, tools: registry, config: makeConfig(), cwd: "/tmp" }); // no approve
  const events = await collect(agent.run("go"));
  const result = events.find((e) => e.type === "tool-result") as any;
  expect(result.isError).toBe(true);
  expect(result.result).toContain("Refused");
});

test("routine bash still runs without approver (one-shot)", async () => {
  const registry = new ToolRegistry();
  registry.register(bashTool);
  const client = fakeClient([
    [{ type: "tool-calls", calls: [{ id: "c1", name: "bash", argsJson: JSON.stringify({ command: "echo hi" }) }] }, usage],
    [{ type: "text", delta: "done" }, usage],
  ]);
  const agent = new Agent({ client, tools: registry, config: makeConfig(), cwd: "/tmp" });
  const events = await collect(agent.run("go"));
  const result = events.find((e) => e.type === "tool-result") as any;
  expect(result.isError).toBe(false);
  expect(result.result).toContain("hi");
});

test("reflect() turns a failure into a lesson + quirk via the model", async () => {
  const client = fakeClient([
    [{ type: "text", delta: '{"lesson": "read the file before editing", "quirk": "model loops on ambiguous edits"}' }, usage],
  ]);
  const agent = new Agent({ client, tools: new ToolRegistry(), config: makeConfig(), cwd: "/tmp" });
  agent.context.addUser("edit the thing");
  const { lesson, quirk } = await agent.reflect("ran out of iterations");
  expect(lesson).toBe("read the file before editing");
  expect(quirk).toContain("loops");
});

test("reflect() tolerates non-JSON output", async () => {
  const client = fakeClient([[{ type: "text", delta: "just be more careful next time" }, usage]]);
  const agent = new Agent({ client, tools: new ToolRegistry(), config: makeConfig(), cwd: "/tmp" });
  const { lesson, quirk } = await agent.reflect("x");
  expect(lesson).toContain("careful");
  expect(quirk).toBe("");
});

test("stuckLimit stops a pure-error loop without capping productive work", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "fail",
    description: "always errors",
    args: z.object({}),
    maxResultTokens: 100,
    execute: async () => {
      throw new Error("nope");
    },
  });
  const client = fakeClient([[{ type: "tool-calls", calls: [{ id: "c", name: "fail", argsJson: "{}" }] }, usage]]);
  const cfg = makeConfig();
  cfg.loop.maxIterations = 0; // unlimited
  cfg.loop.stuckLimit = 3;
  const agent = new Agent({ client, tools: registry, config: cfg, cwd: "/tmp" });
  const events = await collect(agent.run("go"));
  expect(events.find((e) => e.type === "error" && /no progress/.test((e as any).message))).toBeTruthy();
  expect(events.find((e) => e.type === "turn-end")).toBeTruthy();
});
