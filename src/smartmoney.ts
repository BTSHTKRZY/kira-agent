// smartmoney.ts — Smart Money Tracker
// Sources:
// 1. Seeded public known wallets (VCs, known traders, whales)
// 2. AgentCheck high-rated wallets
// 3. Recent NFT buyers from collections KIRA watches
// 4. CoinGecko on-chain top traders (free)
// 5. Self-learned wallets proven to be early buyers
// Primary chain: Ethereum. Secondary: Base, Arbitrum.

import { kiraRedis } from "./redis.js";

// ── TYPES ──────────────────────────────────────────────────────────────────────

export type WalletSource =
  | "agentcheck_verified"
  | "known_vc"
  | "known_whale"
  | "known_trader"
  | "normies_holder"
  | "nft_buyer"
  | "coingecko_top_trader"
  | "self_learned"
  | "manual_seed";

export interface SmartWallet {
  address:   string;
  source:    WalletSource;
  label?:    string;        // e.g. "Paradigm", "a16z", "Vitalik"
  rating?:   string;        // AgentCheck rating
  addedAt:   number;
  lastSeen:  number;
  buyCount:  number;
  winCount:  number;        // buys that preceded recoveries
  tags:      string[];
}

export interface WalletActivity {
  wallet:       string;
  assetType:    "token" | "nft";
  assetAddress: string;
  assetName:    string;
  chain:        string;
  action:       "buy" | "sell";
  amountEth:    number;
  timestamp:    number;
  txHash?:      string;
}

export interface SmartMoneySignal {
  assetAddress:   string;
  assetName:      string;
  chain:          string;
  assetType:      "token" | "nft";
  buyerCount:     number;
  totalVolumeEth: number;
  buyers:         string[];
  sources:        WalletSource[];
  confidence:     number;
  firstSeen:      number;
  lastSeen:       number;
}

// Redis keys
const K = {
  wallet:   (a: string)  => `kira:sm:wallet:${a.toLowerCase()}`,
  wallets:  ()           => `kira:sm:wallets`,
  signal:   (k: string)  => `kira:sm:signal:${k.toLowerCase()}`,
  signals:  ()           => `kira:sm:signals`,
  lastScan: ()           => `kira:sm:lastscan`,
};

// Etherscan endpoints
const ETHERSCAN_BASE = "https://api.etherscan.io/api";
const BASESCAN_BASE  = "https://api.basescan.org/api";
const ETHERSCAN_KEY  = process.env.ETHERSCAN_API_KEY || "";
const BASESCAN_KEY   = process.env.BASESCAN_API_KEY  || "";

// ── SEED WALLET LIST ──────────────────────────────────────────────────────────
// Publicly known wallets from on-chain research and public disclosures

