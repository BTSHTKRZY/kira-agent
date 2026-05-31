// scoring.ts — Unified scoring engine for KIRA's trading decisions
// NFT revival score + token momentum score
// Signal weights stored in Redis so KIRA can adjust them over time

import { NFTCollection, HolderAnalysis, NFTListing } from "./nfts.js";
import { TokenPrice } from "./prices.js";

// ── TYPES ──────────────────────────────────────────────────────────────────────

export interface NFTScore {
  collection:      string;
  chain:           string;
  totalScore:      number;         // 0-100
  signals:         NFTSignals;
  decision:        "buy" | "watchlist" | "pass";
  thesis:          string;         // KIRA's natural language reasoning
  confidence:      "high" | "medium" | "low";
  scoredAt:        number;
}

export interface NFTSignals {
  floorDipDepth:      number;      // 0-20 pts
  floorStabilizing:   number;      // 0-15 pts
  holderTrend:        number;      // 0-15 pts
  avgHoldDuration:    number;      // 0-15 pts
  knownWalletBuying:  number;      // 0-20 pts
  volumeRecovery:     number;      // 0-10 pts
  washTradeClean:     number;      // 0-5 pts
}

export interface TokenScore {
  address:        string;
  symbol:         string;
  chain:          string;
  totalScore:     number;          // 0-100
  signals:        TokenSignals;
  decision:       "buy" | "watchlist" | "pass";
  thesis:         string;
  confidence:     "high" | "medium" | "low";
  scoredAt:       number;
}

export interface TokenSignals {
  priceVs24hAvg:     number;       // 0-20 pts: buying below recent avg
  momentumStrength:  number;       // 0-25 pts: directional strength
  volumeTrend:       number;       // 0-20 pts: volume increasing
  liquidityDepth:    number;       // 0-20 pts: enough liquidity
  normiesWalletFlow: number;       // 0-15 pts: known wallets accumulating
}

// Default signal weights — KIRA adjusts these over time via learning loop
export interface SignalWeights {
  nft: {
    floorDipDepth:     number;
    floorStabilizing:  number;
    holderTrend:       number;
    avgHoldDuration:   number;
    knownWalletBuying: number;
    volumeRecovery:    number;
    washTradeClean:    number;
  };
  token: {
    priceVs24hAvg:     number;
    momentumStrength:  number;
    volumeTrend:       number;
    liquidityDepth:    number;
    normiesWalletFlow: number;
  };
  updatedAt: number;
  version:   number;
}

export const DEFAULT_WEIGHTS: SignalWeights = {
  nft: {
    floorDipDepth:     1.0,
    floorStabilizing:  1.0,
    holderTrend:       1.0,
    avgHoldDuration:   1.0,
    knownWalletBuying: 1.0,
    volumeRecovery:    1.0,
    washTradeClean:    1.0,
  },
  token: {
    priceVs24hAvg:     1.0,
    momentumStrength:  1.0,
    volumeTrend:       1.0,
    liquidityDepth:    1.0,
    normiesWalletFlow: 1.0,
  },
  updatedAt: Date.now(),
  version:   1,
};

// Thresholds
const NFT_BUY_THRESHOLD       = 70;
const NFT_WATCHLIST_THRESHOLD = 50;
const TOKEN_BUY_THRESHOLD     = 70;
const TOKEN_WATCHLIST_THRESHOLD = 50;

// ── SCORING ENGINE ─────────────────────────────────────────────────────────────

export class KiraScoring {
  private weights: SignalWeights = DEFAULT_WEIGHTS;

  // Load weights from Redis if available
  async loadWeights(redis: any): Promise<void> {
    try {
      const stored = await redis.get("kira:signal_weights");
      if (stored) {
        this.weights = JSON.parse(stored);
        console.log(`Loaded signal weights v${this.weights.version}`);
      }
    } catch {
      console.log("Using default signal weights");
    }
  }

  // Save updated weights to Redis
  async saveWeights(redis: any): Promise<void> {
    try {
      await redis.set("kira:signal_weights", JSON.stringify(this.weights));
    } catch (err: any) {
      console.error("Failed to save weights:", err?.message);
    }
  }

  // ── NFT SCORING ──────────────────────────────────────────────────────────────

