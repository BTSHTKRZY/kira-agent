// sourcelearning.ts — ARC 3 of the "Close the Loop" build (the closure).
//
// THE THESIS (the "Harvard isn't working, try Yale" arc):
//   KIRA's conviction calls carry attribution: which knowledge SOURCES fed each decision
//   ("seed", "ingested", "promoted_learning"). When calls resolve, Arc 2 computes per-source
//   YIELD. Arc 3 closes the loop: it feeds that yield back into HOW MUCH KIRA TRUSTS each
//   source when retrieving knowledge — favoring sources that lead to good calls, deprioritizing
//   those that lead to bad ones. Accumulation becomes self-correcting intelligence.
//
// WHY THIS IS THE RISKIEST ARC — and how it's made safe:
//   A loop that reweights its own inputs based on outcomes can THRASH: kill a source after
//   two unlucky calls, or spiral (down-weight → read less → never learn it was fine). With
//   tiny samples (we have ~0 resolved calls right now), naive reweighting would learn pure
//   noise. So Arc 3 is built with hard guardrails:
//     1. SAMPLE-GATED   — a source's weight does not move until it has ≥ MIN_RESOLVED calls.
//                         Below that, weight stays neutral (1.0). This is the key safety: it
//                         ACCUMULATES data now but does NOTHING until there's enough to mean
//                         something — exactly the discipline we agreed on.
//     2. FLOOR + CEIL   — weights clamp to [MIN_WEIGHT, MAX_WEIGHT]; nothing is ever fully
//                         killed (so a deprioritized source can still recover) or allowed to
//                         dominate.
//     3. SLOW + BOUNDED — each update nudges weight toward the yield-implied target by only
//                         a fraction (LEARNING_RATE); no single result swings it hard.
//     4. RELATIVE       — yield is judged vs. the overall call win-rate, so a source isn't
//                         punished for KIRA simply trading a bad market (everything losing).
//
// NON-MONEY-TOUCHING. This only changes retrieval ordering/weighting of KNOWLEDGE — never
// touches funds, trades, or execution.

import { kiraRedis } from "./redis.js";
import { ConvictionCall } from "./convictioncalls.js";

const K = {
  weights: () => `kira:source_weights`,
};

// ── SAFETY CONSTANTS (deliberately conservative) ──────────────────────────────
const MIN_RESOLVED  = parseInt(process.env.SRC_MIN_RESOLVED  || "8");   // no weight movement below this sample
const MIN_WEIGHT    = parseFloat(process.env.SRC_MIN_WEIGHT  || "0.5"); // never fully kill a source
const MAX_WEIGHT    = parseFloat(process.env.SRC_MAX_WEIGHT  || "1.5"); // never let one dominate
const LEARNING_RATE = parseFloat(process.env.SRC_LEARN_RATE  || "0.15");// fraction of the gap moved per update (slow)
const NEUTRAL       = 1.0;

export interface SourceWeight {
  source:      string;
  weight:      number;    // multiplier applied to retrieval relevance (1.0 = neutral)
  n:           number;    // resolved calls observed for this source
  lastYield:   number;    // last computed avg pnl for this source
  active:      boolean;   // true once sample-gate passed and weight is actually moving
  updatedAt:   number;
}

export class KiraSourceLearning {

  async getWeights(): Promise<Record<string, SourceWeight>> {
    return (await kiraRedis.getJson<Record<string, SourceWeight>>(K.weights())) || {};
  }

  // Multiplier for a source (1.0 if unknown / not yet active). Used by retrieval to bias
  // ordering toward higher-yielding sources. Safe default = neutral.
  async weightFor(source: string): Promise<number> {
    const w = await this.getWeights();
    return w[source]?.weight ?? NEUTRAL;
  }

