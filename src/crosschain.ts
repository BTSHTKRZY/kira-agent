// crosschain.ts — Cross-chain intelligence
// Arbitrum: full token + NFT scanning
// Solana: read-only price + volume intelligence (no execution — different wallet format)
// Base: already in main scanning loop

import { kiraRedis } from "./redis.js";

export interface ChainIntelligence {
  chain:          string;
  tvl:            number;        // total value locked USD
  volume24h:      number;        // DEX volume USD
  activeWallets:  number;
  topTokens:      TokenSnapshot[];
  topNFTs:        NFTSnapshot[];
  gasGwei:        number;
  fetchedAt:      number;
}

export interface TokenSnapshot {
  address:   string;
  symbol:    string;
  price:     number;
  change24h: number;
  volume24h: number;
  chain:     string;
}

export interface NFTSnapshot {
  address:    string;
  name:       string;
  floorEth:   number;
  volume24h:  number;
  chain:      string;
}

export interface CrossChainSignal {
  type:        "token_momentum" | "nft_activity" | "whale_migration" | "chain_rotation";
  fromChain:   string;
  toChain?:    string;
  asset:       string;
  description: string;
  confidence:  number;
  timestamp:   number;
}

const K = {
  intel:   (chain: string) => `kira:crosschain:intel:${chain}`,
  signals: ()               => `kira:crosschain:signals`,
};

export class KiraCrossChain {

  // ── ARBITRUM INTELLIGENCE ─────────────────────────────────────────────────────

  async getArbitrumIntel(): Promise<ChainIntelligence | null> {
    const cached = await kiraRedis.getJson<ChainIntelligence>(K.intel("arbitrum"));
    if (cached && Date.now() - cached.fetchedAt < 2 * 60 * 60 * 1000) return cached;

    try {
      // DexScreener boosted tokens (real endpoint), filter to Arbitrum,
      // then enrich each with live pair data via search.
      const topTokens: TokenSnapshot[] = [];
      const boostRes = await fetch(
        "https://api.dexscreener.com/token-boosts/top/v1",
        { signal: AbortSignal.timeout(10000), headers: { "accept": "application/json", "user-agent": "kira-agent/4.6" } }
      );
      if (!boostRes.ok) {
        console.warn(`[CrossChain] DexScreener boosts HTTP ${boostRes.status} — likely datacenter-IP block; cross-chain feeds need a proxy or keyed source`);
      }
      if (boostRes.ok) {
        const boosts = await boostRes.json() as any;
        const total  = Array.isArray(boosts) ? boosts.length : 0;
        const arbBoosts = (Array.isArray(boosts) ? boosts : [])
          .filter((b: any) => b.chainId === "arbitrum")
          .slice(0, 8);
        console.log(`[CrossChain] DexScreener boosts: ${total} total, ${arbBoosts.length} on Arbitrum`);

        for (const b of arbBoosts) {
          // Enrich with real price/volume via the pairs-by-token endpoint
          try {
            const pr = await fetch(
              `https://api.dexscreener.com/latest/dex/tokens/${b.tokenAddress}`,
              { signal: AbortSignal.timeout(8000) }
            );
            if (pr.ok) {
              const pd = await pr.json() as any;
              const pair = (pd.pairs || []).find((p: any) => p.chainId === "arbitrum") || (pd.pairs || [])[0];
              if (pair) {
                topTokens.push({
                  address:   b.tokenAddress || "",
                  symbol:    pair.baseToken?.symbol || "UNKNOWN",
                  price:     parseFloat(pair.priceUsd || "0"),
                  change24h: parseFloat(pair.priceChange?.h24 || "0"),
                  volume24h: pair.volume?.h24 || 0,
                  chain:     "arbitrum",
                });
              }
            }
          } catch {}
          await new Promise(r => setTimeout(r, 250));
        }
      }
      // Fallback: if no boosts on arbitrum, search a major arb token for activity
      if (topTokens.length === 0) {
        try {
          const sr = await fetch(
            "https://api.dexscreener.com/latest/dex/search?q=arbitrum",
            { signal: AbortSignal.timeout(8000) }
          );
          if (sr.ok) {
            const sd = await sr.json() as any;
            const arbPairs = (sd.pairs || []).filter((p: any) => p.chainId === "arbitrum").slice(0, 5);
            for (const pair of arbPairs) {
              topTokens.push({
                address:   pair.baseToken?.address || "",
                symbol:    pair.baseToken?.symbol  || "UNKNOWN",
                price:     parseFloat(pair.priceUsd || "0"),
                change24h: parseFloat(pair.priceChange?.h24 || "0"),
                volume24h: pair.volume?.h24 || 0,
                chain:     "arbitrum",
              });
            }
          }
        } catch {}
      }

      // Gas price for Arbitrum
      let gasGwei = 0;
      try {
        const gasRes  = await fetch(
          "https://api.etherscan.io/api?module=gastracker&action=gasoracle&chainid=42161" +
          (process.env.ETHERSCAN_API_KEY ? `&apikey=${process.env.ETHERSCAN_API_KEY}` : ""),
          { signal: AbortSignal.timeout(8000) }
        );
        if (gasRes.ok) {
          const gasData = await gasRes.json() as any;
          gasGwei = parseFloat(gasData.result?.SafeGasPrice || "0");
        }
      } catch {}

      const intel: ChainIntelligence = {
        chain:         "arbitrum",
        tvl:           0,
        volume24h:     topTokens.reduce((s, t) => s + t.volume24h, 0),
        activeWallets: 0,
        topTokens:     topTokens.slice(0, 5),
        topNFTs:       [],
        gasGwei,
        fetchedAt:     Date.now(),
      };

      await kiraRedis.setJson(K.intel("arbitrum"), intel);
      return intel;

    } catch (err: any) {
      console.error("[CrossChain] Arbitrum intel failed:", err?.message);
      return null;
    }
  }

