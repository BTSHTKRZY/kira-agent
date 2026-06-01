// scoring.ts — Unified scoring engine for KIRA's trading decisions
// NFT revival + token momentum + technical indicators + macro context
// Signal weights stored in Redis via REST fetch — no SDK

import { NFTCollection, HolderAnalysis, NFTListing } from "./nfts.js";
import { TokenPrice }        from "./prices.js";
import { TechnicalIndicators } from "./technicals.js";
import { MacroData }         from "./research.js";
import { kiraRedis }         from "./redis.js";

// ── TYPES ──────────────────────────────────────────────────────────────────────

export interface NFTScore {
  collection:  string;
  chain:       string;
  totalScore:  number;
  signals:     NFTSignals;
  decision:    "buy" | "watchlist" | "pass";
  thesis:      string;
  confidence:  "high" | "medium" | "low";
  scoredAt:    number;
}

export interface NFTSignals {
  floorDipDepth:      number;
  floorStabilizing:   number;
  holderTrend:        number;
  avgHoldDuration:    number;
  knownWalletBuying:  number;
  volumeRecovery:     number;
  washTradeClean:     number;
  macroContext:       number;
  [key: string]:      number;
}

export interface TokenScore {
  address:     string;
  symbol:      string;
  chain:       string;
  totalScore:  number;
  signals:     TokenSignals;
  decision:    "buy" | "watchlist" | "pass";
  thesis:      string;
  confidence:  "high" | "medium" | "low";
  scoredAt:    number;
}

export interface TokenSignals {
  priceVs24hAvg:     number;
  momentumStrength:  number;
  volumeTrend:       number;
  liquidityDepth:    number;
  normiesWalletFlow: number;
  technicalScore:    number;
  macroContext:      number;
  [key: string]:     number;
}

export interface SignalWeights {
  nft: {
    floorDipDepth:     number;
    floorStabilizing:  number;
    holderTrend:       number;
    avgHoldDuration:   number;
    knownWalletBuying: number;
    volumeRecovery:    number;
    washTradeClean:    number;
    macroContext:      number;
  };
  token: {
    priceVs24hAvg:     number;
    momentumStrength:  number;
    volumeTrend:       number;
    liquidityDepth:    number;
    normiesWalletFlow: number;
    technicalScore:    number;
    macroContext:      number;
  };
  updatedAt: number;
  version:   number;
}

const DEFAULT_WEIGHTS: SignalWeights = {
  nft: {
    floorDipDepth:     1.0,
    floorStabilizing:  1.0,
    holderTrend:       1.0,
    avgHoldDuration:   1.0,
    knownWalletBuying: 1.0,
    volumeRecovery:    1.0,
    washTradeClean:    1.0,
    macroContext:      1.0,
  },
  token: {
    priceVs24hAvg:     1.0,
    momentumStrength:  1.0,
    volumeTrend:       1.0,
    liquidityDepth:    1.0,
    normiesWalletFlow: 1.0,
    technicalScore:    1.0,
    macroContext:      1.0,
  },
  updatedAt: Date.now(),
  version:   1,
};

const WEIGHTS_KEY             = "kira:signal_weights";
const NFT_BUY_THRESHOLD       = 70;
const NFT_WATCHLIST_THRESHOLD = 50;
const TOKEN_BUY_THRESHOLD     = 70;
const TOKEN_WATCHLIST_THRESHOLD = 50;

// ── SCORING ENGINE ─────────────────────────────────────────────────────────────

export class KiraScoring {
  private weights: SignalWeights = { ...DEFAULT_WEIGHTS };

  async loadWeights(): Promise<void> {
    const stored = await kiraRedis.getJson<SignalWeights>(WEIGHTS_KEY);
    if (stored) {
      // Merge stored with defaults to handle new signals added since last save
      this.weights = {
        nft:   { ...DEFAULT_WEIGHTS.nft,   ...stored.nft   },
        token: { ...DEFAULT_WEIGHTS.token, ...stored.token },
        updatedAt: stored.updatedAt,
        version:   stored.version,
      };
      console.log(`Loaded signal weights v${this.weights.version}`);
    } else {
      console.log("Using default signal weights");
    }
  }

