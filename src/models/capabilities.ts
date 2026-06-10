/**
 * Model capability detection — reasoning, tools, vision, context length.
 * Curated map for known models; optionally enriched from OpenRouter supported_parameters.
 */

export interface ModelCapabilities {
  reasoning?: "none" | "budget" | "full";
  tools?: boolean;
  vision?: boolean;
  contextLength?: number;
}

/**
 * Curated static map of model -> capabilities.
 * Models are identified by OpenRouter model ID (e.g., "anthropic/claude-fable-5").
 *
 * Reasoning levels:
 * - "none": no reasoning support (most models)
 * - "full": supports effort levels (low/medium/high) like Claude, Gemini, Grok
 * - "budget": supports max_tokens control like o1, o1-mini, deepseek-r1 (limited tokens)
 */
const CAPABILITIES_MAP: Record<string, ModelCapabilities> = {
  // Anthropic Claude
  "anthropic/claude-opus-4-8": {
    reasoning: "full",
    tools: true,
    vision: true,
    contextLength: 200000,
  },
  "anthropic/claude-opus-4-7": {
    reasoning: "full",
    tools: true,
    vision: true,
    contextLength: 200000,
  },
  "anthropic/claude-opus-4-6": {
    reasoning: "full",
    tools: true,
    vision: true,
    contextLength: 200000,
  },
  "anthropic/claude-sonnet-4-6": {
    reasoning: "full",
    tools: true,
    vision: true,
    contextLength: 200000,
  },
  "anthropic/claude-haiku-4-5": {
    reasoning: "none",
    tools: true,
    vision: true,
    contextLength: 200000,
  },
  "anthropic/claude-fable-5": {
    reasoning: "full",
    tools: true,
    vision: true,
    contextLength: 200000,
  },
  "~anthropic/claude-fable-latest": {
    reasoning: "full",
    tools: true,
    vision: true,
    contextLength: 200000,
  },

  // OpenAI o-series (budget reasoning)
  "openai/o1": {
    reasoning: "budget",
    tools: false,
    vision: false,
    contextLength: 128000,
  },
  "openai/o1-mini": {
    reasoning: "budget",
    tools: false,
    vision: false,
    contextLength: 128000,
  },
  "openai/o1-preview": {
    reasoning: "budget",
    tools: false,
    vision: false,
    contextLength: 128000,
  },

  // Deepseek (budget reasoning)
  "deepseek/deepseek-r1": {
    reasoning: "budget",
    tools: true,
    vision: false,
    contextLength: 64000,
  },

  // Google Gemini (thinking models — full reasoning)
  "google/gemini-2-flash-thinking-exp": {
    reasoning: "full",
    tools: true,
    vision: true,
    contextLength: 1000000,
  },
  "google/gemini-2-pro-exp-thinking": {
    reasoning: "full",
    tools: true,
    vision: true,
    contextLength: 1000000,
  },

  // Qwen
  "qwen/qwen-32b-vision-awq": {
    reasoning: "none",
    tools: true,
    vision: true,
    contextLength: 32768,
  },
  "qwen/qwen-long": {
    reasoning: "none",
    tools: true,
    vision: false,
    contextLength: 1000000,
  },

  // xAI Grok (full reasoning)
  "x-ai/grok-4.3": {
    reasoning: "full",
    tools: true,
    vision: true,
    contextLength: 128000,
  },

  // Owl-alpha (OpenRouter's free fallback)
  "openrouter/owl-alpha": {
    reasoning: "none",
    tools: true,
    vision: false,
    contextLength: 8000,
  },
};

/**
 * Get capabilities for a model by ID.
 * Falls back to conservative defaults if model is unknown.
 */
export function getCapabilities(modelId: string): ModelCapabilities {
  if (modelId in CAPABILITIES_MAP) {
    return CAPABILITIES_MAP[modelId]!;
  }

  // Heuristics for unknown models
  const lowerCased = modelId.toLowerCase();
  let reasoning: "none" | "budget" | "full" = "none";

  // Budget reasoning: o1, r1 (OpenAI, DeepSeek) — limited tokens
  if (lowerCased.includes("o1") || lowerCased.includes("r1")) {
    reasoning = "budget";
  }
  // Full reasoning: thinking, gemini-thinking, qwen-thinking, grok
  else if (
    lowerCased.includes("thinking") ||
    lowerCased.includes("reasoning") ||
    lowerCased.includes("grok")
  ) {
    reasoning = "full";
  }

  return {
    reasoning,
    tools: !lowerCased.includes("o1"), // o1 doesn't support tools
    vision: lowerCased.includes("vision") || lowerCased.includes("gemini"),
    contextLength: 64000, // conservative default
  };
}
