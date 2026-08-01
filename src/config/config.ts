import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

const ConfigSchema = z.object({
  model: z
    .object({
      /** Primary model id, e.g. "deepseek/deepseek-chat" or "openrouter/auto". */
      primary: z.string().default("openrouter/auto"),
      /** Fallback model ids tried by OpenRouter (the `models` array) when primary errors. */
      fallbacks: z.array(z.string()).default([]),
      /** Model used for compaction summaries — grunt work, point it at a free model. Empty = primary. */
      compactor: z.string().default(""),
      /** Model for sub-agents (the `task` tool). Point at a FASTER model to cut delegation latency. Empty = primary. */
      subagent: z.string().default(""),
      /** Model that vets facts during `dream` (LLM-as-judge). A stronger model here improves memory quality. Empty = dream model. */
      judge: z.string().default(""),
      temperature: z.number().min(0).max(2).default(0.3),
    })
    .prefault({}),
  context: z
    .object({
      /** Self-imposed context budget in tokens. Clamped at startup to the active model's
       *  window (× 0.8), so this default suits a 1M-window model (owl-alpha) without
       *  overflowing a smaller one. 40k was strangling reasoning on big-window models. */
      budgetTokens: z.number().default(200_000),
      /** Compact when estimated history exceeds this fraction of the budget. */
      compactionThreshold: z.number().min(0.3).max(0.95).default(0.65),
      /** Turns kept at full fidelity during compaction. */
      keepFullTurns: z.number().default(10),
      /** Repo-map token budget; 0 disables. */
      repoMapTokens: z.number().default(1_500),
      /** Attach a cache_control breakpoint to the system prompt (providers without caching ignore it). */
      cacheSystemPrompt: z.boolean().default(true),
      /** Min % of context budget kept free as headroom (0-50). E.g. 20 = compact to 80% at most. */
      headroom: z.number().min(0).max(50).default(20),
      /** Use accurate token estimation (code-aware chars/tok ratio instead of fixed 4). */
      accurateEstimates: z.boolean().default(true),
    })
    .prefault({}),
  loop: z
    .object({
      /** Max model-call iterations per user turn. 0 = unlimited (work until done). */
      maxIterations: z.number().default(0),
      /** Safety stop ONLY for a stuck model: N consecutive rounds where every tool
       *  call errors and nothing succeeds. Not a productive cap. 0 = never stop. */
      stuckLimit: z.number().default(10),
      /** Bash tool timeout in ms. */
      bashTimeoutMs: z.number().default(60_000),
      /** Hard session cost ceiling in USD — the turn halts once accumulated cost
       *  reaches it (the safety net for autonomous/long runs). 0 = unlimited. */
      maxCostUsd: z.number().default(0),
      /** Enable background monitors that fire between iterations (file watchers, periodic checks, etc.). */
      enableMonitors: z.boolean().default(true),
    })
    .prefault({}),
  retry: z
    .object({
      /** Max retry attempts for API calls (rate limits, server errors). Default 5. */
      maxRetries: z.number().min(0).max(10).default(5),
    })
    .prefault({}),
  toolResultCaps: z.record(z.string(), z.number()).default({}),
  router: z
    .object({
      /** Master toggle: off = fully manual model selection (no escalation suggestions, no canary). */
      enabled: z.boolean().default(true),
      /** "offer" suggests a switch; "auto" switches the primary model itself. */
      mode: z.enum(["offer", "auto"]).default("offer"),
      /** Guardrail failures within the window before escalation fires. */
      failureThreshold: z.number().default(3),
      /** Run the 3-prompt canary on first use of an unknown model (interactive only). */
      canary: z.boolean().default(true),
      /** Default escalation target when a model profile has none. */
      escalateTo: z.string().default(""),
    })
    .prefault({}),
  memory: z
    .object({
      enabled: z.boolean().default(true),
      /** Combined session-start budget for memory index + lessons (tokens). */
      budgetTokens: z.number().default(1200),
      /** Model for `persoje dream` consolidation. Empty = compactor, then primary. */
      dreamModel: z.string().default(""),
    })
    .prefault({}),
  openrouter: z
    .object({
      baseUrl: z.string().default("https://openrouter.ai/api/v1"),
      /** Falls back to OPENROUTER_API_KEY env var. */
      apiKey: z.string().optional(),
      /**
       * OpenRouter provider routing passthrough, e.g. {"order": ["deepinfra"], "allow_fallbacks": true}.
       * Pinning a provider keeps prompt-cache continuity on multi-provider models.
       * @deprecated Use providers[activeProvider].routing instead.
       */
      provider: z.record(z.string(), z.unknown()).optional(),
    })
    .prefault({}),
  providers: z
    .record(
      z.string(),
      z.object({
        /** Provider type: "openai-compat" (only supported type currently). */
        type: z.enum(["openai-compat"]).default("openai-compat"),
        /** Base URL for the provider's API. */
        baseUrl: z.string(),
        /** API key (plain); if not set, reads from apiKeyEnv or OPENROUTER_API_KEY. */
        apiKey: z.string().optional(),
        /** Name of environment variable to read the API key from (fallback). */
        apiKeyEnv: z.string().optional(),
        /** Extra headers to send with every request (e.g. X-Title for OpenRouter). */
        extraHeaders: z.record(z.string(), z.string()).optional(),
        /** Provider routing config (OpenRouter-specific, e.g. {"order": ["deepinfra"]}). */
        routing: z.record(z.string(), z.unknown()).optional(),
        /** Optional default model for this provider. */
        model: z.string().optional(),
      }),
    )
    .default({}),
  /** Active provider name — defaults to "openrouter". */
  activeProvider: z.string().default("openrouter"),
  theme: z
    .object({
      /** Theme name: amber (default), ocean, forest, rose, mono */
      name: z.enum(["amber", "ocean", "forest", "rose", "mono"]).default("amber"),
    })
    .prefault({}),
});

