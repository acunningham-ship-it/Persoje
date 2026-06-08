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
      /** Self-imposed context budget in tokens — deliberately far below model max. */
      budgetTokens: z.number().default(40_000),
      /** Compact when estimated history exceeds this fraction of the budget. */
      compactionThreshold: z.number().min(0.3).max(0.95).default(0.8),
      /** Turns kept at full fidelity during compaction. */
      keepFullTurns: z.number().default(4),
      /** Repo-map token budget; 0 disables. */
      repoMapTokens: z.number().default(800),
      /** Attach a cache_control breakpoint to the system prompt (providers without caching ignore it). */
      cacheSystemPrompt: z.boolean().default(true),
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
    })
    .prefault({}),
  retry: z
    .object({
      /** Max retry attempts for API calls (rate limits, server errors). Default 5. */
      maxRetries: z.number().min(0).max(10).default(5),
    })
    .prefault({}),
  effort: z
    .object({
      /** Current effort level: low | mid | high | max */
      level: z.enum(["low", "mid", "high", "max"]).default("mid"),
    })
    .prefault({}),
  /** Per-tool result caps in tokens (overrides tool defaults). */
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
       */
      provider: z.record(z.string(), z.unknown()).optional(),
    })
    .prefault({}),
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

export function resolveApiKey(config: PersojeConfig): string {
  const key = config.openrouter.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      "No OpenRouter API key. Set OPENROUTER_API_KEY or add openrouter.apiKey to ~/.config/persoje/config.json",
    );
  }
  return key;
}
