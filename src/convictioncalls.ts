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
  degraded?:        boolean;    // true if knowledge retrieval FAILED (e.g. Vector timeout) —
                                // attribution is unreliable; Arc 2/3 should exclude from
                                // knowledge-lift/source-yield rather than count as "no knowledge used"
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
  horizonDays:  number;        // thesis-appropriate soft horizon (resolve by this if nothing else triggers)
  // ARC-B: condition-based resolution targets (resolve when ANY triggers, not a fixed timer).
  targetPct?:   number;        // take-profit: thesis proven if price rises this % (e.g. +20)
  stopPct?:     number;        // stop: thesis invalidated if price falls this % (e.g. -15), stored as negative
  // Attribution (load-bearing for Arcs 2-3)
  attribution:  CallAttribution;
  // Outcome (filled on resolution)
  resolved:     boolean;
  exitPrice?:   number;
  exitTime?:    number;
  pnlPct?:      number;
  outcome?:     "win" | "loss" | "flat";
  resolveReason?: "target_hit" | "stop_hit" | "horizon" | "max_age_forced" | "unpriceable_forced" | "displaced";
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
  lastCall:()           => `kira:calls:lastts`,     // global anti-burst pacing
  assetLast:(addr: string) => `kira:calls:asset:${(addr||"").toLowerCase()}`, // per-asset cooldown
  displaceLog:()        => `kira:calls:displace_log`,  // timestamps of recent displacements (anti-churn)
};

// Cadence guards — keep calls DELIBERATE without artificially capping good ideas.
// Old design used one global ~36h cooldown, which blocked ALL calls after any single
// call — so KIRA couldn't act on a genuinely better, DIFFERENT setup that appeared during
// the window. That both mismatched real trading judgment (a trader holds a diversified
// book) AND throttled the track-record data generation Arcs 2-3 depend on. New design:
//   • PER-ASSET cooldown  — don't re-call the SAME name within ~36h (prevents spamming one thesis)
//   • ANTI-BURST gap      — a short global gap (~3h) so she can't fire many in one burst,
//                           but CAN build a book of distinct calls over a day or two
//   • MAX_OPEN_CALLS cap  — still at most 5 live calls at once
// The 45 quality FLOOR (enforced in index.ts) is the real selectivity discipline now —
// she can make several calls, but only on setups that clear the bar.
const CALL_BURST_GAP_MS     = parseInt(process.env.CALL_BURST_GAP_MS     || String(3 * 60 * 60 * 1000));  // ~3h between ANY two calls
const CALL_ASSET_COOLDOWN_MS= parseInt(process.env.CALL_ASSET_COOLDOWN_MS|| String(36 * 60 * 60 * 1000)); // ~36h before re-calling the SAME asset
const MAX_OPEN_CALLS        = parseInt(process.env.MAX_OPEN_CALLS        || "8");   // raised from 5 — pacing/floor are the real discipline
const DEFAULT_HORIZON       = parseInt(process.env.CALL_HORIZON_DAYS     || "4");   // shorter soft horizon — crypto/NFT moves fast; 7d was an eternity
// ARC-B condition-based resolution: a call resolves when ANY of these triggers, not on a
// fixed timer. Defaults are sensible for a fast market; conviction can scale them later.
const DEFAULT_TARGET_PCT    = parseFloat(process.env.CALL_TARGET_PCT     || "20");  // +20% → thesis proven, book the win
const DEFAULT_STOP_PCT      = parseFloat(process.env.CALL_STOP_PCT       || "-15"); // -15% → thesis invalidated, book the loss
// CRITICAL anti-deadlock guard: a call MUST resolve by this hard age no matter what, even
// if it can't be priced. The old code pushed unpriceable calls back to "open" forever,
// which paralysed KIRA at 5/5 for 6 days. Nothing hangs open past this.
const CALL_MAX_AGE_MS       = parseInt(process.env.CALL_MAX_AGE_MS       || String(10 * 24 * 60 * 60 * 1000)); // 10 days hard cap
const FLAT_BAND_PCT      = 2;     // |pnl| < 2% counts as "flat", not win/loss
// Same data-artifact guard the shadow system uses: a >±500% short-horizon move on a
// tracked asset is a mis-scaled/near-zero price, not a real move. Don't let it pollute
// the track record.
const MAX_PLAUSIBLE_ABS_PNL_PCT = 500;

