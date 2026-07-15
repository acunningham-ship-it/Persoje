/**
 * Built-in provider presets for the `/provider` menu.
 *
 * Every preset here is an OpenAI-compatible HTTP endpoint — so switching is pure
 * config, no new client code (the OpenRouter client speaks this dialect to any
 * baseUrl). Anthropic is reachable this way via its OpenAI-compat endpoint; the
 * CLI-subprocess backends (claude -p, codex) are added separately (they need a
 * different client). Local/self-hosted endpoints go through the "primer / custom
 * URL" slot, where primer-detect probes /health and either enables prefix-cache
 * primer mode (local only) or falls back to plain requests.
 */
import type { PersojeConfig } from "./config.ts";

export interface ProviderPreset {
  name: string;
  label: string;
  baseUrl: string;
  /** Env var read for the key when no explicit apiKey is configured. */
  apiKeyEnv?: string;
  /**
   * Model to select on switch. External endpoints reject OpenRouter-style ids
   * (`vendor/model`), so we seed a native default; the user can `/model` after.
   * Omitted for openrouter (keeps the session's current model).
   */
  defaultModel?: string;
}

/** The one custom/local slot — re-entering a URL overwrites it. */
export const PRIMER_PROVIDER = "primer";

export const BUILTIN_PROVIDERS: ProviderPreset[] = [
  { name: "openrouter", label: "OpenRouter — default · every model", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
  // freebee = OpenRouter pinned to its free auto-router. `openrouter/free` picks whatever free
  // model is available, so a single model's rate-limit doesn't stall the session. $0, still needs
  // OPENROUTER_API_KEY. The lean-harness dogfood target: prove the harness on a free model.
  { name: "freebee", label: "Freebee — free models, $0 (OpenRouter free auto-router)", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", defaultModel: "openrouter/free" },
  { name: "openai", label: "OpenAI API — GPT / o-series (codex)", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", defaultModel: "gpt-4o" },
  { name: "anthropic", label: "Anthropic API — Claude (OpenAI-compat)", baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-4-20250514" },
];

export type ProviderMenuItem =
  | { kind: "preset"; preset: ProviderPreset; label: string }
  | { kind: "existing"; name: string; label: string }
  | { kind: "custom"; label: string };

/** True if a key is reachable for this preset (env var or a configured apiKey). */
export function presetHasKey(config: PersojeConfig, preset: ProviderPreset): boolean {
  return !!(process.env[preset.apiKeyEnv ?? ""] || config.providers?.[preset.name]?.apiKey);
}

/**
 * Build the `/provider` menu: built-in presets, then any user-configured
 * providers not already shown, then the custom/primer URL slot.
 */
export function buildProviderMenu(config: PersojeConfig): ProviderMenuItem[] {
  const active = config.activeProvider ?? "openrouter";
  const shown = new Set<string>([...BUILTIN_PROVIDERS.map((p) => p.name), PRIMER_PROVIDER]);
  const mark = (name: string) => (name === active ? " ✓" : "");

  const items: ProviderMenuItem[] = BUILTIN_PROVIDERS.map((preset) => ({
    kind: "preset" as const,
    preset,
    label: preset.label + mark(preset.name),
  }));

  for (const [name, def] of Object.entries(config.providers ?? {})) {
    if (shown.has(name)) continue;
    items.push({ kind: "existing", name, label: `${name} — ${def.baseUrl}${mark(name)}` });
  }

  const primerUrl = config.providers?.[PRIMER_PROVIDER]?.baseUrl;
  items.push({
    kind: "custom",
    label: `primer / custom URL — ${primerUrl ?? "local inference (auto-detect)"}${mark(PRIMER_PROVIDER)}`,
  });
  return items;
}
