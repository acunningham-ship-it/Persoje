import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

/**
 * Model quality assessment. Used to decide escalation thresholds and fallback
 * behavior — weak models are tracked more aggressively.
 */
export type ToolQuality = "excellent" | "good" | "variable" | "poor" | "unknown";

/**
 * Cached profile of a model's characteristics. Updated by canary tests and
 * accumulated failure observations. Persisted to ~/.config/persoje/models.json.
 */
export interface ModelProfile {
  id: string;
  /** Tool-calling consistency: excellent (native, reliable), good (native, occasional fail),
   *  variable (works sometimes or needs rescue), poor (hallucination-prone), unknown (untested). */
  toolQuality: ToolQuality;
  /** Prompt-caching support: explicit (respects cache_control), automatic (opaque caching),
   *  none (don't bother). */
  cachingMode: "explicit" | "automatic" | "none";
  /** Model to escalate to when this one fails too often. Null = give up. */
  escalateTo?: string;
  /** Known quirks: e.g. ["loves_markdown", "weak_json", "slow_reasoning"]. */
  quirks: string[];
  /** Results from most recent canary test, if run. */
  canary?: {
    score: number;
    total: number;
    testedAt: number;
    notes: string[];
  };
}

/**
 * Heuristic defaults for unknown models, by ID pattern. Updated when a canary
 * is run or failures accumulate.
 */
export function seedProfile(modelId: string): ModelProfile {
  // Anthropic models: excellent tool calling, explicit caching support
  if (modelId.startsWith("anthropic/")) {
    return {
      id: modelId,
      toolQuality: "excellent",
      cachingMode: "explicit",
      quirks: [],
    };
  }
  // OpenAI and Google: excellent but opaque caching
  if (modelId.startsWith("openai/") || modelId.startsWith("google/gemini")) {
    return {
      id: modelId,
      toolQuality: "excellent",
      cachingMode: "automatic",
      quirks: [],
    };
  }
  // Strong open-weight models
  if (
    modelId.startsWith("deepseek/") ||
    modelId.startsWith("moonshotai/") ||
    modelId.startsWith("x-ai/") ||
    (modelId.startsWith("qwen/") && !modelId.includes(":free")) ||
    modelId.startsWith("mistralai/")
  ) {
    return {
      id: modelId,
      toolQuality: "good",
      cachingMode: "automatic",
      quirks: [],
    };
  }
  // Free-tier or stealth/cloaked models: variable quality
  if (modelId.endsWith(":free") || modelId.startsWith("openrouter/")) {
    return {
      id: modelId,
      toolQuality: "variable",
      cachingMode: "none",
      quirks: [],
    };
  }
  // Anything else: untested
  return {
    id: modelId,
    toolQuality: "unknown",
    cachingMode: "none",
    quirks: [],
  };
}

/**
 * Stores and persists model profiles. Loads on init, writes on upsert.
 */
export class ProfileStore {
  private profiles = new Map<string, ModelProfile>();
  private path: string;

  constructor(pathOverride?: string) {
    this.path = pathOverride ?? join(homedir(), ".config", "persoje", "models.json");
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) {
        this.profiles.clear();
        return;
      }
      const text = readFileSync(this.path, "utf-8");
      const data = JSON.parse(text) as Record<string, ModelProfile>;
      this.profiles.clear();
      for (const [id, p] of Object.entries(data ?? {})) {
        this.profiles.set(id, p);
      }
    } catch {
      this.profiles.clear();
    }
  }

  /** Get a profile, seeding with heuristic defaults if not persisted. Does not persist the seed. */
  get(modelId: string): ModelProfile {
    return this.profiles.get(modelId) ?? seedProfile(modelId);
  }

  /** Persist a profile update. */
  upsert(profile: ModelProfile): void {
    this.profiles.set(profile.id, profile);
    this.save();
  }

  /** Add a quirk, deduplicating and capping at 10. Persists. */
  addQuirk(modelId: string, quirk: string): void {
    const p = this.get(modelId);
    if (!p.quirks.includes(quirk)) {
      p.quirks.push(quirk);
      if (p.quirks.length > 10) p.quirks.pop();
    }
    this.upsert(p);
  }

  private save(): void {
    const dir = this.path.slice(0, this.path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    const data: Record<string, ModelProfile> = {};
    for (const [id, p] of Array.from(this.profiles.entries())) {
      data[id] = p;
    }
    writeFileSync(this.path, JSON.stringify(data, null, 2), "utf-8");
  }
}

interface FailureRecord {
  kind: "validation" | "loop" | "syntax" | "rescue" | "api";
  at: number;
}

/**
 * Routes models based on observed failure patterns. Escalates to fallback
 * models when a primary repeatedly fails. Tracks failures in-memory (not persisted),
 * escalation recommendations via persisted ProfileStore.
 */
export class Router {
  private failures = new Map<string, FailureRecord[]>();
  private lastEscalated = new Map<string, number>(); // per-model count when last escalated
  private failureThreshold: number;
  private profiles: ProfileStore;
  public enabled: boolean;
  public mode: "offer" | "auto";

  constructor(opts: {
    enabled: boolean;
    mode: "offer" | "auto";
    failureThreshold: number;
    profiles: ProfileStore;
  }) {
    this.enabled = opts.enabled;
    this.mode = opts.mode;
    this.failureThreshold = opts.failureThreshold;
    this.profiles = opts.profiles;
  }

  /** Record a failure for a model. */
  recordFailure(modelId: string, kind: FailureRecord["kind"]): void {
    if (!this.failures.has(modelId)) {
      this.failures.set(modelId, []);
    }
    this.failures.get(modelId)!.push({ kind, at: Date.now() });
  }

  /** Count failures within a time window (default 10 min). */
  failureCount(modelId: string, windowMs = 10 * 60_000): number {
    const now = Date.now();
    const records = this.failures.get(modelId) ?? [];
    return records.filter((r) => now - r.at < windowMs).length;
  }

  /**
   * Check if escalation is warranted. Returns null if disabled or below threshold.
   * Otherwise returns { target, reason }. Avoids repeat-firing — once triggered,
   * requires 5+ new failures to trigger again.
   */
  shouldEscalate(modelId: string): { target: string | null; reason: string } | null {
    if (!this.enabled) return null;
    const count = this.failureCount(modelId);
    if (count < this.failureThreshold) return null;

    const lastCount = this.lastEscalated.get(modelId);
    if (lastCount !== undefined && count - lastCount < 5) return null; // avoid nagging

    this.lastEscalated.set(modelId, count);

    const failures = this.failures.get(modelId) ?? [];
    const recent = failures.slice(-5);
    const kinds = new Set(recent.map((r) => r.kind));
    const reason = `${count} failures (${Array.from(kinds).join(", ")}) in last 10m`;

    const profile = this.profiles.get(modelId);
    return { target: profile.escalateTo ?? null, reason };
  }
}
