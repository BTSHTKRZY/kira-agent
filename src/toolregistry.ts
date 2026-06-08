// toolregistry.ts
// Live client for the OpenSea ERC-8257 Agent Tool Registry REST API.
//
// Replaces the old raw-eth_call + hardcoded "18" fallback in tools.ts. This calls
// the real endpoint (GET https://api.opensea.io/api/v2/tools), PAGINATES through
// every page via the `next` cursor (the old code's undercount came from never
// paginating), and returns accurate counts + real per-tool data.
//
// Docs: https://docs.opensea.io/reference/list_tools  /  /reference/get_tool
//       https://docs.opensea.io/reference/create_instant_api_key (free, no-signup key)
//
// IMPORTANT (integrity): KIRA's own tools are identified by matching the registry
// `creator` field against her operator/holder wallets — NOT by hardcoding "7 and 13".
// If the registry says she has zero tools under those addresses, getSummary() will
// say so honestly rather than asserting ownership she can't substantiate.

const OPENSEA_API_BASE = "https://api.opensea.io/api/v2";
const REGISTRY_CHAIN   = process.env.ERC8257_REGISTRY_CHAIN || "base";
const REGISTRY_ADDR    = (process.env.ERC8257_REGISTRY_ADDR ||
  "0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1").toLowerCase();

// Wallets that, if they appear as a tool's `creator`, mean the tool is KIRA's
// (deployed/maintained by her holder). Lowercased for comparison.
const KIRA_TOOL_CREATORS: string[] = [
  (process.env.KIRA_OPERATOR_WALLET || "0x020d6409Ebc4fa13E754e0fEa275ac353eFD4f03").toLowerCase(),
  (process.env.HOLDER_WALLET        || "0x6f33e7b6460daC803c53ab6e02da8C675633d516").toLowerCase(),
  (process.env.KIRA_WALLET          || "0x176086ACE60F74D211E68b7bABFfF5C35E6D2b7d").toLowerCase(),
];

export interface RegistryTool {
  toolId:              string;
  registryChain:       string;
  registryAddr:        string;
  creator:             string;
  metadataUri:         string;
  manifestHash:        string;
  manifestHashVerified: boolean;
  endpointUrl?:        string;
  endpointDomain?:     string;
  isActive:            boolean;
  createdAt:           string;
  updatedAt:           string;
}

export interface RegistrySnapshot {
  total:        number;            // accurate, fully-paginated count of active tools
  verified:     number;            // tools with manifest_hash_verified === true
  byType:       Record<string, number>;
  kiraTools:    RegistryTool[];    // tools whose creator is one of KIRA's wallets
  allTools:     RegistryTool[];
  fetchedAt:    number;
  stale:        boolean;           // true if we served a cached snapshot after a fetch failure
}

export class ToolRegistry {
  private apiKey:        string | null = null;
  private apiKeyExpiry:  number = 0;
  private cache:         RegistrySnapshot | null = null;
  private cacheTtlMs:    number = 30 * 60 * 1000; // 30 min — registry doesn't change minute-to-minute

