import type { UsageReport } from "../core/events.ts";

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
  | { type: "usage"; usage: UsageReport };

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
  signal?: AbortSignal;
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

const MAX_RETRIES = 3;

export class OpenRouterClient {
  constructor(
    private apiKey: string,
    private baseUrl = "https://openrouter.ai/api/v1",
  ) {}

  /** Fetch the model catalog → id ⇒ real context-window size (for the status gauge). */
  async modelContextWindows(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) return map;
      const data = (await res.json()) as { data?: Array<{ id: string; context_length?: number }> };
      for (const m of data.data ?? []) if (m.context_length) map.set(m.id, m.context_length);
    } catch {
      // offline / rate-limited — gauge falls back to the compaction budget
    }
    return map;
  }

  /**
   * Stream a chat completion. Yields text deltas as they arrive, accumulated tool
   * calls once complete, and a final usage report with real cost from OpenRouter.
   */
  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const started = Date.now();
    // cache_control rides on multipart content; providers without explicit caching ignore it.
    const messages: unknown[] = req.cacheSystemPrompt
      ? req.messages.map((m) =>
          m.role === "system"
            ? { role: "system", content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] }
            : m,
        )
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

    const response = await this.fetchWithRetry(body, req.signal);
    if (!response.body) throw new OpenRouterError("Empty response body", 0, false);

    // Accumulate tool-call deltas by index (OpenAI streaming convention).
    const toolCalls = new Map<number, { id: string; name: string; argsJson: string }>();
    let sawText = false;

    for await (const data of sseLines(response.body, req.signal)) {
      if (data === "[DONE]") break;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue; // OpenRouter sends ": OPENROUTER PROCESSING" comments; skip anything non-JSON
      }
      if (chunk.error) {
        throw new OpenRouterError(chunk.error.message ?? "stream error", chunk.error.code ?? 0, false);
      }

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        sawText = true;
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

      if (chunk.usage) {
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
  }

  private async fetchWithRetry(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let lastError: OpenRouterError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
      if (!retryable || attempt === MAX_RETRIES) throw lastError;

      // Honor Retry-After when present (free models: ~20 req/min), else exponential backoff.
      const retryAfter = Number(response.headers.get("retry-after"));
      const delayMs = retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt;
      await Bun.sleep(delayMs);
    }
    throw lastError ?? new OpenRouterError("unreachable", 0, false);
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