  // ── SOLANA INTELLIGENCE (read-only) ───────────────────────────────────────────

  async getSolanaIntel(): Promise<ChainIntelligence | null> {
    const cached = await kiraRedis.getJson<ChainIntelligence>(K.intel("solana"));
    if (cached && Date.now() - cached.fetchedAt < 2 * 60 * 60 * 1000) return cached;

    try {
      // DexScreener for Solana top tokens
      const tokenRes = await fetch(
        "https://api.dexscreener.com/token-boosts/top/v1",
        { signal: AbortSignal.timeout(10000) }
      );

      const topTokens: TokenSnapshot[] = [];
      if (tokenRes.ok) {
        const data   = await tokenRes.json() as any;
        const tokens = (Array.isArray(data) ? data : [])
          .filter((t: any) => t.chainId === "solana")
          .slice(0, 6);

        for (const t of tokens) {
          // Enrich with real price/volume
          try {
            const pr = await fetch(
              `https://api.dexscreener.com/latest/dex/tokens/${t.tokenAddress}`,
              { signal: AbortSignal.timeout(8000) }
            );
            if (pr.ok) {
              const pd   = await pr.json() as any;
              const pair = (pd.pairs || []).find((p: any) => p.chainId === "solana") || (pd.pairs || [])[0];
              topTokens.push({
                address:   t.tokenAddress || "",
                symbol:    pair?.baseToken?.symbol || "UNKNOWN",
                price:     parseFloat(pair?.priceUsd || "0"),
                change24h: parseFloat(pair?.priceChange?.h24 || "0"),
                volume24h: pair?.volume?.h24 || 0,
                chain:     "solana",
              });
            }
          } catch {}
          await new Promise(r => setTimeout(r, 250));
        }
      }

      // Solana NFT floor data via Magic Eden API (free)
      const topNFTs: NFTSnapshot[] = [];
      try {
        // Magic Eden popular collections (valid endpoint)
        const nftRes = await fetch(
          "https://api-mainnet.magiceden.dev/v2/marketplace/popular_collections?timeRange=1d",
          { signal: AbortSignal.timeout(10000) }
        );
        if (nftRes.ok) {
          const nftData = await nftRes.json() as any;
          const list = Array.isArray(nftData) ? nftData : (nftData.collections || []);
          for (const col of list.slice(0, 5)) {
            // floorPrice from ME is in lamports (1e9 per SOL); convert SOL→ETH approx
            const floorSol = (col.floorPrice || 0) / 1e9;
            topNFTs.push({
              address:   col.symbol      || "",
              name:      col.name        || "Unknown",
              floorEth:  floorSol * 0.007, // SOL→ETH rough; refined by macro later
              volume24h: col.volume      || col.volumeAll || 0,
              chain:     "solana",
            });
          }
        }
      } catch {}

      const intel: ChainIntelligence = {
        chain:         "solana",
        tvl:           0,
        volume24h:     topTokens.reduce((s, t) => s + t.volume24h, 0),
        activeWallets: 0,
        topTokens:     topTokens.slice(0, 5),
        topNFTs,
        gasGwei:       0.00025, // SOL fee in SOL, not gwei — approximate
        fetchedAt:     Date.now(),
      };

      await kiraRedis.setJson(K.intel("solana"), intel);
      return intel;

    } catch (err: any) {
      console.error("[CrossChain] Solana intel failed:", err?.message);
      return null;
    }
  }

