// research.ts — Macro data, external knowledge, pattern certainty engine
// Fed rates, CPI, Fear & Greed, BTC dominance, pattern tracking

import { kiraRedis } from "./redis.js";

// ── TYPES ──────────────────────────────────────────────────────────────────────

export interface MacroData {
  fedFundsRate:      number;      // current Fed funds rate %
  lastFedChange:     number;      // timestamp of last rate change
  lastFedChangeBps:  number;      // basis points changed (+/- )
  cpiYoY:            number;      // CPI year-over-year %
  fearGreedIndex:    number;      // 0-100 (0=extreme fear, 100=extreme greed)
  fearGreedLabel:    string;      // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  btcDominance:      number;      // BTC market cap dominance %
  totalMarketCapUsd: number;
  fetchedAt:         number;
}

export interface PatternRecord {
  id:              string;       // e.g. "fed_rate_cut_crypto_rally"
  name:            string;       // human readable
  description:     string;
  timesObserved:   number;
  timesCorrect:    number;
  confidence:      number;       // timesCorrect / timesObserved
  avgImpact:       number;       // average % price change when pattern fires
  avgDuration:     number;       // average days until impact
  minConfidence:   number;       // threshold before KIRA acts (default 0.65)
  minObservations: number;       // minimum before acting (default 5)
  lastObserved:    number;
  lastUpdated:     number;
  active:          boolean;      // currently firing?
  weightEffect:    Record<string, number>; // signal weight adjustments when firing
}

export interface ResearchSummary {
  macro:    MacroData | null;
  patterns: PatternRecord[];
  insights: string[];
  fetchedAt: number;
}

// Redis keys
const K = {
  macro:   ()                => `kira:research:macro`,
  pattern: (id: string)      => `kira:pattern:${id}`,
  patterns: ()               => `kira:patterns`,
  research: ()               => `kira:research:summary`,
};

// ── MACRO DATA FEEDS ──────────────────────────────────────────────────────────

export class KiraResearch {

  // ── FEAR & GREED INDEX ────────────────────────────────────────────────────────