  scoreNFT(
    collection:      NFTCollection,
    holders:         HolderAnalysis,
    listings:        NFTListing[],
    trustedBuyers:   string[]        // wallets verified by AgentCheck
  ): NFTScore {
    const w = this.weights.nft;
    const signals: NFTSignals = {
      floorDipDepth:     0,
      floorStabilizing:  0,
      holderTrend:       0,
      avgHoldDuration:   0,
      knownWalletBuying: 0,
      volumeRecovery:    0,
      washTradeClean:    0,
    };

    // 1. Floor dip depth (max 20 pts)
    // Sweet spot: down 30-70%. Less = not a dip. More = possibly dying.
    const dip = Math.abs(Math.min(0, collection.floor30dChange));
    if      (dip >= 60) signals.floorDipDepth = 10 * w.floorDipDepth; // too deep
    else if (dip >= 40) signals.floorDipDepth = 18 * w.floorDipDepth;
    else if (dip >= 25) signals.floorDipDepth = 20 * w.floorDipDepth; // sweet spot
    else if (dip >= 15) signals.floorDipDepth = 12 * w.floorDipDepth;
    else                signals.floorDipDepth = 5  * w.floorDipDepth; // barely a dip

    // 2. Floor stabilizing (max 15 pts)
    // 7d change better than 30d change = floor finding support
    const recovering = collection.floor7dChange > collection.floor30dChange;
    const flat7d     = Math.abs(collection.floor7dChange) < 5;
    if      (recovering && flat7d)  signals.floorStabilizing = 15 * w.floorStabilizing;
    else if (recovering)            signals.floorStabilizing = 10 * w.floorStabilizing;
    else if (flat7d)                signals.floorStabilizing = 7  * w.floorStabilizing;
    else                            signals.floorStabilizing = 0;

    // 3. Holder trend (max 15 pts)
    if      (holders.holderTrend === "growing")   signals.holderTrend = 15 * w.holderTrend;
    else if (holders.holderTrend === "stable")    signals.holderTrend = 8  * w.holderTrend;
    else                                          signals.holderTrend = 0;

    // 4. Average hold duration (max 15 pts)
    // Long holders = conviction. Short = flippers.
    if      (holders.avgHoldDays >= 90) signals.avgHoldDuration = 15 * w.avgHoldDuration;
    else if (holders.avgHoldDays >= 60) signals.avgHoldDuration = 12 * w.avgHoldDuration;
    else if (holders.avgHoldDays >= 30) signals.avgHoldDuration = 8  * w.avgHoldDuration;
    else if (holders.avgHoldDays >= 14) signals.avgHoldDuration = 4  * w.avgHoldDuration;
    else                                signals.avgHoldDuration = 0;

    // 5. Known wallet buying (max 20 pts)
    // AgentCheck-verified wallets accumulating = strong signal
    const knownBuyerCount = holders.recentBuyers.filter(
      b => trustedBuyers.includes(b.toLowerCase())
    ).length;
    if      (knownBuyerCount >= 5) signals.knownWalletBuying = 20 * w.knownWalletBuying;
    else if (knownBuyerCount >= 3) signals.knownWalletBuying = 15 * w.knownWalletBuying;
    else if (knownBuyerCount >= 1) signals.knownWalletBuying = 8  * w.knownWalletBuying;
    else                           signals.knownWalletBuying = 0;

    // 6. Volume recovery (max 10 pts)
    // Volume picking up from lows = demand returning
    const volRatio = collection.volume24h > 0 && collection.volume7d > 0
      ? (collection.volume24h * 7) / collection.volume7d
      : 0;
    if      (volRatio >= 2.0) signals.volumeRecovery = 10 * w.volumeRecovery;
    else if (volRatio >= 1.3) signals.volumeRecovery = 7  * w.volumeRecovery;
    else if (volRatio >= 0.8) signals.volumeRecovery = 4  * w.volumeRecovery;
    else                      signals.volumeRecovery = 0;

    // 7. Wash trade clean (max 5 pts)
    if      (holders.washTradeRisk === "low")    signals.washTradeClean = 5 * w.washTradeClean;
    else if (holders.washTradeRisk === "medium") signals.washTradeClean = 2 * w.washTradeClean;
    else                                         signals.washTradeClean = 0;

    // Cap each signal at its max
    signals.floorDipDepth     = Math.min(20, signals.floorDipDepth);
    signals.floorStabilizing  = Math.min(15, signals.floorStabilizing);
    signals.holderTrend       = Math.min(15, signals.holderTrend);
    signals.avgHoldDuration   = Math.min(15, signals.avgHoldDuration);
    signals.knownWalletBuying = Math.min(20, signals.knownWalletBuying);
    signals.volumeRecovery    = Math.min(10, signals.volumeRecovery);
    signals.washTradeClean    = Math.min(5,  signals.washTradeClean);

    const totalScore = Math.round(
      Object.values(signals).reduce((a, b) => a + b, 0)
    );

    const decision: "buy" | "watchlist" | "pass" =
      totalScore >= NFT_BUY_THRESHOLD       ? "buy" :
      totalScore >= NFT_WATCHLIST_THRESHOLD ? "watchlist" : "pass";

    const confidence: "high" | "medium" | "low" =
      totalScore >= 80 ? "high" :
      totalScore >= 60 ? "medium" : "low";

    const thesis = this.generateNFTThesis(collection, holders, signals, totalScore, knownBuyerCount);

    return {
      collection: collection.address,
      chain:      collection.chain,
      totalScore,
      signals,
      decision,
      thesis,
      confidence,
      scoredAt:   Date.now(),
    };
  }

