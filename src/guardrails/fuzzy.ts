/** Fuzzy tool-name matching — weak models hallucinate tool names ("read_file" for "read"). */

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]) as number[][];
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m]![n]!;
}

/**
 * Find the intended tool for a hallucinated name. Catches the common cases:
 * snake_case prefixes ("read_file"→"read"), containment ("bash_command"→"bash"),
 * and small typos (edit distance ≤ 2).
 */
export function closestToolName(requested: string, available: string[]): string | null {
  const req = requested.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!req) return null;

  for (const name of available) {
    const n = name.toLowerCase();
    // exact-after-normalize, prefix segment, or containment
    if (req === n) return name;
    if (req.startsWith(n + "_") || n.startsWith(req + "_")) return name;
    if (req.includes(n) && n.length >= 3) return name;
  }
  let best: string | null = null;
  let bestDist = 3; // accept distance ≤ 2
  for (const name of available) {
    const d = editDistance(req, name.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}
