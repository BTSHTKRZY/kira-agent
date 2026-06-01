// research.ts — Macro data feeds, pattern certainty engine
// Fed rates, CPI, Fear & Greed, BTC dominance, pattern tracking

import { kiraRedis } from "./redis.js";

export interface MacroData {
  fedFundsRate:      number;
  lastFedChange:     number;
  lastFedChangeBps:  number;
  cpiYoY:            number;
  cpiMoM:            number;
  cpiLastUpdated:    number;
  fearGreedIndex:    number;
  fearGreedLabel:    string;
  btcDominance:      number;
  totalMarketCapUsd: number;
  fetchedAt:         number;
}

export interface PatternRecord {
  id:              string;
  name:            string;
  description:     string;
  timesObserved:   number;
  timesCorrect:    number;
  confidence:      number;
  avgImpact:       number;
  avgDuration:     number;
  minConfidence:   number;
  minObservations: number;
  lastObserved:    number;
  lastUpdated:     number;
  active:          boolean;
  weightEffect:    Record<string, number>;
}

const K = {
  macro:   () => `kira:research:macro`,
  pattern: (id: string) => `kira:pattern:${id}`,
  patterns: () => `kira:patterns`,
};

export class KiraResearch {

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
      return { value: parseInt(entry.value || "50"), label: entry.value_classification || "Neutral" };
    } catch { return null; }
  }

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
    } catch { return null; }
  }

  async getFedRate(): Promise<{ rate: number; lastChange: number; changeBps: number } | null> {
    try {
      const res = await fetch(
        "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFF&vintage_date=" +
        new Date().toISOString().slice(0, 10),
        { signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) return { rate: 5.25, lastChange: 0, changeBps: 0 };
      const csv   = await res.text();
      const lines = csv.trim().split("\n").filter(l => !l.startsWith("DATE"));
      if (!lines.length) return { rate: 5.25, lastChange: 0, changeBps: 0 };
      const last    = lines[lines.length - 1].split(",");
      const prev    = lines[lines.length - 2]?.split(",");
      const current = parseFloat(last[1]);
      const previous = prev ? parseFloat(prev[1]) : current;
      return {
        rate:       current,
        lastChange: Date.now(),
        changeBps:  Math.round((current - previous) * 100),
      };
    } catch { return { rate: 5.25, lastChange: 0, changeBps: 0 }; }
  }

  // ── CPI FEED ──────────────────────────────────────────────────────────────────

  async getCPI(): Promise<{ yoy: number; mom: number; updatedAt: number } | null> {
    try {
      // FRED API — Consumer Price Index (CPIAUCSL series)
      const res = await fetch(
        "https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL",
        { signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) return null;

      const csv   = await res.text();
      const lines = csv.trim().split("\n")
        .filter(l => !l.startsWith("DATE") && l.trim())
        .slice(-14); // last 14 months

      if (lines.length < 13) return null;

      const parseVal = (l: string) => parseFloat(l.split(",")[1] || "0");
      const current  = parseVal(lines[lines.length - 1]);
      const prevMonth = parseVal(lines[lines.length - 2]);
      const yearAgo  = parseVal(lines[lines.length - 13]);

      const yoy = yearAgo  > 0 ? ((current - yearAgo)   / yearAgo)   * 100 : 0;
      const mom = prevMonth > 0 ? ((current - prevMonth) / prevMonth) * 100 : 0;

      return { yoy, mom, updatedAt: Date.now() };

    } catch (err: any) {
      console.error("[Research] CPI fetch failed:", err?.message);
      return null;
    }
  }

  // ── COMPILE MACRO DATA ────────────────────────────────────────────────────────

  async getMacroData(): Promise<MacroData> {
    const cached = await kiraRedis.getJson<MacroData>(K.macro());
    if (cached && Date.now() - cached.fetchedAt < 6 * 60 * 60 * 1000) return cached;

    const [fearGreed, market, fedRate, cpi] = await Promise.allSettled([
      this.getFearGreed(),
      this.getMarketData(),
      this.getFedRate(),
      this.getCPI(),
    ]);

    const fg   = fearGreed.status === "fulfilled" ? fearGreed.value : null;
    const mkt  = market.status    === "fulfilled" ? market.value    : null;
    const fed  = fedRate.status   === "fulfilled" ? fedRate.value   : null;
    const cpiD = cpi.status       === "fulfilled" ? cpi.value       : null;

    const macro: MacroData = {
      fedFundsRate:      fed?.rate        || 5.25,
      lastFedChange:     fed?.lastChange  || 0,
      lastFedChangeBps:  fed?.changeBps   || 0,
      cpiYoY:            cpiD?.yoy        || 0,
      cpiMoM:            cpiD?.mom        || 0,
      cpiLastUpdated:    cpiD?.updatedAt  || 0,
      fearGreedIndex:    fg?.value        || 50,
      fearGreedLabel:    fg?.label        || "Neutral",
      btcDominance:      mkt?.btcDominance   || 50,
      totalMarketCapUsd: mkt?.totalMarketCap || 0,
      fetchedAt:         Date.now(),
    };

    await kiraRedis.setJson(K.macro(), macro);
    return macro;
  }

  scoreMacro(macro: MacroData): { score: number; reasoning: string } {
    let score = 0;
    const reasons: string[] = [];

    if      (macro.fearGreedIndex < 20) { score += 15; reasons.push("Extreme fear = contrarian buy"); }
    else if (macro.fearGreedIndex < 35) { score +=  8; reasons.push("Fear zone = good entry"); }
    else if (macro.fearGreedIndex > 80) { score -= 12; reasons.push("Extreme greed = elevated risk"); }
    else if (macro.fearGreedIndex > 65) { score -=  5; reasons.push("Greed zone = caution"); }

    if      (macro.lastFedChangeBps < -25) { score += 10; reasons.push(`Fed cut ${Math.abs(macro.lastFedChangeBps)}bps`); }
    else if (macro.lastFedChangeBps > 25)  { score -=  8; reasons.push(`Fed hike ${macro.lastFedChangeBps}bps`); }

    if      (macro.btcDominance > 60) { score -= 6; reasons.push("High BTC dom = altcoin headwinds"); }
    else if (macro.btcDominance < 45) { score += 5; reasons.push("Low BTC dom = altcoin season"); }

    // CPI signals
    if (macro.cpiYoY > 0) {
      if      (macro.cpiYoY > 5)  { score -= 5; reasons.push(`High CPI ${macro.cpiYoY.toFixed(1)}% = hawkish risk`); }
      else if (macro.cpiYoY < 2)  { score += 5; reasons.push(`Low CPI ${macro.cpiYoY.toFixed(1)}% = dovish signal`); }
      if      (macro.cpiMoM < 0)  { score += 3; reasons.push("CPI falling MoM = positive"); }
    }

    return { score: Math.max(-20, Math.min(20, score)), reasoning: reasons.join("; ") };
  }

  formatMacroForContext(macro: MacroData): string {
    const cpiStr = macro.cpiYoY > 0
      ? ` | CPI: ${macro.cpiYoY.toFixed(1)}% YoY`
      : "";
    return [
      `Fear/Greed: ${macro.fearGreedIndex} (${macro.fearGreedLabel})`,
      `Fed: ${macro.fedFundsRate}%${macro.lastFedChangeBps !== 0 ? ` (${macro.lastFedChangeBps > 0 ? "+" : ""}${macro.lastFedChangeBps}bps)` : ""}`,
      `BTC dom: ${macro.btcDominance.toFixed(1)}%${cpiStr}`,
    ].join(" | ");
  }

  // ── PATTERN ENGINE ────────────────────────────────────────────────────────────

  async getPattern(id: string): Promise<PatternRecord | null> {
    return kiraRedis.getJson<PatternRecord>(K.pattern(id));
  }

  async getAllPatterns(): Promise<PatternRecord[]> {
    const ids      = await kiraRedis.smembers(K.patterns());
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
      timesObserved: 0, timesCorrect: 0, confidence: 0,
      avgImpact: 0, avgDuration: 0,
      minConfidence, minObservations,
      lastObserved: 0, lastUpdated: Date.now(),
      active: false, weightEffect,
    };
    await kiraRedis.setJson(K.pattern(id), pattern);
    await kiraRedis.sadd(K.patterns(), id);
    return pattern;
  }

  async recordPatternOutcome(
    id: string, correct: boolean, impact: number, days: number
  ): Promise<void> {
    const pattern = await this.getPattern(id);
    if (!pattern) return;
    pattern.timesObserved++;
    if (correct) pattern.timesCorrect++;
    pattern.confidence  = pattern.timesCorrect / pattern.timesObserved;
    const n = pattern.timesObserved;
    pattern.avgImpact   = (pattern.avgImpact   * (n - 1) + impact) / n;
    pattern.avgDuration = (pattern.avgDuration * (n - 1) + days)   / n;
    pattern.lastUpdated = Date.now();
    await kiraRedis.setJson(K.pattern(id), pattern);
  }

  async setPatternActive(id: string, active: boolean): Promise<void> {
    const pattern = await this.getPattern(id);
    if (!pattern) return;
    pattern.active       = active;
    pattern.lastObserved = active ? Date.now() : pattern.lastObserved;
    pattern.lastUpdated  = Date.now();
    await kiraRedis.setJson(K.pattern(id), pattern);
  }

  async getActivePatternAdjustments(): Promise<{ adjustments: Record<string, number>; reasoning: string[] }> {
    const patterns    = await this.getAllPatterns();
    const adjustments: Record<string, number> = {};
    const reasoning:  string[] = [];
    for (const p of patterns) {
      if (p.active && p.confidence >= p.minConfidence && p.timesObserved >= p.minObservations) {
        for (const [signal, delta] of Object.entries(p.weightEffect)) {
          adjustments[signal] = (adjustments[signal] || 0) + delta;
        }
        reasoning.push(`${p.name}: ${(p.confidence * 100).toFixed(0)}% confidence`);
      }
    }
    return { adjustments, reasoning };
  }

  async seedBasePatterns(): Promise<void> {
    await this.initPattern("fed_rate_cut_crypto_rally",    "Fed Rate Cut → Crypto Rally",         "Fed cutting rates historically precedes crypto rallies",           0.65, 4, { liquidityDepth: 0.2, momentumStrength: 0.2 });
    await this.initPattern("extreme_fear_contrarian_buy",  "Extreme Fear → Contrarian Buy",        "F&G below 20 historically signals good medium-term entry",         0.65, 5, { priceVs24hAvg: 0.3, liquidityDepth: 0.2 });
    await this.initPattern("btc_dominance_drop_altseason", "BTC Dominance Drop → Altcoin Season",  "BTC dom below 45% → altcoins outperform",                          0.60, 4, { momentumStrength: 0.3, volumeTrend: 0.2 });
    await this.initPattern("rsi_oversold_volume_spike",    "RSI Oversold + Volume Spike",          "RSI < 30 + 2x volume spike → short-term recovery",                0.65, 5, { priceVs24hAvg: 0.4, momentumStrength: 0.2 });
    await this.initPattern("nft_floor_dip_accumulation",   "NFT Floor Dip + Accumulation",         "Floor dip 30%+ + holder growth → revival",                        0.60, 5, { floorDipDepth: 0.2, holderTrend: 0.3 });
    await this.initPattern("high_cpi_crypto_headwind",     "High CPI → Crypto Headwind",           "CPI above 5% historically creates risk-off environment for crypto", 0.60, 4, { liquidityDepth: -0.2, momentumStrength: -0.1 });
    await this.initPattern("falling_cpi_risk_on",          "Falling CPI → Risk-On Signal",         "CPI declining MoM creates dovish expectations → risk assets benefit", 0.60, 4, { priceVs24hAvg: 0.2, momentumStrength: 0.1 });
    console.log("[Research] Base patterns seeded (7 patterns including CPI)");
  }

  async detectMacroHypotheses(macro: MacroData): Promise<Array<{
    patternId: string; title: string; observation: string; confidence: string; weights: Record<string, number>;
  }>> {
    const hypotheses: Array<{ patternId: string; title: string; observation: string; confidence: string; weights: Record<string, number>; }> = [];

    if (macro.lastFedChangeBps <= -25) {
      const p = await this.getPattern("fed_rate_cut_crypto_rally");
      if (p && p.timesObserved > 0) {
        hypotheses.push({ patternId: "fed_rate_cut_crypto_rally", title: `Fed Rate Cut (${macro.lastFedChangeBps}bps)`, observation: `Fed cut rates by ${Math.abs(macro.lastFedChangeBps)}bps.`, confidence: `${(p.confidence * 100).toFixed(0)}%`, weights: p.weightEffect });
      }
    }
    if (macro.fearGreedIndex < 20) {
      const p = await this.getPattern("extreme_fear_contrarian_buy");
      if (p && p.timesObserved > 0) {
        hypotheses.push({ patternId: "extreme_fear_contrarian_buy", title: `Extreme Fear (${macro.fearGreedIndex})`, observation: `F&G at ${macro.fearGreedIndex}.`, confidence: `${(p.confidence * 100).toFixed(0)}%`, weights: p.weightEffect });
      }
    }
    if (macro.btcDominance < 45) {
      const p = await this.getPattern("btc_dominance_drop_altseason");
      if (p && p.timesObserved > 0) {
        hypotheses.push({ patternId: "btc_dominance_drop_altseason", title: `BTC Dom Low (${macro.btcDominance.toFixed(1)}%)`, observation: `BTC dominance at ${macro.btcDominance.toFixed(1)}%.`, confidence: `${(p.confidence * 100).toFixed(0)}%`, weights: p.weightEffect });
      }
    }
    if (macro.cpiYoY > 5) {
      const p = await this.getPattern("high_cpi_crypto_headwind");
      if (p) {
        hypotheses.push({ patternId: "high_cpi_crypto_headwind", title: `High CPI (${macro.cpiYoY.toFixed(1)}% YoY)`, observation: `CPI at ${macro.cpiYoY.toFixed(1)}% YoY — hawkish environment.`, confidence: `${(p.confidence * 100).toFixed(0)}%`, weights: p.weightEffect });
      }
    }
    if (macro.cpiMoM < 0) {
      const p = await this.getPattern("falling_cpi_risk_on");
      if (p) {
        hypotheses.push({ patternId: "falling_cpi_risk_on", title: "Falling CPI MoM", observation: `CPI fell ${macro.cpiMoM.toFixed(2)}% MoM — dovish signal.`, confidence: `${(p.confidence * 100).toFixed(0)}%`, weights: p.weightEffect });
      }
    }

    return hypotheses;
  }

  async getMarketInsights(): Promise<string[]> {
    const insights: string[] = [];
    try {
      const macro = await this.getMacroData();
      if      (macro.fearGreedIndex < 25) insights.push(`OPPORTUNITY: F&G ${macro.fearGreedIndex} — strong contrarian buy zone`);
      else if (macro.fearGreedIndex > 75) insights.push(`CAUTION: F&G ${macro.fearGreedIndex} — market overheated`);
      if      (macro.btcDominance > 58)   insights.push(`BTC dom ${macro.btcDominance.toFixed(1)}% — altcoin caution`);
      else if (macro.btcDominance < 45)   insights.push(`BTC dom ${macro.btcDominance.toFixed(1)}% — altcoin season`);
      if      (macro.fedFundsRate > 5)    insights.push(`High rate env (${macro.fedFundsRate}%) — quality over quantity`);
      if (macro.cpiYoY > 0) {
        if      (macro.cpiYoY > 5) insights.push(`High CPI ${macro.cpiYoY.toFixed(1)}% — Fed unlikely to cut soon`);
        else if (macro.cpiYoY < 2) insights.push(`Low CPI ${macro.cpiYoY.toFixed(1)}% — rate cuts possible`);
        if      (macro.cpiMoM < 0) insights.push(`CPI falling MoM — disinflationary trend forming`);
      }
    } catch {}
    return insights;
  }
}
