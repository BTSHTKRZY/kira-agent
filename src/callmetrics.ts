// callmetrics.ts — ARC 2 of the "Close the Loop" build.
//
// WHAT THIS DOES:
//   Arc 1 made KIRA take owned calls, each tagged with WHICH knowledge/sources fed it.
//   Arc 2 reads the RESOLVED calls and answers the questions we could never answer before:
//     1. KNOWLEDGE LIFT — do calls that used corpus knowledge resolve better than ones
//        that didn't? (Is the corpus actually helping her decisions, or just decorating?)
//     2. SOURCE YIELD — when a call wins/loses, credit/debit the SOURCES that fed it.
//        Over time: is seed knowledge yielding? Is research-ingested knowledge yielding?
//        (This is the data Arc 3 will use to decide "Harvard isn't working, try Yale.")
//     3. CONVICTION CALIBRATION — do her "high" conviction calls actually outperform her
//        "low" ones? (Is her own confidence meaningful, or noise?)
//
// THE HONESTY REQUIREMENT (non-negotiable, per the build spec):
//   With few resolved calls, NONE of these numbers mean anything. A 100% win rate over
//   2 calls is noise. So EVERY metric this produces is stamped with its sample size and a
//   plain-English confidence label, and the report leads with a blunt caveat when the
//   sample is too small. We are building the INSTRUMENT now; it will not give trustworthy
//   readings until weeks of calls accumulate. This module must never present a small-sample
//   number as if it were a finding.
//
// Arc 2 is pure read-and-compute over Arc 1's resolved calls. It changes nothing about how
// calls are made or recorded. Non-money-touching.

import { ConvictionCall } from "./convictioncalls.js";

// Minimum resolved calls before a metric is considered even weakly meaningful.
const MIN_SAMPLE_WEAK   = 5;
const MIN_SAMPLE_DECENT = 15;
const MIN_SAMPLE_GOOD   = 30;

function confidenceLabel(n: number): string {
  if (n === 0) return "no data";
  if (n < MIN_SAMPLE_WEAK)   return `NOT MEANINGFUL (only ${n} resolved — noise)`;
  if (n < MIN_SAMPLE_DECENT) return `weak signal (${n} resolved — treat as directional only)`;
  if (n < MIN_SAMPLE_GOOD)   return `moderate signal (${n} resolved)`;
  return `reasonable signal (${n} resolved)`;
}

export interface GroupStat {
  n:         number;
  wins:      number;
  losses:    number;
  flats:     number;
  winRate:   number;
  avgPnlPct: number;
}

export interface SourceYield {
  source:    string;
  n:         number;        // resolved calls that used this source
  wins:      number;
  losses:    number;
  avgPnlPct: number;
  winRate:   number;
  confidence: string;
}

export interface QualityReport {
  resolvedTotal:   number;
  overall:         GroupStat;
  knowledgeLift: {
    withKnowledge:    GroupStat;
    withoutKnowledge: GroupStat;
    liftPct:          number | null;   // (withKnowledge avgPnl) - (without) ; null if either empty
    interpretation:   string;
  };
  sourceYields:    SourceYield[];
  convictionCalibration: {
    high:   GroupStat;
    medium: GroupStat;
    low:    GroupStat;
    interpretation: string;
  };
  caveat:          string;
}

function emptyGroup(): GroupStat {
  return { n: 0, wins: 0, losses: 0, flats: 0, winRate: 0, avgPnlPct: 0 };
}

function statFromCalls(calls: ConvictionCall[]): GroupStat {
  const g = emptyGroup();
  let pnlSum = 0;
  for (const c of calls) {
    if (!c.resolved) continue;
    g.n++;
    if (c.outcome === "win") g.wins++;
    else if (c.outcome === "loss") g.losses++;
    else g.flats++;
    pnlSum += (c.pnlPct || 0);
  }
  g.winRate   = g.n > 0 ? g.wins / g.n : 0;
  g.avgPnlPct = g.n > 0 ? pnlSum / g.n : 0;
  return g;
}

export class KiraCallMetrics {

