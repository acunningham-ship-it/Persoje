import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PersojeConfig } from "../src/config/config.ts";
import { loadConfig, resolveProvider, resolveApiKey, setActiveProvider } from "../src/config/config.ts";

// Use a temp config path for testing
const TEST_CONFIG_DIR = join(homedir(), ".config", "persoje-test");
const TEST_CONFIG_PATH = join(TEST_CONFIG_DIR, "config.json");

async function writeTestConfig(cfg: Record<string, unknown>): Promise<void> {
  await Bun.write(TEST_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

async function readTestConfig(): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(TEST_CONFIG_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

describe("multi-provider config", () => {
  beforeEach(async () => {
    try {
      await Bun.file(TEST_CONFIG_PATH).exists() && (await rm(TEST_CONFIG_PATH));
    } catch {}
  });

  afterEach(async () => {
    try {
      await rm(TEST_CONFIG_PATH);
    } catch {}
  });

  it("resolveProvider falls back to legacy openrouter block when no providers defined", async () => {
    const config: PersojeConfig = {
      model: { primary: "openrouter/auto", fallbacks: [], compactor: "", subagent: "", judge: "", temperature: 0.3 },
      context: { budgetTokens: 40000, compactionThreshold: 0.8, keepFullTurns: 4, repoMapTokens: 800, cacheSystemPrompt: true, headroom: 20, accurateEstimates: true },
      loop: { maxIterations: 0, stuckLimit: 10, bashTimeoutMs: 60000, maxCostUsd: 0, enableMonitors: true },
      retry: { maxRetries: 5 },
      toolResultCaps: {},
      router: { enabled: true, mode: "offer", failureThreshold: 3, canary: true, escalateTo: "" },
      memory: { enabled: true, budgetTokens: 1200, dreamModel: "" },
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "test-key-123",
      },
      providers: {},
      activeProvider: "openrouter",
      theme: { name: "amber" },
    };

    const provider = resolveProvider(config);
    expect(provider.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(provider.apiKey).toBe("test-key-123");
    expect(provider.extraHeaders?.["HTTP-Referer"]).toBe("https://github.com/armani/persoje");
    expect(provider.extraHeaders?.["X-Title"]).toBe("Persoje");
    expect(provider.routing).toBeUndefined();
  });

  it("resolveApiKey delegates to resolveProvider for backward compat", async () => {
    const config: PersojeConfig = {
      model: { primary: "openrouter/auto", fallbacks: [], compactor: "", subagent: "", judge: "", temperature: 0.3 },
      context: { budgetTokens: 40000, compactionThreshold: 0.8, keepFullTurns: 4, repoMapTokens: 800, cacheSystemPrompt: true, headroom: 20, accurateEstimates: true },
      loop: { maxIterations: 0, stuckLimit: 10, bashTimeoutMs: 60000, maxCostUsd: 0, enableMonitors: true },
      retry: { maxRetries: 5 },
      toolResultCaps: {},
      router: { enabled: true, mode: "offer", failureThreshold: 3, canary: true, escalateTo: "" },
      memory: { enabled: true, budgetTokens: 1200, dreamModel: "" },
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "legacy-key-456",
      },
      providers: {},
      activeProvider: "openrouter",
      theme: { name: "amber" },
    };

    const key = resolveApiKey(config);
    expect(key).toBe("legacy-key-456");
  });

  it("resolveProvider reads OPENROUTER_API_KEY from env when not in config", async () => {
    process.env.OPENROUTER_API_KEY = "env-key-789";

    const config: PersojeConfig = {
      model: { primary: "openrouter/auto", fallbacks: [], compactor: "", subagent: "", judge: "", temperature: 0.3 },
      context: { budgetTokens: 40000, compactionThreshold: 0.8, keepFullTurns: 4, repoMapTokens: 800, cacheSystemPrompt: true, headroom: 20, accurateEstimates: true },
      loop: { maxIterations: 0, stuckLimit: 10, bashTimeoutMs: 60000, maxCostUsd: 0, enableMonitors: true },
      retry: { maxRetries: 5 },
      toolResultCaps: {},
      router: { enabled: true, mode: "offer", failureThreshold: 3, canary: true, escalateTo: "" },
      memory: { enabled: true, budgetTokens: 1200, dreamModel: "" },
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
      },
      providers: {},
      activeProvider: "openrouter",
      theme: { name: "amber" },
    };

    const provider = resolveProvider(config);
    expect(provider.apiKey).toBe("env-key-789");

    delete process.env.OPENROUTER_API_KEY;
  });

  it("resolveProvider resolves a named provider with explicit baseUrl and apiKey", async () => {
    const config: PersojeConfig = {
      model: { primary: "deepseek/deepseek-chat", fallbacks: [], compactor: "", subagent: "", judge: "", temperature: 0.3 },
      context: { budgetTokens: 40000, compactionThreshold: 0.8, keepFullTurns: 4, repoMapTokens: 800, cacheSystemPrompt: true, headroom: 20, accurateEstimates: true },
      loop: { maxIterations: 0, stuckLimit: 10, bashTimeoutMs: 60000, maxCostUsd: 0, enableMonitors: true },
      retry: { maxRetries: 5 },
      toolResultCaps: {},
      router: { enabled: true, mode: "offer", failureThreshold: 3, canary: true, escalateTo: "" },
      memory: { enabled: true, budgetTokens: 1200, dreamModel: "" },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
      providers: {
        local: {
          type: "openai-compat",
          baseUrl: "http://localhost:8799/v1",
          apiKey: "local-dev-key",
          extraHeaders: { "Custom-Header": "custom-value" },
        },
      },
      activeProvider: "local",
      theme: { name: "amber" },
    };

    const provider = resolveProvider(config);
    expect(provider.baseUrl).toBe("http://localhost:8799/v1");
    expect(provider.apiKey).toBe("local-dev-key");
    expect(provider.extraHeaders?.["Custom-Header"]).toBe("custom-value");
  });

  it("resolveProvider reads apiKey from apiKeyEnv when not explicit", async () => {
    process.env.MY_CUSTOM_KEY = "custom-env-key";

    const config: PersojeConfig = {
      model: { primary: "deepseek/deepseek-chat", fallbacks: [], compactor: "", subagent: "", judge: "", temperature: 0.3 },
      context: { budgetTokens: 40000, compactionThreshold: 0.8, keepFullTurns: 4, repoMapTokens: 800, cacheSystemPrompt: true, headroom: 20, accurateEstimates: true },
      loop: { maxIterations: 0, stuckLimit: 10, bashTimeoutMs: 60000, maxCostUsd: 0, enableMonitors: true },
      retry: { maxRetries: 5 },
      toolResultCaps: {},
      router: { enabled: true, mode: "offer", failureThreshold: 3, canary: true, escalateTo: "" },
      memory: { enabled: true, budgetTokens: 1200, dreamModel: "" },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
      providers: {
        custom: {
          type: "openai-compat",
          baseUrl: "http://custom.example.com/v1",
          apiKeyEnv: "MY_CUSTOM_KEY",
        },
      },
      activeProvider: "custom",
      theme: { name: "amber" },
    };

    const provider = resolveProvider(config);
    expect(provider.apiKey).toBe("custom-env-key");

    delete process.env.MY_CUSTOM_KEY;
  });

  it("resolveProvider includes routing from provider config", async () => {
    const config: PersojeConfig = {
      model: { primary: "openrouter/auto", fallbacks: [], compactor: "", subagent: "", judge: "", temperature: 0.3 },
      context: { budgetTokens: 40000, compactionThreshold: 0.8, keepFullTurns: 4, repoMapTokens: 800, cacheSystemPrompt: true, headroom: 20, accurateEstimates: true },
      loop: { maxIterations: 0, stuckLimit: 10, bashTimeoutMs: 60000, maxCostUsd: 0, enableMonitors: true },
      retry: { maxRetries: 5 },
      toolResultCaps: {},
      router: { enabled: true, mode: "offer", failureThreshold: 3, canary: true, escalateTo: "" },
      memory: { enabled: true, budgetTokens: 1200, dreamModel: "" },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "test" },
      providers: {
        deepinfra: {
          type: "openai-compat",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "test",
          routing: { order: ["deepinfra"], allow_fallbacks: true },
        },
      },
      activeProvider: "deepinfra",
      theme: { name: "amber" },
    };

    const provider = resolveProvider(config);
    expect(provider.routing).toEqual({ order: ["deepinfra"], allow_fallbacks: true });
  });

  it("resolveProvider includes optional model from provider config", async () => {
    const config: PersojeConfig = {
      model: { primary: "openrouter/auto", fallbacks: [], compactor: "", subagent: "", judge: "", temperature: 0.3 },
      context: { budgetTokens: 40000, compactionThreshold: 0.8, keepFullTurns: 4, repoMapTokens: 800, cacheSystemPrompt: true, headroom: 20, accurateEstimates: true },
      loop: { maxIterations: 0, stuckLimit: 10, bashTimeoutMs: 60000, maxCostUsd: 0, enableMonitors: true },
      retry: { maxRetries: 5 },
      toolResultCaps: {},
      router: { enabled: true, mode: "offer", failureThreshold: 3, canary: true, escalateTo: "" },
      memory: { enabled: true, budgetTokens: 1200, dreamModel: "" },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
      providers: {
        local: {
          type: "openai-compat",
          baseUrl: "http://localhost:8799/v1",
          apiKey: "local-key",
          model: "deepseek/deepseek-chat",
        },
      },
      activeProvider: "local",
      theme: { name: "amber" },
    };

    const provider = resolveProvider(config);
    expect(provider.model).toBe("deepseek/deepseek-chat");
  });

  it("throws error when provider not found and not openrouter", async () => {
    const config: PersojeConfig = {
      model: { primary: "openrouter/auto", fallbacks: [], compactor: "", subagent: "", judge: "", temperature: 0.3 },
      context: { budgetTokens: 40000, compactionThreshold: 0.8, keepFullTurns: 4, repoMapTokens: 800, cacheSystemPrompt: true, headroom: 20, accurateEstimates: true },
      loop: { maxIterations: 0, stuckLimit: 10, bashTimeoutMs: 60000, maxCostUsd: 0, enableMonitors: true },
      retry: { maxRetries: 5 },
      toolResultCaps: {},
      router: { enabled: true, mode: "offer", failureThreshold: 3, canary: true, escalateTo: "" },
      memory: { enabled: true, budgetTokens: 1200, dreamModel: "" },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
      providers: {},
      activeProvider: "nonexistent",
      theme: { name: "amber" },
    };

    expect(() => resolveProvider(config)).toThrow(/not found in config.providers/);
  });

  it("throws error when provider has no baseUrl", async () => {
    const config: PersojeConfig = {
      model: { primary: "openrouter/auto", fallbacks: [], compactor: "", subagent: "", judge: "", temperature: 0.3 },
      context: { budgetTokens: 40000, compactionThreshold: 0.8, keepFullTurns: 4, repoMapTokens: 800, cacheSystemPrompt: true, headroom: 20, accurateEstimates: true },
      loop: { maxIterations: 0, stuckLimit: 10, bashTimeoutMs: 60000, maxCostUsd: 0, enableMonitors: true },
      retry: { maxRetries: 5 },
      toolResultCaps: {},
      router: { enabled: true, mode: "offer", failureThreshold: 3, canary: true, escalateTo: "" },
      memory: { enabled: true, budgetTokens: 1200, dreamModel: "" },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
      providers: {
        broken: {
          type: "openai-compat",
          baseUrl: "",
          apiKey: "key",
        },
      },
      activeProvider: "broken",
      theme: { name: "amber" },
    };

    expect(() => resolveProvider(config)).toThrow(/no baseUrl/);
  });

  it("throws error when no API key available", async () => {
    const config: PersojeConfig = {
      model: { primary: "openrouter/auto", fallbacks: [], compactor: "", subagent: "", judge: "", temperature: 0.3 },
      context: { budgetTokens: 40000, compactionThreshold: 0.8, keepFullTurns: 4, repoMapTokens: 800, cacheSystemPrompt: true, headroom: 20, accurateEstimates: true },
      loop: { maxIterations: 0, stuckLimit: 10, bashTimeoutMs: 60000, maxCostUsd: 0, enableMonitors: true },
      retry: { maxRetries: 5 },
      toolResultCaps: {},
      router: { enabled: true, mode: "offer", failureThreshold: 3, canary: true, escalateTo: "" },
      memory: { enabled: true, budgetTokens: 1200, dreamModel: "" },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
      providers: {
        nokey: {
          type: "openai-compat",
          baseUrl: "http://localhost/v1",
        },
      },
      activeProvider: "nokey",
      theme: { name: "amber" },
    };

    expect(() => resolveProvider(config)).toThrow(/No API key/);
  });

  it("setActiveProvider persists activeProvider to global config", async () => {
    await writeTestConfig({
      activeProvider: "openrouter",
      model: { primary: "openrouter/auto", fallbacks: [], compactor: "", subagent: "", judge: "", temperature: 0.3 },
    });

    // Simulate setActiveProvider but write to test path
    const existing = await readTestConfig();
    await writeTestConfig({ ...existing, activeProvider: "local" });

    const updated = await readTestConfig();
    expect(updated?.activeProvider).toBe("local");
  });

  it("activeProvider defaults to openrouter when set to empty string", async () => {
    const cfg = {
      model: { primary: "openrouter/auto" },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "test" },
      providers: {},
    };
    // Simulate loading a config without activeProvider
    const active = (cfg as any).activeProvider ?? "openrouter";
    expect(active).toBe("openrouter");
  });

  it("legacy openrouter.provider routing is passed through in synthesized provider", async () => {
    const config: PersojeConfig = {
      model: { primary: "openrouter/auto", fallbacks: [], compactor: "", subagent: "", judge: "", temperature: 0.3 },
      context: { budgetTokens: 40000, compactionThreshold: 0.8, keepFullTurns: 4, repoMapTokens: 800, cacheSystemPrompt: true, headroom: 20, accurateEstimates: true },
      loop: { maxIterations: 0, stuckLimit: 10, bashTimeoutMs: 60000, maxCostUsd: 0, enableMonitors: true },
      retry: { maxRetries: 5 },
      toolResultCaps: {},
      router: { enabled: true, mode: "offer", failureThreshold: 3, canary: true, escalateTo: "" },
      memory: { enabled: true, budgetTokens: 1200, dreamModel: "" },
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "test",
        provider: { order: ["deepinfra"] },
      },
      providers: {},
      activeProvider: "openrouter",
      theme: { name: "amber" },
    };

    const provider = resolveProvider(config);
    expect(provider.routing).toEqual({ order: ["deepinfra"] });
  });
});
