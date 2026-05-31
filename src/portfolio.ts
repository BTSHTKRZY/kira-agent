// portfolio.ts — Redis-backed portfolio + paper trading + thesis tracking
// Uses direct REST fetch via kiraRedis — no Upstash SDK

import { NFTScore, TokenScore } from "./scoring.js";
import { kiraRedis }            from "./redis.js";

export type PositionType   = "nft" | "token";
export type PositionMode   = "paper" | "live";
export type PositionStatus = "open" | "closed" | "expired";

export interface Position {
  id:            string;
  type:          PositionType;
  mode:          PositionMode;
  status:        PositionStatus;
  address:       string;
  tokenId?:      string;
  symbol?:       string;
  chain:         string;
  name:          string;
  entryPrice:    number;
  entryScore:    number;
  entryThesis:   string;
  entrySignals:  Record<string, number>;
  openedAt:      number;
  exitPrice?:    number;
  exitReason?:   string;
  closedAt?:     number;
  pnlEth?:       number;
  pnlPct?:       number;
  thesisAccurate?:     boolean;
  whichSignalsWorked?: string[];
  whichSignalsFailed?: string[];
  gradedAt?:           number;
  gradeNote?:          string;
}

export interface WatchlistItem {
  type:      PositionType;
  address:   string;
  tokenId?:  string;
  symbol?:   string;
  chain:     string;
  name:      string;
  score:     number;
  thesis:    string;
  signals:   Record<string, number>;
  addedAt:   number;
  lastScore: number;
  scoredAt:  number;
}

export interface PortfolioSummary {
  totalPositions:   number;
  openPositions:    number;
  paperPositions:   number;
  livePositions:    number;
  totalInvestedEth: number;
  realisedPnlEth:   number;
  winRate:          number;
  avgHoldDays:      number;
  topPerformer?:    Position;
  worstPerformer?:  Position;
}

const K = {
  position:  (id: string) => `kira:position:${id}`,
  positions: ()            => `kira:positions`,
  open:      ()            => `kira:positions:open`,
  paper:     ()            => `kira:positions:paper`,
  live:      ()            => `kira:positions:live`,
  watchlist: ()            => `kira:watchlist`,
  watchItem: (key: string) => `kira:watch:${key}`,
};

export class KiraPortfolio {

  async openPosition(
    score:    NFTScore | TokenScore,
    name:     string,
    mode:     PositionMode = "paper",
    tokenId?: string
  ): Promise<Position> {
    const isNFT   = "collection" in score;
    const address = isNFT
      ? (score as NFTScore).collection
      : (score as TokenScore).address;
    const symbol  = isNFT ? undefined : (score as TokenScore).symbol;

    const id = [
      score.chain,
      address.slice(0, 10),
      tokenId || "token",
      Date.now(),
    ].join(":");

    const position: Position = {
      id,
      type:         isNFT ? "nft" : "token",
      mode,
      status:       "open",
      address,
      tokenId,
      symbol,
      chain:        score.chain,
      name,
      entryPrice:   0,
      entryScore:   score.totalScore,
      entryThesis:  score.thesis,
      entrySignals: score.signals as Record<string, number>,
      openedAt:     Date.now(),
    };

    await this.savePosition(position);
    await kiraRedis.sadd(K.positions(), id);
    await kiraRedis.sadd(K.open(), id);
    await kiraRedis.sadd(mode === "paper" ? K.paper() : K.live(), id);

    console.log(`[Portfolio] ${mode.toUpperCase()} opened: ${name} (score: ${score.totalScore})`);
    return position;
  }

  async setEntryPrice(positionId: string, price: number): Promise<void> {
    const pos = await this.getPosition(positionId);
    if (!pos) return;
    pos.entryPrice = price;
    await this.savePosition(pos);
  }

  async closePosition(
    positionId: string,
    exitPrice:  number,
    reason:     string
  ): Promise<Position | null> {
    const pos = await this.getPosition(positionId);
    if (!pos) return null;

    pos.exitPrice  = exitPrice;
    pos.exitReason = reason;
    pos.closedAt   = Date.now();
    pos.status     = "closed";
    pos.pnlEth     = exitPrice - pos.entryPrice;
    pos.pnlPct     = pos.entryPrice > 0
      ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;

    await this.savePosition(pos);
    await kiraRedis.srem(K.open(), positionId);

    console.log(
      `[Portfolio] Closed: ${pos.name} | ` +
      `P&L: ${pos.pnlEth >= 0 ? "+" : ""}${pos.pnlEth.toFixed(4)} ETH ` +
      `(${pos.pnlPct.toFixed(1)}%)`
    );
    return pos;
  }

