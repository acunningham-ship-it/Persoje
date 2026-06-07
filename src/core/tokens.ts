import type { UsageReport } from "./events.ts";

/** Rough token estimate (~4 chars/token). Good enough for budgets; real usage comes from the API. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface SessionTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
}

/** Accumulates real per-call usage for the session. */
export class Accounting {
  private records: UsageReport[] = [];

  record(usage: UsageReport): void {
    this.records.push(usage);
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

  /** Usage for the most recent turn (last `n` calls). */
  last(n = 1): UsageReport[] {
    return this.records.slice(-n);
  }

  reset(): void {
    this.records = [];
  }
}
