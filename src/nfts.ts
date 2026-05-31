// nfts.ts — NFT data via OpenSea API
// Covers ETH, Base, Arbitrum and other EVM chains

export interface NFTCollection {
  address:        string;
  name:           string;
  chain:          string;
  floorPrice:     number;
  floorPriceUsd:  number;
  floor7dChange:  number;
  floor30dChange: number;
  volume24h:      number;
  volume7d:       number;
  sales24h:       number;
  sales7d:        number;
  holderCount:    number;
  totalSupply:    number;
  listedCount:    number;
  listingRate:    number;
  topHolderPct:   number;
  fetchedAt:      number;
}

export interface NFTSale {
  tokenId:     string;
  price:       number;
  buyer:       string;
  seller:      string;
  timestamp:   number;
  marketplace: string;
}

export interface NFTListing {
  tokenId:     string;
  price:       number;
  seller:      string;
  marketplace: string;
  validUntil:  number;
}

export interface HolderAnalysis {
  totalHolders:   number;
  avgHoldDays:    number;
  top10HolderPct: number;
  recentBuyers:   string[];
  recentSellers:  string[];
  holderTrend:    "growing" | "stable" | "declining";
  washTradeRisk:  "low" | "medium" | "high";
}

// OpenSea chain slugs
const OPENSEA_CHAINS: Record<string, string> = {
  ethereum:  "ethereum",
  base:      "base",
  arbitrum:  "arbitrum",
  polygon:   "matic",
  optimism:  "optimism",
};

const OPENSEA_BASE    = "https://api.opensea.io/api/v2";
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY || "";

const collectionCache: Map<string, NFTCollection> = new Map();
const CACHE_TTL = 5 * 60 * 1000;

export class KiraNFTs {

  private headers(): Record<string, string> {
    return {
      "x-api-key":    OPENSEA_API_KEY,
      "Content-Type": "application/json",
      "Accept":       "application/json",
    };
  }

  private getChainSlug(chain: string): string {
    return OPENSEA_CHAINS[chain] || "ethereum";
  }

  async getCollection(
    contractAddress: string,
    chain:           string = "ethereum"
  ): Promise<NFTCollection | null> {
    const cacheKey = `${chain}:${contractAddress.toLowerCase()}`;
    const cached   = collectionCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached;

    try {
      const chainSlug = this.getChainSlug(chain);

      // Get collection stats
      const statsRes = await fetch(
        `${OPENSEA_BASE}/collections/${contractAddress}/stats`,
        { headers: this.headers(), signal: AbortSignal.timeout(15000) }
      );

      // Get collection metadata
      const metaRes = await fetch(
        `${OPENSEA_BASE}/chain/${chainSlug}/contract/${contractAddress}`,
        { headers: this.headers(), signal: AbortSignal.timeout(15000) }
      );

      if (!statsRes.ok || !metaRes.ok) return null;

      const stats = await statsRes.json() as any;
      const meta  = await metaRes.json() as any;

      const floorEth  = stats.total?.floor_price      || 0;
      const supply    = stats.total?.num_owners        || 0;
      const volume24h = stats.intervals?.find(
        (i: any) => i.interval === "one_day"
      )?.volume || 0;
      const volume7d  = stats.intervals?.find(
        (i: any) => i.interval === "seven_day"
      )?.volume || 0;
      const sales24h  = stats.intervals?.find(
        (i: any) => i.interval === "one_day"
      )?.sales || 0;
      const sales7d   = stats.intervals?.find(
        (i: any) => i.interval === "seven_day"
      )?.sales || 0;

      // Floor change: approximate from volume trends
      const floor7dChange  = 0; // OpenSea doesn't provide direct % change — will enrich later
      const floor30dChange = 0;

      const collection: NFTCollection = {
        address:        contractAddress.toLowerCase(),
        name:           meta.name || meta.collection || "Unknown",
        chain,
        floorPrice:     floorEth,
        floorPriceUsd:  floorEth * 2000, // rough proxy — will improve
        floor7dChange,
        floor30dChange,
        volume24h,
        volume7d,
        sales24h,
        sales7d,
        holderCount:    stats.total?.num_owners     || 0,
        totalSupply:    stats.total?.supply         || 0,
        listedCount:    stats.total?.listed_count   || 0,
        listingRate:    stats.total?.supply > 0
          ? (stats.total?.listed_count / stats.total?.supply) * 100 : 0,
        topHolderPct:   0,
        fetchedAt:      Date.now(),
      };

      collectionCache.set(cacheKey, collection);
      return collection;

    } catch (err: any) {
      console.error(`NFT collection fetch failed for ${contractAddress}:`, err?.message);
      return null;
    }
  }

