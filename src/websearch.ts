// websearch.ts — real web search via the Brave Search API.
//
// WHY THIS EXISTS:
//   KIRA's research loop previously "searched" by querying X. With the X account
//   suspended, that path is dead (401). This gives her a REAL open-web search so she
//   can scout the whole agentic/on-chain-AI frontier — new standards, protocols,
//   tools, marketplaces — and then fetch the actual sources to read.
//
// COST SAFETY (important — Brave is usage-billed beyond a free monthly credit):
//   Brave's "Search" plan bills $5/1,000 requests but includes $5 free credit/month
//   (= 1,000 free requests). To guarantee KIRA NEVER incurs a surprise charge, this
//   client enforces a HARD monthly query ceiling in Redis (default 900, safely under
//   the 1,000 free). When the ceiling is hit, web search stops for the month and the
//   research loop falls back to on-chain/registry sources — it does NOT keep spending.
//   This mirrors the spendlimit.ts philosophy: hard limits in code, not trust.
//
// GRACEFUL DEGRADATION:
//   - No BRAVE_SEARCH_API_KEY set  → enabled=false, search returns [] (loop uses on-chain).
//   - Monthly ceiling reached      → returns [] until the 1st of next month (UTC).
//   - API error / rate-limit       → returns [] for that call, logged, never throws.

import { kiraRedis } from "./redis.js";

const BRAVE_KEY      = process.env.BRAVE_SEARCH_API_KEY || "";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

// Hard monthly ceiling — conservative default under Brave's 1,000 free-credit requests.
const MONTHLY_QUERY_CEILING = parseInt(process.env.BRAVE_MONTHLY_CEILING || "900");

// Brave free tier capacity is generous (50 req/s on Search) but we self-throttle to be
// polite and predictable. Minimum gap between calls.
const MIN_GAP_MS = 1200;

export const WEB_SEARCH_ENABLED = Boolean(BRAVE_KEY);

const K = {
  month:   () => `kira:websearch:count:${new Date().toISOString().slice(0, 7)}`, // YYYY-MM (UTC)
};

let lastCallTs = 0;

export interface WebResult {
  title:   string;
  url:     string;
  snippet: string;
}

export const webSearchClient = {

  enabled(): boolean { return WEB_SEARCH_ENABLED; },

  // How many queries used this month, and the ceiling.
  async usage(): Promise<{ used: number; ceiling: number; remaining: number }> {
    const used = parseInt(await kiraRedis.get(K.month()) || "0");
    return { used, ceiling: MONTHLY_QUERY_CEILING, remaining: Math.max(0, MONTHLY_QUERY_CEILING - used) };
  },

  // Real web search. Returns [] on any failure / disabled / ceiling-hit (never throws),
  // so callers can always fall back to on-chain sources cleanly.
  async search(query: string, count: number = 8): Promise<WebResult[]> {
    if (!WEB_SEARCH_ENABLED) return [];
    if (!query || !query.trim()) return [];

    // HARD CEILING CHECK — refuse before spending if the month's budget is exhausted.
    const monthKey = K.month();
    const used = parseInt(await kiraRedis.get(monthKey) || "0");
    if (used >= MONTHLY_QUERY_CEILING) {
      console.warn(`[WebSearch] Monthly ceiling reached (${used}/${MONTHLY_QUERY_CEILING}) — skipping (falls back to on-chain). Resets next month.`);
      return [];
    }

    // Self-throttle.
    const gap = Date.now() - lastCallTs;
    if (gap < MIN_GAP_MS) await new Promise(r => setTimeout(r, MIN_GAP_MS - gap));
    lastCallTs = Date.now();

    try {
      const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${Math.min(count, 10)}`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "Accept":               "application/json",
          "Accept-Encoding":      "gzip",
          "X-Subscription-Token": BRAVE_KEY,
        },
        signal: AbortSignal.timeout(12000),
      });

      // Count the request regardless of result shape (Brave bills on request, not results).
      await this.incrementUsage(monthKey);

      if (!res.ok) {
        console.warn(`[WebSearch] Brave HTTP ${res.status} for "${query.slice(0, 40)}"`);
        return [];
      }

      const json = await res.json() as any;
      const items = json?.web?.results || [];
      return items.slice(0, count).map((r: any) => ({
        title:   r.title       || "",
        url:     r.url         || "",
        snippet: r.description || r.snippet || "",
      })).filter((r: WebResult) => r.url);
    } catch (err: any) {
      console.warn(`[WebSearch] error for "${query.slice(0, 40)}": ${err?.message}`);
      return [];
    }
  },

  async incrementUsage(monthKey: string): Promise<void> {
    try {
      const cur = parseInt(await kiraRedis.get(monthKey) || "0");
      await kiraRedis.set(monthKey, String(cur + 1));
    } catch { /* non-fatal — a missed count just means slightly conservative accounting */ }
  },
};