  // Compute the full quality report from resolved calls. `allCalls` comes from
  // convictionCalls.getAllCalls(). Only resolved calls contribute to metrics.
  compute(allCalls: ConvictionCall[]): QualityReport {
    const resolved = allCalls.filter(c => c.resolved);
    const overall  = statFromCalls(resolved);

    // ── KNOWLEDGE LIFT ────────────────────────────────────────────────────────
    // Exclude calls whose attribution is DEGRADED (retrieval failed) — counting them as
    // "no knowledge used" would corrupt the comparison.
    const reliable = resolved.filter(c => c.attribution?.degraded !== true);
    const withK    = reliable.filter(c => (c.attribution?.knowledgeIds?.length || 0) > 0);
    const withoutK = reliable.filter(c => (c.attribution?.knowledgeIds?.length || 0) === 0);
    const gWith    = statFromCalls(withK);
    const gWithout = statFromCalls(withoutK);
    let liftPct: number | null = null;
    let liftInterp: string;
    if (gWith.n === 0 || gWithout.n === 0) {
      liftInterp = gWith.n === 0
        ? "No knowledge-informed calls resolved yet."
        : "No knowledge-FREE calls to compare against yet — can't isolate the corpus's effect. (KIRA almost always retrieves something, so a clean control group may be rare; treat knowledge-lift cautiously.)";
    } else {
      liftPct = gWith.avgPnlPct - gWithout.avgPnlPct;
      const dir = liftPct > 0 ? "BETTER" : liftPct < 0 ? "WORSE" : "no different";
      liftInterp = `Knowledge-informed calls performed ${dir} by ${Math.abs(liftPct).toFixed(1)}pp avg P&L. ` +
        `${confidenceLabel(Math.min(gWith.n, gWithout.n))}.`;
    }

    // ── SOURCE YIELD ──────────────────────────────────────────────────────────
    // Each resolved call credits/debits every source that fed it.
    const bySource: Record<string, ConvictionCall[]> = {};
    for (const c of resolved) {
      if (c.attribution?.degraded === true) continue;  // unreliable attribution — skip
      const sources = c.attribution?.knowledgeSources || [];
      for (const s of sources) {
        (bySource[s] ||= []).push(c);
      }
    }
    const sourceYields: SourceYield[] = Object.entries(bySource).map(([source, calls]) => {
      const g = statFromCalls(calls);
      return {
        source, n: g.n, wins: g.wins, losses: g.losses,
        avgPnlPct: g.avgPnlPct, winRate: g.winRate,
        confidence: confidenceLabel(g.n),
      };
    }).sort((a, b) => b.avgPnlPct - a.avgPnlPct);

    // ── CONVICTION CALIBRATION ────────────────────────────────────────────────
    const high   = statFromCalls(resolved.filter(c => c.conviction === "high"));
    const medium = statFromCalls(resolved.filter(c => c.conviction === "medium"));
    const low    = statFromCalls(resolved.filter(c => c.conviction === "low"));
    let convInterp: string;
    if (high.n === 0 && medium.n === 0 && low.n === 0) {
      convInterp = "No resolved calls yet.";
    } else if (high.n >= MIN_SAMPLE_WEAK && low.n >= MIN_SAMPLE_WEAK) {
      convInterp = high.avgPnlPct > low.avgPnlPct
        ? `Her conviction is calibrated: high-conviction calls (avg ${high.avgPnlPct.toFixed(1)}%) outperform low (avg ${low.avgPnlPct.toFixed(1)}%). Good sign.`
        : `WARNING: her high-conviction calls (avg ${high.avgPnlPct.toFixed(1)}%) are NOT beating her low-conviction (avg ${low.avgPnlPct.toFixed(1)}%). Her confidence may be miscalibrated — worth investigating.`;
    } else {
      convInterp = `Conviction breakdown: high=${high.n}, medium=${medium.n}, low=${low.n} resolved. Too few in each bucket to judge calibration yet.`;
    }

    // ── BLUNT TOP-LEVEL CAVEAT ────────────────────────────────────────────────
    let caveat: string;
    if (overall.n === 0) {
      caveat = "No conviction calls have resolved yet. No metrics are meaningful. This report is the empty instrument — it will fill as calls resolve (~7 days each).";
    } else if (overall.n < MIN_SAMPLE_WEAK) {
      caveat = `⚠️ ONLY ${overall.n} CALL(S) RESOLVED. Every number below is NOISE, not signal. Do not draw conclusions. Shown only to confirm the instrument works. Meaningful readings need ~${MIN_SAMPLE_DECENT}+ resolved calls (weeks away).`;
    } else if (overall.n < MIN_SAMPLE_DECENT) {
      caveat = `⚠️ Small sample (${overall.n} resolved). Treat everything as directional hints, not findings. Trends may reverse entirely with more data.`;
    } else {
      caveat = `${overall.n} calls resolved — metrics are becoming directionally useful, still not statistically strong. Keep accumulating.`;
    }

    return {
      resolvedTotal: overall.n,
      overall,
      knowledgeLift: { withKnowledge: gWith, withoutKnowledge: gWithout, liftPct, interpretation: liftInterp },
      sourceYields,
      convictionCalibration: { high, medium, low, interpretation: convInterp },
      caveat,
    };
  }