  async getRecentSales(
    contractAddress: string,
    chain:           string = "ethereum",
    limit:           number = 50
  ): Promise<NFTSale[]> {
    try {
      const chainSlug = this.getChainSlug(chain);
      const res       = await fetch(
        `${OPENSEA_BASE}/events/collection/${contractAddress}?event_type=sale&limit=${limit}&chain=${chainSlug}`,
        { headers: this.headers(), signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) return [];

      const data = await res.json() as any;
      return (data.asset_events || []).map((e: any) => ({
        tokenId:     e.nft?.identifier   || "",
        price:       parseFloat(e.payment?.quantity || "0") / 1e18,
        buyer:       e.buyer             || "",
        seller:      e.seller            || "",
        timestamp:   new Date(e.event_timestamp).getTime() / 1000,
        marketplace: "opensea",
      }));

    } catch (err: any) {
      console.error(`Sales fetch failed for ${contractAddress}:`, err?.message);
      return [];
    }
  }

  async getFloorListings(
    contractAddress: string,
    chain:           string = "ethereum",
    limit:           number = 10
  ): Promise<NFTListing[]> {
    try {
      const chainSlug = this.getChainSlug(chain);
      const res       = await fetch(
        `${OPENSEA_BASE}/listings/collection/${contractAddress}/best?limit=${limit}&chain=${chainSlug}`,
        { headers: this.headers(), signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) return [];

      const data = await res.json() as any;
      return (data.listings || []).map((l: any) => ({
        tokenId:     l.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria || "",
        price:       parseFloat(l.price?.current?.value || "0") / 1e18,
        seller:      l.protocol_data?.parameters?.offerer || "",
        marketplace: "opensea",
        validUntil:  parseInt(l.protocol_data?.parameters?.endTime || "0"),
      }));

    } catch (err: any) {
      console.error(`Listings fetch failed for ${contractAddress}:`, err?.message);
      return [];
    }
  }

  async analyseHolders(
    contractAddress: string,
    chain:           string = "ethereum"
  ): Promise<HolderAnalysis> {
    const sales        = await this.getRecentSales(contractAddress, chain, 100);
    const sevenDaysAgo = Date.now() / 1000 - 7 * 24 * 3600;
    const recentSales  = sales.filter(s => s.timestamp > sevenDaysAgo);

    const recentBuyers  = [...new Set(recentSales.map(s => s.buyer).filter(Boolean))];
    const recentSellers = [...new Set(recentSales.map(s => s.seller).filter(Boolean))];

    const buyerSet    = new Set(recentBuyers);
    const washTraders = recentSellers.filter(s => buyerSet.has(s));
    const washRisk: "low" | "medium" | "high" =
      washTraders.length > 3 ? "high" :
      washTraders.length > 1 ? "medium" : "low";

    const holderTrend: "growing" | "stable" | "declining" =
      recentBuyers.length > recentSellers.length * 1.2  ? "growing" :
      recentSellers.length > recentBuyers.length * 1.2  ? "declining" : "stable";

    const avgHoldDays = sales.length > 0
      ? Math.min(365, Math.round(30 / (sales.length / 30))) : 90;

    const col = collectionCache.get(`${chain}:${contractAddress.toLowerCase()}`);

    return {
      totalHolders:   col?.holderCount || 0,
      avgHoldDays,
      top10HolderPct: col?.topHolderPct || 0,
      recentBuyers,
      recentSellers,
      holderTrend,
      washTradeRisk:  washRisk,
    };
  }

  async getTrendingCollections(
    chain: string = "ethereum",
    limit: number = 10
  ): Promise<NFTCollection[]> {
    try {
      const chainSlug = this.getChainSlug(chain);
      const res       = await fetch(
        `${OPENSEA_BASE}/collections?chain=${chainSlug}&order_by=one_day_volume&limit=${limit}`,
        { headers: this.headers(), signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) return [];

      const data    = await res.json() as any;
      const results = await Promise.allSettled(
        (data.collections || []).map((c: any) =>
          this.getCollection(c.contracts?.[0]?.address || c.collection, chain)
        )
      );

      return results
        .filter(r => r.status === "fulfilled" && r.value !== null)
        .map(r => (r as PromiseFulfilledResult<NFTCollection>).value);

    } catch (err: any) {
      console.error(`Trending collections fetch failed:`, err?.message);
      return [];
    }
  }

  hasFloorDepth(listings: NFTListing[], targetPrice: number, minListings: number = 5): boolean {
    return listings.filter(l => l.price <= targetPrice * 1.1).length >= minListings;
  }

  formatForContext(col: NFTCollection): string {
    return [
      `${col.name} (${col.chain}):`,
      `Floor: ${col.floorPrice.toFixed(4)} ETH`,
      `7d: ${col.floor7dChange > 0 ? "+" : ""}${col.floor7dChange.toFixed(1)}%`,
      `30d: ${col.floor30dChange > 0 ? "+" : ""}${col.floor30dChange.toFixed(1)}%`,
      `Vol 24h: ${col.volume24h.toFixed(3)} ETH`,
      `Sales 7d: ${col.sales7d}`,
      `Holders: ${col.holderCount}`,
      `Listed: ${col.listedCount} (${col.listingRate.toFixed(1)}%)`,
    ].join(" | ");
  }
}
