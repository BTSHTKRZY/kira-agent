// convictioncalls.ts — ARC 1 of the "Close the Loop" build.
//
// THE GAP THIS FILLS:
//   KIRA has elaborate scoring + shadow-learning, but she has NEVER made a call.
//   Scores cluster 39-48, the buy threshold is 70, so nothing ever fires → Paper: 0
//   forever. An agent that never acts cannot be measured, learned-from, or trusted.
//   Shadows are PASSIVE (what would've happened to things she watched); they tune
//   signal weights but never test KIRA's own judgment.
//
// WHAT A CONVICTION CALL IS:
//   KIRA's OWNED decision — "of everything I can see right now, THIS is my best pick,
//   here is my thesis and conviction." She commits it as a recorded paper position
//   (no money) that resolves against real price into HER track record. This is the
//   first thing in the system that represents KIRA's judgment being put on the line.
//
// THE LOAD-BEARING PART — ATTRIBUTION:
//   Each call records WHICH corpus items (and their SOURCES) were retrieved into the
//   decision. This is what later arcs need: outcomes will judge inputs ("did calls
//   informed by Harvard-sourced knowledge actually resolve better than Yale-sourced?").
//   Without this tag, Arcs 2-3 cannot exist. Capture it now even though Arc 1 doesn't
//   yet consume it.
//
// CONSERVATIVE BY DESIGN:
//   A few calls per week, not churn. We want a record of CONSIDERED judgments, not a
//   flurry of noise. Cooldown + a max-open cap enforce this. Non-money-touching always.

import { kiraRedis } from "./redis.js";

export interface CallAttribution {
  knowledgeIds:     string[];   // corpus item ids retrieved into this decision
  knowledgeSources: string[];   // their sources ("seed" | "promoted_learning" | "ingested")
  signals:          Record<string, number>;  // the scoring signals that drove it
}

export interface ConvictionCall {
  id:           string;
  type:         "nft" | "token";
  address:      string;
  chain:        string;
  name:         string;
  // The decision
  score:        number;         // her score for it at call time (may be < 70 — relative best)
  thesis:       string;         // why THIS, in her words
  conviction:   "low" | "medium" | "high";
  entryPrice:   number;
  entryTime:    number;
  horizonDays:  number;
  // Attribution (load-bearing for Arcs 2-3)
  attribution:  CallAttribution;
  // Outcome (filled on resolution)
  resolved:     boolean;
  exitPrice?:   number;
  exitTime?:    number;
  pnlPct?:      number;
  outcome?:     "win" | "loss" | "flat";
  resolveNote?: string;
}

export interface CallTrackRecord {
  total:        number;
  resolved:     number;
  wins:         number;
  losses:       number;
  flats:        number;
  winRate:      number;        // resolved wins / resolved total
  avgPnlPct:    number;        // mean resolved pnl
  open:         number;
}

const K = {
  call:    (id: string) => `kira:call:${id}`,
  calls:   ()           => `kira:calls`,           // set of all call ids
  open:    ()           => `kira:calls:open`,       // set of open call ids
  counter: ()           => `kira:calls:counter`,
  lastCall:()           => `kira:calls:lastts`,     // cadence control
};

// Cadence guards — keep calls deliberate, not churny.
const CALL_COOLDOWN_MS   = parseInt(process.env.CALL_COOLDOWN_MS   || String(36 * 60 * 60 * 1000)); // ~1.5 days between calls
const MAX_OPEN_CALLS     = parseInt(process.env.MAX_OPEN_CALLS     || "5");   // at most 5 live judgments at once
const DEFAULT_HORIZON    = parseInt(process.env.CALL_HORIZON_DAYS  || "7");
const FLAT_BAND_PCT      = 2;     // |pnl| < 2% counts as "flat", not win/loss
// Same data-artifact guard the shadow system uses: a >±500% short-horizon move on a
// tracked asset is a mis-scaled/near-zero price, not a real move. Don't let it pollute
// the track record.
const MAX_PLAUSIBLE_ABS_PNL_PCT = 500;

export class KiraConvictionCalls {

  private async nextId(): Promise<string> {
    const n = parseInt(await kiraRedis.get(K.counter()) || "0") + 1;
    await kiraRedis.set(K.counter(), String(n));
    return `c${n}`;
  }

