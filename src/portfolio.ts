// portfolio.ts — Paper + live position tracking
// Stop-loss, take-profit, auto-close, thesis recording, learning loop

import { kiraRedis } from "./redis.js";

export interface Position {
  id:            string;
  type:          "nft" | "token";
  mode:          "paper" | "live";
  address:       string;
  tokenId?:      string;
  symbol?:       string;
  name:          string;
  chain:         string;
  entryPrice:    number;
  currentPrice:  number;
  targetPrice:   number;    // take-profit
  stopLoss:      number;    // stop-loss
  timeStop:      number;    // timestamp to force-close
  quantity:      number;
  entryScore:    number;
  thesis:        string;
  signals:       Record<string, number>;
  openedAt:      number;
  closedAt?:     number;
  exitPrice?:    number;
  exitReason?:   "take_profit" | "stop_loss" | "time_stop" | "manual" | "signal_change";
  pnlEth?:       number;
  pnlPct?:       number;
  status:        "open" | "closed";
  txHashBuy?:    string;
  txHashSell?:   string;
}

export interface WatchlistItem {
  key:        string;
  address:    string;
  tokenId?:   string;
  symbol?:    string;
  name:       string;
  chain:      string;
  type:       "nft" | "token";
  lastScore:  number;
  thesis:     string;
  signals:    Record<string, number>;
  scoredAt:   number;
  addedAt:    number;
}

export interface PortfolioSummary {
  openPositions:   number;
  paperPositions:  number;
  livePositions:   number;
  totalInvested:   number;
  unrealisedPnl:   number;
  realisedPnl:     number;
  winRate:         number;
  totalTrades:     number;
  avgHoldDays:     number;
  watchlistSize:   number;
}

export interface LearningReview {
  summary:         string;
  recommendations: Array<{
    type:      "nft" | "token";
    signal:    string;
    adjust:    "up" | "down";
    magnitude: number;
    reason:    string;
  }>;
}

// Stop-loss and take-profit thresholds
const NFT_STOP_LOSS_PCT    = -20;  // -20%
const NFT_TAKE_PROFIT_PCT  =  40;  // +40%
const NFT_TIME_STOP_DAYS   =  30;  // 30 days
const TOKEN_STOP_LOSS_PCT  = -15;  // -15%
const TOKEN_TAKE_PROFIT_PCT =  30;  // +30%
const TOKEN_TIME_STOP_DAYS  =  14;  // 14 days

const K = {
  position:  (id: string)  => `kira:position:${id}`,
  positions: ()             => `kira:positions`,
  open:      ()             => `kira:positions:open`,
  closed:    ()             => `kira:positions:closed`,
  watchlist: ()             => `kira:watchlist`,
  watch:     (key: string)  => `kira:watch:${key}`,
  counter:   ()             => `kira:position:counter`,
};

export class KiraPortfolio {

  // ── POSITION MANAGEMENT ───────────────────────────────────────────────────────

  private async nextId(): Promise<string> {
    const n = parseInt(await kiraRedis.get(K.counter()) || "0") + 1;
    await kiraRedis.set(K.counter(), String(n));
    return `P${String(n).padStart(4, "0")}`;
  }

  async openPosition(
    score:    any,
    name:     string,
    mode:     "paper" | "live" = "paper",
    tokenId?: string
  ): Promise<Position> {
    const id   = await this.nextId();
    const type = score.collection ? "nft" : "token";

    const stopLossPct   = type === "nft" ? NFT_STOP_LOSS_PCT   : TOKEN_STOP_LOSS_PCT;
    const takeProfitPct = type === "nft" ? NFT_TAKE_PROFIT_PCT : TOKEN_TAKE_PROFIT_PCT;
    const timeStopDays  = type === "nft" ? NFT_TIME_STOP_DAYS  : TOKEN_TIME_STOP_DAYS;

    const position: Position = {
      id,
      type,
      mode,
      address:      (score.collection || score.address || "").toLowerCase(),
      tokenId,
      symbol:       score.symbol,
      name,
      chain:        score.chain,
      entryPrice:   0,
      currentPrice: 0,
      targetPrice:  0,  // set after entry price known
      stopLoss:     0,  // set after entry price known
      timeStop:     Date.now() + timeStopDays * 24 * 3600 * 1000,
      quantity:     1,
      entryScore:   score.totalScore,
      thesis:       score.thesis || "",
      signals:      score.signals || {},
      openedAt:     Date.now(),
      status:       "open",
    };

    await kiraRedis.setJson(K.position(id), position);
    await kiraRedis.sadd(K.positions(), id);
    await kiraRedis.sadd(K.open(), id);

    console.log(`[Portfolio] Opened ${mode} position ${id}: ${name}`);
    return position;
  }