export type PersojeConfig = z.infer<typeof ConfigSchema>;

export const GLOBAL_CONFIG_DIR = join(homedir(), ".config", "persoje");
export const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "config.json");

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${(e as Error).message}`);
  }
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const existing = out[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      existing && typeof existing === "object" && !Array.isArray(existing)
    ) {
      out[k] = deepMerge(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Load config: defaults ← ~/.config/persoje/config.json ← ./.persoje/config.json */
export async function loadConfig(cwd = process.cwd()): Promise<PersojeConfig> {
  let raw: Record<string, unknown> = {};
  const global = await readJsonIfExists(GLOBAL_CONFIG_PATH);
  if (global) raw = deepMerge(raw, global);
  const project = await readJsonIfExists(join(cwd, ".persoje", "config.json"));
  if (project) raw = deepMerge(raw, project);
  return ConfigSchema.parse(raw);
}

/**
 * Resolve the active provider: synthesize from providers[activeProvider], falling back to
 * the legacy openrouter block for backward compatibility. Returns baseUrl, apiKey,
 * extraHeaders, routing, and optional model.
 */
export interface ResolvedProvider {
  baseUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  routing?: Record<string, unknown>;
  model?: string;
}

export function resolveProvider(config: PersojeConfig): ResolvedProvider {
  const active = config.activeProvider ?? "openrouter";
  const providerDef = config.providers?.[active];

  // If no provider defined and active is "openrouter", synthesize from legacy block.
  if (!providerDef && active === "openrouter") {
    const baseUrl = config.openrouter.baseUrl ?? "https://openrouter.ai/api/v1";
    const apiKey = config.openrouter.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "No OpenRouter API key. Set OPENROUTER_API_KEY or add openrouter.apiKey to ~/.config/persoje/config.json",
      );
    }
    return {
      baseUrl,
      apiKey,
      extraHeaders: {
        "HTTP-Referer": "https://github.com/armani/persoje",
        "X-Title": "Persoje",
      },
      routing: config.openrouter.provider,
    };
  }

  // Provider explicitly defined.
  if (providerDef) {
    const baseUrl = providerDef.baseUrl;
    if (!baseUrl) {
      throw new Error(`Provider "${active}" has no baseUrl in config`);
    }

    // Resolve API key: explicit → env var → fallback to OPENROUTER_API_KEY for back-compat.
    const apiKey = providerDef.apiKey ?? process.env[providerDef.apiKeyEnv ?? ""] ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        `No API key for provider "${active}". Set ${providerDef.apiKeyEnv ?? "OPENROUTER_API_KEY"} ` +
          `or add providers.${active}.apiKey to ~/.config/persoje/config.json`,
      );
    }

    return {
      baseUrl,
      apiKey,
      extraHeaders: providerDef.extraHeaders,
      routing: providerDef.routing,
      model: providerDef.model,
    };
  }

  // No provider config and not openrouter — error.
  throw new Error(
    `Provider "${active}" not found in config.providers. ` +
      `Add a provider entry or set activeProvider to "openrouter"`,
  );
}

/** @deprecated Use resolveProvider() instead. */
export function resolveApiKey(config: PersojeConfig): string {
  return resolveProvider(config).apiKey;
}

/**
 * Persist the default primary model to the global config (preserving every other
 * key). This is what `/dmodel` writes, so the choice survives across sessions —
 * unlike `/model`, which only changes the running session.
 */
export async function setDefaultModel(modelId: string): Promise<string> {
  return setConfigValue("model", "primary", modelId);
}

/**
 * Merge a single key into a nested config section (e.g. `theme.name`),
 * preserving every other key. Backs `/theme`
 * so a chosen theme survives across sessions. Trust level is
 * deliberately NOT persisted — yolo must re-arm each session (safety).
 */
export async function setConfigValue(section: string, key: string, value: unknown): Promise<string> {
  const existing = (await readJsonIfExists(GLOBAL_CONFIG_PATH)) ?? {};
  const merged = { ...((existing[section] as Record<string, unknown>) ?? {}), [key]: value };
  await Bun.write(GLOBAL_CONFIG_PATH, JSON.stringify({ ...existing, [section]: merged }, null, 2) + "\n");
  return GLOBAL_CONFIG_PATH;
}

/**
 * Set the active provider (top-level key), persisting to global config.
 * Backs `/provider` so the choice survives across sessions.
 */
export async function setActiveProvider(providerName: string): Promise<string> {
  const existing = (await readJsonIfExists(GLOBAL_CONFIG_PATH)) ?? {};
  await Bun.write(GLOBAL_CONFIG_PATH, JSON.stringify({ ...existing, activeProvider: providerName }, null, 2) + "\n");
  return GLOBAL_CONFIG_PATH;
}

/**
 * Upsert one entry into `providers`, preserving every other key. Backs the
 * `/provider` menu when it materializes a built-in preset or a custom URL so
 * the provider (and its key/URL) survives across sessions.
 */
export async function saveProvider(
  name: string,
  def: { type?: "openai-compat"; baseUrl: string; apiKey?: string; apiKeyEnv?: string; extraHeaders?: Record<string, string>; routing?: Record<string, unknown>; model?: string },
): Promise<string> {
  const existing = (await readJsonIfExists(GLOBAL_CONFIG_PATH)) ?? {};
  const providers = { ...((existing.providers as Record<string, unknown>) ?? {}), [name]: { type: "openai-compat", ...def } };
  await Bun.write(GLOBAL_CONFIG_PATH, JSON.stringify({ ...existing, providers }, null, 2) + "\n");
  return GLOBAL_CONFIG_PATH;
}