  private async savePosition(pos: Position): Promise<void> {
    await kiraRedis.setJson(K.position(pos.id), pos);
  }

  async getPosition(id: string): Promise<Position | null> {
    return kiraRedis.getJson<Position>(K.position(id));
  }

  async getOpenPositions(): Promise<Position[]> {
    return this.getPositionSet(K.open());
  }

  async getPaperPositions(): Promise<Position[]> {
    return this.getPositionSet(K.paper());
  }

  async getClosedPositions(limit: number = 50): Promise<Position[]> {
    const all = await this.getAllPositions();
    return all
      .filter(p => p.status === "closed")
      .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
      .slice(0, limit);
  }

  async getAllPositions(): Promise<Position[]> {
    return this.getPositionSet(K.positions());
  }

  private async getPositionSet(setKey: string): Promise<Position[]> {
    const ids = await kiraRedis.smembers(setKey);
    if (!ids.length) return [];
    const results = await Promise.all(ids.map(id => this.getPosition(id)));
    return results.filter(Boolean) as Position[];
  }

  async addToWatchlist(
    score:    NFTScore | TokenScore,
    name:     string,
    tokenId?: string
  ): Promise<WatchlistItem> {
    const isNFT   = "collection" in score;
    const address = isNFT
      ? (score as NFTScore).collection
      : (score as TokenScore).address;
    const symbol  = isNFT ? undefined : (score as TokenScore).symbol;
    const key     = `${score.chain}:${address}:${tokenId || "token"}`;

    const item: WatchlistItem = {
      type:      isNFT ? "nft" : "token",
      address,
      tokenId,
      symbol,
      chain:     score.chain,
      name,
      score:     score.totalScore,
      thesis:    score.thesis,
      signals:   score.signals as Record<string, number>,
      addedAt:   Date.now(),
      lastScore: score.totalScore,
      scoredAt:  Date.now(),
    };

    await kiraRedis.setJson(K.watchItem(key), item);
    await kiraRedis.sadd(K.watchlist(), key);

    console.log(`[Watchlist] Added: ${name} (score: ${score.totalScore})`);
    return item;
  }

  async updateWatchlistScore(
    key:   string,
    score: NFTScore | TokenScore
  ): Promise<void> {
    const item = await kiraRedis.getJson<WatchlistItem>(K.watchItem(key));
    if (!item) return;
    item.lastScore = score.totalScore;
    item.thesis    = score.thesis;
    item.signals   = score.signals as Record<string, number>;
    item.scoredAt  = Date.now();
    await kiraRedis.setJson(K.watchItem(key), item);
  }

  async getWatchlist(): Promise<WatchlistItem[]> {
    const keys = await kiraRedis.smembers(K.watchlist());
    if (!keys.length) return [];
    const items = await Promise.all(
      keys.map(k => kiraRedis.getJson<WatchlistItem>(K.watchItem(k)))
    );
    return (items.filter(Boolean) as WatchlistItem[])
      .sort((a, b) => b.lastScore - a.lastScore);
  }

  async removeFromWatchlist(key: string): Promise<void> {
    await kiraRedis.srem(K.watchlist(), key);
    await kiraRedis.del(K.watchItem(key));
  }

  async gradePosition(
    positionId:     string,
    thesisAccurate: boolean,
    workedSignals:  string[],
    failedSignals:  string[],
    note:           string
  ): Promise<void> {
    const pos = await this.getPosition(positionId);
    if (!pos || pos.status !== "closed") return;
    pos.thesisAccurate     = thesisAccurate;
    pos.whichSignalsWorked = workedSignals;
    pos.whichSignalsFailed = failedSignals;
    pos.gradedAt           = Date.now();
    pos.gradeNote          = note;
    await this.savePosition(pos);
    console.log(`[Learning] Graded: ${pos.name} | Thesis: ${thesisAccurate ? "✓" : "✗"}`);
  }