  private generateNFTThesis(
    col:             NFTCollection,
    holders:         HolderAnalysis,
    signals:         NFTSignals,
    score:           number,
    knownBuyerCount: number
  ): string {
    const parts: string[] = [];

    if (signals.floorDipDepth > 15) {
      parts.push(`Floor down ${Math.abs(col.floor30dChange).toFixed(0)}% over 30 days — significant dip creating potential entry.`);
    }
    if (signals.floorStabilizing > 10) {
      parts.push(`7-day floor (${col.floor7dChange.toFixed(1)}%) stabilizing vs 30-day trend — support forming.`);
    }
    if (signals.holderTrend > 10) {
      parts.push(`Holder count ${holders.holderTrend} despite price pressure — conviction holding.`);
    }
    if (signals.avgHoldDuration > 10) {
      parts.push(`Average holder has held ~${holders.avgHoldDays} days — long-term conviction base.`);
    }
    if (knownBuyerCount > 0) {
      parts.push(`${knownBuyerCount} AgentCheck-verified wallet(s) accumulated in last 7 days — informed demand signal.`);
    }
    if (signals.volumeRecovery > 7) {
      parts.push(`Volume picking up from lows — demand returning.`);
    }
    if (signals.washTradeClean === 0) {
      parts.push(`Wash trade risk detected — discount thesis accordingly.`);
    }

    parts.push(`Score: ${score}/100. Decision: ${score >= NFT_BUY_THRESHOLD ? "BUY" : score >= NFT_WATCHLIST_THRESHOLD ? "WATCHLIST" : "PASS"}.`);

    return parts.join(" ");
  }

  // ── TOKEN SCORING ────────────────────────────────────────────────────────────

  scoreToken(
    price:          TokenPrice,
    normiesWallets: string[],      // wallets from Normies ecosystem
    tradeAmountEth: number = 0.005
  ): TokenScore {
    const w = this.weights.token;
    const signals: TokenSignals = {
      priceVs24hAvg:     0,
      momentumStrength:  0,
      volumeTrend:       0,
      liquidityDepth:    0,
      normiesWalletFlow: 0,
    };

    // 1. Price vs 24h avg (max 20 pts)
    // Buying on a dip within an uptrend
    if      (price.change24h < -10 && price.change1h > 0)  signals.priceVs24hAvg = 20 * w.priceVs24hAvg; // dip + recovering
    else if (price.change24h < -5  && price.change1h > 0)  signals.priceVs24hAvg = 15 * w.priceVs24hAvg;
    else if (price.change24h < 0   && price.change1h > 0)  signals.priceVs24hAvg = 10 * w.priceVs24hAvg;
    else if (price.change24h > 20)                          signals.priceVs24hAvg = 5  * w.priceVs24hAvg; // chasing
    else                                                    signals.priceVs24hAvg = 8  * w.priceVs24hAvg;

    // 2. Momentum strength (max 25 pts)
    const momentum = Math.abs(price.change1h) + Math.abs(price.change6h) * 0.5;
    const positive = price.change1h > 0 && price.change6h > 0;
    if      (positive && momentum > 15) signals.momentumStrength = 25 * w.momentumStrength;
    else if (positive && momentum > 8)  signals.momentumStrength = 18 * w.momentumStrength;
    else if (positive && momentum > 3)  signals.momentumStrength = 12 * w.momentumStrength;
    else if (positive)                  signals.momentumStrength = 6  * w.momentumStrength;
    else                                signals.momentumStrength = 0;

    // 3. Volume trend (max 20 pts)
    // High volume relative to market cap = genuine interest
    const volToFdv = price.fdv > 0 ? (price.volume24h / price.fdv) * 100 : 0;
    if      (volToFdv > 20)  signals.volumeTrend = 20 * w.volumeTrend;
    else if (volToFdv > 10)  signals.volumeTrend = 15 * w.volumeTrend;
    else if (volToFdv > 5)   signals.volumeTrend = 10 * w.volumeTrend;
    else if (volToFdv > 1)   signals.volumeTrend = 5  * w.volumeTrend;
    else                     signals.volumeTrend = 0;

    // 4. Liquidity depth (max 20 pts)
    // Must have enough liquidity to enter and exit without moving price
    const ethEstimate = 2000; // rough ETH price in USD
    const tradeUsd    = tradeAmountEth * ethEstimate;
    const liqRatio    = price.liquidity / tradeUsd;
    if      (liqRatio > 100) signals.liquidityDepth = 20 * w.liquidityDepth;
    else if (liqRatio > 50)  signals.liquidityDepth = 15 * w.liquidityDepth;
    else if (liqRatio > 20)  signals.liquidityDepth = 10 * w.liquidityDepth;
    else if (liqRatio > 10)  signals.liquidityDepth = 5  * w.liquidityDepth;
    else                     signals.liquidityDepth = 0;

    // 5. Normies wallet flow (max 15 pts)
    // Placeholder — will be populated when wallet tracking is live
    // For now: 0 unless normies wallets are detected buying
    signals.normiesWalletFlow = normiesWallets.length > 0
      ? Math.min(15, normiesWallets.length * 5) * w.normiesWalletFlow
      : 0;

    // Cap signals
    signals.priceVs24hAvg     = Math.min(20, signals.priceVs24hAvg);
    signals.momentumStrength  = Math.min(25, signals.momentumStrength);
    signals.volumeTrend       = Math.min(20, signals.volumeTrend);
    signals.liquidityDepth    = Math.min(20, signals.liquidityDepth);
    signals.normiesWalletFlow = Math.min(15, signals.normiesWalletFlow);

    const totalScore = Math.round(
      Object.values(signals).reduce((a, b) => a + b, 0)
    );

    const decision: "buy" | "watchlist" | "pass" =
      totalScore >= TOKEN_BUY_THRESHOLD         ? "buy" :
      totalScore >= TOKEN_WATCHLIST_THRESHOLD   ? "watchlist" : "pass";

    const confidence: "high" | "medium" | "low" =
      totalScore >= 80 ? "high" :
      totalScore >= 60 ? "medium" : "low";

    const thesis = this.generateTokenThesis(price, signals, totalScore);

    return {
      address:  price.address,
      symbol:   price.symbol,
      chain:    price.chain,
      totalScore,
      signals,
      decision,
      thesis,
      confidence,
      scoredAt: Date.now(),
    };
  }