  // Render the report as a readable text block for the quality digest email.
  format(report: QualityReport): string {
    const L: string[] = [];
    const pct = (g: GroupStat) => `${g.n} resolved, ${g.wins}W/${g.losses}L/${g.flats}F, win ${(g.winRate*100).toFixed(0)}%, avg ${g.avgPnlPct>=0?"+":""}${g.avgPnlPct.toFixed(1)}%`;

    L.push("KIRA — Decision Quality Report (Arc 2)");
    L.push("=".repeat(44));
    L.push("");
    L.push(report.caveat);
    L.push("");
    L.push(`OVERALL: ${pct(report.overall)}`);
    L.push("");
    L.push("KNOWLEDGE LIFT (does the corpus help her decisions?):");
    L.push(`  With corpus knowledge:    ${pct(report.knowledgeLift.withKnowledge)}`);
    L.push(`  Without corpus knowledge: ${pct(report.knowledgeLift.withoutKnowledge)}`);
    L.push(`  → ${report.knowledgeLift.interpretation}`);
    L.push("");
    L.push("SOURCE YIELD (which knowledge sources lead to good calls?):");
    if (report.sourceYields.length === 0) {
      L.push("  (no resolved calls with sourced knowledge yet)");
    } else {
      for (const s of report.sourceYields) {
        L.push(`  [${s.source}] ${s.n} calls, win ${(s.winRate*100).toFixed(0)}%, avg ${s.avgPnlPct>=0?"+":""}${s.avgPnlPct.toFixed(1)}% — ${s.confidence}`);
      }
    }
    L.push("");
    L.push("CONVICTION CALIBRATION (do her 'high' calls beat her 'low' calls?):");
    L.push(`  high:   ${pct(report.convictionCalibration.high)}`);
    L.push(`  medium: ${pct(report.convictionCalibration.medium)}`);
    L.push(`  low:    ${pct(report.convictionCalibration.low)}`);
    L.push(`  → ${report.convictionCalibration.interpretation}`);
    L.push("");
    L.push("(Arc 3 will use source-yield to steer what KIRA reads and retrieves. Until the");
    L.push(" sample grows, these are observations, not yet inputs to any automated change.)");
    return L.join("\n");
  }

  // Short one-liner for the decision context / activity digest.
  formatBrief(report: QualityReport): string {
    if (report.resolvedTotal === 0) return "Decision quality: no calls resolved yet (instrument ready).";
    const o = report.overall;
    return `Decision quality: ${o.n} resolved, win ${(o.winRate*100).toFixed(0)}%, avg ${o.avgPnlPct>=0?"+":""}${o.avgPnlPct.toFixed(1)}% — ${report.resolvedTotal < 5 ? "NOISE, not signal yet" : report.resolvedTotal < 15 ? "directional only" : "becoming meaningful"}.`;
  }
}
