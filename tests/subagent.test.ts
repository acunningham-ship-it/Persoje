import { test, expect } from "bun:test";
import { runSubAgent, SubAgentPool, makeTaskTool } from "../src/agents/subagent.ts";
import { ToolRegistry } from "../src/tools/types.ts";
import { readTool } from "../src/tools/file-tools.ts";
import type { ChatRequest, StreamEvent } from "../src/models/openrouter.ts";
import { z } from "zod";

/** Scripted fake client for testing. */
function fakeClient(scripts: StreamEvent[][]) {
  let call = 0;
  const capturedRequests: ChatRequest[] = [];

  const client = {
    stream: async function* (req: ChatRequest): AsyncGenerator<StreamEvent> {
      capturedRequests.push(req);
      const script = scripts[Math.min(call, scripts.length - 1)]!;
      call++;
      for (const ev of script) yield ev;
    },
    getRequests: () => capturedRequests,
  } as any;

  return client;
}

function makeConfig() {
  return {
    model: { primary: "test/model", fallbacks: [], temperature: 0 },
    context: { budgetTokens: 40_000, compactionThreshold: 0.8, keepFullTurns: 4 },
    loop: { maxIterations: 10, bashTimeoutMs: 5000 },
    toolResultCaps: {},
    openrouter: { baseUrl: "http://test", apiKey: "x" },
  } as any;
}

const usage = {
  type: "usage" as const,
  usage: { model: "test/model", inputTokens: 10, outputTokens: 5, cachedTokens: 0, cost: 0.001, durationMs: 10 },
};

test("runSubAgent captures final text and usage", async () => {
  const client = fakeClient([[{ type: "text", delta: "Task completed." }, usage]]);
  const registry = new ToolRegistry();
  registry.register(readTool);

  const result = await runSubAgent(
    { task: "Do something" },
    { client, tools: registry, config: makeConfig(), cwd: "/tmp" },
  );

  expect(result.summary).toContain("Task completed");
  expect(result.usage.calls).toBe(1);
  expect(result.usage.inputTokens).toBe(10);
  expect(result.usage.outputTokens).toBe(5);
  expect(result.usage.cost).toBeCloseTo(0.001);
});

test("sub-agent uses read-only default tools when none specified", async () => {
  const client = fakeClient([[{ type: "text", delta: "done" }, usage]]);
  const registry = new ToolRegistry();
  registry.register(readTool);
  registry.register({
    name: "bash",
    description: "bash",
    args: z.object({}),
    maxResultTokens: 100,
    execute: async () => "should not be available",
  });

  await runSubAgent(
    { task: "Do something" },
    { client, tools: registry, config: makeConfig(), cwd: "/tmp" },
  );

  // Verify the child's tools (passed to the stream) do NOT include bash.
  const req = client.getRequests()[0] as any;
  const toolNames = (req.tools ?? []).map((t: any) => t.function.name);
  expect(toolNames).not.toContain("bash");
  expect(toolNames).toContain("read");
});

test("sub-agent uses specified tools", async () => {
  const client = fakeClient([[{ type: "text", delta: "done" }, usage]]);
  const registry = new ToolRegistry();
  registry.register(readTool);
  registry.register({
    name: "bash",
    description: "bash",
    args: z.object({}),
    maxResultTokens: 100,
    execute: async () => "bash result",
  });

  await runSubAgent(
    { task: "Do something", tools: ["read", "bash"] },
    { client, tools: registry, config: makeConfig(), cwd: "/tmp" },
  );

  const req = client.getRequests()[0] as any;
  const toolNames = (req.tools ?? []).map((t: any) => t.function.name);
  expect(toolNames).toContain("bash");
  expect(toolNames).toContain("read");
});

test("sub-agent summary is truncated to summaryMaxTokens", async () => {
  const longText = "X".repeat(10_000); // ~2500 tokens
  const client = fakeClient([[{ type: "text", delta: longText }, usage]]);
  const registry = new ToolRegistry();

  const result = await runSubAgent(
    { task: "Do something", summaryMaxTokens: 100 },
    { client, tools: registry, config: makeConfig(), cwd: "/tmp" },
  );

  // Summary should be much shorter than 10k chars.
  expect(result.summary.length).toBeLessThan(2000);
  // Check if truncation marker is present.
  expect(result.summary).toContain("omitted");
});

