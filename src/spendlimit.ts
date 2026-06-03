// spendlimit.ts — Cumulative daily spend ceiling (wallet-drain protection)
// The per-trade caps stop any single trade being large, but nothing stopped
// many small trades in a loop from draining the wallet. This is that hard stop.
//
// Tracks cumulative ETH spent per UTC day in Redis, enforces a configurable
// daily ceiling, resets at midnight UTC. ALL spend paths must check this first.

import { kiraRedis } from "./redis.js";

// Hard daily ceiling — configurable via env, conservative default
const DAILY_CEILING_ETH = parseFloat(process.env.DAILY_SPEND_CEILING_ETH || "0.05");

// Also track gas separately so a gas spike can't silently blow the budget
const COUNT_GAS = (process.env.SPEND_CEILING_INCLUDES_GAS || "true") === "true";

const K = {
  spent:   (day: string) => `kira:spend:${day}`,
  log:     (day: string) => `kira:spend:log:${day}`,
};

function utcDay(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export interface SpendCheck {
  allowed:        boolean;
  reason?:        string;
  spentToday:     number;
  ceiling:        number;
  remaining:      number;
}

export class KiraSpendLimit {

  // Check BEFORE any spend. Returns whether the proposed amount is allowed.
  async checkSpend(amountEth: number): Promise<SpendCheck> {
    const day     = utcDay();
    const spent   = parseFloat(await kiraRedis.get(K.spent(day)) || "0");
    const ceiling = DAILY_CEILING_ETH;
    const remaining = Math.max(0, ceiling - spent);

    if (amountEth <= 0) {
      return { allowed: false, reason: "Non-positive amount", spentToday: spent, ceiling, remaining };
    }
    if (spent + amountEth > ceiling) {
      return {
        allowed:   false,
        reason:    `Daily spend ceiling: ${spent.toFixed(4)} already spent + ${amountEth.toFixed(4)} requested > ${ceiling} ETH ceiling`,
        spentToday: spent,
        ceiling,
        remaining,
      };
    }
    return { allowed: true, spentToday: spent, ceiling, remaining };
  }

  // Record AFTER a successful spend (the actual amount that left the wallet).
  async recordSpend(amountEth: number, label: string): Promise<void> {
    if (amountEth <= 0) return;
    const day     = utcDay();
    const current = parseFloat(await kiraRedis.get(K.spent(day)) || "0");
    const updated = current + amountEth;
    await kiraRedis.set(K.spent(day), updated.toFixed(8));

    // Append to a daily audit log
    const log = await kiraRedis.getJson<Array<{ ts: number; amount: number; label: string }>>(K.log(day)) || [];
    log.push({ ts: Date.now(), amount: amountEth, label });
    await kiraRedis.setJson(K.log(day), log.slice(-200));

    console.log(`[SpendLimit] Recorded ${amountEth.toFixed(4)} ETH (${label}). Day total: ${updated.toFixed(4)}/${DAILY_CEILING_ETH} ETH`);
  }

  async getSpentToday(): Promise<number> {
    return parseFloat(await kiraRedis.get(K.spent(utcDay())) || "0");
  }

  async getCeiling(): Promise<number> {
    return DAILY_CEILING_ETH;
  }

  async formatForContext(): Promise<string> {
    const spent = await this.getSpentToday();
    const pct   = DAILY_CEILING_ETH > 0 ? (spent / DAILY_CEILING_ETH * 100) : 0;
    return `Daily spend: ${spent.toFixed(4)}/${DAILY_CEILING_ETH} ETH (${pct.toFixed(0)}%)`;
  }

  countsGas(): boolean { return COUNT_GAS; }
}
