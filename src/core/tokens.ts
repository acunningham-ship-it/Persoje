import type { UsageReport } from "./events.ts";

const CODE_PATTERN = /[{}[\]();:<>+\-*/=!&|^~@#$%`\\]/g;
const CODE_RATIO = 3.5;
const PROSE_RATIO = 4.5;

export function estimateTokens(text: unknown, accurate = true): number {
  const str = typeof text === "string" ? text : "";
  if (!accurate || !str) return Math.ceil(str.length / 4);
  const codeChars = (str.match(CODE_PATTERN) || []).length;
  const proseChars = str.length - codeChars;
  const ratio = (PROSE_RATIO * proseChars + CODE_RATIO * codeChars) / str.length;
  return Math.ceil(str.length / ratio);
}

export interface SessionTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
}

export class Accounting {
  private records: UsageReport[] = [];

  record(usage: UsageReport): void {
    this.records.push(usage);
  }

  /** Record usage from an external source (subagent, etc.) */
  recordExternal(usage: { inputTokens: number; outputTokens: number; cost: number; calls: number }): void {
    this.records.push({
      model: "external",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: 0,
      cost: usage.cost,
      durationMs: 0,
    });
  }

  totals(): SessionTotals {
    const t: SessionTotals = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
    for (const r of this.records) {
      t.calls++;
      t.inputTokens += r.inputTokens;
      t.outputTokens += r.outputTokens;
      t.cachedTokens += r.cachedTokens;
      t.cost += r.cost;
    }
    return t;
  }

  last(n = 1): UsageReport[] {
    return this.records.slice(-n);
  }

  reset(): void {
    this.records = [];
  }
}