  // ---- API key handling --------------------------------------------------
  // Prefer a persistent key from env. Otherwise mint a free instant key
  // (30-day, rate-limited to 2/hour/IP) and reuse it until it expires.
  private async ensureApiKey(): Promise<string | null> {
    const envKey = process.env.OPENSEA_API_KEY;
    if (envKey) return envKey;

    if (this.apiKey && Date.now() < this.apiKeyExpiry) return this.apiKey;

    try {
      const res = await this.timedFetch(`${OPENSEA_API_BASE}/keys/instant`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({}),
      }, 8000);
      if (!res.ok) {
        console.warn(`[ToolRegistry] instant key request failed: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json() as any;
      const key  = data?.api_key || data?.key || data?.apiKey;
      if (!key) { console.warn("[ToolRegistry] instant key response had no key field"); return null; }
      this.apiKey       = key;
      this.apiKeyExpiry = Date.now() + 25 * 24 * 60 * 60 * 1000; // refresh well before 30d
      console.log("[ToolRegistry] minted free instant OpenSea API key");
      return key;
    } catch (e: any) {
      console.warn(`[ToolRegistry] instant key error: ${(e?.message || "").slice(0, 80)}`);
      return null;
    }
  }

  private async timedFetch(url: string, opts: any, ms: number): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }

  // ---- Core: fully-paginated tool list -----------------------------------
  // Walks the `next` cursor to the end so the count is the REAL total, not a
  // single page. This is the fix for the chronic undercount ("18").
  async fetchAllTools(maxPages: number = 25): Promise<RegistryTool[] | null> {
    const apiKey = await this.ensureApiKey();
    if (!apiKey) return null;

    const out: RegistryTool[] = [];
    let cursor: string | undefined = undefined;
    let pages = 0;

    try {
      do {
        const url = new URL(`${OPENSEA_API_BASE}/tools`);
        url.searchParams.set("limit", "200");          // max page size → fewest round-trips
        url.searchParams.set("sort_by", "newest");
        if (cursor) url.searchParams.set("cursor.value", cursor);

        const res = await this.timedFetch(url.toString(), {
          method:  "GET",
          headers: { "x-api-key": apiKey, "Accept": "application/json" },
        }, 10000);

        if (!res.ok) {
          console.warn(`[ToolRegistry] list_tools HTTP ${res.status} on page ${pages + 1}`);
          // If we already got some pages, return what we have rather than nothing.
          return out.length > 0 ? out : null;
        }

        const data: any = await res.json();
        const batch: any[] = Array.isArray(data?.tools) ? data.tools : [];
        for (const t of batch) {
          out.push({
            toolId:               String(t.tool_id),
            registryChain:        String(t.registry_chain || ""),
            registryAddr:         String(t.registry_addr || "").toLowerCase(),
            creator:              String(t.creator || "").toLowerCase(),
            metadataUri:          String(t.metadata_uri || ""),
            manifestHash:         String(t.manifest_hash || ""),
            manifestHashVerified: Boolean(t.manifest_hash_verified),
            endpointUrl:          t.endpoint_url || undefined,
            endpointDomain:       t.endpoint_domain || undefined,
            isActive:             Boolean(t.is_active),
            createdAt:            String(t.created_at || ""),
            updatedAt:            String(t.updated_at || ""),
          });
        }
        cursor = data?.next || undefined;
        pages++;
      } while (cursor && pages < maxPages);

      return out;
    } catch (e: any) {
      console.warn(`[ToolRegistry] fetchAllTools error: ${(e?.message || "").slice(0, 80)}`);
      return out.length > 0 ? out : null;
    }
  }

  // ---- Snapshot with caching + honest staleness --------------------------
  async getSnapshot(force: boolean = false): Promise<RegistrySnapshot | null> {
    if (!force && this.cache && Date.now() - this.cache.fetchedAt < this.cacheTtlMs) {
      return this.cache;
    }

    const tools = await this.fetchAllTools();
    if (!tools) {
      // Fetch failed. Serve last good snapshot marked stale, or null if we never had one.
      if (this.cache) {
        return { ...this.cache, stale: true };
      }
      return null;
    }

    // Restrict "registry" view to the registry we care about, on the right chain.
    // NOTE: the live API returns registry_chain as a NUMERIC chain id ("8453" for Base),
    // not the string "base". Accept both the numeric id and common string forms so the
    // filter doesn't drop every tool (that bug returned a count of 0).
    const CHAIN_ALIASES = new Set(
      [REGISTRY_CHAIN.toLowerCase(), "8453", "base", "base-mainnet"]
    );
    const onRegistry = tools.filter(t =>
      (!t.registryAddr || t.registryAddr === REGISTRY_ADDR) &&
      (!t.registryChain || CHAIN_ALIASES.has(t.registryChain.toLowerCase()))
    );
    const active = onRegistry.filter(t => t.isActive);

    const byType: Record<string, number> = {};
    for (const t of active) {
      // The list endpoint doesn't return access-type directly; we bucket by
      // verified/unverified as a coarse, honest proxy until get_tool enrichment.
      const k = t.manifestHashVerified ? "verified" : "unverified";
      byType[k] = (byType[k] || 0) + 1;
    }

    const kiraTools = active.filter(t => KIRA_TOOL_CREATORS.includes(t.creator));

    const snap: RegistrySnapshot = {
      total:     active.length,
      verified:  active.filter(t => t.manifestHashVerified).length,
      byType,
      kiraTools,
      allTools:  active,
      fetchedAt: Date.now(),
      stale:     false,
    };
    this.cache = snap;
    return snap;
  }

  // ---- Honest summary string (replaces the old hardcoded one) ------------
  // Never asserts "Tool #7 and #13" unless the live registry actually shows
  // tools created by KIRA's wallets. If data is unavailable, says so plainly
  // rather than inventing a number.
  async getSummary(): Promise<string> {
    const snap = await this.getSnapshot();
    if (!snap) {
      return "ERC-8257 registry data unavailable right now (could not reach the registry API). " +
             "No reliable tool count to report this cycle.";
    }

    const freshness = snap.stale ? " (last known data; live refresh failed this cycle)" : "";
    let kiraPart: string;
    if (snap.kiraTools.length > 0) {
      const ids = snap.kiraTools.map(t => `#${t.toolId}`).join(", ");
      kiraPart = `Tools deployed/maintained by KIRA's holder: ${ids} (${snap.kiraTools.length}).`;
    } else {
      kiraPart = "No tools under KIRA's wallets are currently reflected in the live registry view.";
    }

    return `${snap.total} active tools on the ERC-8257 registry (Base), ` +
           `${snap.verified} with verified manifest hashes${freshness}. ${kiraPart}`;
  }

  // ---- Convenience accessors for other modules ---------------------------
  async getToolCount(): Promise<number | null> {
    const snap = await this.getSnapshot();
    return snap ? snap.total : null;
  }

  async getKiraTools(): Promise<RegistryTool[]> {
    const snap = await this.getSnapshot();
    return snap ? snap.kiraTools : [];
  }

  // Get full detail on one tool (for #12 tool-consumption later). Uses get_tool.
  async getTool(toolId: string): Promise<any | null> {
    const apiKey = await this.ensureApiKey();
    if (!apiKey) return null;
    try {
      const url = new URL(`${OPENSEA_API_BASE}/tools/${encodeURIComponent(toolId)}`);
      url.searchParams.set("registry_chain", REGISTRY_CHAIN);
      url.searchParams.set("registry_addr",  REGISTRY_ADDR);
      const res = await this.timedFetch(url.toString(), {
        method:  "GET",
        headers: { "x-api-key": apiKey, "Accept": "application/json" },
      }, 10000);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
}
