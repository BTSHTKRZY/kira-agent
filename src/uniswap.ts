// uniswap.ts — Token intelligence via Uniswap V3 subgraph + DexScreener
// Data gathering and learning — execution handled in execution.ts

import { kiraRedis } from "./redis.js";

export interface TokenIntelligence {
  address:      string;
  symbol:       string;
  chain:        string;
  priceUsd:     number;
  priceEth:     number;
  liquidity:    number;
  volume24h:    number;
  txCount24h:   number;
  holders?:     number;
  topPools:     PoolData[];
  priceChange1h: number;
  priceChange24h: number;
  fetchedAt:    number;
}

export interface PoolData {
  address:     string;
  fee:         number;       // fee tier e.g. 3000 = 0.3%
  token0:      string;
  token1:      string;
  tvlUsd:      number;
  volume24h:   number;
  feeTier:     string;
}

export interface UniswapSignal {
  type:        "liquidity_spike" | "volume_surge" | "new_pool" | "fee_tier_migration";
  tokenAddress: string;
  symbol:      string;
  chain:       string;
  description: string;
  magnitude:   number;      // % change
  timestamp:   number;
}

const UNISWAP_ETH_SUBGRAPH   = "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3";
const UNISWAP_BASE_SUBGRAPH  = "https://api.thegraph.com/subgraphs/name/messari/uniswap-v3-base";

const K = {
  token:   (chain: string, addr: string) => `kira:uni:token:${chain}:${addr.toLowerCase()}`,
  signals: ()                             => `kira:uni:signals`,
};

export class KiraUniswap {

  // ── TOKEN INTELLIGENCE ────────────────────────────────────────────────────────

  async getTokenIntelligence(
    tokenAddress: string,
    chain:        string = "ethereum"
  ): Promise<TokenIntelligence | null> {
    const cached = await kiraRedis.getJson<TokenIntelligence>(K.token(chain, tokenAddress));
    if (cached && Date.now() - cached.fetchedAt < 30 * 60 * 1000) return cached;

    try {
      // Use DexScreener as primary source (more reliable than subgraph)
      const chainSlug = chain === "base" ? "base" : "ethereum";
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return null;

      const data  = await res.json() as any;
      const pairs = (data.pairs || [])
        .filter((p: any) => p.chainId === chainSlug)
        .sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

      if (!pairs.length) return null;

      const primary  = pairs[0];
      const priceUsd = parseFloat(primary.priceUsd || "0");
      const priceEth = priceUsd / 2000; // rough conversion

      const intel: TokenIntelligence = {
        address:       tokenAddress.toLowerCase(),
        symbol:        primary.baseToken?.symbol || "UNKNOWN",
        chain,
        priceUsd,
        priceEth,
        liquidity:     primary.liquidity?.usd    || 0,
        volume24h:     primary.volume?.h24        || 0,
        txCount24h:    primary.txns?.h24?.buys + primary.txns?.h24?.sells || 0,
        priceChange1h: primary.priceChange?.h1    || 0,
        priceChange24h: primary.priceChange?.h24  || 0,
        topPools:      pairs.slice(0, 3).map((p: any) => ({
          address:  p.pairAddress || "",
          fee:      3000,
          token0:   p.baseToken?.address  || "",
          token1:   p.quoteToken?.address || "",
          tvlUsd:   p.liquidity?.usd      || 0,
          volume24h: p.volume?.h24        || 0,
          feeTier:  "0.3%",
        })),
        fetchedAt: Date.now(),
      };

      await kiraRedis.setJson(K.token(chain, tokenAddress), intel);
      return intel;

    } catch (err: any) {
      console.error(`[Uniswap] Token intel failed ${tokenAddress}:`, err?.message);
      return null;
    }
  }

  // ── SIGNAL DETECTION ──────────────────────────────────────────────────────────