  // ── THE LEARNING STEP ───────────────────────────────────────────────────────
  // Recompute source weights from resolved calls. Called periodically (not every cycle).
  // Returns a human-readable summary of what changed (or why nothing did).
  async update(allCalls: ConvictionCall[]): Promise<{ changed: boolean; summary: string; weights: Record<string, SourceWeight> }> {
    const resolved = allCalls.filter(c => c.resolved && c.attribution?.degraded !== true);
    const weights = await this.getWeights();

    if (resolved.length === 0) {
      return { changed: false, summary: "Arc 3: no resolved calls yet — source weights neutral, accumulating.", weights };
    }

    // Overall baseline: average pnl across all reliable resolved calls. A source is judged
    // RELATIVE to this, so it isn't punished for a uniformly bad market.
    const overallAvg = resolved.reduce((s, c) => s + (c.pnlPct || 0), 0) / resolved.length;

    // Group resolved calls by source.
    const bySource: Record<string, ConvictionCall[]> = {};
    for (const c of resolved) {
      for (const src of (c.attribution?.knowledgeSources || [])) {
        (bySource[src] ||= []).push(c);
      }
    }

    let changed = false;
    const movements: string[] = [];

    for (const [source, calls] of Object.entries(bySource)) {
      const n = calls.length;
      const avgYield = calls.reduce((s, c) => s + (c.pnlPct || 0), 0) / n;
      const prev = weights[source] || { source, weight: NEUTRAL, n: 0, lastYield: 0, active: false, updatedAt: 0 };

      // SAMPLE GATE: below MIN_RESOLVED, record the data but DO NOT move the weight.
      if (n < MIN_RESOLVED) {
        weights[source] = { ...prev, source, n, lastYield: avgYield, active: false, updatedAt: Date.now() };
        continue;
      }

      // Above the gate: nudge weight toward a yield-implied target, RELATIVE to overall.
      // Sources beating the overall avg drift toward MAX_WEIGHT; laggards toward MIN_WEIGHT.
      const edge = avgYield - overallAvg;                 // + = this source beats KIRA's baseline
      // Map edge to a target in [MIN_WEIGHT, MAX_WEIGHT]. ±10pp edge ≈ full swing.
      const target = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, NEUTRAL + (edge / 10) * (MAX_WEIGHT - NEUTRAL)));
      const newWeight = prev.weight + (target - prev.weight) * LEARNING_RATE;  // slow move
      const clamped = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, newWeight));

      if (Math.abs(clamped - prev.weight) > 0.001) {
        changed = true;
        movements.push(`${source}: ${prev.weight.toFixed(2)}→${clamped.toFixed(2)} (yield ${avgYield >= 0 ? "+" : ""}${avgYield.toFixed(1)}% vs base ${overallAvg >= 0 ? "+" : ""}${overallAvg.toFixed(1)}%, n=${n})`);
      }
      weights[source] = { source, weight: clamped, n, lastYield: avgYield, active: true, updatedAt: Date.now() };
    }

    await kiraRedis.setJson(K.weights(), weights);
    const activeCount = Object.values(weights).filter(w => w.active).length;
    const summary = changed
      ? `Arc 3: source weights updated — ${movements.join(" | ")}`
      : `Arc 3: ${activeCount} source(s) active, none moved this cycle (${resolved.length} resolved calls, baseline ${overallAvg >= 0 ? "+" : ""}${overallAvg.toFixed(1)}%).`;
    return { changed, summary, weights };
  }

  // Compact status for digests / context.
  async formatForContext(): Promise<string> {
    const w = await this.getWeights();
    const entries = Object.values(w);
    if (entries.length === 0) return "Source learning (Arc 3): no data yet — all sources neutral.";
    const active = entries.filter(e => e.active);
    if (active.length === 0) {
      const near = entries.sort((a,b) => b.n - a.n)[0];
      return `Source learning (Arc 3): accumulating — no source has hit the ${MIN_RESOLVED}-call gate yet (top: ${near.source} n=${near.n}). Weights neutral.`;
    }
    return "Source learning (Arc 3): " + active
      .sort((a, b) => b.weight - a.weight)
      .map(e => `${e.source} ×${e.weight.toFixed(2)} (n=${e.n}, yield ${e.lastYield >= 0 ? "+" : ""}${e.lastYield.toFixed(1)}%)`)
      .join(" | ");
  }
}
