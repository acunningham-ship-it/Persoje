import { join } from "node:path";
import { homedir } from "node:os";
import type { UsageReport } from "../core/events.ts";

/** Reasoning parameter for effort-aware chain-of-thought / extended thinking. */
export type ReasoningParam = {
  effort?: "low" | "medium" | "high";
  max_tokens?: number;
  exclude?: boolean;
};

/** OpenAI-compatible message shapes (OpenRouter speaks this dialect for every model). */
export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON string of arguments as emitted by the model — parsed/validated downstream. */
  argsJson: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; content: string; tool_call_id: string };

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool-calls"; calls: ToolCallRequest[] }
  | { type: "usage"; usage: UsageReport }
  | { type: "reasoning"; content: unknown } // TODO: PHASE 2 — verify real shape (string vs array) from OpenRouter streaming responses
  | { type: "retry"; attempt: number; maxRetries: number; delayMs: number; reason: string };

export interface ChatRequest {
  model: string;
  /** OpenRouter fallback models tried in order if the primary errors. */
  fallbackModels?: string[];
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  /** Mark the system prompt as a prompt-cache breakpoint (no-op on providers without explicit caching). */
  cacheSystemPrompt?: boolean;
  /** OpenRouter provider routing object (pinning providers preserves cache continuity). */
  provider?: Record<string, unknown>;
  /** Reasoning config: effort level or max_tokens for budget-constrained reasoning. */
  reasoning?: ReasoningParam;
  signal?: AbortSignal;
  /** Max retry attempts (default 5). */
  maxRetries?: number;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryable: boolean,
  ) {
    super(message);
  }
}

const DEFAULT_MAX_RETRIES = 5;

/**
 * Is a mid-stream SSE error worth retrying? OpenRouter returns these as an error
 * chunk after a 200, so they bypass the HTTP-status retry. Stealth/free providers
 * (e.g. owl-alpha) throw "Provider returned error" transiently — retrying the
 * request usually succeeds. Be conservative: retry transient upstream failures,
 * not genuine client errors (bad request, context length, content filter).
 */
export function isTransientStreamError(message: string, code: number): boolean {
  if (code === 429 || (code >= 500 && code <= 599)) return true;
  return /provider returned error|overloaded|temporarily|unavailable|timeout|timed out|rate.?limit|capacity|try again|503|502|520/i.test(
    message,
  );
}

export class OpenRouterClient {
  constructor(
    private apiKey: string,
    private baseUrl = "https://openrouter.ai/api/v1",
  ) {}