  async saveWeights(): Promise<void> {
    const ok = await kiraRedis.setJson(WEIGHTS_KEY, this.weights);
    if (!ok) console.error("Failed to save signal weights");
  }

  // ── NFT SCORING ──────────────────────────────────────────────────────────────

  scoreNFT(
    collection:    NFTCollection,
    holders:       HolderAnalysis,
    listings:      NFTListing[],
    trustedBuyers: string[],
    macro?:        MacroData
  ): NFTScore {
    const w = this.weights.nft;
    const s: NFTSignals = {
      floorDipDepth:     0,
      floorStabilizing:  0,
      holderTrend:       0,
      avgHoldDuration:   0,
      knownWalletBuying: 0,
      volumeRecovery:    0,
      washTradeClean:    0,
      macroContext:      0,
    };

    // 1. Floor dip depth (max 20 pts)
    const dip = Math.abs(Math.min(0, collection.floor30dChange));
    s.floorDipDepth =
      dip >= 60 ? 10 * w.floorDipDepth :
      dip >= 40 ? 18 * w.floorDipDepth :
      dip >= 25 ? 20 * w.floorDipDepth :
      dip >= 15 ? 12 * w.floorDipDepth :
                   5 * w.floorDipDepth;

    // 2. Floor stabilizing (max 15 pts)
    const recovering = collection.floor7dChange > collection.floor30dChange;
    const flat7d     = Math.abs(collection.floor7dChange) < 5;
    s.floorStabilizing =
      recovering && flat7d ? 15 * w.floorStabilizing :
      recovering           ? 10 * w.floorStabilizing :
      flat7d               ?  7 * w.floorStabilizing : 0;

    // 3. Holder trend (max 15 pts)
    s.holderTrend =
      holders.holderTrend === "growing"  ? 15 * w.holderTrend :
      holders.holderTrend === "stable"   ?  8 * w.holderTrend : 0;

    // 4. Avg hold duration (max 15 pts)
    s.avgHoldDuration =
      holders.avgHoldDays >= 90 ? 15 * w.avgHoldDuration :
      holders.avgHoldDays >= 60 ? 12 * w.avgHoldDuration :
      holders.avgHoldDays >= 30 ?  8 * w.avgHoldDuration :
      holders.avgHoldDays >= 14 ?  4 * w.avgHoldDuration : 0;

    // 5. Known wallet buying (max 20 pts)
    const knownCount = holders.recentBuyers.filter(
      b => trustedBuyers.includes(b.toLowerCase())
    ).length;
    s.knownWalletBuying =
      knownCount >= 5 ? 20 * w.knownWalletBuying :
      knownCount >= 3 ? 15 * w.knownWalletBuying :
      knownCount >= 1 ?  8 * w.knownWalletBuying : 0;

    // 6. Volume recovery (max 10 pts)
    const volRatio = collection.volume24h > 0 && collection.volume7d > 0
      ? (collection.volume24h * 7) / collection.volume7d : 0;
    s.volumeRecovery =
      volRatio >= 2.0 ? 10 * w.volumeRecovery :
      volRatio >= 1.3 ?  7 * w.volumeRecovery :
      volRatio >= 0.8 ?  4 * w.volumeRecovery : 0;

    // 7. Wash trade clean (max 5 pts)
    s.washTradeClean =
      holders.washTradeRisk === "low"    ? 5 * w.washTradeClean :
      holders.washTradeRisk === "medium" ? 2 * w.washTradeClean : 0;

    // 8. Macro context (max 10 pts)
    if (macro) {
      const macroScore = this.getMacroScore(macro);
      s.macroContext = Math.max(0, Math.min(10, (macroScore + 20) * 0.25)) * w.macroContext;
    }

    // Cap signals
    s.floorDipDepth     = Math.min(20, s.floorDipDepth);
    s.floorStabilizing  = Math.min(15, s.floorStabilizing);
    s.holderTrend       = Math.min(15, s.holderTrend);
    s.avgHoldDuration   = Math.min(15, s.avgHoldDuration);
    s.knownWalletBuying = Math.min(20, s.knownWalletBuying);
    s.volumeRecovery    = Math.min(10, s.volumeRecovery);
    s.washTradeClean    = Math.min(5,  s.washTradeClean);
    s.macroContext      = Math.min(10, s.macroContext);

    const totalScore = Math.round(Object.values(s).reduce((a, b) => a + b, 0));
    const decision: "buy" | "watchlist" | "pass" =
      totalScore >= NFT_BUY_THRESHOLD       ? "buy" :
      totalScore >= NFT_WATCHLIST_THRESHOLD ? "watchlist" : "pass";
    const confidence: "high" | "medium" | "low" =
      totalScore >= 80 ? "high" :
      totalScore >= 60 ? "medium" : "low";

    return {
      collection: collection.address,
      chain:      collection.chain,
      totalScore,
      signals:    s,
      decision,
      thesis:     this.nftThesis(collection, holders, s, totalScore, knownCount, macro),
      confidence,
      scoredAt:   Date.now(),
    };
  }