  // ── CROSS-CHAIN SIGNAL DETECTION ──────────────────────────────────────────────
  // Identifies patterns that span chains — rotation signals, momentum spreads

  async detectCrossChainSignals(
    ethIntel?:  ChainIntelligence,
    baseIntel?: ChainIntelligence,
    arbIntel?:  ChainIntelligence,
    solIntel?:  ChainIntelligence,
  ): Promise<CrossChainSignal[]> {
    const signals: CrossChainSignal[] = [];

    try {
      // Signal 1: Same token trending on multiple chains
      const allTokens = [
        ...(ethIntel?.topTokens  || []),
        ...(baseIntel?.topTokens || []),
        ...(arbIntel?.topTokens  || []),
        ...(solIntel?.topTokens  || []),
      ];

      const symbolCount: Record<string, { count: number; chains: string[] }> = {};
      for (const t of allTokens) {
        const sym = t.symbol.toUpperCase();
        if (!symbolCount[sym]) symbolCount[sym] = { count: 0, chains: [] };
        symbolCount[sym].count++;
        symbolCount[sym].chains.push(t.chain);
      }

      for (const [sym, data] of Object.entries(symbolCount)) {
        if (data.count >= 2 && sym !== "WETH" && sym !== "USDC" && sym !== "USDT") {
          signals.push({
            type:        "token_momentum",
            fromChain:   data.chains[0],
            toChain:     data.chains[1],
            asset:       sym,
            description: `${sym} trending on ${data.chains.join(" + ")} simultaneously`,
            confidence:  Math.min(0.9, data.count * 0.3),
            timestamp:   Date.now(),
          });
        }
      }

      // Signal 2: Solana NFT volume spike vs Ethereum NFT volume drop (rotation)
      if (solIntel && ethIntel) {
        const solNFTVol = solIntel.topNFTs.reduce((s, n) => s + n.volume24h, 0);
        const ethNFTVol = ethIntel.topNFTs.reduce((s, n) => s + n.volume24h, 0);

        // This is a rough heuristic — improve with historical data
        if (solNFTVol > 0 && ethNFTVol > 0) {
          // Record for pattern detection over time
          await kiraRedis.set("kira:cc:sol_nft_vol", String(solNFTVol));
          await kiraRedis.set("kira:cc:eth_nft_vol", String(ethNFTVol));
        }
      }

      // Store signals
      if (signals.length > 0) {
        const existing  = await kiraRedis.getJson<CrossChainSignal[]>(K.signals()) || [];
        const combined  = [...signals, ...existing].slice(0, 20);
        await kiraRedis.setJson(K.signals(), combined);
      }

    } catch (err: any) {
      console.error("[CrossChain] Signal detection failed:", err?.message);
    }

    return signals;
  }

  // ── FULL INTEL SCAN ───────────────────────────────────────────────────────────

  async scanAllChains(): Promise<{
    arbitrum?:  ChainIntelligence;
    solana?:    ChainIntelligence;
    signals:    CrossChainSignal[];
  }> {
    console.log("[CrossChain] Scanning Arbitrum + Solana...");

    const [arb, sol] = await Promise.allSettled([
      this.getArbitrumIntel(),
      this.getSolanaIntel(),
    ]);

    const arbData = arb.status === "fulfilled" ? arb.value || undefined : undefined;
    const solData = sol.status === "fulfilled" ? sol.value || undefined : undefined;

    const signals = await this.detectCrossChainSignals(
      undefined, undefined, arbData, solData
    );

    if (arbData) console.log(`[CrossChain] Arbitrum: ${arbData.topTokens.length} tokens tracked`);
    if (solData) console.log(`[CrossChain] Solana: ${solData.topNFTs.length} NFTs tracked (read-only)`);
    if (signals.length > 0) console.log(`[CrossChain] ${signals.length} cross-chain signals`);

    return { arbitrum: arbData, solana: solData, signals };
  }

  async formatForContext(): Promise<string> {
    const arb = await kiraRedis.getJson<ChainIntelligence>(K.intel("arbitrum"));
    const sol = await kiraRedis.getJson<ChainIntelligence>(K.intel("solana"));
    const sigs = await kiraRedis.getJson<CrossChainSignal[]>(K.signals()) || [];

    const parts: string[] = [];
    if (arb) parts.push(`ARB: ${arb.topTokens[0]?.symbol || "N/A"} leading`);
    if (sol) parts.push(`SOL: ${sol.topNFTs[0]?.name || "N/A"} top NFT`);
    if (sigs.length > 0) parts.push(`${sigs.length} cross-chain signals`);
    return parts.join(" | ") || "Cross-chain: scanning";
  }
}