  /**
   * Fetch the model catalog → id ⇒ real context-window size (for the status gauge).
   * Cached to disk for 24h — the catalog barely changes and the fetch is ~hundreds of
   * KB, so hitting it on every cold start was pure latency.
   */
  async modelContextWindows(): Promise<Map<string, number>> {
    const cachePath = join(homedir(), ".config", "persoje", "models-cache.json");
    const TTL = 24 * 60 * 60 * 1000;

    // Serve from cache if fresh.
    try {
      const cached = (await Bun.file(cachePath).json()) as { fetchedAt: number; windows: Record<string, number> };
      if (cached.fetchedAt && Date.now() - cached.fetchedAt < TTL) {
        return new Map(Object.entries(cached.windows));
      }
    } catch {
      // no cache or unparseable — fall through to fetch
    }

    const map = new Map<string, number>();
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) return map;
      const data = (await res.json()) as { data?: Array<{ id: string; context_length?: number }> };
      for (const m of data.data ?? []) if (m.context_length) map.set(m.id, m.context_length);
      // Persist for next launch (best-effort).
      void Bun.write(cachePath, JSON.stringify({ fetchedAt: Date.now(), windows: Object.fromEntries(map) })).catch(() => {});
    } catch {
      // offline / rate-limited — gauge falls back to the compaction budget
    }
    return map;
  }

  /** Fetch the model catalog with pricing + tool support (for the /models picker). */
  async catalog(): Promise<Array<{ id: string; context: number; inPrice: number; outPrice: number; tools: boolean }>> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        data?: Array<{ id: string; context_length?: number; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[] }>;
      };
      return (data.data ?? []).map((m) => ({
        id: m.id,
        context: m.context_length ?? 0,
        inPrice: Number(m.pricing?.prompt ?? 0) * 1e6,
        outPrice: Number(m.pricing?.completion ?? 0) * 1e6,
        tools: (m.supported_parameters ?? []).includes("tools"),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Stream a chat completion. Yields text deltas as they arrive, accumulated tool
   * calls once complete, and a final usage report with real cost from OpenRouter.
   */
  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const started = Date.now();
    // cache_control rides on multipart content; providers without explicit caching ignore it.
    // If messages already have multipart content (from buildWithCacheBreakpoints), pass through.
    // Otherwise, wrap the system prompt in multipart format with cache_control.
    const messages: unknown[] = req.cacheSystemPrompt
      ? req.messages.map((m) => {
          // Already multipart (array content) — pass through as-is
          if (Array.isArray(m.content)) return m;
          // System prompt gets cache breakpoint
          if (m.role === "system")
            return { role: "system", content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] };
          return m;
        })
      : req.messages;

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: true,
      usage: { include: true },
      temperature: req.temperature ?? 0.3,
    };
    if (req.fallbackModels?.length) body.models = [req.model, ...req.fallbackModels];
    if (req.tools?.length) body.tools = req.tools;
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.provider) body.provider = req.provider;
    if (req.reasoning) body.reasoning = req.reasoning;

    const maxRetries = req.maxRetries ?? DEFAULT_MAX_RETRIES;

    // The retry loop wraps the full request + SSE consumption, not just the fetch.
    // A mid-stream "Provider returned error" arrives as an error chunk after a 200,
    // so fetchWithRetry never sees it — without this loop, one flaky provider reply
    // ends the whole turn. We only retry while nothing has been emitted to the caller
    // yet; once text/usage is out, a re-request would duplicate output, so we propagate.
    let yieldedAny = false;
    for (let streamAttempt = 0; ; streamAttempt++) {
      const response = await this.fetchWithRetry(body, req.signal, maxRetries, (attempt, delayMs, reason) => {
        this._lastRetryEvent = { type: "retry", attempt, maxRetries, delayMs, reason };
      });
      if (!response.body) throw new OpenRouterError("Empty response body", 0, false);

      // Accumulate tool-call deltas by index (OpenAI streaming convention).
      const toolCalls = new Map<number, { id: string; name: string; argsJson: string }>();
      let sawText = false;

      try {
        for await (const data of sseLines(response.body, req.signal)) {
          if (data === "[DONE]") break;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue; // OpenRouter sends ": OPENROUTER PROCESSING" comments; skip anything non-JSON
          }
          if (chunk.error) {
            const code = chunk.error.code ?? 0;
            const msg = chunk.error.message ?? "stream error";
            throw new OpenRouterError(msg, code, isTransientStreamError(msg, code));
          }

          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            sawText = true;
            yieldedAny = true;
            yield { type: "text", delta: delta.content as string };
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCalls.get(idx) ?? { id: "", name: "", argsJson: "" };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.argsJson += tc.function.arguments;
              toolCalls.set(idx, existing);
            }
          }

          if (delta?.reasoning_content) {
            yieldedAny = true;
            yield { type: "reasoning", content: delta.reasoning_content };
          }

          if (chunk.usage) {
            yieldedAny = true;
            yield {
              type: "usage",
              usage: {
                model: chunk.model ?? req.model,
                inputTokens: chunk.usage.prompt_tokens ?? 0,
                outputTokens: chunk.usage.completion_tokens ?? 0,
                cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
                cost: chunk.usage.cost ?? 0,
                durationMs: Date.now() - started,
              },
            };
          }
        }
      } catch (err) {
        const e = err as OpenRouterError;
        const canRetry =
          e instanceof OpenRouterError && e.retryable && !yieldedAny && streamAttempt < maxRetries;
        if (!canRetry) throw err;
        if (req.signal?.aborted) throw new DOMException("aborted", "AbortError");
        const delayMs = 1500 * 2 ** streamAttempt + 2000;
        const retryEv = {
          type: "retry" as const,
          attempt: streamAttempt + 1,
          maxRetries,
          delayMs,
          reason: "provider error",
        };
        this._lastRetryEvent = retryEv;
        yield retryEv;
        await Bun.sleep(delayMs);
        continue; // re-request from scratch
      }

      if (toolCalls.size > 0) {
        const calls: ToolCallRequest[] = [...toolCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([i, c]) => ({
            id: c.id || `call_${started}_${i}`,
            name: c.name,
            argsJson: c.argsJson || "{}",
          }));
        yield { type: "tool-calls", calls };
      } else if (!sawText) {
        // Some weak/free models return an entirely empty stream — surface it rather than hang.
        yield { type: "text", delta: "" };
      }
      return; // clean completion — leave the retry loop
    }
  }

  /** Last retry event (for the caller to surface to the user). */
  private _lastRetryEvent: StreamEvent | null = null;
  get lastRetryEvent(): StreamEvent | null {
    return this._lastRetryEvent;
  }

  /**
   * Smart retry with:
   * - 5 retries by default
   * - Retry-After header parsing
   * - Error body parsing for "retry in X seconds" patterns
   * - Formula: parsedWaitSeconds + 2 = total delay
   * - Exponential backoff fallback: 1500 * 2^attempt + 2
   */
  private async fetchWithRetry(
    body: Record<string, unknown>,
    signal?: AbortSignal,
    maxRetries = DEFAULT_MAX_RETRIES,
    onRetry?: (attempt: number, delayMs: number, reason: string) => void,
  ): Promise<Response> {
    let lastError: OpenRouterError | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/armani/persoje",
          "X-Title": "Persoje",
        },
        body: JSON.stringify(body),
        signal,
      });
      if (response.ok) return response;

      const retryable = response.status === 429 || response.status >= 500;
      const text = await response.text().catch(() => "");
      lastError = new OpenRouterError(
        `OpenRouter ${response.status}: ${text.slice(0, 300)}`,
        response.status,
        retryable,
      );
      if (!retryable || attempt === maxRetries) throw lastError;

      // Smart delay calculation:
      // 1. Check Retry-After header (standard HTTP)
      // 2. Parse error body for "retry in X seconds" patterns
      // 3. Fall back to exponential backoff
      // Formula: parsedWaitSeconds + 2 additional seconds = total delay
      const delayMs = this.calculateRetryDelay(response, text, attempt);

      const reason = response.status === 429
        ? "rate limited"
        : response.status >= 500
          ? "server error"
          : "unknown";

      onRetry?.(attempt + 1, delayMs, reason);
      await Bun.sleep(delayMs);
    }
    throw lastError ?? new OpenRouterError("unreachable", 0, false);
  }

  /**
   * Calculate retry delay using the formula: parsedWaitSeconds + 2 = total delay.
   *
   * Priority:
   * 1. Retry-After header (seconds or HTTP-date)
   * 2. Error body patterns: "retry in X seconds", "wait Xs", "retry_after": X, etc.
   * 3. Exponential backoff: 1500 * 2^attempt ms
   *
   * All paths add +2 seconds as the safety margin.
   */
  private calculateRetryDelay(response: Response, body: string, attempt: number): number {
    const TWO_SEC = 2000;

    // 1. Retry-After header
    const retryAfterHeader = response.headers.get("retry-after");
    if (retryAfterHeader) {
      // Could be seconds (integer) or HTTP-date
      const asSeconds = Number(retryAfterHeader);
      if (asSeconds > 0 && Number.isFinite(asSeconds)) {
        return asSeconds * 1000 + TWO_SEC;
      }
      // Try HTTP-date
      const asDate = new Date(retryAfterHeader).getTime();
      if (Number.isFinite(asDate)) {
        const waitSec = Math.max(0, (asDate - Date.now()) / 1000);
        return waitSec * 1000 + TWO_SEC;
      }
    }

    // 2. Parse error body for wait-time hints
    const bodyWait = this.parseRetryWaitFromBody(body);
    if (bodyWait !== null) {
      return bodyWait * 1000 + TWO_SEC;
    }

    // 3. Exponential backoff + 2s
    return 1500 * 2 ** attempt + TWO_SEC;
  }

  /**
   * Parse error response body for retry wait time hints.
   * Handles patterns like:
   * - "retry in 5 seconds", "retry in 5s", "retry after 10 seconds"
   * - "wait 3 seconds", "wait 3s"
   * - "retry_after": 5, "retryAfter": 5 (JSON)
   * - "please wait 8 seconds before retrying"
   * - "rate limit reset in 12.5 seconds"
   * - "try again in 30s"
   */
  private parseRetryWaitFromBody(body: string): number | null {
    // Try JSON first
    try {
      const json = JSON.parse(body);
      // Common JSON fields
      if (typeof json.retry_after === "number" && json.retry_after > 0) return json.retry_after;
      if (typeof json.retryAfter === "number" && json.retryAfter > 0) return json.retryAfter;
      if (typeof json.error?.retry_after === "number" && json.error.retry_after > 0) return json.error.retry_after;
      // Nested message
      if (typeof json.error?.message === "string") {
        const parsed = this.extractSecondsFromText(json.error.message);
        if (parsed !== null) return parsed;
      }
      if (typeof json.message === "string") {
        const parsed = this.extractSecondsFromText(json.message);
        if (parsed !== null) return parsed;
      }
    } catch {
      // Not JSON — try text patterns
    }

    // Text patterns
    return this.extractSecondsFromText(body);
  }

  /** Extract a wait time in seconds from freeform text. */
  private extractSecondsFromText(text: string): number | null {
    // Patterns (case-insensitive):
    // "retry in X seconds", "retry in Xs", "retry after X seconds"
    // "wait X seconds", "wait Xs"
    // "try again in X seconds", "try again in Xs"
    // "reset in X seconds", "rate limit reset in X seconds"
    // "please wait X seconds before retrying"
    const patterns = [
      /(?:retry|try\s+again|wait|reset|rate\s+limit\s+reset)\s+(?:in|after|for)\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i,
      /(?:retry|try\s+again|wait|reset)\s+(?:in|after|for)\s+(\d+(?:\.\d+)?)\s*(?:seconds?|sec|s)\b/i,
      /wait\s+(\d+(?:\.\d+)?)\s*(?:seconds?|sec|s)\b/i,
      /please\s+wait\s+(\d+(?:\.\d+)?)\s*(?:seconds?|sec|s)\s+before\s+retrying/i,
      /(\d+(?:\.\d+)?)\s*(?:seconds?|sec|s)\s+(?:before\s+)?(?:retry|retries|next\s+request)/i,
    ];
    for (const pat of patterns) {
      const match = text.match(pat);
      if (match && match[1]) {
        const seconds = parseFloat(match[1]);
        if (seconds > 0 && Number.isFinite(seconds)) return seconds;
      }
    }
    return null;
  }
}

/** Parse an SSE byte stream into `data:` payload strings. */
async function* sseLines(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = stream.getReader();
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
    if (signal?.aborted) await stream.cancel().catch(() => {});
  }
}