  private nftThesis(
    col:        NFTCollection,
    holders:    HolderAnalysis,
    signals:    NFTSignals,
    score:      number,
    knownCount: number,
    macro?:     MacroData
  ): string {
    const parts: string[] = [];
    if (signals.floorDipDepth > 15)
      parts.push(`Floor down ${Math.abs(col.floor30dChange).toFixed(0)}% over 30d — significant dip.`);
    if (signals.floorStabilizing > 10)
      parts.push(`7d floor stabilizing vs 30d trend — support forming.`);
    if (signals.holderTrend > 10)
      parts.push(`Holders ${holders.holderTrend} despite price pressure.`);
    if (signals.avgHoldDuration > 10)
      parts.push(`Avg hold ~${holders.avgHoldDays}d — conviction base.`);
    if (knownCount > 0)
      parts.push(`${knownCount} verified wallet(s) accumulated last 7d.`);
    if (signals.volumeRecovery > 7)
      parts.push(`Volume picking up from lows.`);
    if (signals.washTradeClean === 0)
      parts.push(`Wash trade risk — discount thesis.`);
    if (macro && signals.macroContext > 5)
      parts.push(`Macro supportive: F&G ${macro.fearGreedIndex} (${macro.fearGreedLabel}).`);
    parts.push(`Score: ${score}/100. Decision: ${
      score >= NFT_BUY_THRESHOLD ? "BUY" :
      score >= NFT_WATCHLIST_THRESHOLD ? "WATCHLIST" : "PASS"
    }.`);
    return parts.join(" ");
  }

  // ── TOKEN SCORING ────────────────────────────────────────────────────────────

