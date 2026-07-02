// sourcelearning.ts — ARC 3 (item-level): "which of KIRA's trading BELIEFS actually work?"
//
// ── WHY THIS WAS RE-AIMED (Jun 30 2026) ──────────────────────────────────────
// Arc 3 originally learned per-SOURCE yield ("seed" vs "ingested" vs "promoted"). In
// practice that produced no signal: virtually every trading call retrieves market-belief
// items that are ALL source="seed" (extreme-fear-contrarian, BTC-dominance-altseason,
// CPI-headwind...), while "ingested" items are infra/protocol knowledge (x402, ERC-8183)
// that is correctly NOT retrieved for trading decisions — different domain. So source-level
// yield compared things that don't compete for the same decisions (a category mismatch).
//
// RE-AIMED: Arc 3 now learns per-ITEM yield — which SPECIFIC beliefs lead to good calls.
// Does "extreme fear -> contrarian entry" actually win? Does "BTC dominance -> altseason"?
// Beliefs that earn their keep get up-weighted in retrieval; beliefs that consistently lead
// to losers get down-weighted. This is genuine trading self-improvement: KIRA learns which
// of her OWN convictions have edge, and leans on those. Same safe machinery as before:
//   - SAMPLE-GATED  — an item's weight doesn't move until it has >= MIN_RESOLVED calls citing it.
//   - FLOOR + CEIL  — weights clamp to [MIN_WEIGHT, MAX_WEIGHT]; a belief is never fully killed
//                     (it can recover) nor allowed to dominate.
//   - SLOW          — each update nudges weight a fraction (LEARNING_RATE) toward the target.
//   - RELATIVE      — an item's yield is judged vs. the OVERALL call average, so a belief
//                     isn't punished for KIRA simply trading a bad market (all calls losing).
//
// ── KNOWN LIMITATION (honest) ────────────────────────────────────────────────
// KIRA's beliefs are CORRELATED: most calls retrieve the same ~5 market items together as a
// bundle, so disentangling which one drove the outcome is hard when they always co-occur.
// Item-level yield will therefore be slow to produce clean signal, and the sample-gate keeps
// it neutral until an item has enough independent data. This is measurement, not magic.
//
// ── ARCHITECTURAL CEILING (deliberate, parked as future scope) ────────────────
// This learns the WEIGHTING of beliefs KIRA ALREADY HAS. It does NOT let her DISCOVER new
// belief/factor categories she wasn't given (seeded or ingested). The vocabulary of factors
// is authored; only the weights on that vocabulary are learned. TIER-3 FACTOR DISCOVERY —
// KIRA inventing her own predictive factors from raw data — is a separate, harder, riskier
// future build (overfitting risk, best attempted post-#12). See ROADMAP note. Not this build.
//
// NON-MONEY-TOUCHING. Only changes retrieval ordering/weighting of KNOWLEDGE items.

import { kiraRedis } from "./redis.js";
import { ConvictionCall } from "./convictioncalls.js";

const K = {
  weights: () => `kira:item_weights`,   // re-aimed key (was kira:source_weights)
};

// ── SAFETY CONSTANTS (deliberately conservative) ──────────────────────────────
const MIN_RESOLVED  = parseInt(process.env.ITEM_MIN_RESOLVED  || "8");   // no weight movement below this per-item sample
const MIN_WEIGHT    = parseFloat(process.env.ITEM_MIN_WEIGHT  || "0.5"); // never fully kill a belief
const MAX_WEIGHT    = parseFloat(process.env.ITEM_MAX_WEIGHT  || "1.5"); // never let one dominate
const LEARNING_RATE = parseFloat(process.env.ITEM_LEARN_RATE  || "0.15");// slow
const NEUTRAL       = 1.0;

export interface ItemWeight {
  itemId:    string;
  weight:    number;    // multiplier applied to this item's retrieval relevance (1.0 = neutral)
  n:         number;    // resolved calls that CITED this item
  lastYield: number;    // last computed avg pnl for calls citing this item
  active:    boolean;   // true once sample-gate passed
  updatedAt: number;
}

export class KiraSourceLearning {   // name kept for import stability across index.ts

  async getWeights(): Promise<Record<string, ItemWeight>> {
    return (await kiraRedis.getJson<Record<string, ItemWeight>>(K.weights())) || {};
  }