// ── DISPLACEMENT (opportunity-cost reallocation) ──────────────────────────────
// When KIRA is at capacity (MAX_OPEN_CALLS), a CLEARLY-better new setup may close the
// weakest eligible open call and take its slot — rehearsing capital allocation in paper
// before real budget arrives at #12. Deliberately STRICT/rare: all gates must pass, and
// at most one displacement per day. The failure mode we guard against (churn — abandoning
// theses mid-flight, conviction calls becoming day-trades) is worse than occasionally
// missing a better setup, so every knob biases toward NOT displacing.
const DISPLACE_REQUIRE_HIGH   = (process.env.DISPLACE_REQUIRE_HIGH ?? "true") !== "false"; // only HIGH-conviction new calls can displace
const DISPLACE_SCORE_MARGIN   = parseFloat(process.env.DISPLACE_SCORE_MARGIN || "10");     // new score ≥ weakest-open score + this
const DISPLACE_MIN_HOLD_MS    = parseInt(process.env.DISPLACE_MIN_HOLD_MS  || String(24 * 60 * 60 * 1000)); // a call is protected for 24h UNLESS it's losing
const DISPLACE_MAX_PER_DAY    = parseInt(process.env.DISPLACE_MAX_PER_DAY  || "1");        // anti-churn: at most N displacements per rolling 24h

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
  // Pass the candidate's address to also enforce the per-asset cooldown. Omit it for a
  // generic "can I make ANY call" check (anti-burst + max-open only).
  async cooldownStatus(candidateAddress?: string): Promise<{ canCall: boolean; reason: string; openCount: number }> {
    const openIds   = await kiraRedis.getJson<string[]>(K.open()) || [];
    const openCount = openIds.length;
    if (openCount >= MAX_OPEN_CALLS) {
      return { canCall: false, reason: `Max open calls reached (${openCount}/${MAX_OPEN_CALLS}) — let some resolve first`, openCount };
    }
    // Anti-burst: short global gap so she can't fire a flurry in one cycle.
    const last  = parseInt(await kiraRedis.get(K.lastCall()) || "0");
    const since = Date.now() - last;
    if (last > 0 && since < CALL_BURST_GAP_MS) {
      const mins = Math.round((CALL_BURST_GAP_MS - since) / 60000);
      return { canCall: false, reason: `Anti-burst pacing (~${mins}m since last call) — spacing calls out`, openCount };
    }
    // Per-asset: don't re-call the SAME name too soon (prevents spamming one thesis).
    if (candidateAddress) {
      const assetLast = parseInt(await kiraRedis.get(K.assetLast(candidateAddress)) || "0");
      const assetSince = Date.now() - assetLast;
      if (assetLast > 0 && assetSince < CALL_ASSET_COOLDOWN_MS) {
        const hrs = Math.round((CALL_ASSET_COOLDOWN_MS - assetSince) / 3.6e6);
        return { canCall: false, reason: `Already called this asset recently (~${hrs}h until re-callable) — pick a different setup or abstain`, openCount };
      }
    }
    return { canCall: true, reason: "clear", openCount };
  }

  // ── DISPLACEMENT — opportunity-cost reallocation ────────────────────────────
  // Called ONLY when KIRA is at capacity and wants to make a new call. Decides whether the
  // new setup is clearly better than her weakest ELIGIBLE open call; if so, closes that call
  // at current price (booking real P&L into the track record, reason="displaced") to free a
  // slot. Returns { displaced, note }. Deliberately strict — all gates must pass:
  //   GATE 1: new call must be HIGH conviction (if DISPLACE_REQUIRE_HIGH).
  //   GATE 2: new score ≥ weakest-eligible-open score + DISPLACE_SCORE_MARGIN.
  //   GATE 3: the displaced call must be ELIGIBLE — past min-hold OR already losing.
  //           (Young AND winning calls are protected so patient theses can resolve.)
  //   + anti-churn: at most DISPLACE_MAX_PER_DAY displacements per rolling 24h.
  async tryDisplace(
    candidate: { score: number; conviction: "high" | "medium" | "low" },
    priceLookup: (c: ConvictionCall) => Promise<number | null>
  ): Promise<{ displaced: boolean; note: string }> {
    // GATE 1: conviction
    if (DISPLACE_REQUIRE_HIGH && candidate.conviction !== "high") {
      return { displaced: false, note: "no displacement — new call isn't high-conviction (slots reserved for best ideas)" };
    }
    // Anti-churn: daily limit
    const now = Date.now();
    const log = (await kiraRedis.getJson<number[]>(K.displaceLog()) || []).filter(t => t > now - 24 * 60 * 60 * 1000);
    if (log.length >= DISPLACE_MAX_PER_DAY) {
      return { displaced: false, note: `no displacement — daily limit reached (${log.length}/${DISPLACE_MAX_PER_DAY} in last 24h)` };
    }

    const openIds = await kiraRedis.getJson<string[]>(K.open()) || [];
    if (openIds.length < MAX_OPEN_CALLS) return { displaced: false, note: "not at capacity — no displacement needed" };

    // Gather open calls with current price + eligibility.
    const candidates: Array<{ call: ConvictionCall; price: number | null; pnl: number | null; eligible: boolean }> = [];
    for (const id of openIds) {
      const call = await kiraRedis.getJson<ConvictionCall>(K.call(id));
      if (!call || call.resolved) continue;
      let price: number | null = null;
      try { price = await priceLookup(call); } catch { price = null; }
      const pnl = price !== null ? this.safePnlPct(call.entryPrice, price) : null;
      const age = now - call.entryTime;
      // GATE 3: eligible if past min-hold OR currently losing. Young AND (winning or flat) = protected.
      const losing = pnl !== null && pnl < 0;
      const eligible = age >= DISPLACE_MIN_HOLD_MS || losing;
      candidates.push({ call, price, pnl, eligible });
    }

    const eligible = candidates.filter(c => c.eligible);
    if (eligible.length === 0) {
      return { displaced: false, note: "no displacement — all open calls are young and not losing (protected to let theses resolve)" };
    }

    // Pick the WEAKEST eligible: lowest conviction first, then worst current P&L.
    const convRank = (c: ConvictionCall) => c.conviction === "high" ? 2 : c.conviction === "medium" ? 1 : 0;
    eligible.sort((a, b) => {
      const cr = convRank(a.call) - convRank(b.call);
      if (cr !== 0) return cr;                          // lower conviction first
      return (a.pnl ?? 0) - (b.pnl ?? 0);               // then worst P&L first
    });
    const weakest = eligible[0];

    // GATE 2: new setup must clearly out-score the weakest eligible open call.
    if (candidate.score < weakest.call.score + DISPLACE_SCORE_MARGIN) {
      return { displaced: false, note: `no displacement — new setup (${candidate.score}) doesn't clear weakest open ${weakest.call.name} (${weakest.call.score}) by +${DISPLACE_SCORE_MARGIN}` };
    }

    // All gates passed — CLOSE the weakest at current price (book real P&L into the record).
    const wc = weakest.call;
    wc.resolved   = true;
    wc.exitTime   = now;
    wc.resolveReason = "displaced";
    if (weakest.price !== null && weakest.pnl !== null) {
      wc.exitPrice = weakest.price;
      wc.pnlPct    = weakest.pnl;
      wc.outcome   = weakest.pnl > FLAT_BAND_PCT ? "win" : weakest.pnl < -FLAT_BAND_PCT ? "loss" : "flat";
      wc.resolveNote = `displaced by a higher-conviction setup (score ${candidate.score} vs ${wc.score}); closed at ${weakest.pnl >= 0 ? "+" : ""}${weakest.pnl.toFixed(1)}%`;
    } else {
      // Unpriceable at displacement time — book flat, excluded from P&L, but still freed.
      wc.pnlPct = 0; wc.outcome = "flat";
      wc.resolveNote = `displaced (unpriceable at close) by higher-conviction setup score ${candidate.score} vs ${wc.score}`;
    }
    await kiraRedis.setJson(K.call(wc.id), wc);
    await kiraRedis.setJson(K.open(), openIds.filter(id => id !== wc.id));
    log.push(now);
    await kiraRedis.setJson(K.displaceLog(), log);

    const pnlStr = weakest.pnl !== null ? `${weakest.pnl >= 0 ? "+" : ""}${weakest.pnl.toFixed(1)}%` : "n/a";
    return { displaced: true, note: `displaced ${wc.name} (${wc.conviction}, ${pnlStr}, score ${wc.score}) for new high-conviction setup (score ${candidate.score})` };
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
    targetPct?: number;
    stopPct?: number;
  }): Promise<ConvictionCall | null> {
    if (!params.entryPrice || params.entryPrice <= 0) return null;
    const id = await this.nextId();
    // Conviction scales the target: higher conviction → wider target (more upside expected),
    // but the stop stays tight regardless (risk discipline doesn't loosen with confidence).
    const convMult = params.conviction === "high" ? 1.5 : params.conviction === "medium" ? 1.0 : 0.7;
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
      targetPct:   params.targetPct ?? (DEFAULT_TARGET_PCT * convMult),
      stopPct:     params.stopPct ?? DEFAULT_STOP_PCT,
      attribution: params.attribution,
      resolved:    false,
    };
    await kiraRedis.setJson(K.call(id), call);
    const all  = await kiraRedis.getJson<string[]>(K.calls()) || [];
    const open = await kiraRedis.getJson<string[]>(K.open())  || [];
    all.push(id); open.push(id);
    await kiraRedis.setJson(K.calls(), all.slice(-1000));
    await kiraRedis.setJson(K.open(),  open);
    await kiraRedis.set(K.lastCall(), String(Date.now()));                      // anti-burst clock
    await kiraRedis.set(K.assetLast(params.address), String(Date.now()));        // per-asset clock
    return call;
  }

  // ── RESOLVE calls — CONDITION-BASED, not a fixed timer ──────────────────────
  // A call resolves when ANY trigger fires, checked every cycle:
  //   • target_hit   — price ≥ entry*(1+target%)  → thesis proven, win
  //   • stop_hit     — price ≤ entry*(1+stop%)    → thesis invalidated, loss
  //   • horizon      — soft thesis horizon elapsed → resolve at whatever price is
  //   • max_age      — HARD cap: resolve no matter what, even if unpriceable (anti-deadlock)
  // The max_age guard is the fix for the 6-day paralysis: the old code pushed unpriceable
  // calls back to "open" FOREVER, so dead micro-caps (DOGEUS et al.) never resolved and
  // capped her at 5/5 indefinitely. Now nothing hangs open past CALL_MAX_AGE_MS.
  async resolveCalls(
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

      const age          = Date.now() - call.entryTime;
      const horizonMs    = call.horizonDays * 24 * 60 * 60 * 1000;
      const horizonPassed= age >= horizonMs;
      const overMaxAge   = age >= CALL_MAX_AGE_MS;

      let price: number | null = null;
      try { price = await priceLookup(call); }
      catch { price = null; }   // defense-in-depth: never let one lookup abort the batch

      // ── ANTI-DEADLOCK: unpriceable AND over hard max age → force-close, free the slot.
      if ((price === null || price === undefined)) {
        if (overMaxAge) {
          call.resolved = true;
          call.exitTime = Date.now();
          call.pnlPct = 0;
          call.outcome = "flat";
          call.resolveReason = "unpriceable_forced";
          call.resolveNote = "force-closed: unpriceable past max age (asset likely dead/delisted) — excluded from P&L";
          await kiraRedis.setJson(K.call(id), call);
          notes.push(`${call.name}: force-closed (unpriceable, dead asset)`);
          resolved++;
          continue;
        }
        // Not yet at max age — keep trying to price it, but it WILL close at max age.
        stillOpen.push(id);
        continue;
      }

      const pnl = this.safePnlPct(call.entryPrice, price);
      if (pnl === null) {
        // Implausible price — only force-resolve if also past horizon/max-age, else retry.
        if (horizonPassed || overMaxAge) {
          call.resolved = true; call.exitPrice = price; call.exitTime = Date.now();
          call.pnlPct = 0; call.outcome = "flat";
          call.resolveReason = "max_age_forced";
          call.resolveNote = "excluded from P&L — implausible price (data artifact)";
          await kiraRedis.setJson(K.call(id), call);
          notes.push(`${call.name}: excluded (bad price)`);
          resolved++;
        } else {
          stillOpen.push(id);
        }
        continue;
      }

      // ── CONDITION CHECKS (target / stop / horizon / max-age) ──
      let reason: ConvictionCall["resolveReason"] | null = null;
      if (call.targetPct !== undefined && pnl >= call.targetPct)      reason = "target_hit";
      else if (call.stopPct !== undefined && pnl <= call.stopPct)     reason = "stop_hit";
      else if (overMaxAge)                                            reason = "max_age_forced";
      else if (horizonPassed)                                         reason = "horizon";

      if (!reason) { stillOpen.push(id); continue; }   // no trigger yet — keep holding

      call.resolved   = true;
      call.exitPrice  = price;
      call.exitTime   = Date.now();
      call.pnlPct     = pnl;
      call.outcome    = pnl > FLAT_BAND_PCT ? "win" : pnl < -FLAT_BAND_PCT ? "loss" : "flat";
      call.resolveReason = reason;
      await kiraRedis.setJson(K.call(id), call);
      notes.push(`${call.name}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}% (${call.outcome}, ${reason})`);
      resolved++;
    }
    await kiraRedis.setJson(K.open(), stillOpen);
    return { resolved, notes };
  }

  // Back-compat alias (index.ts may still call resolveMatured).
  async resolveMatured(priceLookup: (c: ConvictionCall) => Promise<number | null>) {
    return this.resolveCalls(priceLookup);
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