  scoreToken(
    price:          TokenPrice,
    normiesWallets: string[],
    tradeAmountEth: number = 0.005,
    technicals?:    TechnicalIndicators,
    macro?:         MacroData
  ): TokenScore {
    const w = this.weights.token;
    const s: TokenSignals = {
      priceVs24hAvg:     0,
      momentumStrength:  0,
      volumeTrend:       0,
      liquidityDepth:    0,
      normiesWalletFlow: 0,
      technicalScore:    0,
      macroContext:      0,
    };

    // 1. Price vs 24h avg (max 20 pts)
    s.priceVs24hAvg =
      price.change24h < -10 && price.change1h > 0 ? 20 * w.priceVs24hAvg :
      price.change24h < -5  && price.change1h > 0 ? 15 * w.priceVs24hAvg :
      price.change24h < 0   && price.change1h > 0 ? 10 * w.priceVs24hAvg :
      price.change24h > 20                         ?  5 * w.priceVs24hAvg :
                                                      8 * w.priceVs24hAvg;

    // 2. Momentum strength (max 20 pts)
    const momentum = Math.abs(price.change1h) + Math.abs(price.change6h) * 0.5;
    const positive = price.change1h > 0 && price.change6h > 0;
    s.momentumStrength =
      positive && momentum > 15 ? 20 * w.momentumStrength :
      positive && momentum > 8  ? 14 * w.momentumStrength :
      positive && momentum > 3  ?  9 * w.momentumStrength :
      positive                  ?  4 * w.momentumStrength : 0;

    // 3. Volume trend (max 15 pts)
    const volToFdv = price.fdv > 0 ? (price.volume24h / price.fdv) * 100 : 0;
    s.volumeTrend =
      volToFdv > 20 ? 15 * w.volumeTrend :
      volToFdv > 10 ? 11 * w.volumeTrend :
      volToFdv > 5  ?  7 * w.volumeTrend :
      volToFdv > 1  ?  3 * w.volumeTrend : 0;

    // 4. Liquidity depth (max 15 pts)
    const ethUsd   = 2000;
    const tradeUsd = tradeAmountEth * ethUsd;
    const liqRatio = price.liquidity / tradeUsd;
    s.liquidityDepth =
      liqRatio > 100 ? 15 * w.liquidityDepth :
      liqRatio > 50  ? 11 * w.liquidityDepth :
      liqRatio > 20  ?  7 * w.liquidityDepth :
      liqRatio > 10  ?  3 * w.liquidityDepth : 0;

    // 5. Normies wallet flow (max 10 pts)
    s.normiesWalletFlow = normiesWallets.length > 0
      ? Math.min(10, normiesWallets.length * 3) * w.normiesWalletFlow : 0;

    // 6. Technical score (max 15 pts)
    if (technicals) {
      const techScore = this.getTechnicalScore(technicals);
      s.technicalScore = Math.min(15, techScore * 0.6) * w.technicalScore;
    }

    // 7. Macro context (max 5 pts)
    if (macro) {
      const macroScore = this.getMacroScore(macro);
      s.macroContext = Math.max(0, Math.min(5, (macroScore + 20) * 0.125)) * w.macroContext;
    }

    // Cap signals
    s.priceVs24hAvg     = Math.min(20, s.priceVs24hAvg);
    s.momentumStrength  = Math.min(20, s.momentumStrength);
    s.volumeTrend       = Math.min(15, s.volumeTrend);
    s.liquidityDepth    = Math.min(15, s.liquidityDepth);
    s.normiesWalletFlow = Math.min(10, s.normiesWalletFlow);
    s.technicalScore    = Math.min(15, s.technicalScore);
    s.macroContext      = Math.min(5,  s.macroContext);

    const totalScore = Math.round(Object.values(s).reduce((a, b) => a + b, 0));
    const decision: "buy" | "watchlist" | "pass" =
      totalScore >= TOKEN_BUY_THRESHOLD       ? "buy" :
      totalScore >= TOKEN_WATCHLIST_THRESHOLD ? "watchlist" : "pass";
    const confidence: "high" | "medium" | "low" =
      totalScore >= 80 ? "high" :
      totalScore >= 60 ? "medium" : "low";

    return {
      address:  price.address,
      symbol:   price.symbol,
      chain:    price.chain,
      totalScore,
      signals:  s,
      decision,
      thesis:   this.tokenThesis(price, s, totalScore, technicals, macro),
      confidence,
      scoredAt: Date.now(),
    };
  }

  private tokenThesis(
    price:      TokenPrice,
    signals:    TokenSignals,
    score:      number,
    tech?:      TechnicalIndicators,
    macro?:     MacroData
  ): string {
    const parts: string[] = [];
    if (signals.priceVs24hAvg > 15)
      parts.push(`Down ${Math.abs(price.change24h).toFixed(1)}% in 24h but recovering — dip entry.`);
    if (signals.momentumStrength > 14)
      parts.push(`Strong momentum: 1h +${price.change1h.toFixed(1)}%, 6h +${price.change6h.toFixed(1)}%.`);
    if (signals.volumeTrend > 10)
      parts.push(`Vol $${(price.volume24h / 1000).toFixed(0)}k — high relative to market cap.`);
    if (signals.liquidityDepth < 3)
      parts.push(`Thin liquidity — slippage risk.`);
    if (signals.normiesWalletFlow > 0)
      parts.push(`Normies wallets accumulating.`);
    if (tech) {
      if (tech.signals.oversoldRecovery)
        parts.push(`RSI ${tech.rsi14.toFixed(0)} oversold + recovering — strong entry signal.`);
      else if (tech.signals.macdBullish)
        parts.push(`MACD bullish crossover.`);
      if (tech.signals.goldenCross)
        parts.push(`Golden cross detected.`);
    }
    if (macro && signals.macroContext > 2)
      parts.push(`Macro: F&G ${macro.fearGreedIndex} (${macro.fearGreedLabel}), BTC dom ${macro.btcDominance.toFixed(0)}%.`);
    parts.push(`Score: ${score}/100. Decision: ${
      score >= TOKEN_BUY_THRESHOLD ? "BUY" :
      score >= TOKEN_WATCHLIST_THRESHOLD ? "WATCHLIST" : "PASS"
    }.`);
    return parts.join(" ");
  }

