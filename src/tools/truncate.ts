import { estimateTokens } from "../core/tokens.ts";

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

/**
 * Cap tool output at a token budget. The single highest-ROI token optimization:
 * a naive harness feeds 5k-line bash dumps straight into context.
 *
 * Keeps head + tail (errors usually live at the end of output).
 */
export function truncate(text: string, maxTokens: number): TruncateResult {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };

  const maxChars = maxTokens * 4;
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = Math.floor(maxChars * 0.3);
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omitted = text.length - head.length - tail.length;
  return {
    text: `${head}\n[... ${omitted} chars omitted — re-run with narrower scope if needed ...]\n${tail}`,
    truncated: true,
  };
}
