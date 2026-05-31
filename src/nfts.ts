// nfts.ts — NFT data via Reservoir API (free public endpoint)
// Covers ETH, Base, Arbitrum, Polygon and other EVM chains

export interface NFTCollection {
  address:          string;
  name:             string;
  chain:            string;
  floorPrice:       number;       // in ETH
  floorPriceUsd:    number;
  floor7dChange:    number;       // % change over 7 days
  floor30dChange:   number;
  volume24h:        number;       // ETH
  volume7d:         number;
  sales24h:         number;
  sales7d:          number;
  holderCount:      number;
  totalSupply:      number;
  listedCount:      number;       // currently listed
  listingRate:      number;       // listed / supply %
  topHolderPct:     number;       // % held by top 10 wallets
  fetchedAt:        number;
}

export interface NFTSale {
  tokenId:    string;
  price:      number;            // ETH
  buyer:      string;
  seller:     string;
  timestamp:  number;
  marketplace: string;
}

export interface NFTListing {
  tokenId:    string;
  price:      number;            // ETH
  seller:     string;
  marketplace: string;
  validUntil: number;
}

export interface HolderAnalysis {
  totalHolders:     number;
  avgHoldDays:      number;      // estimated average hold duration
  top10HolderPct:   number;      // concentration risk
  recentBuyers:     string[];    // wallets that bought in last 7d
  recentSellers:    string[];    // wallets that sold in last 7d
  holderTrend:      "growing" | "stable" | "declining";
  washTradeRisk:    "low" | "medium" | "high";
}

// Reservoir chain slugs
const RESERVOIR_CHAINS: Record<string, string> = {
  ethereum:  "https://api.reservoir.tools",
  base:      "https://api-base.reservoir.tools",
  arbitrum:  "https://api-arbitrum.reservoir.tools",
  polygon:   "https://api-polygon.reservoir.tools",
  optimism:  "https://api-optimism.reservoir.tools",
};

const RESERVOIR_API_KEY = process.env.RESERVOIR_API_KEY || "demo"; // free public key