const SEED_WALLETS: Array<{
  address: string;
  source:  WalletSource;
  label:   string;
  tags:    string[];
}> = [
  // Normies ecosystem
  { address: "0x6f33e7b6460daC803c53ab6e02da8C675633d516", source: "normies_holder",  label: "KIRA Holder",      tags: ["normies", "holder"] },

  // Known public figures / VCs
  { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", source: "known_whale",    label: "Vitalik Buterin",  tags: ["founder", "ethereum"] },
  { address: "0x293Ed38530005620e4B28600f196a97E1125dAAc", source: "known_whale",    label: "Mark Cuban",       tags: ["investor"] },
  { address: "0xbcd5000f5c522856e710c5d274bb672b2f2eefbf", source: "known_vc",       label: "Polychain Capital", tags: ["vc", "fund"] },
  { address: "0xf584F8728B874a6a5c7A8d4d387C9aae9172D62",  source: "known_vc",       label: "Jump Trading",     tags: ["trading_firm"] },

  // Known NFT collectors/whales (publicly identified)
  { address: "0x54be3a794282c030b15e43ae2bb182e14c2f2033", source: "known_whale",    label: "Pranksy",          tags: ["nft_whale", "early_collector"] },
  { address: "0xc6400a5584db71e41b0e5dfbdc769b54b7a74a65", source: "known_whale",    label: "WhaleShark",       tags: ["nft_whale", "collector"] },
  { address: "0x9c5083dd4838e120dbeac44c052179692aa5dac5", source: "known_whale",    label: "Punk6529",         tags: ["nft_whale", "memes"] },
  { address: "0x020ca66c30bec2c4fe3861a94e4db4a498a35872", source: "known_whale",    label: "3AC Kyle",         tags: ["nft_whale"] },
  { address: "0xb932a70a57673d89f4acffbe830e8ed7f75fb9e0", source: "known_whale",    label: "SuperRare",        tags: ["nft_platform"] },

  // Known DeFi smart traders (publicly identified via on-chain analysis)
  { address: "0xa9c2b639a28cdb5c63a13a3e3c4a0c70c3fc3e93", source: "known_trader",   label: "DeFi Whale 1",    tags: ["defi", "trader"] },
  { address: "0x5d752f322befb038991579972e912b02425ab374", source: "known_trader",   label: "NFT Trader Alpha", tags: ["nft", "trader"] },

  // Known VC/Fund wallets
  { address: "0x0716a17fbaee714f1e6ab0f9d59edbc5f09815c0", source: "known_vc",       label: "a16z crypto",      tags: ["vc", "fund"] },
  { address: "0x66B870dDf78c975af5Cd8EDC6De25eca81791DE1", source: "known_vc",       label: "Paradigm",         tags: ["vc", "fund"] },
  { address: "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be", source: "known_vc",       label: "Binance Hot",      tags: ["exchange"] },
];

// ── SMART MONEY CLASS ─────────────────────────────────────────────────────────

export class KiraSmartMoney {

  // ── WALLET MANAGEMENT ────────────────────────────────────────────────────────

  async addWallet(
    address: string,
    source:  WalletSource,
    label?:  string,
    rating?: string,
    tags:    string[] = []
  ): Promise<void> {
    if (!address || address.length < 10) return;
    const addr = address.toLowerCase();

    const existing = await kiraRedis.getJson<SmartWallet>(K.wallet(addr));
    if (existing) {
      existing.lastSeen = Date.now();
      if (label)  existing.label  = label;
      if (rating) existing.rating = rating;
      existing.tags = [...new Set([...existing.tags, ...tags])];
      await kiraRedis.setJson(K.wallet(addr), existing);
      return;
    }

    const wallet: SmartWallet = {
      address:  addr,
      source,
      label,
      rating,
      addedAt:  Date.now(),
      lastSeen: Date.now(),
      buyCount: 0,
      winCount: 0,
      tags,
    };

    await kiraRedis.setJson(K.wallet(addr), wallet);
    await kiraRedis.sadd(K.wallets(), addr);
    console.log(`[SmartMoney] Added: ${label || addr.slice(0, 10)} (${source})`);
  }

  async getWallet(address: string): Promise<SmartWallet | null> {
    return kiraRedis.getJson<SmartWallet>(K.wallet(address.toLowerCase()));
  }

  async getAllWallets(): Promise<SmartWallet[]> {
    const addrs   = await kiraRedis.smembers(K.wallets());
    const wallets = await Promise.all(addrs.map(a => this.getWallet(a)));
    return wallets.filter(Boolean) as SmartWallet[];
  }

  async getWalletAddresses(): Promise<string[]> {
    return kiraRedis.smembers(K.wallets());
  }

  // ── SEEDING ──────────────────────────────────────────────────────────────────

  async seedWallets(): Promise<void> {
    let seeded = 0;
    for (const w of SEED_WALLETS) {
      const existing = await this.getWallet(w.address);
      if (!existing) {
        await this.addWallet(w.address, w.source, w.label, undefined, w.tags);
        seeded++;
      }
    }
    if (seeded > 0) console.log(`[SmartMoney] Seeded ${seeded} wallets`);
  }

  // ── AGENTCHECK INGEST ────────────────────────────────────────────────────────

  async ingestFromAgentCheck(
    agentcheckUrl: string = "https://agentcheck-bice.vercel.app"
  ): Promise<number> {
    try {
      const res = await fetch(`${agentcheckUrl}/api/checks?limit=100`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return 0;

      const data   = await res.json() as any;
      const checks = data.checks || data.results || [];
      let added    = 0;

      for (const check of checks) {
        const address = check.wallet || check.address;
        const rating  = String(check.rating || check.score || "");
        if (!address || !rating) continue;

        const score      = parseInt(rating) || 0;
        const isHighRated = score >= 70 ||
          rating.startsWith("AA") || rating === "AAA";

        if (isHighRated) {
          await this.addWallet(
            address, "agentcheck_verified",
            `AgentCheck ${rating}`, rating, ["high_trust"]
          );
          added++;
        }
      }

      if (added > 0) console.log(`[SmartMoney] AgentCheck: ${added} high-rated wallets`);
      return added;

    } catch (err: any) {
      console.error("[SmartMoney] AgentCheck ingest failed:", err?.message);
      return 0;
    }
  }

  // ── COINGECKO TOP TRADERS ────────────────────────────────────────────────────

  async ingestFromCoinGecko(tokenAddress: string, chain: string = "eth"): Promise<number> {
    try {
      // CoinGecko on-chain top traders endpoint (free)
      const chainId = chain === "ethereum" ? "eth" :
                      chain === "base"     ? "base" :
                      chain === "arbitrum" ? "arbitrum" : "eth";

      const res = await fetch(
        `https://api.coingecko.com/api/v3/onchain/networks/${chainId}/tokens/${tokenAddress}/top_traders?time_period=day`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return 0;

      const data    = await res.json() as any;
      const traders = data.data || [];
      let added     = 0;

      for (const trader of traders.slice(0, 20)) {
        const address = trader.attributes?.address;
        if (!address) continue;

        await this.addWallet(
          address, "coingecko_top_trader",
          `CoinGecko Top Trader`, undefined,
          ["top_trader", chain]
        );
        added++;
      }

      return added;

    } catch (err: any) {
      console.error("[SmartMoney] CoinGecko ingest failed:", err?.message);
      return 0;
    }
  }

  // ── NFT BUYER INGEST ─────────────────────────────────────────────────────────

  async ingestFromNFTSales(buyers: string[], collectionName: string): Promise<void> {
    for (const buyer of buyers.slice(0, 30)) {
      if (!buyer || buyer.length < 10) continue;
      const existing = await this.getWallet(buyer);
      if (!existing) {
        await this.addWallet(
          buyer, "nft_buyer", undefined, undefined,
          [`bought_${collectionName.replace(/\s+/g, "_").slice(0, 15)}`]
        );
      }
    }
  }

  // ── ON-CHAIN ACTIVITY ────────────────────────────────────────────────────────

  async getRecentTokenActivity(
    wallet: string,
    chain:  string = "ethereum"
  ): Promise<WalletActivity[]> {
    try {
      const baseUrl = chain === "base" ? BASESCAN_BASE : ETHERSCAN_BASE;
      const apiKey  = chain === "base" ? BASESCAN_KEY  : ETHERSCAN_KEY;

      const url = `${baseUrl}?module=account&action=tokentx` +
        `&address=${wallet}&sort=desc&offset=50&page=1` +
        (apiKey ? `&apikey=${apiKey}` : "");

      const res  = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) return [];

      const data = await res.json() as any;
      if (data.status !== "1" || !Array.isArray(data.result)) return [];

      const cutoff = Date.now() / 1000 - 7 * 24 * 3600;

      return data.result
        .filter((tx: any) => parseInt(tx.timeStamp) > cutoff)
        .map((tx: any) => ({
          wallet:       wallet.toLowerCase(),
          assetType:    "token" as const,
          assetAddress: (tx.contractAddress || "").toLowerCase(),
          assetName:    tx.tokenSymbol || "UNKNOWN",
          chain,
          action:       tx.to?.toLowerCase() === wallet.toLowerCase() ? "buy" : "sell",
          amountEth:    parseFloat(tx.value || "0") /
                        Math.pow(10, parseInt(tx.tokenDecimal || "18")),
          timestamp:    parseInt(tx.timeStamp) * 1000,
          txHash:       tx.hash,
        }));

    } catch (err: any) {
      console.error(`[SmartMoney] Token activity error ${wallet.slice(0, 8)}:`, err?.message);
      return [];
    }
  }

  async getRecentNFTActivity(
    wallet: string,
    chain:  string = "ethereum"
  ): Promise<WalletActivity[]> {
    try {
      const baseUrl = chain === "base" ? BASESCAN_BASE : ETHERSCAN_BASE;
      const apiKey  = chain === "base" ? BASESCAN_KEY  : ETHERSCAN_KEY;

      const url = `${baseUrl}?module=account&action=tokennfttx` +
        `&address=${wallet}&sort=desc&offset=50&page=1` +
        (apiKey ? `&apikey=${apiKey}` : "");

      const res  = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) return [];

      const data = await res.json() as any;
      if (data.status !== "1" || !Array.isArray(data.result)) return [];

      const cutoff = Date.now() / 1000 - 7 * 24 * 3600;

      return data.result
        .filter((tx: any) => parseInt(tx.timeStamp) > cutoff)
        .map((tx: any) => ({
          wallet:       wallet.toLowerCase(),
          assetType:    "nft" as const,
          assetAddress: (tx.contractAddress || "").toLowerCase(),
          assetName:    tx.tokenName || "Unknown NFT",
          chain,
          action:       tx.to?.toLowerCase() === wallet.toLowerCase() ? "buy" : "sell",
          amountEth:    0,
          timestamp:    parseInt(tx.timeStamp) * 1000,
          txHash:       tx.hash,
        }));

    } catch (err: any) {
      console.error(`[SmartMoney] NFT activity error ${wallet.slice(0, 8)}:`, err?.message);
      return [];
    }
  }

  // ── SIGNAL GENERATION ────────────────────────────────────────────────────────

  async scanForSignals(): Promise<SmartMoneySignal[]> {
    const wallets = await this.getAllWallets();
    if (!wallets.length) return [];

    console.log(`[SmartMoney] Scanning ${Math.min(wallets.length, 30)} wallets...`);

    // Prioritise: agentcheck_verified > known_vc > known_whale > known_trader > others
    const priorityOrder: WalletSource[] = [
      "agentcheck_verified", "known_vc", "known_whale",
      "known_trader", "normies_holder", "coingecko_top_trader",
      "nft_buyer", "self_learned", "manual_seed",
    ];

    const sorted = wallets.sort((a, b) => {
      const ai = priorityOrder.indexOf(a.source);
      const bi = priorityOrder.indexOf(b.source);
      return ai - bi;
    });

    const toScan = sorted.slice(0, 30);

    // Accumulate activity by asset
    const assetMap: Map<string, {
      buyers:    Set<string>;
      sources:   Set<WalletSource>;
      volume:    number;
      firstSeen: number;
      lastSeen:  number;
      name:      string;
      chain:     string;
      type:      "token" | "nft";
    }> = new Map();

    for (const wallet of toScan) {
      // Primary: Ethereum (tokens + NFTs)
      // Secondary: Base (tokens only)
      const chains = wallet.tags.includes("normies_holder")
        ? ["base", "ethereum"]
        : ["ethereum"];

      for (const chain of chains) {
        const [tokenActs, nftActs] = await Promise.allSettled([
          this.getRecentTokenActivity(wallet.address, chain),
          this.getRecentNFTActivity(wallet.address, chain),
        ]);

        const allActs = [
          ...(tokenActs.status === "fulfilled" ? tokenActs.value : []),
          ...(nftActs.status  === "fulfilled" ? nftActs.value  : []),
        ].filter(a => a.action === "buy");

        for (const act of allActs) {
          // Filter out noise: stablecoins, WETH, wrapped tokens
          const skipSymbols = ["USDC", "USDT", "WETH", "DAI", "WBTC", "STETH"];
          if (skipSymbols.includes(act.assetName?.toUpperCase())) continue;
          if (!act.assetAddress || act.assetAddress.length < 10) continue;

          const key = `${act.chain}:${act.assetAddress}`;
          if (!assetMap.has(key)) {
            assetMap.set(key, {
              buyers:    new Set(),
              sources:   new Set(),
              volume:    0,
              firstSeen: act.timestamp,
              lastSeen:  act.timestamp,
              name:      act.assetName,
              chain:     act.chain,
              type:      act.assetType,
            });
          }

          const entry = assetMap.get(key)!;
          entry.buyers.add(wallet.address);
          entry.sources.add(wallet.source);
          entry.volume    += act.amountEth;
          entry.lastSeen   = Math.max(entry.lastSeen, act.timestamp);
          entry.firstSeen  = Math.min(entry.firstSeen, act.timestamp);
        }

        // Update wallet lastSeen
        const updated = { ...wallet, lastSeen: Date.now() };
        await kiraRedis.setJson(K.wallet(wallet.address), updated);

        // Polite delay — Etherscan Pro allows 10 req/sec
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Build signals
    const signals: SmartMoneySignal[] = [];

    for (const [key, data] of assetMap.entries()) {
      if (data.buyers.size < 1) continue;

      const buyerCount  = data.buyers.size;
      const sourceCount = data.sources.size;
      const hasVCOrWhale = [...data.sources].some(
        s => s === "known_vc" || s === "known_whale" || s === "agentcheck_verified"
      );

      // Confidence formula
      const confidence = Math.min(1,
        (buyerCount  >= 5 ? 0.5 : buyerCount  * 0.1) +
        (sourceCount >= 3 ? 0.3 : sourceCount * 0.1) +
        (hasVCOrWhale ? 0.3 : 0) +
        (data.volume > 1 ? 0.1 : 0)
      );

      const signal: SmartMoneySignal = {
        assetAddress:   key.split(":")[1],
        assetName:      data.name,
        chain:          data.chain,
        assetType:      data.type,
        buyerCount,
        totalVolumeEth: data.volume,
        buyers:         [...data.buyers],
        sources:        [...data.sources],
        confidence,
        firstSeen:      data.firstSeen,
        lastSeen:       data.lastSeen,
      };

      signals.push(signal);
      await kiraRedis.setJson(K.signal(key), signal);
      await kiraRedis.sadd(K.signals(), key);
    }

    await kiraRedis.set(K.lastScan(), String(Date.now()));
    console.log(`[SmartMoney] ${signals.length} signals from ${toScan.length} wallets`);
    return signals.sort((a, b) => b.confidence - a.confidence);
  }

  // ── SIGNAL LOOKUP ─────────────────────────────────────────────────────────────

  async getSignalForAsset(
    assetAddress: string,
    chain:        string
  ): Promise<SmartMoneySignal | null> {
    const key = `${chain}:${assetAddress.toLowerCase()}`;
    return kiraRedis.getJson<SmartMoneySignal>(K.signal(key));
  }

  async getScoreContribution(
    assetAddress: string,
    chain:        string
  ): Promise<{ score: number; reasoning: string }> {
    const signal = await this.getSignalForAsset(assetAddress, chain);
    if (!signal) return { score: 0, reasoning: "No smart money signal" };

    const daysOld = (Date.now() - signal.lastSeen) / (24 * 3600 * 1000);
    if (daysOld > 7) return { score: 0, reasoning: "Signal stale (>7d)" };

    let score = 0;
    const reasons: string[] = [];

    // Buyer count score
    if      (signal.buyerCount >= 5) { score += 15; reasons.push(`${signal.buyerCount} smart money buyers`); }
    else if (signal.buyerCount >= 3) { score += 10; reasons.push(`${signal.buyerCount} smart money buyers`); }
    else if (signal.buyerCount >= 1) { score +=  5; reasons.push(`${signal.buyerCount} smart money buyer`); }

    // Source quality bonuses
    if (signal.sources.includes("known_vc") || signal.sources.includes("known_whale")) {
      score += 4;
      reasons.push("VC/whale wallet buying");
    }
    if (signal.sources.includes("agentcheck_verified")) {
      score += 3;
      reasons.push("AgentCheck verified accumulating");
    }
    if (signal.sources.length >= 3) {
      score += 2;
      reasons.push("Multiple source types converging");
    }

    return {
      score:     Math.min(15, score),
      reasoning: reasons.join("; "),
    };
  }

  async getAllSignals(): Promise<SmartMoneySignal[]> {
    const keys    = await kiraRedis.smembers(K.signals());
    const signals = await Promise.all(
      keys.map(k => kiraRedis.getJson<SmartMoneySignal>(K.signal(k)))
    );
    return (signals.filter(Boolean) as SmartMoneySignal[])
      .sort((a, b) => b.buyerCount - a.buyerCount);
  }

  // ── SELF-LEARNING ─────────────────────────────────────────────────────────────

  async recordSuccessfulBuyers(assetAddress: string, chain: string): Promise<void> {
    const signal = await this.getSignalForAsset(assetAddress, chain);
    if (!signal) return;

    for (const addr of signal.buyers) {
      const wallet = await this.getWallet(addr);
      if (!wallet) continue;

      wallet.winCount++;
      wallet.buyCount++;

      // Promote to self_learned after 3 wins
      if (wallet.winCount >= 3 &&
          wallet.source !== "agentcheck_verified" &&
          wallet.source !== "known_vc" &&
          wallet.source !== "known_whale") {
        wallet.source = "self_learned";
        if (!wallet.tags.includes("proven_predictor")) {
          wallet.tags.push("proven_predictor");
        }
        console.log(`[SmartMoney] Promoted to self_learned: ${addr.slice(0, 10)}...`);
      }

      await kiraRedis.setJson(K.wallet(addr), wallet);
    }
  }

  // ── SUMMARY ───────────────────────────────────────────────────────────────────

  async formatSummaryForContext(): Promise<string> {
    const wallets = await this.getAllWallets();
    const signals = await this.getAllSignals();

    const bySource = wallets.reduce((acc, w) => {
      acc[w.source] = (acc[w.source] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const active  = signals.filter(
      s => Date.now() - s.lastSeen < 7 * 24 * 3600 * 1000
    );

    const sourceSummary = Object.entries(bySource)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([s, c]) => `${s.replace("known_", "")}: ${c}`)
      .join(", ");

    return [
      `${wallets.length} wallets (${sourceSummary})`,
      `${active.length} active signals`,
      active.length > 0
        ? `Top: ${active[0].assetName} (${active[0].buyerCount} buyers, conf ${(active[0].confidence * 100).toFixed(0)}%)`
        : "",
    ].filter(Boolean).join(" | ");
  }
}