  private safePnlPct(entry: number, exit: number): number | null {
    if (!entry || entry <= 0 || !exit || exit <= 0) return null;
    const pct = ((exit - entry) / entry) * 100;
    if (!isFinite(pct) || Math.abs(pct) > MAX_PLAUSIBLE_ABS_PNL_PCT) return null;
    return pct;
  }

  // ── CADENCE: can KIRA make a call right now? ────────────────────────────────
  // Returns a reason string if blocked, or null if clear. Keeps calls deliberate.
  async cooldownStatus(): Promise<{ canCall: boolean; reason: string; openCount: number }> {
    const openIds  = await kiraRedis.getJson<string[]>(K.open()) || [];
    const openCount = openIds.length;
    if (openCount >= MAX_OPEN_CALLS) {
      return { canCall: false, reason: `Max open calls reached (${openCount}/${MAX_OPEN_CALLS}) — let some resolve first`, openCount };
    }
    const last = parseInt(await kiraRedis.get(K.lastCall()) || "0");
    const since = Date.now() - last;
    if (last > 0 && since < CALL_COOLDOWN_MS) {
      const hrs = Math.round((CALL_COOLDOWN_MS - since) / 3.6e6);
      return { canCall: false, reason: `Call cooldown active (~${hrs}h remaining) — calls stay deliberate`, openCount };
    }
    return { canCall: true, reason: "clear", openCount };
  }

  // ── RECORD a conviction call (KIRA's owned decision) ────────────────────────
  async recordCall(params: {
    type: "nft" | "token";
    address: string;
    chain: string;
    name: string;
    score: number;
    thesis: string;
    conviction: "low" | "medium" | "high";
    entryPrice: number;
    attribution: CallAttribution;
    horizonDays?: number;
  }): Promise<ConvictionCall | null> {
    if (!params.entryPrice || params.entryPrice <= 0) return null;
    const id = await this.nextId();
    const call: ConvictionCall = {
      id,
      type:        params.type,
      address:     params.address,
      chain:       params.chain,
      name:        params.name,
      score:       params.score,
      thesis:      params.thesis,
      conviction:  params.conviction,
      entryPrice:  params.entryPrice,
      entryTime:   Date.now(),
      horizonDays: params.horizonDays || DEFAULT_HORIZON,
      attribution: params.attribution,
      resolved:    false,
    };
    await kiraRedis.setJson(K.call(id), call);
    const all  = await kiraRedis.getJson<string[]>(K.calls()) || [];
    const open = await kiraRedis.getJson<string[]>(K.open())  || [];
    all.push(id); open.push(id);
    await kiraRedis.setJson(K.calls(), all.slice(-1000));
    await kiraRedis.setJson(K.open(),  open);
    await kiraRedis.set(K.lastCall(), String(Date.now()));
    return call;
  }

  // ── RESOLVE matured calls against real price ────────────────────────────────
  // priceLookup returns the current price for a call's asset, or null if unavailable.
  async resolveMatured(
    priceLookup: (c: ConvictionCall) => Promise<number | null>
  ): Promise<{ resolved: number; notes: string[] }> {
    const open = await kiraRedis.getJson<string[]>(K.open()) || [];
    if (!open.length) return { resolved: 0, notes: [] };
    const stillOpen: string[] = [];
    const notes: string[] = [];
    let resolved = 0;

    for (const id of open) {
      const call = await kiraRedis.getJson<ConvictionCall>(K.call(id));
      if (!call || call.resolved) continue;
      const matured = Date.now() - call.entryTime >= call.horizonDays * 24 * 60 * 60 * 1000;
      if (!matured) { stillOpen.push(id); continue; }

      const price = await priceLookup(call);
      if (price === null || price === undefined) {
        // Can't price it yet — keep it open, try next cycle.
        stillOpen.push(id);
        continue;
      }
      const pnl = this.safePnlPct(call.entryPrice, price);
      if (pnl === null) {
        // Implausible/corrupted price — resolve as flat with a note so it doesn't poison stats.
        call.resolved = true;
        call.exitPrice = price;
        call.exitTime = Date.now();
        call.pnlPct = 0;
        call.outcome = "flat";
        call.resolveNote = "excluded from P&L — implausible price (data artifact)";
        await kiraRedis.setJson(K.call(id), call);
        notes.push(`${call.name}: excluded (bad price)`);
        resolved++;
        continue;
      }
      call.resolved  = true;
      call.exitPrice = price;
      call.exitTime  = Date.now();
      call.pnlPct    = pnl;
      call.outcome   = pnl > FLAT_BAND_PCT ? "win" : pnl < -FLAT_BAND_PCT ? "loss" : "flat";
      await kiraRedis.setJson(K.call(id), call);
      notes.push(`${call.name}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}% (${call.outcome})`);
      resolved++;
    }
    await kiraRedis.setJson(K.open(), stillOpen);
    return { resolved, notes };
  }

