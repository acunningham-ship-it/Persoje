/**
 * Primer detection: probe a provider's /health endpoint to detect local inference runtime.
 * Cache result per-provider (one probe, not per-request). Graceful: any failure → primer-mode OFF.
 *
 * Primer is a LOCAL-only optimization (Armani's hard constraint — never primer-mode against a
 * public/cloud endpoint). It requires:
 * 1. A local/private host (loopback, RFC1918 LAN, or *.local) — cheap pre-filter, so we never
 *    probe a public cloud URL. A primer runtime may live on another box on your own network
 *    (e.g. the M2 at 192.168.x.x), so "local" means private network, not just loopback.
 * 2. Health endpoint returning {primer:true} or an X-Primer header — confirms it's really primer.
 * 3. Per-segment hashing (seg1+seg2 → X-Primer-Prefix-Hash) — primer uses prefix reuse, not cache_control.
 */

const primerCache = new Map<string, { primerMode: boolean; lastProbeTime: number }>();

/**
 * Is this baseUrl on a local/private network? Loopback, RFC1918 private IPv4, or *.local.
 * Cheap pre-filter so we only ever probe local endpoints, never public/cloud ones.
 */
export function isLocalUrl(baseUrl: string): boolean {
  try {
    // URL.hostname keeps IPv6 brackets (e.g. "[::1]") — strip them before comparing.
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (host.endsWith(".local")) return true;
    // RFC1918 private IPv4 ranges (a primer runtime on your LAN, e.g. another machine).
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Probe {baseUrl}/health for primer signature.
 * Returns true if health returns {primer:true} or X-Primer header.
 * Graceful: on any error/timeout → false. Caches result (one probe per provider).
 */
export async function detectPrimerMode(baseUrl: string): Promise<boolean> {
  // Pre-filter: local/private hosts only (never probe a public/cloud endpoint).
  if (!isLocalUrl(baseUrl)) return false;

  // Check cache (e.g. if we probed this endpoint 30s ago, reuse the result).
  const cached = primerCache.get(baseUrl);
  if (cached && Date.now() - cached.lastProbeTime < 60_000) {
    return cached.primerMode;
  }

  // Probe /health with 2s timeout.
  let primerMode = false;
  try {
    const healthUrl = new URL("/health", baseUrl).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(healthUrl, { signal: controller.signal });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        // Detect via JSON body {primer:true} or the presence of an X-Primer header (its value is a
        // version like "0.0.1", so check for presence, not equality).
        if (data.primer === true || res.headers.get("X-Primer") != null) {
          primerMode = true;
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Graceful: any error (timeout, fetch fail, JSON parse fail) → primer-mode OFF, no throw.
  }

  // Cache the result for this baseUrl (60s TTL).
  primerCache.set(baseUrl, { primerMode, lastProbeTime: Date.now() });
  return primerMode;
}
