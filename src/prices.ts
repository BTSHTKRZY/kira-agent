// prices.ts — Token price feeds via DexScreener (free, no API key)
// Covers ETH, Base, Arbitrum and any EVM chain DexScreener indexes

export interface TokenPrice {
  address:       string;
  symbol:        string;
  chain:         string;
  priceUsd:      number;
  priceNative:   number;
  change1h:      number;
  change6h:      number;
  change24h:     number;
  volume24h:     number;
  liquidity:     number;
  fdv:           number;
  pairAddress:   string;
  dexId:         string;
  fetchedAt:     number;
}

const CHAIN_MAP: Record<string, string> = {
  ethereum:  "ethereum",
  base:      "base",
  arbitrum:  "arbitrum",
  polygon:   "polygon",
  optimism:  "optimism",
};

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const priceCache: Map<string, TokenPrice> = new Map();
const CACHE_TTL = 2 * 60 * 1000;

export class KiraPrices {

  async getTokenPrice(
    tokenAddress: string,
    chain: string = "base"
  ): Promise<TokenPrice | null> {
    const cacheKey = `${chain}:${tokenAddress.toLowerCase()}`;
    const cached   = priceCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached;

    try {
      const chainId = CHAIN_MAP[chain] || chain;
      const res     = await fetch(
        `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenAddress}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return null;

      const data  = await res.json() as any;
      const pairs = (data.pairs || []).filter((p: any) => p.chainId === chainId);
      if (!pairs.length) return null;

      const best = pairs.sort(
        (a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      )[0];

      const price: TokenPrice = {
        address:     tokenAddress.toLowerCase(),
        symbol:      best.baseToken?.symbol || "UNKNOWN",
        chain,
        priceUsd:    parseFloat(best.priceUsd    || "0"),
        priceNative: parseFloat(best.priceNative || "0"),
        change1h:    best.priceChange?.h1  || 0,
        change6h:    best.priceChange?.h6  || 0,
        change24h:   best.priceChange?.h24 || 0,
        volume24h:   best.volume?.h24      || 0,
        liquidity:   best.liquidity?.usd   || 0,
        fdv:         best.fdv              || 0,
        pairAddress: best.pairAddress      || "",
        dexId:       best.dexId            || "",
        fetchedAt:   Date.now(),
      };

      priceCache.set(cacheKey, price);
      return price;

    } catch (err: any) {
      console.error(`Price fetch failed for ${tokenAddress}:`, err?.message);
      return null;
    }
  }

  async searchToken(
    symbol: string,
    chain:  string = "base"
  ): Promise<TokenPrice | null> {
    try {
      const chainId = CHAIN_MAP[chain] || chain;
      const res     = await fetch(
        `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(symbol)}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return null;

      const data  = await res.json() as any;
      const pairs = (data.pairs || []).filter(
        (p: any) =>
          p.chainId === chainId &&
          p.baseToken?.symbol?.toUpperCase() === symbol.toUpperCase()
      );
      if (!pairs.length) return null;

      const best = pairs.sort(
        (a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      )[0];

      return {
        address:     best.baseToken?.address?.toLowerCase() || "",
        symbol:      best.baseToken?.symbol || symbol,
        chain,
        priceUsd:    parseFloat(best.priceUsd    || "0"),
        priceNative: parseFloat(best.priceNative || "0"),
        change1h:    best.priceChange?.h1  || 0,
        change6h:    best.priceChange?.h6  || 0,
        change24h:   best.priceChange?.h24 || 0,
        volume24h:   best.volume?.h24      || 0,
        liquidity:   best.liquidity?.usd   || 0,
        fdv:         best.fdv              || 0,
        pairAddress: best.pairAddress      || "",
        dexId:       best.dexId            || "",
        fetchedAt:   Date.now(),
      };

    } catch (err: any) {
      console.error(`Token search failed for ${symbol}:`, err?.message);
      return null;
    }
  }

  async getMultiplePrices(
    tokens: Array<{ address: string; chain: string }>
  ): Promise<TokenPrice[]> {
    const results = await Promise.allSettled(
      tokens.map(t => this.getTokenPrice(t.address, t.chain))
    );
    return results
      .filter(r => r.status === "fulfilled" && r.value !== null)
      .map(r => (r as PromiseFulfilledResult<TokenPrice>).value);
  }

  hasEnoughLiquidity(price: TokenPrice, tradeAmountEth: number = 0.005): boolean {
    const ethPriceUsd    = price.priceUsd / price.priceNative;
    const tradeAmountUsd = tradeAmountEth * ethPriceUsd;
    return price.liquidity > tradeAmountUsd * 20;
  }

  getMomentumSignal(price: TokenPrice): "strong_up" | "up" | "neutral" | "down" | "strong_down" {
    const { change1h, change6h, change24h } = price;
    if (change1h > 5  && change6h > 10 && change24h > 20) return "strong_up";
    if (change1h > 2  && change6h > 5)                    return "up";
    if (change1h < -5 && change6h < -10)                  return "strong_down";
    if (change1h < -2 && change6h < -5)                   return "down";
    return "neutral";
  }

  formatForContext(price: TokenPrice): string {
    return [
      `${price.symbol} (${price.chain}):`,
      `$${price.priceUsd.toFixed(6)}`,
      `1h: ${price.change1h > 0 ? "+" : ""}${price.change1h.toFixed(1)}%`,
      `24h: ${price.change24h > 0 ? "+" : ""}${price.change24h.toFixed(1)}%`,
      `Vol: $${(price.volume24h / 1000).toFixed(1)}k`,
      `Liq: $${(price.liquidity / 1000).toFixed(1)}k`,
      `Signal: ${this.getMomentumSignal(price)}`,
    ].join(" | ");
  }

  async getEthPrice(): Promise<number> {
    try {
      const res  = await fetch(
        "https://api.dexscreener.com/latest/dex/search?q=WETH",
        { signal: AbortSignal.timeout(10000) }
      );
      const data = await res.json() as any;
      const pair = (data.pairs || []).find(
        (p: any) => p.chainId === "ethereum" && p.baseToken?.symbol === "WETH"
      );
      return pair ? parseFloat(pair.priceUsd || "0") : 0;
    } catch {
      return 0;
    }
  }
}
