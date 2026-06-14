/**
 * Primer detection: probe a provider's /health endpoint to detect local inference runtime.
 * Cache result per-provider (one probe, not per-request). Graceful: any failure → primer-mode OFF.
 *
 * Primer is a local-only optimization that requires:
 * 1. Loopback URL (localhost, 127.0.0.1, ::1) — cheap pre-filter before probing.
 * 2. Health endpoint returning {primer:true} or X-Primer header — confirm activation.
 * 3. Per-segment hashing (seg1+seg2 → X-Primer-Prefix-Hash) — primer uses prefix reuse, not cache_control.
 */

const primerCache = new Map<string, { primerMode: boolean; lastProbeTime: number }>();

/**
 * Check if a baseUrl is loopback (localhost, 127.0.0.1, ::1).
 * Cheap pre-filter before sending a health probe.
 */
function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
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
  // Pre-filter: loopback only (Armani's hard constraint).
  if (!isLoopbackUrl(baseUrl)) return false;

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
        // Detect via JSON body {primer:true} or response header X-Primer.
        if (data.primer === true || res.headers.get("X-Primer") === "true") {
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