  async setEntryPrice(positionId: string, entryPrice: number, txHash?: string): Promise<void> {
    const pos = await this.getPosition(positionId);
    if (!pos) return;

    const stopLossPct   = pos.type === "nft" ? NFT_STOP_LOSS_PCT   : TOKEN_STOP_LOSS_PCT;
    const takeProfitPct = pos.type === "nft" ? NFT_TAKE_PROFIT_PCT : TOKEN_TAKE_PROFIT_PCT;

    pos.entryPrice   = entryPrice;
    pos.currentPrice = entryPrice;
    pos.stopLoss     = entryPrice * (1 + stopLossPct   / 100);
    pos.targetPrice  = entryPrice * (1 + takeProfitPct / 100);
    if (txHash) pos.txHashBuy = txHash;

    await kiraRedis.setJson(K.position(positionId), pos);
    console.log(
      `[Portfolio] ${positionId} entry: ${entryPrice.toFixed(4)} ETH | ` +
      `SL: ${pos.stopLoss.toFixed(4)} | TP: ${pos.targetPrice.toFixed(4)}`
    );
  }

  async updatePrice(positionId: string, currentPrice: number): Promise<{
    shouldClose: boolean;
    reason?: Position["exitReason"];
  }> {
    const pos = await this.getPosition(positionId);
    if (!pos || pos.status === "closed") return { shouldClose: false };

    pos.currentPrice = currentPrice;
    await kiraRedis.setJson(K.position(positionId), pos);

    if (pos.entryPrice === 0) return { shouldClose: false };

    // Check stop-loss
    if (currentPrice <= pos.stopLoss) {
      console.log(`[Portfolio] STOP-LOSS triggered: ${pos.name} @ ${currentPrice.toFixed(4)} ETH (entry: ${pos.entryPrice.toFixed(4)})`);
      return { shouldClose: true, reason: "stop_loss" };
    }

    // Check take-profit
    if (currentPrice >= pos.targetPrice) {
      console.log(`[Portfolio] TAKE-PROFIT triggered: ${pos.name} @ ${currentPrice.toFixed(4)} ETH (target: ${pos.targetPrice.toFixed(4)})`);
      return { shouldClose: true, reason: "take_profit" };
    }

    // Check time-stop
    if (Date.now() >= pos.timeStop) {
      console.log(`[Portfolio] TIME-STOP triggered: ${pos.name} (${Math.floor((Date.now() - pos.openedAt) / 86400000)} days held)`);
      return { shouldClose: true, reason: "time_stop" };
    }

    return { shouldClose: false };
  }

  async closePosition(
    positionId: string,
    exitPrice:  number,
    reason:     Position["exitReason"] = "manual",
    txHash?:    string
  ): Promise<Position> {
    const pos = await this.getPosition(positionId);
    if (!pos) throw new Error(`Position ${positionId} not found`);

    const pnlEth = exitPrice - pos.entryPrice - (pos.entryPrice * 0.025); // 2.5% marketplace fee
    const pnlPct = pos.entryPrice > 0 ? (pnlEth / pos.entryPrice) * 100 : 0;

    pos.exitPrice  = exitPrice;
    pos.exitReason = reason;
    pos.pnlEth     = pnlEth;
    pos.pnlPct     = pnlPct;
    pos.closedAt   = Date.now();
    pos.status     = "closed";
    if (txHash) pos.txHashSell = txHash;

    await kiraRedis.setJson(K.position(positionId), pos);
    await kiraRedis.srem(K.open(), positionId);
    await kiraRedis.sadd(K.closed(), positionId);

    const outcome = pnlEth >= 0 ? "WIN ✓" : "LOSS ✗";
    console.log(
      `[Portfolio] Closed ${positionId} (${reason}): ${pos.name} | ` +
      `${outcome} ${pnlEth > 0 ? "+" : ""}${pnlEth.toFixed(4)} ETH (${pnlPct.toFixed(1)}%)`
    );

    return pos;
  }