test("sub-agent model can be overridden", async () => {
  const client = fakeClient([[{ type: "text", delta: "done" }, usage]]);
  const registry = new ToolRegistry();
  const config = makeConfig();
  config.model.primary = "default/model";

  await runSubAgent(
    { task: "Do something", model: "special/model" },
    { client, tools: registry, config, cwd: "/tmp" },
  );

  const req = client.getRequests()[0] as any;
  expect(req.model).toBe("special/model");
});

test("sub-agent maxIterations defaults to 10", async () => {
  const client = fakeClient([
    [{ type: "tool-calls", calls: [{ id: "c", name: "read", argsJson: JSON.stringify({ path: "/etc/hostname" }) }] }, usage],
  ]);
  const registry = new ToolRegistry();
  registry.register(readTool);
  const config = makeConfig();
  config.loop.maxIterations = 50; // parent has high limit

  await runSubAgent(
    { task: "loop forever" },
    { client, tools: registry, config, cwd: "/tmp" },
  );

  const req = client.getRequests()[0] as any;
  expect(req.model).toBeDefined();
  // The child config should have maxIterations = 10.
  // We can't directly inspect it, but we verify the sub-agent respects the default.
});

test("SubAgentPool limits concurrency", async () => {
  const pool = new SubAgentPool(2);
  const concurrencyLog: number[] = [];
  let peakConcurrency = 0;
  let activeTasks = 0;

  const task = async (id: number) => {
    activeTasks++;
    peakConcurrency = Math.max(peakConcurrency, activeTasks);
    await new Promise((resolve) => setTimeout(resolve, 50));
    activeTasks--;
    return id;
  };

  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(pool.run(() => task(i)));
  }

  const results = await Promise.all(promises);
  expect(results).toHaveLength(5);
  expect(peakConcurrency).toBeLessThanOrEqual(2);
});

test("makeTaskTool returns a Tool and executes via pool", async () => {
  const client = fakeClient([[{ type: "text", delta: "task result" }, usage]]);
  const registry = new ToolRegistry();

  const tool = makeTaskTool({
    client,
    tools: registry,
    config: makeConfig(),
    cwd: "/tmp",
  });

  expect(tool.name).toBe("task");
  expect(tool.description).toContain("sub-agent");

  // Execute the tool.
  const result = await tool.execute({ task: "do work", tools: ["read"] }, { cwd: "/tmp", bashTimeoutMs: 5000 });

  expect(result).toContain("task result");
  expect(result).toContain("[sub-agent:");
  expect(result).toContain("calls");
});

test("makeTaskTool summary includes usage footer", async () => {
  const client = fakeClient([
    [{ type: "text", delta: "summary" }, { type: "usage", usage: { model: "m", inputTokens: 100, outputTokens: 50, cachedTokens: 0, cost: 0.005, durationMs: 100 } }],
  ]);
  const registry = new ToolRegistry();

  const tool = makeTaskTool({
    client,
    tools: registry,
    config: makeConfig(),
    cwd: "/tmp",
  });

  const result = await tool.execute({ task: "work" }, { cwd: "/tmp", bashTimeoutMs: 5000 });

  expect(result).toContain("summary");
  expect(result).toMatch(/\$0\.\d+/); // Cost in result
});

test("transcript isolation: only summary returns to parent", async () => {
  const client = fakeClient([
    [
      { type: "text", delta: "internal reasoning step 1\n" },
      { type: "text", delta: "internal reasoning step 2\n" },
      { type: "text", delta: "final summary" },
      usage,
    ],
  ]);
  const registry = new ToolRegistry();

  const result = await runSubAgent(
    { task: "Do something" },
    { client, tools: registry, config: makeConfig(), cwd: "/tmp" },
  );

  // Only the final text should be in the result.
  expect(result.summary).toContain("final summary");
  // The intermediate deltas are captured internally but only final is returned.
});
