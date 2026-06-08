import { z } from "zod";
import { ToolError, type Tool } from "./types.ts";

// A coding agent that can't read a URL is half-blind: it can't check a library's
// docs, an RFC, a changelog, or the page behind an error message. These two tools
// close that gap while staying on-thesis — HTML is stripped to lean text before it
// ever touches the context, and the agent loop caps the result like any other tool.
// No API key, no SDK, no new dependency: raw fetch + a regex HTML stripper.

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000; // don't slurp a 50MB page into memory

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™", deg: "°", times: "×", middot: "·",
};

/** Decode the handful of HTML entities that actually show up in body text. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code: string) => {
    if (code[0] === "#") {
      const cp = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[code] ?? m;
  });
}

/**
 * Strip an HTML document to readable markdown-ish text. Not a full parser —
 * a deliberately lean converter that drops chrome (script/style/nav/svg),
 * keeps headings/links/code/list structure, and collapses the whitespace
 * blowup that makes raw HTML so token-expensive.
 */
export function htmlToText(html: string): string {
  let s = html;
  // Kill non-content elements wholesale (including their contents).
  s = s.replace(/<(script|style|noscript|svg|head|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Structural markers → markdown before tags are stripped.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, inner: string) => {
    return `\n\n${"#".repeat(Number(lvl))} ${inner.replace(/<[^>]+>/g, "").trim()}\n\n`;
  });
  s = s.replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    if (!text) return "";
    if (/^(#|javascript:)/i.test(href)) return text;
    return `[${text}](${href})`;
  });
  s = s.replace(/<(pre|code)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner: string) => {
    return "`" + inner.replace(/<[^>]+>/g, "").trim() + "`";
  });
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<\/(p|div|section|article|tr|ul|ol|table|h[1-6]|blockquote)>/gi, "\n\n");
  s = s.replace(/<br\b[^>]*>/gi, "\n");
  // Drop every remaining tag, decode entities, collapse whitespace.
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Pull the <title> out of a document for a one-line header. */
export function extractTitle(html: string): string {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]!.replace(/<[^>]+>/g, "").trim()) : "";
}

/**
 * Read a response body but stop after `maxBytes` — streaming, so a 50MB page
 * never fully lands in memory. We only need the first chunk of a doc page; the
 * result is truncated to the tool's token cap downstream anyway.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes * 4);
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (total >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}

async function fetchText(url: string, signal?: AbortSignal): Promise<{ body: string; contentType: string; finalUrl: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": DEFAULT_UA, Accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*" },
    });
    if (!res.ok) throw new ToolError(`HTTP ${res.status} ${res.statusText} for ${url}`);
    const contentType = res.headers.get("content-type") ?? "";
    const body = await readCapped(res, MAX_BYTES);
    return { body, contentType, finalUrl: res.url || url };
  } catch (e) {
    if (e instanceof ToolError) throw e;
    const msg = (e as Error).name === "AbortError" ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : (e as Error).message;
    throw new ToolError(`fetch failed for ${url}: ${msg}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function normalizeUrl(raw: string): string {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) return `https://${url}`;
  return url;
}

/**
 * Refuse URLs that point at the loopback, the link-local cloud-metadata
 * endpoint, or RFC-1918 private ranges. A fetched page can carry an injected
 * "now fetch http://169.254.169.254/…" instruction; this is the cheap floor
 * that stops a coding agent being turned into an SSRF proxy for internal
 * services. Returns a reason string when blocked, null when allowed.
 */
export function ssrfReason(rawUrl: string): string | null {
  let host: string;
  try {
    host = new URL(normalizeUrl(rawUrl)).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "unparseable URL";
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return "loopback/internal host";
  if (host === "::1" || host === "0.0.0.0") return "loopback address";
  if (host === "169.254.169.254" || host === "metadata.google.internal") return "cloud metadata endpoint";
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return "loopback address";
    if (a === 10) return "private network (10.x)";
    if (a === 192 && b === 168) return "private network (192.168.x)";
    if (a === 172 && b >= 16 && b <= 31) return "private network (172.16–31.x)";
    if (a === 169 && b === 254) return "link-local address";
  }
  return null;
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description: "Fetch a URL and return its main text as clean markdown (HTML stripped, capped). Use for docs, RFCs, changelogs, error-page lookups.",
  args: z.object({
    url: z.string().describe("The URL to fetch (https:// assumed if no scheme)"),
  }),
  maxResultTokens: 3000,
  async execute({ url }, ctx) {
    const target = normalizeUrl(url);
    const blocked = ssrfReason(target);
    if (blocked) throw new ToolError(`refusing to fetch ${target}: ${blocked}`);
    const { body, contentType, finalUrl } = await fetchText(target, ctx.signal);
    let out: string;
    if (/application\/json|text\/plain|application\/xml|text\/xml/i.test(contentType)) {
      out = body.trim();
    } else if (/text\/html|application\/xhtml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body)) {
      const title = extractTitle(body);
      const text = htmlToText(body);
      if (!text) throw new ToolError(`no readable text extracted from ${finalUrl}`);
      out = title ? `# ${title}\n\n${text}` : text;
    } else {
      out = body.trim();
    }
    if (!out) throw new ToolError(`empty response from ${finalUrl}`);
    const header = finalUrl !== target ? `[fetched: ${finalUrl}]\n\n` : "";
    return header + out;
  },
};

/** Decode DuckDuckGo's `/l/?uddg=<encoded>` redirect wrapper to the real URL. */
export function unwrapDdgUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return href;
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Parse DuckDuckGo's HTML results page into structured hits. */
export function parseDdgResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push(decodeEntities(sm[1]!.replace(/<[^>]+>/g, "").trim()));
  }
  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) !== null && results.length < limit) {
    const url = unwrapDdgUrl(lm[1]!);
    const title = decodeEntities(lm[2]!.replace(/<[^>]+>/g, "").trim());
    if (!title || !/^https?:/i.test(url)) {
      i++;
      continue;
    }
    results.push({ title, url, snippet: snippets[i] ?? "" });
    i++;
  }
  return results;
}

export const webSearchTool: Tool = {
  name: "web_search",
  description: "Search the web (keyless, via DuckDuckGo). Returns top results as title · url · snippet. Follow up with web_fetch to read one.",
  args: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().optional().describe("Max results (default 6)"),
  }),
  maxResultTokens: 1500,
  async execute({ query, limit }, ctx) {
    const n = Math.min(Math.max(limit ?? 6, 1), 10);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const { body } = await fetchText(url, ctx.signal);
    const hits = parseDdgResults(body, n);
    if (hits.length === 0) {
      throw new ToolError(`no results for "${query}" (the engine may be rate-limiting; retry or web_fetch a known URL directly)`);
    }
    return hits
      .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`)
      .join("\n\n");
  },
};
