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
   * Keyless local endpoint (Ollama, vLLM, LM Studio). The menu skips the key prompt
   * and materializes a placeholder key, so the client's always-on `Authorization:
   * Bearer` header is harmless (local servers ignore it). `defaultModel` is usually
   * omitted here — the pulled model is auto-detected via {@link firstLocalModel}.
   */
  keyless?: boolean;
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
  // freebee = Armani's OpenRouter *Preset* (`@preset/freebee`, configured on the OpenRouter
  // dashboard: a curated free-model fallback chain + system prompt + params). OpenRouter resolves
  // the `@preset/<slug>` model id server-side, so a single free model's rate-limit rolls to the
  // next. $0, reuses OPENROUTER_API_KEY. The lean-harness dogfood target: prove it on free models.
  { name: "freebee", label: "Freebee — free models, $0 (@preset/freebee)", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", defaultModel: "@preset/freebee" },
  // Ollama = local models over its OpenAI-compat endpoint. Keyless, $0, offline. The pulled
  // model is auto-detected on switch (firstLocalModel), so no static defaultModel to go stale.
  // Remote/non-default Ollama hosts go through the custom-URL slot.
  { name: "ollama", label: "Ollama — local models, $0 (localhost:11434)", baseUrl: "http://localhost:11434/v1", keyless: true },
  { name: "openai", label: "OpenAI API — GPT / o-series (codex)", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", defaultModel: "gpt-4o" },
  { name: "anthropic", label: "Anthropic API — Claude (OpenAI-compat)", baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-4-20250514" },
];

export type ProviderMenuItem =
  | { kind: "preset"; preset: ProviderPreset; label: string }
  | { kind: "existing"; name: string; label: string }
  | { kind: "custom"; label: string };

/** True if a key is reachable for this preset (env var or a configured apiKey).
 *  Keyless local endpoints (Ollama) always qualify — there is no key to prompt for. */
export function presetHasKey(config: PersojeConfig, preset: ProviderPreset): boolean {
  if (preset.keyless) return true;
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

/**
 * Probe a keyless local server (Ollama) for a model the user has pulled that can
 * actually run an agentic turn — i.e. supports tools. Persoje always sends tool
 * schemas, so a vision/embedding-only model 400s on the first message ("does not
 * support tools"); auto-picking one is worse than no default. Ollama's native
 * `/api/show` reports per-model `capabilities`, which is the source of truth. If the
 * endpoint isn't Ollama, falls back to the OpenAI-compat catalog (first non-embedding
 * id — best effort, since generic servers expose no capability field).
 * Returns undefined if unreachable or nothing tool-capable is pulled — the caller then
 * keeps the session model and any error surfaces on the first message, not here.
 * ponytail: returns the FIRST tool-capable model, not the "best" — user `/model`s to change.
 */
export async function firstLocalModel(baseUrl: string): Promise<string | undefined> {
  const origin = baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, ""); // /v1 base → Ollama native root
  try {
    const tags = await fetch(`${origin}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (tags.ok) {
      const { models } = (await tags.json()) as { models?: Array<{ model?: string; name?: string }> };
      const ids = (models ?? []).map((m) => m.model ?? m.name).filter((x): x is string => !!x);
      for (const id of ids.slice(0, 25)) { // bound the probes; typical installs have <20 models
        try {
          const show = await fetch(`${origin}/api/show`, {
            method: "POST",
            body: JSON.stringify({ model: id }),
            signal: AbortSignal.timeout(3000),
          });
          if (!show.ok) continue;
          const caps = ((await show.json()) as { capabilities?: string[] }).capabilities ?? [];
          if (caps.includes("tools")) return id;
        } catch {
          // one model's probe failed — try the next
        }
      }
      return undefined; // Ollama up but nothing tool-capable pulled — nothing safe to auto-pick
    }
  } catch {
    // not an Ollama native API / unreachable — fall through to the OpenAI-compat catalog
  }
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id).find((id): id is string => !!id && !/embed/i.test(id));
  } catch {
    return undefined;
  }
}