  async runLearningReview(): Promise<{
    signalPerformance: Record<string, { wins: number; losses: number; winRate: number }>;
    recommendations:   Array<{ signal: string; type: "nft" | "token"; adjust: "up" | "down"; magnitude: number }>;
    summary:           string;
  }> {
    const closed = await this.getClosedPositions(200);
    const graded = closed.filter(p => p.gradedAt);
    const signalPerf: Record<string, { wins: number; losses: number }> = {};

    for (const pos of graded) {
      const profitable = (pos.pnlPct || 0) > 0;
      for (const signal of pos.whichSignalsWorked || []) {
        if (!signalPerf[signal]) signalPerf[signal] = { wins: 0, losses: 0 };
        if (profitable) signalPerf[signal].wins++;
        else            signalPerf[signal].losses++;
      }
      for (const signal of pos.whichSignalsFailed || []) {
        if (!signalPerf[signal]) signalPerf[signal] = { wins: 0, losses: 0 };
        if (!profitable) signalPerf[signal].wins++;
        else             signalPerf[signal].losses++;
      }
    }

    const performance: Record<string, { wins: number; losses: number; winRate: number }> = {};
    const recommendations: Array<{
      signal: string; type: "nft" | "token"; adjust: "up" | "down"; magnitude: number
    }> = [];

    for (const [signal, perf] of Object.entries(signalPerf)) {
      const total   = perf.wins + perf.losses;
      const winRate = total > 0 ? perf.wins / total : 0;
      performance[signal] = { ...perf, winRate };
      if (total >= 5) {
        const type = signal.includes("normies") || signal.includes("token")
          ? "token" : "nft";
        if (winRate >= 0.7)      recommendations.push({ signal, type, adjust: "up",   magnitude: 0.1 });
        else if (winRate <= 0.3) recommendations.push({ signal, type, adjust: "down", magnitude: 0.1 });
      }
    }

    const profitable     = graded.filter(p => (p.pnlPct || 0) > 0).length;
    const overallWinRate = graded.length > 0
      ? (profitable / graded.length * 100).toFixed(1) : "N/A";
    const avgPnl = graded.length > 0
      ? graded.reduce((s, p) => s + (p.pnlPct || 0), 0) / graded.length : 0;

    const summary = [
      `Learning review: ${graded.length} graded positions.`,
      `Win rate: ${overallWinRate}%. Avg P&L: ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(1)}%.`,
      `${recommendations.length} signal weight adjustments recommended.`,
      recommendations.map(r => `${r.signal}: ${r.adjust === "up" ? "↑" : "↓"}`).join(", "),
    ].filter(Boolean).join(" ");

    return { signalPerformance: performance, recommendations, summary };
  }

  async getSummary(): Promise<PortfolioSummary> {
    const all    = await this.getAllPositions();
    const open   = all.filter(p => p.status === "open");
    const closed = all.filter(p => p.status === "closed");

    const totalInvested = open.reduce((s, p) => s + p.entryPrice, 0);
    const realisedPnl   = closed.reduce((s, p) => s + (p.pnlEth || 0), 0);
    const profitable    = closed.filter(p => (p.pnlPct || 0) > 0);
    const winRate       = closed.length > 0
      ? (profitable.length / closed.length) * 100 : 0;

    const holdTimes = closed
      .filter(p => p.closedAt)
      .map(p => (p.closedAt! - p.openedAt) / (1000 * 3600 * 24));
    const avgHoldDays = holdTimes.length > 0
      ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0;

    const byPnl = [...closed].sort((a, b) => (b.pnlPct || 0) - (a.pnlPct || 0));

    return {
      totalPositions:   all.length,
      openPositions:    open.length,
      paperPositions:   open.filter(p => p.mode === "paper").length,
      livePositions:    open.filter(p => p.mode === "live").length,
      totalInvestedEth: totalInvested,
      realisedPnlEth:   realisedPnl,
      winRate,
      avgHoldDays,
      topPerformer:     byPnl[0],
      worstPerformer:   byPnl[byPnl.length - 1],
    };
  }

  async formatSummaryForContext(): Promise<string> {
    const s         = await this.getSummary();
    const watchlist = await this.getWatchlist();
    return [
      `Portfolio: ${s.openPositions} open (${s.paperPositions} paper / ${s.livePositions} live)`,
      `Invested: ${s.totalInvestedEth.toFixed(4)} ETH`,
      `Realised P&L: ${s.realisedPnlEth >= 0 ? "+" : ""}${s.realisedPnlEth.toFixed(4)} ETH`,
      `Win rate: ${s.winRate.toFixed(1)}% (${s.totalPositions} total)`,
      `Avg hold: ${s.avgHoldDays.toFixed(1)} days`,
      `Watchlist: ${watchlist.length} items`,
      watchlist.length > 0
        ? `Top watch: ${watchlist[0].name} (${watchlist[0].lastScore}/100)` : "",
    ].filter(Boolean).join(" | ");
  }
}