  // ── HELPER SCORERS ────────────────────────────────────────────────────────────

  private getMacroScore(macro: MacroData): number {
    let score = 0;
    if (macro.fearGreedIndex < 20)       score += 15;
    else if (macro.fearGreedIndex < 35)  score += 8;
    else if (macro.fearGreedIndex > 80)  score -= 12;
    else if (macro.fearGreedIndex > 65)  score -= 5;
    if (macro.lastFedChangeBps < -25)    score += 10;
    else if (macro.lastFedChangeBps > 25) score -= 8;
    if (macro.btcDominance > 60)         score -= 6;
    else if (macro.btcDominance < 45)    score += 5;
    return Math.max(-20, Math.min(20, score));
  }

  private getTechnicalScore(tech: TechnicalIndicators): number {
    let score = 0;
    if (tech.signals.oversoldRecovery)                      score += 10;
    else if (tech.signals.rsiOversold)                      score += 6;
    else if (tech.rsi14 < 40)                               score += 3;
    if (tech.signals.macdBullish)                           score += 6;
    if (tech.signals.goldenCross)                           score += 5;
    if (tech.signals.volumeSpike && tech.trend === "up")    score += 4;
    if (tech.bbPosition < 0.2)                              score += 4;
    else if (tech.bbPosition < 0.4)                         score += 2;
    if (tech.signals.rsiOverbought)                         score -= 8;
    if (tech.signals.macdBearish)                           score -= 5;
    if (tech.signals.deathCross)                            score -= 6;
    if (tech.signals.bbBreakoutDown)                        score -= 4;
    return Math.max(0, Math.min(25, score));
  }

  // ── LEARNING LOOP ────────────────────────────────────────────────────────────

  adjustWeights(
    signalType:    "nft" | "token",
    signalName:    string,
    performedWell: boolean,
    magnitude:     number = 0.1
  ): void {
    const group = this.weights[signalType] as Record<string, number>;
    if (!(signalName in group)) return;
    const current     = group[signalName];
    const delta       = performedWell ? magnitude : -magnitude;
    group[signalName] = Math.max(0.1, Math.min(3.0, current + delta));
    this.weights.updatedAt = Date.now();
    this.weights.version++;
    console.log(
      `Weight adjusted: ${signalType}.${signalName} ` +
      `${current.toFixed(2)} → ${group[signalName].toFixed(2)} ` +
      `(${performedWell ? "↑" : "↓"})`
    );
  }

  // Apply external weight adjustments (from proposals or patterns)
  applyExternalAdjustments(adjustments: Record<string, number>): void {
    for (const [signal, delta] of Object.entries(adjustments)) {
      // Try both nft and token weight groups
      if (signal in this.weights.nft) {
        (this.weights.nft as any)[signal] = Math.max(
          0.1, Math.min(3.0, (this.weights.nft as any)[signal] + delta)
        );
      }
      if (signal in this.weights.token) {
        (this.weights.token as any)[signal] = Math.max(
          0.1, Math.min(3.0, (this.weights.token as any)[signal] + delta)
        );
      }
    }
  }

  getWeights(): SignalWeights { return this.weights; }

  formatWeightsForContext(): string {
    const nft   = Object.entries(this.weights.nft)
      .map(([k, v]) => `${k}:${(v as number).toFixed(2)}`).join(", ");
    const token = Object.entries(this.weights.token)
      .map(([k, v]) => `${k}:${(v as number).toFixed(2)}`).join(", ");
    return `Signal weights v${this.weights.version} — NFT: ${nft} | Token: ${token}`;
  }
}
