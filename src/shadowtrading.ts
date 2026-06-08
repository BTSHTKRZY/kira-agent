// shadowtrading.ts — Learning accelerator
// Problem: real paper trades are few, so learning is slow.
// Solution: shadow-track EVERY scored item's hypothetical outcome over time.
// Records entry score + price, then checks price later — did high scores predict gains?
// This generates signal-validation data far faster than waiting for paper trades to close.

import { kiraRedis } from "./redis.js";

export interface ShadowPosition {
  id:          string;
  type:        "nft" | "token";
  address:     string;
  chain:       string;
  name:        string;
  entryScore:  number;
  entryPrice:  number;
  entryTime:   number;
  signals:     Record<string, number>;
  // Outcome (filled later)
  checkedPrice?: number;
  checkedTime?:  number;
  pnlPct?:      number;
  resolved:     boolean;
  horizonDays:  number;   // when to check (7d default)
  // Observability only — interim price snapshot at the ~2d checkpoint. Does NOT
  // resolve the shadow or move weights; purely lets us watch learning forming early.
  interimPnlPct?: number;
  interimTime?:   number;
}

export interface SignalPerformance {
  signal:       string;
  appearances:  number;   // times this signal was active (>5)
  correctUp:    number;   // active + price went up
  total:        number;   // resolved positions where it was active
  winRate:      number;
  avgPnlWhenActive: number;
}

const K = {
  shadow:  (id: string) => `kira:shadow:${id}`,
  shadows: ()            => `kira:shadows`,
  perf:    ()            => `kira:shadow:performance`,
  counter: ()            => `kira:shadow:counter`,
};

const DEFAULT_HORIZON_DAYS = 7;
const MAX_SHADOWS = 500;

export class KiraShadowTrading {

  private async nextId(): Promise<string> {
    const n = parseInt(await kiraRedis.get(K.counter()) || "0") + 1;
    await kiraRedis.set(K.counter(), String(n));
    return `S${String(n).padStart(5, "0")}`;
  }

  // Record a shadow position for ANY scored item (called during market scan)
  async recordShadow(
    type:    "nft" | "token",
    address: string,
    chain:   string,
    name:    string,
    score:   number,
    price:   number,
    signals: Record<string, number>,
    horizonDays: number = DEFAULT_HORIZON_DAYS
  ): Promise<void> {
    if (price <= 0) return;

    // Avoid duplicate active shadows for same asset
    const key = `${chain}:${address.toLowerCase()}`;
    const activeShadows = await kiraRedis.smembers(K.shadows());
    for (const sid of activeShadows.slice(0, 50)) {
      const s = await kiraRedis.getJson<ShadowPosition>(K.shadow(sid));
      if (s && !s.resolved && `${s.chain}:${s.address.toLowerCase()}` === key) {
        return; // already tracking this asset
      }
    }

    const id = await this.nextId();
    const shadow: ShadowPosition = {
      id, type, address: address.toLowerCase(), chain, name,
      entryScore: score, entryPrice: price, entryTime: Date.now(),
      signals, resolved: false, horizonDays,
    };
    await kiraRedis.setJson(K.shadow(id), shadow);
    await kiraRedis.sadd(K.shadows(), id);
  }

  // Resolve shadows whose horizon has passed — compare price, attribute to signals
  async resolveMatured(
    getPriceNFT:   (a: string, c: string) => Promise<number>,
    getPriceToken: (a: string, c: string) => Promise<number>
  ): Promise<number> {
    const ids = await kiraRedis.smembers(K.shadows());
    let resolved = 0;

    for (const id of ids) {
      const shadow = await kiraRedis.getJson<ShadowPosition>(K.shadow(id));
      if (!shadow || shadow.resolved) continue;

      const ageMs = Date.now() - shadow.entryTime;
      if (ageMs < shadow.horizonDays * 86400000) continue;

      // Time to resolve
      let currentPrice = 0;
      try {
        currentPrice = shadow.type === "nft"
          ? await getPriceNFT(shadow.address, shadow.chain)
          : await getPriceToken(shadow.address, shadow.chain);
      } catch {}

      if (currentPrice <= 0) {
        // Can't resolve — extend horizon once, then give up
        shadow.horizonDays += 3;
        if (ageMs > 21 * 86400000) {
          shadow.resolved = true; // stale, drop it
          await kiraRedis.srem(K.shadows(), id);
        }
        await kiraRedis.setJson(K.shadow(id), shadow);
        continue;
      }

      shadow.checkedPrice = currentPrice;
      shadow.checkedTime  = Date.now();
      shadow.pnlPct       = ((currentPrice - shadow.entryPrice) / shadow.entryPrice) * 100;
      shadow.resolved     = true;
      await kiraRedis.setJson(K.shadow(id), shadow);
      await kiraRedis.srem(K.shadows(), id);

      await this.attributeToSignals(shadow);
      resolved++;
    }

    return resolved;
  }

  // ── OBSERVABILITY CHECKPOINT (Option C) ───────────────────────────────────────
  // Looks at shadows aged >= CHECKPOINT_DAYS but not yet at full horizon, takes an
  // INTERIM price snapshot, and reports a PROVISIONAL per-signal trend. This does NOT
  // resolve the shadow and does NOT move scoring weights — it exists purely so we can
  // WATCH learning forming days before the 7-day horizon lets it act. Keeps weight
  // adjustments on the quality (7d) signal while giving early, risk-free visibility.
  private static CHECKPOINT_DAYS = 2;

