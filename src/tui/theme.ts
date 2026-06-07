/**
 * Persoje's visual identity — multiple themes.
 *
 * Design philosophy:
 * - Geometric markers (◆ ▸ ⬡) instead of emoji
 * - Dense, scannable layout — information over decoration
 * - The status bar is a dashboard, not a decoration
 *
 * Themes:
 * - amber  — warm amber/gold (default, Persoje's signature)
 * - ocean  — cool teal/cyan
 * - forest — deep green/emerald
 * - rose   — soft pink/magenta
 * - mono   — pure grayscale, no color
 */

export interface Theme {
  accent: string;
  accent2: string;
  bullet: string;
  border: string;
  ok: string;
  err: string;
  warn: string;
  dim: string;
  /** Gradient start RGB for the banner title */
  gradFrom: [number, number, number];
  /** Gradient end RGB for the banner title */
  gradTo: [number, number, number];
}

const palettes: Record<string, Theme> = {
  amber: {
    accent: "#e8a317",
    accent2: "#c78b0d",
    bullet: "gray",
    border: "gray",
    ok: "#00c853",
    err: "#f44336",
    warn: "#ffc107",
    dim: "#6b7280",
    gradFrom: [232, 163, 23],
    gradTo: [199, 139, 13],
  },
  ocean: {
    accent: "#00bcd4",
    accent2: "#0097a7",
    bullet: "gray",
    border: "gray",
    ok: "#4db6ac",
    err: "#ef5350",
    warn: "#ffb74d",
    dim: "#607d8b",
    gradFrom: [0, 188, 212],
    gradTo: [0, 151, 167],
  },
  forest: {
    accent: "#4caf50",
    accent2: "#388e3c",
    bullet: "gray",
    border: "gray",
    ok: "#81c784",
    err: "#e57373",
    warn: "#ffb74d",
    dim: "#5d7a4f",
    gradFrom: [76, 175, 80],
    gradTo: [56, 142, 60],
  },
  rose: {
    accent: "#e91e63",
    accent2: "#c2185b",
    bullet: "gray",
    border: "gray",
    ok: "#66bb6a",
    err: "#ef5350",
    warn: "#ffa726",
    dim: "#8e6b7a",
    gradFrom: [233, 30, 99],
    gradTo: [194, 24, 91],
  },
  mono: {
    accent: "white",
    accent2: "gray",
    bullet: "gray",
    border: "gray",
    ok: "white",
    err: "white",
    warn: "gray",
    dim: "gray",
    gradFrom: [180, 180, 180],
    gradTo: [120, 120, 120],
  },
};

/** Get a theme by name (falls back to amber for unknown names). */
export function getTheme(name: string): Theme {
  return palettes[name] ?? palettes.amber!;
}

/** List available theme names. */
export const themeNames = Object.keys(palettes);

/** Default theme (backward compat — the old `theme` const). */
export const theme: Theme = palettes.amber!;
