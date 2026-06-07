/**
 * Persoje's visual identity — distinct from Hermes/Claude Code.
 *
 * Design philosophy:
 * - Warm amber/gold accent (not peach-orange)
 * - Geometric markers (◆ ▸ ⬡) instead of emoji
 * - Dense, scannable layout — information over decoration
 * - The status bar is a dashboard, not a decoration
 */
export const theme = {
  accent: "#e8a317",    // warm amber-gold — Persoje's signature
  accent2: "#c78b0d",   // darker amber for secondary highlights
  bullet: "gray",       // quiet markers
  border: "gray",       // chrome borders stay quiet
  ok: "#00c853",
  err: "#f44336",
  warn: "#ffc107",
  dim: "#6b7280",       // muted text
} as const;