  async getFearGreed(): Promise<{ value: number; label: string } | null> {
    try {
      const res  = await fetch(
        "https://api.alternative.me/fng/?limit=1",
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return null;

      const data  = await res.json() as any;
      const entry = data.data?.[0];
      if (!entry) return null;

      return {
        value: parseInt(entry.value || "50"),
        label: entry.value_classification || "Neutral",
      };
    } catch {
      return null;
    }
  }

  // ── BTC DOMINANCE + MARKET CAP ────────────────────────────────────────────────

  async getMarketData(): Promise<{ btcDominance: number; totalMarketCap: number } | null> {
    try {
      const res  = await fetch(
        "https://api.coingecko.com/api/v3/global",
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return null;

      const data = await res.json() as any;
      return {
        btcDominance:   data.data?.market_cap_percentage?.btc || 0,
        totalMarketCap: data.data?.total_market_cap?.usd      || 0,
      };
    } catch {
      return null;
    }
  }

  // ── FRED — Fed Funds Rate ─────────────────────────────────────────────────────
  // Uses FRED API (free, no key for basic series)

  async getFedRate(): Promise<{ rate: number; lastChange: number; changeBps: number } | null> {
    try {
      // FRED API — Federal Funds Effective Rate (DFF series)
      const res = await fetch(
        "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF&vintage_date=" +
        new Date().toISOString().slice(0, 10),
        { signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) return null;

      const csv   = await res.text();
      const lines = csv.trim().split("\n").filter(l => !l.startsWith("DATE"));
      if (!lines.length) return null;

      // Get last two values to calculate change
      const last    = lines[lines.length - 1].split(",");
      const prev    = lines[lines.length - 2]?.split(",");
      const current = parseFloat(last[1]);
      const previous = prev ? parseFloat(prev[1]) : current;

      const changeBps = Math.round((current - previous) * 100);

      return {
        rate:       current,
        lastChange: Date.now(), // approximate
        changeBps,
      };
    } catch {
      // Fallback: return reasonable defaults if FRED is unavailable
      return { rate: 5.25, lastChange: 0, changeBps: 0 };
    }
  }

  // ── COMPILE MACRO DATA ────────────────────────────────────────────────────────

  async getMacroData(): Promise<MacroData> {
    const cached = await kiraRedis.getJson<MacroData>(K.macro());
    if (cached && Date.now() - cached.fetchedAt < 6 * 60 * 60 * 1000) {
      return cached; // Cache for 6 hours
    }

    const [fearGreed, market, fedRate] = await Promise.allSettled([
      this.getFearGreed(),
      this.getMarketData(),
      this.getFedRate(),
    ]);

    const fg  = fearGreed.status  === "fulfilled" ? fearGreed.value  : null;
    const mkt = market.status     === "fulfilled" ? market.value     : null;
    const fed = fedRate.status    === "fulfilled" ? fedRate.value    : null;

    const macro: MacroData = {
      fedFundsRate:      fed?.rate        || 5.25,
      lastFedChange:     fed?.lastChange  || 0,
      lastFedChangeBps:  fed?.changeBps   || 0,
      cpiYoY:            0,               // will add CPI feed in next iteration
      fearGreedIndex:    fg?.value        || 50,
      fearGreedLabel:    fg?.label        || "Neutral",
      btcDominance:      mkt?.btcDominance   || 50,
      totalMarketCapUsd: mkt?.totalMarketCap || 0,
      fetchedAt:         Date.now(),
    };

    await kiraRedis.setJson(K.macro(), macro);
    return macro;
  }

  // ── MACRO SCORING ─────────────────────────────────────────────────────────────

  // Returns a score modifier (-20 to +20) based on macro conditions
  scoreMacro(macro: MacroData): { score: number; reasoning: string } {
    let score = 0;
    const reasons: string[] = [];

    // Fear & Greed — contrarian indicator
    if (macro.fearGreedIndex < 20) {
      score += 15;
      reasons.push("Extreme fear = contrarian buy signal");
    } else if (macro.fearGreedIndex < 35) {
      score += 8;
      reasons.push("Fear zone = historically good entry");
    } else if (macro.fearGreedIndex > 80) {
      score -= 12;
      reasons.push("Extreme greed = elevated risk");
    } else if (macro.fearGreedIndex > 65) {
      score -= 5;
      reasons.push("Greed zone = caution warranted");
    }

    // Fed rate environment
    if (macro.lastFedChangeBps < -25) {
      score += 10;
      reasons.push(`Fed cut ${Math.abs(macro.lastFedChangeBps)}bps = risk-on signal`);
    } else if (macro.lastFedChangeBps > 25) {
      score -= 8;
      reasons.push(`Fed hike ${macro.lastFedChangeBps}bps = risk-off signal`);
    }

    // BTC dominance — high dominance = altcoin weakness
    if (macro.btcDominance > 60) {
      score -= 6;
      reasons.push("High BTC dominance = altcoin headwinds");
    } else if (macro.btcDominance < 45) {
      score += 5;
      reasons.push("Low BTC dominance = altcoin season");
    }

    return {
      score:     Math.max(-20, Math.min(20, score)),
      reasoning: reasons.join("; "),
    };
  }

  formatMacroForContext(macro: MacroData): string {
    return [
      `Fear/Greed: ${macro.fearGreedIndex} (${macro.fearGreedLabel})`,
      `Fed rate: ${macro.fedFundsRate}%${macro.lastFedChangeBps !== 0 ? ` (${macro.lastFedChangeBps > 0 ? "+" : ""}${macro.lastFedChangeBps}bps recent)` : ""}`,
      `BTC dominance: ${macro.btcDominance.toFixed(1)}%`,
    ].join(" | ");
  }

  // ── PATTERN CERTAINTY ENGINE ──────────────────────────────────────────────────

  async getPattern(id: string): Promise<PatternRecord | null> {
    return kiraRedis.getJson<PatternRecord>(K.pattern(id));
  }

  async getAllPatterns(): Promise<PatternRecord[]> {
    const ids = await kiraRedis.smembers(K.patterns());
    const patterns = await Promise.all(ids.map(id => this.getPattern(id)));
    return patterns.filter(Boolean) as PatternRecord[];
  }

  async initPattern(
    id:              string,
    name:            string,
    description:     string,
    minConfidence:   number = 0.65,
    minObservations: number = 5,
    weightEffect:    Record<string, number> = {}
  ): Promise<PatternRecord> {
    const existing = await this.getPattern(id);
    if (existing) return existing;

    const pattern: PatternRecord = {
      id, name, description,
      timesObserved:   0,
      timesCorrect:    0,
      confidence:      0,
      avgImpact:       0,
      avgDuration:     0,
      minConfidence,
      minObservations,
      lastObserved:    0,
      lastUpdated:     Date.now(),
      active:          false,
      weightEffect,
    };

    await kiraRedis.setJson(K.pattern(id), pattern);
    await kiraRedis.sadd(K.patterns(), id);
    return pattern;
  }

  async recordPatternOutcome(
    id:       string,
    correct:  boolean,
    impact:   number,  // % price change observed
    days:     number   // days until impact materialised
  ): Promise<void> {
    const pattern = await this.getPattern(id);
    if (!pattern) return;

    pattern.timesObserved++;
    if (correct) pattern.timesCorrect++;

    pattern.confidence = pattern.timesCorrect / pattern.timesObserved;

    // Rolling average impact
    const n = pattern.timesObserved;
    pattern.avgImpact   = (pattern.avgImpact * (n - 1) + impact) / n;
    pattern.avgDuration = (pattern.avgDuration * (n - 1) + days) / n;
    pattern.lastUpdated = Date.now();

    await kiraRedis.setJson(K.pattern(id), pattern);

    console.log(
      `[Research] Pattern "${pattern.name}" updated: ` +
      `${pattern.timesCorrect}/${pattern.timesObserved} correct ` +
      `(${(pattern.confidence * 100).toFixed(1)}% confidence)`
    );
  }

  async setPatternActive(id: string, active: boolean): Promise<void> {
    const pattern = await this.getPattern(id);
    if (!pattern) return;
    pattern.active      = active;
    pattern.lastObserved = active ? Date.now() : pattern.lastObserved;
    pattern.lastUpdated = Date.now();
    await kiraRedis.setJson(K.pattern(id), pattern);
  }

  // Returns weight adjustments from all active, high-confidence patterns
  async getActivePatternAdjustments(): Promise<{
    adjustments: Record<string, number>;
    reasoning:   string[];
  }> {
    const patterns   = await this.getAllPatterns();
    const adjustments: Record<string, number> = {};
    const reasoning: string[] = [];

    for (const p of patterns) {
      if (
        p.active &&
        p.confidence >= p.minConfidence &&
        p.timesObserved >= p.minObservations
      ) {
        for (const [signal, delta] of Object.entries(p.weightEffect)) {
          adjustments[signal] = (adjustments[signal] || 0) + delta;
        }
        reasoning.push(
          `${p.name}: ${(p.confidence * 100).toFixed(0)}% confidence, ` +
          `avg impact ${p.avgImpact > 0 ? "+" : ""}${p.avgImpact.toFixed(1)}%`
        );
      }
    }

    return { adjustments, reasoning };
  }

  // ── SEED BASE PATTERNS ────────────────────────────────────────────────────────

  async seedBasePatterns(): Promise<void> {
    await this.initPattern(
      "fed_rate_cut_crypto_rally",
      "Fed Rate Cut → Crypto Rally",
      "Fed cutting rates historically precedes crypto market rallies within 30-60 days",
      0.65, 4,
      { liquidityDepth: 0.2, momentumStrength: 0.2, normiesWalletFlow: 0.1 }
    );

    await this.initPattern(
      "extreme_fear_contrarian_buy",
      "Extreme Fear → Contrarian Buy",
      "Fear & Greed below 20 historically signals good medium-term entry points",
      0.65, 5,
      { priceVs24hAvg: 0.3, liquidityDepth: 0.2 }
    );

    await this.initPattern(
      "btc_dominance_drop_altseason",
      "BTC Dominance Drop → Altcoin Season",
      "When BTC dominance drops below 45%, altcoins tend to outperform",
      0.60, 4,
      { momentumStrength: 0.3, volumeTrend: 0.2 }
    );

    await this.initPattern(
      "rsi_oversold_volume_spike",
      "RSI Oversold + Volume Spike → Recovery",
      "RSI below 30 combined with 2x+ volume spike historically signals short-term recovery",
      0.65, 5,
      { priceVs24hAvg: 0.4, momentumStrength: 0.2 }
    );

    await this.initPattern(
      "nft_floor_dip_holder_accumulation",
      "NFT Floor Dip + Holder Accumulation → Revival",
      "NFT collections where floor dips 30%+ but holder count grows tend to recover",
      0.60, 5,
      { floorDipDepth: 0.2, holderTrend: 0.3, avgHoldDuration: 0.2 }
    );

    console.log("[Research] Base patterns seeded");
  }

  // ── MACRO HYPOTHESIS DETECTION ────────────────────────────────────────────────

  // Checks macro data and returns hypotheses worth proposing
  async detectMacroHypotheses(macro: MacroData): Promise<Array<{
    patternId:   string;
    title:       string;
    observation: string;
    confidence:  string;
    weights:     Record<string, number>;
  }>> {
    const hypotheses: Array<{
      patternId: string; title: string;
      observation: string; confidence: string;
      weights: Record<string, number>;
    }> = [];

    // Fed rate cut signal
    if (macro.lastFedChangeBps <= -25) {
      const pattern = await this.getPattern("fed_rate_cut_crypto_rally");
      if (pattern && pattern.timesObserved > 0) {
        hypotheses.push({
          patternId:   "fed_rate_cut_crypto_rally",
          title:       `Fed Rate Cut Detected (${macro.lastFedChangeBps}bps)`,
          observation: `Federal Reserve cut rates by ${Math.abs(macro.lastFedChangeBps)}bps. ` +
                       `Historical pattern shows crypto rally within 30-60 days in ` +
                       `${(pattern.confidence * 100).toFixed(0)}% of cases (${pattern.timesObserved} observations).`,
          confidence:  `${(pattern.confidence * 100).toFixed(0)}% (${pattern.timesObserved} observations, avg impact +${pattern.avgImpact.toFixed(1)}%)`,
          weights:     pattern.weightEffect,
        });
      }
    }

    // Extreme fear signal
    if (macro.fearGreedIndex < 20) {
      const pattern = await this.getPattern("extreme_fear_contrarian_buy");
      if (pattern && pattern.timesObserved > 0) {
        hypotheses.push({
          patternId:   "extreme_fear_contrarian_buy",
          title:       `Extreme Fear Detected (F&G: ${macro.fearGreedIndex})`,
          observation: `Fear & Greed Index at ${macro.fearGreedIndex} — Extreme Fear territory. ` +
                       `Contrarian signal historically correct ${(pattern.confidence * 100).toFixed(0)}% of the time.`,
          confidence:  `${(pattern.confidence * 100).toFixed(0)}% (${pattern.timesObserved} observations)`,
          weights:     pattern.weightEffect,
        });
      }
    }

    // Altcoin season signal
    if (macro.btcDominance < 45) {
      const pattern = await this.getPattern("btc_dominance_drop_altseason");
      if (pattern && pattern.timesObserved > 0) {
        hypotheses.push({
          patternId:   "btc_dominance_drop_altseason",
          title:       `BTC Dominance Low (${macro.btcDominance.toFixed(1)}%)`,
          observation: `BTC dominance at ${macro.btcDominance.toFixed(1)}% — below 45% altseason threshold. ` +
                       `Altcoins historically outperform BTC in this regime.`,
          confidence:  `${(pattern.confidence * 100).toFixed(0)}% (${pattern.timesObserved} observations)`,
          weights:     pattern.weightEffect,
        });
      }
    }

    return hypotheses;
  }

  // ── WEEKLY KNOWLEDGE REFRESH ──────────────────────────────────────────────────

  async getMarketInsights(): Promise<string[]> {
    const insights: string[] = [];

    try {
      const macro = await this.getMacroData();

      // Fear & Greed insight
      if (macro.fearGreedIndex < 25) {
        insights.push(`OPPORTUNITY: Fear & Greed at ${macro.fearGreedIndex} — historically a strong contrarian buy zone`);
      } else if (macro.fearGreedIndex > 75) {
        insights.push(`CAUTION: Fear & Greed at ${macro.fearGreedIndex} — market overheated, reduce position sizes`);
      }

      // BTC dominance insight
      if (macro.btcDominance > 58) {
        insights.push(`BTC dominance ${macro.btcDominance.toFixed(1)}% — capital flowing to BTC, altcoin caution warranted`);
      } else if (macro.btcDominance < 45) {
        insights.push(`BTC dominance ${macro.btcDominance.toFixed(1)}% — altcoin season conditions present`);
      }

      // Fed environment
      if (macro.fedFundsRate > 5) {
        insights.push(`High rate environment (${macro.fedFundsRate}%) — risk assets under pressure, quality over quantity`);
      } else if (macro.fedFundsRate < 2) {
        insights.push(`Low rate environment (${macro.fedFundsRate}%) — historically positive for crypto and risk assets`);
      }

    } catch (err: any) {
      console.error("[Research] Market insights error:", err?.message);
    }

    return insights;
  }
}