  private generateTokenThesis(
    price:   TokenPrice,
    signals: TokenSignals,
    score:   number
  ): string {
    const parts: string[] = [];

    if (signals.priceVs24hAvg > 15) {
      parts.push(`Down ${Math.abs(price.change24h).toFixed(1)}% in 24h but recovering in last hour — dip entry opportunity.`);
    }
    if (signals.momentumStrength > 18) {
      parts.push(`Strong positive momentum: 1h +${price.change1h.toFixed(1)}%, 6h +${price.change6h.toFixed(1)}%.`);
    }
    if (signals.volumeTrend > 15) {
      parts.push(`Volume ${(price.volume24h / 1000).toFixed(0)}k USD — high relative to market cap, genuine interest.`);
    }
    if (signals.liquidityDepth < 5) {
      parts.push(`Liquidity thin ($${(price.liquidity / 1000).toFixed(0)}k) — slippage risk, reduce size.`);
    }
    if (signals.normiesWalletFlow > 0) {
      parts.push(`Normies ecosystem wallets detected accumulating.`);
    }

    parts.push(`Score: ${score}/100. Decision: ${score >= TOKEN_BUY_THRESHOLD ? "BUY" : score >= TOKEN_WATCHLIST_THRESHOLD ? "WATCHLIST" : "PASS"}.`);

    return parts.join(" ");
  }

  // ── LEARNING LOOP ────────────────────────────────────────────────────────────

  // Called by the monthly review to adjust weights based on outcomes
  adjustWeights(
    signalType:    "nft" | "token",
    signalName:    string,
    performedWell: boolean,
    magnitude:     number = 0.1   // how much to adjust (0.0 - 0.5)
  ): void {
    const group = this.weights[signalType] as Record<string, number>;
    if (!(signalName in group)) return;

    const current = group[signalName];
    const delta   = performedWell ? magnitude : -magnitude;
    // Keep weights between 0.1 and 3.0
    group[signalName] = Math.max(0.1, Math.min(3.0, current + delta));

    this.weights.updatedAt = Date.now();
    this.weights.version++;

    console.log(
      `Weight adjusted: ${signalType}.${signalName} ` +
      `${current.toFixed(2)} → ${group[signalName].toFixed(2)} ` +
      `(${performedWell ? "↑" : "↓"})`
    );
  }

  getWeights(): SignalWeights {
    return this.weights;
  }

  formatWeightsForContext(): string {
    const nft   = Object.entries(this.weights.nft)
      .map(([k, v]) => `${k}:${(v as number).toFixed(2)}`).join(", ");
    const token = Object.entries(this.weights.token)
      .map(([k, v]) => `${k}:${(v as number).toFixed(2)}`).join(", ");
    return `NFT weights v${this.weights.version}: ${nft} | Token weights: ${token}`;
  }
}