  // ── ABSTENTION: a deliberate no-trade is also a decision ────────────────────
  // When KIRA's best available setup doesn't clear the quality floor, abstaining is the
  // CORRECT judgment (a good trader doesn't trade junk). But we record it so "no good
  // setups" is a visible, counted decision — never an invisible excuse for never acting.
  // If abstentions vastly outnumber calls over time, that's a signal to revisit either
  // the floor or the scoring, surfaced rather than hidden.
  async recordAbstention(bestScore: number, note: string): Promise<void> {
    try {
      const key = "kira:calls:abstentions";
      const cur = await kiraRedis.getJson<{ count: number; lastTs: number; lastNote: string; recentScores: number[] }>(key)
                  || { count: 0, lastTs: 0, lastNote: "", recentScores: [] };
      cur.count += 1;
      cur.lastTs = Date.now();
      cur.lastNote = note;
      cur.recentScores = [...(cur.recentScores || []), bestScore].slice(-20);
      await kiraRedis.setJson(key, cur);
    } catch { /* non-fatal */ }
  }

  async getAbstentions(): Promise<{ count: number; lastTs: number; lastNote: string; recentScores: number[] }> {
    return await kiraRedis.getJson<{ count: number; lastTs: number; lastNote: string; recentScores: number[] }>("kira:calls:abstentions")
           || { count: 0, lastTs: 0, lastNote: "", recentScores: [] };
  }

  // ── TRACK RECORD ────────────────────────────────────────────────────────────
  async getTrackRecord(): Promise<CallTrackRecord> {
    const all = await kiraRedis.getJson<string[]>(K.calls()) || [];
    let resolved = 0, wins = 0, losses = 0, flats = 0, pnlSum = 0, open = 0;
    for (const id of all) {
      const c = await kiraRedis.getJson<ConvictionCall>(K.call(id));
      if (!c) continue;
      if (!c.resolved) { open++; continue; }
      resolved++;
      if (c.outcome === "win") wins++;
      else if (c.outcome === "loss") losses++;
      else flats++;
      pnlSum += (c.pnlPct || 0);
    }
    return {
      total: all.length,
      resolved, wins, losses, flats,
      winRate:   resolved > 0 ? wins / resolved : 0,
      avgPnlPct: resolved > 0 ? pnlSum / resolved : 0,
      open,
    };
  }

  async getAllCalls(): Promise<ConvictionCall[]> {
    const all = await kiraRedis.getJson<string[]>(K.calls()) || [];
    const out: ConvictionCall[] = [];
    for (const id of all) {
      const c = await kiraRedis.getJson<ConvictionCall>(K.call(id));
      if (c) out.push(c);
    }
    return out;
  }

  // Compact human-readable summary for the decision context + digests.
  async formatForContext(): Promise<string> {
    const tr = await this.getTrackRecord();
    const abs = await this.getAbstentions();
    const absNote = abs.count > 0 ? ` | ${abs.count} abstentions (no setup cleared the bar)` : "";
    if (tr.total === 0) return `Conviction calls: none yet — KIRA has made no owned calls.${absNote}`;
    const wr = (tr.winRate * 100).toFixed(0);
    const conf = tr.resolved < 5
      ? " (too few resolved to be meaningful yet)"
      : tr.resolved < 15 ? " (small sample)" : "";
    return `Conviction calls: ${tr.total} made, ${tr.open} open, ${tr.resolved} resolved — ` +
           `${tr.wins}W/${tr.losses}L/${tr.flats}F, win rate ${wr}%, avg ${tr.avgPnlPct >= 0 ? "+" : ""}${tr.avgPnlPct.toFixed(1)}%${conf}${absNote}`;
  }
}