  // ── MONITORING — check all open positions ─────────────────────────────────────

  async checkOpenPositions(
    getPriceNFT:   (address: string, chain: string) => Promise<number>,
    getPriceToken: (address: string, chain: string) => Promise<number>
  ): Promise<Array<{ position: Position; shouldClose: boolean; reason?: Position["exitReason"] }>> {
    const results: Array<{ position: Position; shouldClose: boolean; reason?: Position["exitReason"] }> = [];
    const openIds = await kiraRedis.smembers(K.open());

    for (const id of openIds) {
      try {
        const pos = await this.getPosition(id);
        if (!pos || pos.entryPrice === 0) continue;

        // Get current price
        let currentPrice = 0;
        if (pos.type === "nft") {
          currentPrice = await getPriceNFT(pos.address, pos.chain);
        } else {
          currentPrice = await getPriceToken(pos.address, pos.chain);
        }

        if (currentPrice === 0) continue;

        const check = await this.updatePrice(id, currentPrice);
        results.push({ position: pos, ...check });

      } catch (err: any) {
        console.error(`[Portfolio] Price check error for ${id}:`, err?.message);
      }
    }

    return results;
  }

  // ── WATCHLIST ─────────────────────────────────────────────────────────────────

  async addToWatchlist(score: any, name: string): Promise<void> {
    const type    = score.collection ? "nft" : "token";
    const address = (score.collection || score.address || "").toLowerCase();
    const key     = `${score.chain}:${address}:${score.tokenId || "token"}`;

    const existing = await kiraRedis.getJson<WatchlistItem>(K.watch(key));
    if (existing && existing.lastScore >= score.totalScore) return;

    const item: WatchlistItem = {
      key, address,
      tokenId:   score.tokenId,
      symbol:    score.symbol,
      name,
      chain:     score.chain,
      type,
      lastScore: score.totalScore,
      thesis:    score.thesis || "",
      signals:   score.signals || {},
      scoredAt:  score.scoredAt || Date.now(),
      addedAt:   existing?.addedAt || Date.now(),
    };

    await kiraRedis.setJson(K.watch(key), item);
    await kiraRedis.sadd(K.watchlist(), key);
    console.log(`[Watchlist] Added: ${name} (score: ${score.totalScore})`);
  }

  async removeFromWatchlist(key: string): Promise<void> {
    await kiraRedis.srem(K.watchlist(), key);
  }

  async getWatchlist(): Promise<WatchlistItem[]> {
    const keys  = await kiraRedis.smembers(K.watchlist());
    const items = await Promise.all(keys.map(k => kiraRedis.getJson<WatchlistItem>(K.watch(k))));
    return (items.filter(Boolean) as WatchlistItem[])
      .sort((a, b) => b.lastScore - a.lastScore);
  }

  // ── GETTERS ───────────────────────────────────────────────────────────────────

  async getPosition(id: string): Promise<Position | null> {
    return kiraRedis.getJson<Position>(K.position(id));
  }

  async getOpenPositions(): Promise<Position[]> {
    const ids      = await kiraRedis.smembers(K.open());
    const positions = await Promise.all(ids.map(id => this.getPosition(id)));
    return positions.filter(Boolean) as Position[];
  }

  async getClosedPositions(): Promise<Position[]> {
    const ids      = await kiraRedis.smembers(K.closed());
    const positions = await Promise.all(ids.map(id => this.getPosition(id)));
    return (positions.filter(Boolean) as Position[])
      .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  }