  async checkpointTrends(
    getPriceNFT:   (a: string, c: string) => Promise<number>,
    getPriceToken: (a: string, c: string) => Promise<number>
  ): Promise<string> {
    const ids = await kiraRedis.smembers(K.shadows());
    const tally: Record<string, { up: number; total: number; pnlSum: number }> = {};
    let checkpointed = 0;

    for (const id of ids) {
      const shadow = await kiraRedis.getJson<ShadowPosition>(K.shadow(id));
      if (!shadow || shadow.resolved) continue;

      const ageMs = Date.now() - shadow.entryTime;
      const checkpointMs = KiraShadowTrading.CHECKPOINT_DAYS * 86400000;
      const horizonMs    = shadow.horizonDays * 86400000;
      if (ageMs < checkpointMs || ageMs >= horizonMs) continue;

      let price = 0;
      try {
        price = shadow.type === "nft"
          ? await getPriceNFT(shadow.address, shadow.chain)
          : await getPriceToken(shadow.address, shadow.chain);
      } catch {}
      if (price <= 0) continue;

      const interimPnl = ((price - shadow.entryPrice) / shadow.entryPrice) * 100;
      shadow.interimPnlPct = interimPnl;
      shadow.interimTime   = Date.now();
      await kiraRedis.setJson(K.shadow(id), shadow);
      checkpointed++;

      for (const [sig, val] of Object.entries(shadow.signals || {})) {
        if (!val || val <= 0) continue;
        if (!tally[sig]) tally[sig] = { up: 0, total: 0, pnlSum: 0 };
        tally[sig].total += 1;
        tally[sig].pnlSum += interimPnl;
        if (interimPnl > 0) tally[sig].up += 1;
      }
    }

    if (checkpointed === 0) return "";

    const lines: string[] = [];
    for (const [sig, t] of Object.entries(tally)) {
      if (t.total < 3) continue;
      const winRate = Math.round((t.up / t.total) * 100);
      const avgPnl  = (t.pnlSum / t.total).toFixed(1);
      lines.push(`${sig}: ${winRate}% up @ ${t.total} (avg ${avgPnl}%)`);
    }
    if (lines.length === 0) return `interim checkpoint: ${checkpointed} positions snapshotted (no signal has 3+ yet)`;
    return `interim signal trends (provisional, not applied): ${lines.join(" | ")}`;
  }

  // Update per-signal performance stats based on a resolved shadow
  private async attributeToSignals(shadow: ShadowPosition): Promise<void> {
    const perf = await kiraRedis.getJson<Record<string, SignalPerformance>>(K.perf()) || {};
    const wentUp = (shadow.pnlPct || 0) > 0;

    for (const [signal, value] of Object.entries(shadow.signals)) {
      if (value <= 5) continue; // signal wasn't meaningfully active

      if (!perf[signal]) {
        perf[signal] = { signal, appearances: 0, correctUp: 0, total: 0, winRate: 0, avgPnlWhenActive: 0 };
      }
      const p = perf[signal];
      p.appearances++;
      p.total++;
      if (wentUp) p.correctUp++;
      p.avgPnlWhenActive = (p.avgPnlWhenActive * (p.total - 1) + (shadow.pnlPct || 0)) / p.total;
      p.winRate = p.correctUp / p.total;
    }

    await kiraRedis.setJson(K.perf(), perf);
  }

  // Get signal performance — feeds the learning loop and weight adjustments
  async getSignalPerformance(): Promise<SignalPerformance[]> {
    const perf = await kiraRedis.getJson<Record<string, SignalPerformance>>(K.perf()) || {};
    return Object.values(perf).sort((a, b) => b.total - a.total);
  }

  // Recommendations for weight adjustments based on shadow data
  async getWeightRecommendations(): Promise<Array<{ signal: string; adjust: "up" | "down"; magnitude: number; reason: string }>> {
    const perf = await this.getSignalPerformance();
    const recs: Array<{ signal: string; adjust: "up" | "down"; magnitude: number; reason: string }> = [];

    for (const p of perf) {
      if (p.total < 5) continue; // need enough data
      if (p.winRate >= 0.65) {
        recs.push({ signal: p.signal, adjust: "up", magnitude: 0.1,
          reason: `${p.signal}: ${(p.winRate * 100).toFixed(0)}% accuracy across ${p.total} shadow positions` });
      } else if (p.winRate <= 0.40) {
        recs.push({ signal: p.signal, adjust: "down", magnitude: 0.1,
          reason: `${p.signal}: only ${(p.winRate * 100).toFixed(0)}% accuracy across ${p.total} shadows` });
      }
    }
    return recs;
  }

  async getStats(): Promise<{ active: number; resolved: number; topSignal: string }> {
    const active = (await kiraRedis.smembers(K.shadows())).length;
    const perf   = await this.getSignalPerformance();
    const resolved = perf.reduce((s, p) => Math.max(s, p.total), 0);
    const top    = perf.filter(p => p.total >= 5).sort((a, b) => b.winRate - a.winRate)[0];
    return {
      active, resolved,
      topSignal: top ? `${top.signal} (${(top.winRate * 100).toFixed(0)}%)` : "accumulating",
    };
  }

  async formatForContext(): Promise<string> {
    const stats = await this.getStats();
    return `Shadow learning: ${stats.active} tracking, ${stats.resolved} resolved, best signal: ${stats.topSignal}`;
  }
}