// Cache
const collectionCache: Map<string, NFTCollection> = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export class KiraNFTs {

  private getBaseUrl(chain: string): string {
    return RESERVOIR_CHAINS[chain] || RESERVOIR_CHAINS.ethereum;
  }

  private headers(): Record<string, string> {
    return {
      "x-api-key":    RESERVOIR_API_KEY,
      "Content-Type": "application/json",
    };
  }

  // Get collection data
  async getCollection(
    contractAddress: string,
    chain: string = "ethereum"
  ): Promise<NFTCollection | null> {
    const cacheKey = `${chain}:${contractAddress.toLowerCase()}`;
    const cached   = collectionCache.get(cacheKey);

    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      return cached;
    }

    try {
      const base = this.getBaseUrl(chain);
      const url  = `${base}/collections/v7?id=${contractAddress}&includeTopBid=false&normalizeRoyalties=false`;

      const res  = await fetch(url, {
        headers: this.headers(),
        signal:  AbortSignal.timeout(15000),
      });

      if (!res.ok) return null;

      const data       = await res.json() as any;
      const col        = data.collections?.[0];
      if (!col) return null;

      const floorEth   = col.floorAsk?.price?.amount?.native || 0;
      const floorUsd   = col.floorAsk?.price?.amount?.usd    || 0;
      const supply     = col.tokenCount || 0;
      const listed     = col.onSaleCount || 0;

      const collection: NFTCollection = {
        address:        contractAddress.toLowerCase(),
        name:           col.name || "Unknown",
        chain,
        floorPrice:     floorEth,
        floorPriceUsd:  floorUsd,
        floor7dChange:  col.floorSaleChange?.["7day"]  || 0,
        floor30dChange: col.floorSaleChange?.["30day"] || 0,
        volume24h:      col.volume?.["1day"]  || 0,
        volume7d:       col.volume?.["7day"]  || 0,
        sales24h:       col.salesCount?.["1day"]  || 0,
        sales7d:        col.salesCount?.["7day"]  || 0,
        holderCount:    col.ownerCount || 0,
        totalSupply:    supply,
        listedCount:    listed,
        listingRate:    supply > 0 ? (listed / supply) * 100 : 0,
        topHolderPct:   0, // populated separately
        fetchedAt:      Date.now(),
      };

      collectionCache.set(cacheKey, collection);
      return collection;

    } catch (err: any) {
      console.error(`NFT collection fetch failed for ${contractAddress}:`, err?.message);
      return null;
    }
  }

  // Get recent sales — useful for identifying accumulating wallets
  async getRecentSales(
    contractAddress: string,
    chain:           string = "ethereum",
    limit:           number = 50
  ): Promise<NFTSale[]> {
    try {
      const base = this.getBaseUrl(chain);
      const url  = `${base}/sales/v6?contract=${contractAddress}&limit=${limit}&sortBy=time`;

      const res  = await fetch(url, {
        headers: this.headers(),
        signal:  AbortSignal.timeout(15000),
      });

      if (!res.ok) return [];

      const data = await res.json() as any;
      return (data.sales || []).map((s: any) => ({
        tokenId:     s.token?.tokenId || "",
        price:       s.price?.amount?.native || 0,
        buyer:       s.buyer || "",
        seller:      s.seller || "",
        timestamp:   s.timestamp || 0,
        marketplace: s.orderSource || "unknown",
      }));

    } catch (err: any) {
      console.error(`Sales fetch failed for ${contractAddress}:`, err?.message);
      return [];
    }
  }

  // Get floor listings
  async getFloorListings(
    contractAddress: string,
    chain:           string = "ethereum",
    limit:           number = 10
  ): Promise<NFTListing[]> {
    try {
      const base = this.getBaseUrl(chain);
      const url  = `${base}/orders/asks/v5?contracts=${contractAddress}&sortBy=price&limit=${limit}&normalizeRoyalties=false`;

      const res  = await fetch(url, {
        headers: this.headers(),
        signal:  AbortSignal.timeout(15000),
      });

      if (!res.ok) return [];

      const data = await res.json() as any;
      return (data.orders || []).map((o: any) => ({
        tokenId:    o.criteria?.data?.token?.tokenId || "",
        price:      o.price?.amount?.native || 0,
        seller:     o.maker || "",
        marketplace: o.source?.name || "unknown",
        validUntil: o.validUntil || 0,
      }));

    } catch (err: any) {
      console.error(`Listings fetch failed for ${contractAddress}:`, err?.message);
      return [];
    }
  }

  // Analyse holder behaviour from recent sales data
  async analyseHolders(
    contractAddress: string,
    chain:           string = "ethereum"
  ): Promise<HolderAnalysis> {
    const sales   = await this.getRecentSales(contractAddress, chain, 100);
    const sevenDaysAgo = Date.now() / 1000 - 7 * 24 * 3600;

    const recentSales   = sales.filter(s => s.timestamp > sevenDaysAgo);
    const recentBuyers  = [...new Set(recentSales.map(s => s.buyer).filter(Boolean))];
    const recentSellers = [...new Set(recentSales.map(s => s.seller).filter(Boolean))];

    // Wash trade detection: same wallet appears as both buyer and seller
    const buyerSet   = new Set(recentBuyers);
    const washTraders = recentSellers.filter(s => buyerSet.has(s));
    const washRisk: "low" | "medium" | "high" =
      washTraders.length > 3 ? "high" :
      washTraders.length > 1 ? "medium" : "low";

    // Holder trend: more unique buyers than sellers = growing
    const holderTrend: "growing" | "stable" | "declining" =
      recentBuyers.length > recentSellers.length * 1.2 ? "growing" :
      recentSellers.length > recentBuyers.length * 1.2 ? "declining" : "stable";

    // Avg hold estimation: rough proxy from sale frequency
    // If sales are infrequent, average hold time is longer
    const avgHoldDays = sales.length > 0
      ? Math.min(365, Math.round(30 / (sales.length / 30)))
      : 90;

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

  // Search collections by name
  async searchCollections(
    query: string,
    chain: string = "ethereum",
    limit: number = 5
  ): Promise<NFTCollection[]> {
    try {
      const base = this.getBaseUrl(chain);
      const url  = `${base}/search/collections/v2?name=${encodeURIComponent(query)}&limit=${limit}`;

      const res  = await fetch(url, {
        headers: this.headers(),
        signal:  AbortSignal.timeout(15000),
      });

      if (!res.ok) return [];

      const data    = await res.json() as any;
      const results = await Promise.allSettled(
        (data.collections || []).map((c: any) =>
          this.getCollection(c.primaryContract, chain)
        )
      );

      return results
        .filter(r => r.status === "fulfilled" && r.value !== null)
        .map(r => (r as PromiseFulfilledResult<NFTCollection>).value);

    } catch (err: any) {
      console.error(`Collection search failed for ${query}:`, err?.message);
      return [];
    }
  }

  // Check if floor has enough depth for safe entry
  hasFloorDepth(listings: NFTListing[], targetPrice: number, minListings: number = 5): boolean {
    const nearFloor = listings.filter(l => l.price <= targetPrice * 1.1);
    return nearFloor.length >= minListings;
  }

  // Format collection summary for KIRA's context
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

  // Get trending collections on a chain (by volume)
  async getTrendingCollections(
    chain:  string = "ethereum",
    limit:  number = 10
  ): Promise<NFTCollection[]> {
    try {
      const base = this.getBaseUrl(chain);
      const url  = `${base}/collections/v7?sortBy=1DayVolume&limit=${limit}&normalizeRoyalties=false`;

      const res  = await fetch(url, {
        headers: this.headers(),
        signal:  AbortSignal.timeout(15000),
      });

      if (!res.ok) return [];

      const data = await res.json() as any;
      return (data.collections || []).map((col: any) => ({
        address:        col.primaryContract?.toLowerCase() || "",
        name:           col.name || "Unknown",
        chain,
        floorPrice:     col.floorAsk?.price?.amount?.native || 0,
        floorPriceUsd:  col.floorAsk?.price?.amount?.usd    || 0,
        floor7dChange:  col.floorSaleChange?.["7day"]  || 0,
        floor30dChange: col.floorSaleChange?.["30day"] || 0,
        volume24h:      col.volume?.["1day"]  || 0,
        volume7d:       col.volume?.["7day"]  || 0,
        sales24h:       col.salesCount?.["1day"]  || 0,
        sales7d:        col.salesCount?.["7day"]  || 0,
        holderCount:    col.ownerCount || 0,
        totalSupply:    col.tokenCount || 0,
        listedCount:    col.onSaleCount || 0,
        listingRate:    col.tokenCount > 0
          ? (col.onSaleCount / col.tokenCount) * 100 : 0,
        topHolderPct:   0,
        fetchedAt:      Date.now(),
      }));

    } catch (err: any) {
      console.error(`Trending collections fetch failed:`, err?.message);
      return [];
    }
  }
}