  // Multiplier for a specific knowledge ITEM (1.0 if unknown / not yet active). Retrieval
  // uses this to bias ordering toward higher-yielding beliefs. Safe default = neutral.
  async weightFor(itemId: string): Promise<number> {
    const w = await this.getWeights();
    return w[itemId]?.weight ?? NEUTRAL;
  }

  // ── THE LEARNING STEP ───────────────────────────────────────────────────────
  // Recompute per-item weights from resolved calls. Called periodically (on resolution).
  async update(allCalls: ConvictionCall[]): Promise<{ changed: boolean; summary: string; weights: Record<string, ItemWeight> }> {
    const resolved = allCalls.filter(c => c.resolved && c.attribution?.degraded !== true);
    const weights = await this.getWeights();

    if (resolved.length === 0) {
      return { changed: false, summary: "Arc 3 (item-level): no resolved calls yet — belief weights neutral, accumulating.", weights };
    }

    // Baseline: average pnl across all reliable resolved calls. Each item judged RELATIVE to
    // this, so a belief isn't punished for a uniformly bad market.
    const overallAvg = resolved.reduce((s, c) => s + (c.pnlPct || 0), 0) / resolved.length;

    // Group resolved calls by the knowledge ITEMS they cited.
    const byItem: Record<string, ConvictionCall[]> = {};
    for (const c of resolved) {
      for (const id of (c.attribution?.knowledgeIds || [])) {
        (byItem[id] ||= []).push(c);
      }
    }

    let changed = false;
    const movements: string[] = [];

    for (const [itemId, calls] of Object.entries(byItem)) {
      const n = calls.length;
      const avgYield = calls.reduce((s, c) => s + (c.pnlPct || 0), 0) / n;
      const prev = weights[itemId] || { itemId, weight: NEUTRAL, n: 0, lastYield: 0, active: false, updatedAt: 0 };

      // SAMPLE GATE: below MIN_RESOLVED citations, record but DO NOT move the weight.
      if (n < MIN_RESOLVED) {
        weights[itemId] = { ...prev, itemId, n, lastYield: avgYield, active: false, updatedAt: Date.now() };
        continue;
      }

      // Above the gate: nudge weight toward a yield-implied target, RELATIVE to overall.
      const edge = avgYield - overallAvg;                 // + = this belief beats KIRA's baseline
      const target = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, NEUTRAL + (edge / 10) * (MAX_WEIGHT - NEUTRAL)));
      const newWeight = prev.weight + (target - prev.weight) * LEARNING_RATE;
      const clamped = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, newWeight));

      if (Math.abs(clamped - prev.weight) > 0.001) {
        changed = true;
        movements.push(`${itemId}: ${prev.weight.toFixed(2)}->${clamped.toFixed(2)} (yield ${avgYield >= 0 ? "+" : ""}${avgYield.toFixed(1)}% vs base ${overallAvg >= 0 ? "+" : ""}${overallAvg.toFixed(1)}%, n=${n})`);
      }
      weights[itemId] = { itemId, weight: clamped, n, lastYield: avgYield, active: true, updatedAt: Date.now() };
    }

    await kiraRedis.setJson(K.weights(), weights);
    const activeCount = Object.values(weights).filter(w => w.active).length;
    const summary = changed
      ? `Arc 3 (item-level): belief weights updated — ${movements.join(" | ")}`
      : `Arc 3 (item-level): ${activeCount} belief(s) active, none moved this cycle (${resolved.length} resolved calls, baseline ${overallAvg >= 0 ? "+" : ""}${overallAvg.toFixed(1)}%).`;
    return { changed, summary, weights };
  }

  // Compact status for digests / context.
  async formatForContext(): Promise<string> {
    const w = await this.getWeights();
    const entries = Object.values(w);
    if (entries.length === 0) return "Belief learning (Arc 3): no data yet — all beliefs neutral.";
    const active = entries.filter(e => e.active);
    if (active.length === 0) {
      const near = entries.sort((a, b) => b.n - a.n)[0];
      return `Belief learning (Arc 3): accumulating — no belief has hit the ${MIN_RESOLVED}-call gate yet (top: ${near.itemId} n=${near.n}). Weights neutral.`;
    }
    return "Belief learning (Arc 3): " + active
      .sort((a, b) => b.weight - a.weight)
      .map(e => `${e.itemId} x${e.weight.toFixed(2)} (n=${e.n}, yield ${e.lastYield >= 0 ? "+" : ""}${e.lastYield.toFixed(1)}%)`)
      .join(" | ");
  }
}
