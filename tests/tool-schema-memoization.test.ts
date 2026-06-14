import { test, expect, describe } from "bun:test";
import { ToolRegistry, type Tool } from "../src/tools/types.ts";
import { z } from "zod";
import { ContextManager } from "../src/context/manager.ts";
import { Agent } from "../src/core/agent.ts";
import type { ChatRequest } from "../src/models/openrouter.ts";

// Mock tool for testing
const mockTool: Tool = {
  name: "test_tool",
  description: "A test tool for schema memoization",
  args: z.object({ input: z.string().describe("Input text") }),
  maxResultTokens: 100,
  execute: async () => "ok",
};

const mockTool2: Tool = {
  name: "another_tool",
  description: "Another test tool",
  args: z.object({ count: z.number().describe("A count") }),
  maxResultTokens: 100,
  execute: async () => "ok",
};

test("schemas are memoized on repeated calls with same tools", () => {
  const registry = new ToolRegistry();
  registry.register(mockTool);

  // First call — computes schemas
  const schemas1 = registry.schemas();
  const cost1 = registry.schemaTokens();

  // Second call with no changes — should return cached result
  const schemas2 = registry.schemas();
  const cost2 = registry.schemaTokens();

  // Verify they're the same object (memoized)
  expect(schemas1).toBe(schemas2);
  expect(cost1).toBe(cost2);
  expect(cost1).toBeGreaterThan(0);
});

test("schema cache invalidates when tool list changes", () => {
  const registry = new ToolRegistry();
  registry.register(mockTool);

  const schemas1 = registry.schemas();
  const cost1 = registry.schemaTokens();

  // Register a new tool
  registry.register(mockTool2);

  // Next call should recompute
  const schemas2 = registry.schemas();
  const cost2 = registry.schemaTokens();

  // Should be different objects now
  expect(schemas2).not.toBe(schemas1);
  expect(schemas2.length).toBe(2);
  expect(schemas1.length).toBe(1);
  // Cost should be higher with more tools
  expect(cost2).toBeGreaterThan(cost1);
});

test("invalidateSchemaCache clears the cache", () => {
  const registry = new ToolRegistry();
  registry.register(mockTool);

  const schemas1 = registry.schemas();
  const cost1 = registry.schemaTokens();

  // Manually invalidate
  registry.invalidateSchemaCache();

  // Calling schemas again should recompute
  const schemas2 = registry.schemas();
  const cost2 = registry.schemaTokens();

  // New computation results
  expect(schemas2).not.toBe(schemas1);
  expect(cost1).toBe(cost2); // Cost is the same (same tools) but different call
});

test("subset registry has independent schema cache", () => {
  const registry = new ToolRegistry();
  registry.register(mockTool);
  registry.register(mockTool2);

  const fullSchemas = registry.schemas();
  const fullCost = registry.schemaTokens();

  // Create a subset with only one tool
  const subset = registry.subset([mockTool.name]);
  const subsetSchemas = subset.schemas();
  const subsetCost = subset.schemaTokens();

  // Subset should be smaller
  expect(subsetSchemas.length).toBe(1);
  expect(subsetCost).toBeLessThan(fullCost);

  // Caches are independent
  subset.register(mockTool2);
  const subsetSchemas2 = subset.schemas();
  expect(subsetSchemas2.length).toBe(2);
  expect(subsetSchemas2).not.toBe(subsetSchemas);
});

test("schema token count is accurate", () => {
  const registry = new ToolRegistry();
  registry.register(mockTool);

  registry.schemas();
  const schemaTokens = registry.schemaTokens();

  // Verify it's a reasonable estimate (should be roughly JSON length / 4)
  expect(schemaTokens).toBeGreaterThan(0);
  expect(schemaTokens).toBeLessThan(1000); // Sanity check for a single tool
});

describe("ContextManager integration", () => {
  test("buildStats includes schemaTokens", () => {
    const cm = new ContextManager(10000, 0.8, 4);
    cm.setSchemaTokens(500);

    const stats = cm.buildStats();
    expect(stats.schemaTokens).toBe(500);
  });

  test("schemaTokens defaults to 0 if not set", () => {
    const cm = new ContextManager(10000, 0.8, 4);
    const stats = cm.buildStats();
    expect(stats.schemaTokens).toBe(0);
  });

  test("setSchemaTokens updates the value", () => {
    const cm = new ContextManager(10000, 0.8, 4);
    cm.setSchemaTokens(300);
    expect(cm.buildStats().schemaTokens).toBe(300);

    cm.setSchemaTokens(600);
    expect(cm.buildStats().schemaTokens).toBe(600);
  });
});

test("Agent wires schema cost into context at initialization", () => {
  const registry = new ToolRegistry();
  registry.register(mockTool);

  const mockConfig = {
    model: { primary: "test/model", fallbacks: [], temperature: 0 },
    context: { budgetTokens: 40000, compactionThreshold: 0.8, keepFullTurns: 4 },
    loop: { maxIterations: 5, bashTimeoutMs: 5000 },
    toolResultCaps: {},
    openrouter: { baseUrl: "http://test", apiKey: "x" },
  } as any;

  const mockClient = {
    stream: async function* (_req: ChatRequest) {
      yield { type: "text", delta: "done" } as any;
      yield {
        type: "usage",
        usage: {
          model: "test/model",
          inputTokens: 100,
          outputTokens: 50,
          cachedTokens: 0,
          cost: 0.001,
          durationMs: 50,
        },
      } as any;
    },
  } as any;

  const agent = new Agent({
    client: mockClient,
    tools: registry,
    config: mockConfig,
    cwd: "/tmp",
  });

  const stats = agent.context.buildStats();
  expect(stats.schemaTokens).toBeGreaterThan(0);
});