  async detectSignals(
    tokenAddress: string,
    chain:        string
  ): Promise<UniswapSignal[]> {
    const signals: UniswapSignal[] = [];

    try {
      const current  = await this.getTokenIntelligence(tokenAddress, chain);
      if (!current) return signals;

      // Check against cached previous data
      const prevKey  = `kira:uni:prev:${chain}:${tokenAddress.toLowerCase()}`;
      const previous = await kiraRedis.getJson<TokenIntelligence>(prevKey);

      if (previous) {
        // Liquidity spike detection
        const liqChange = previous.liquidity > 0
          ? ((current.liquidity - previous.liquidity) / previous.liquidity) * 100
          : 0;

        if (liqChange > 50) {
          signals.push({
            type:         "liquidity_spike",
            tokenAddress,
            symbol:       current.symbol,
            chain,
            description:  `Liquidity up ${liqChange.toFixed(0)}% in last 30min`,
            magnitude:    liqChange,
            timestamp:    Date.now(),
          });
        }

        // Volume surge detection
        const volChange = previous.volume24h > 0
          ? ((current.volume24h - previous.volume24h) / previous.volume24h) * 100
          : 0;

        if (volChange > 100) {
          signals.push({
            type:         "volume_surge",
            tokenAddress,
            symbol:       current.symbol,
            chain,
            description:  `Volume up ${volChange.toFixed(0)}% — unusual activity`,
            magnitude:    volChange,
            timestamp:    Date.now(),
          });
        }
      }

      // Store current as previous for next check
      await kiraRedis.setJson(prevKey, current);

    } catch (err: any) {
      console.error(`[Uniswap] Signal detection failed:`, err?.message);
    }

    return signals;
  }

  // ── TRENDING TOKENS ───────────────────────────────────────────────────────────

  async getTrendingTokens(chain: string = "ethereum"): Promise<TokenIntelligence[]> {
    try {
      const chainSlug = chain === "base" ? "base" : "ethereum";
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/trending?chain=${chainSlug}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return [];

      const data   = await res.json() as any;
      const tokens = (data.pairs || [])
        .filter((p: any) => p.chainId === chainSlug)
        .slice(0, 10);

      const result: TokenIntelligence[] = [];
      for (const p of tokens) {
        const addr = p.baseToken?.address;
        if (!addr) continue;
        const intel = await this.getTokenIntelligence(addr, chain);
        if (intel) result.push(intel);
      }
      return result;

    } catch (err: any) {
      console.error(`[Uniswap] Trending tokens failed:`, err?.message);
      return [];
    }
  }

  // ── SWAP QUOTE ────────────────────────────────────────────────────────────────
  // Get a quote for how much ETH we'd need/receive — data only, no execution

  async getSwapQuote(
    tokenAddress: string,
    chain:        string,
    amountEth:    number,
    direction:    "buy" | "sell"
  ): Promise<{ expectedTokens?: number; expectedEth?: number; priceImpact: number } | null> {
    try {
      const chainId = chain === "base" ? "8453" : "1";
      const amount  = Math.floor(amountEth * 1e18);

      const url = direction === "buy"
        ? `https://api.0x.org/swap/v1/price?buyToken=${tokenAddress}&sellToken=ETH&sellAmount=${amount}&chainId=${chainId}`
        : `https://api.0x.org/swap/v1/price?buyToken=ETH&sellToken=${tokenAddress}&sellAmount=${amount}&chainId=${chainId}`;

      const res = await fetch(url, {
        headers: { "0x-api-key": process.env.ZEROX_API_KEY || "" },
        signal:  AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;

      const data = await res.json() as any;
      return {
        expectedTokens: direction === "buy"  ? parseFloat(data.buyAmount || "0") : undefined,
        expectedEth:    direction === "sell" ? parseFloat(data.buyAmount || "0") / 1e18 : undefined,
        priceImpact:    parseFloat(data.estimatedPriceImpact || "0"),
      };

    } catch (err: any) {
      console.error("[Uniswap] Quote failed:", err?.message);
      return null;
    }
  }

  formatForContext(intel: TokenIntelligence): string {
    return [
      `${intel.symbol} (${intel.chain})`,
      `$${intel.priceUsd.toFixed(6)}`,
      `Liq: $${(intel.liquidity / 1000).toFixed(0)}k`,
      `Vol: $${(intel.volume24h / 1000).toFixed(0)}k`,
      `1h: ${intel.priceChange1h > 0 ? "+" : ""}${intel.priceChange1h.toFixed(1)}%`,
    ].join(" | ");
  }
}