  async getSummary(): Promise<PortfolioSummary> {
    const open   = await this.getOpenPositions();
    const closed = await this.getClosedPositions();
    const wl     = await this.getWatchlist();

    const paper = open.filter(p => p.mode === "paper").length;
    const live  = open.filter(p => p.mode === "live").length;

    const totalInvested  = open.reduce((s, p) => s + (p.entryPrice || 0), 0);
    const unrealisedPnl  = open.reduce((s, p) => {
      if (!p.entryPrice || !p.currentPrice) return s;
      return s + (p.currentPrice - p.entryPrice);
    }, 0);

    const realisedPnl = closed.reduce((s, p) => s + (p.pnlEth || 0), 0);
    const wins        = closed.filter(p => (p.pnlEth || 0) > 0).length;
    const winRate     = closed.length > 0 ? (wins / closed.length) * 100 : 0;

    const avgHoldDays = closed.length > 0
      ? closed.reduce((s, p) => s + ((p.closedAt || 0) - p.openedAt) / 86400000, 0) / closed.length
      : 0;

    return {
      openPositions:  open.length,
      paperPositions: paper,
      livePositions:  live,
      totalInvested,
      unrealisedPnl,
      realisedPnl,
      winRate,
      totalTrades:    closed.length,
      avgHoldDays,
      watchlistSize:  wl.length,
    };
  }

  async formatSummaryForContext(): Promise<string> {
    const s  = await this.getSummary();
    const wl = await this.getWatchlist();
    const top = wl[0];
    return [
      `Portfolio: ${s.openPositions} open (${s.paperPositions} paper / ${s.livePositions} live)`,
      `Invested: ${s.totalInvested.toFixed(4)} ETH`,
      `Unrealised: ${s.unrealisedPnl >= 0 ? "+" : ""}${s.unrealisedPnl.toFixed(4)} ETH`,
      `Realised P&L: ${s.realisedPnl >= 0 ? "+" : ""}${s.realisedPnl.toFixed(4)} ETH`,
      `Win rate: ${s.winRate.toFixed(1)}% (${s.totalTrades} total)`,
      `Avg hold: ${s.avgHoldDays.toFixed(1)} days`,
      `Watchlist: ${s.watchlistSize} items`,
      top ? `Top watch: ${top.name} (${top.lastScore}/100)` : "",
    ].filter(Boolean).join(" | ");
  }

  // ── LEARNING REVIEW ───────────────────────────────────────────────────────────

  async runLearningReview(): Promise<LearningReview> {
    const closed = await this.getClosedPositions();
    if (closed.length < 3) {
      return { summary: "Not enough closed positions for review (need 3+)", recommendations: [] };
    }

    const recommendations: LearningReview["recommendations"] = [];

    // Analyse which signals predicted correctly
    const signalPerformance: Record<string, { wins: number; losses: number; totalPnl: number }> = {};

    for (const pos of closed) {
      const won = (pos.pnlEth || 0) > 0;
      for (const [signal, value] of Object.entries(pos.signals || {})) {
        if (!signalPerformance[signal]) {
          signalPerformance[signal] = { wins: 0, losses: 0, totalPnl: 0 };
        }
        if (value > 5) { // signal was active
          if (won) signalPerformance[signal].wins++;
          else     signalPerformance[signal].losses++;
          signalPerformance[signal].totalPnl += pos.pnlEth || 0;
        }
      }
    }

    for (const [signal, perf] of Object.entries(signalPerformance)) {
      const total   = perf.wins + perf.losses;
      if (total < 2) continue;
      const winRate = perf.wins / total;

      if (winRate >= 0.7 && total >= 3) {
        recommendations.push({
          type:      "nft",
          signal,
          adjust:    "up",
          magnitude: 0.15,
          reason:    `${signal} predicted correctly in ${(winRate * 100).toFixed(0)}% of ${total} trades`,
        });
      } else if (winRate <= 0.35 && total >= 3) {
        recommendations.push({
          type:      "nft",
          signal,
          adjust:    "down",
          magnitude: 0.1,
          reason:    `${signal} only correct in ${(winRate * 100).toFixed(0)}% of ${total} trades`,
        });
      }
    }

    const realisedPnl = closed.reduce((s, p) => s + (p.pnlEth || 0), 0);
    const wins        = closed.filter(p => (p.pnlEth || 0) > 0).length;

    return {
      summary: [
        `${closed.length} closed positions`,
        `Win rate: ${((wins / closed.length) * 100).toFixed(1)}%`,
        `Total realised: ${realisedPnl >= 0 ? "+" : ""}${realisedPnl.toFixed(4)} ETH`,
        `${recommendations.length} signal adjustments recommended`,
      ].join(" | "),
      recommendations,
    };
  }

  async setEntryPriceAlias(positionId: string, price: number): Promise<void> {
    await this.setEntryPrice(positionId, price);
  }
}
