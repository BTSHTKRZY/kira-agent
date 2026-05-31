// portfolio.ts — Redis-backed portfolio + paper trading + thesis tracking
// This is KIRA's memory of every position, paper or live, and her learning loop

import { NFTScore, TokenScore } from "./scoring.js";

// ── TYPES ──────────────────────────────────────────────────────────────────────

export type PositionType  = "nft" | "token";
export type PositionMode  = "paper" | "live";
export type PositionStatus = "open" | "closed" | "expired";

export interface Position {
  id:            string;          // unique: chain:address:tokenId:timestamp
  type:          PositionType;
  mode:          PositionMode;
  status:        PositionStatus;

  // Asset
  address:       string;          // contract address
  tokenId?:      string;          // NFT only
  symbol?:       string;          // token only
  chain:         string;
  name:          string;

  // Entry
  entryPrice:    number;          // ETH
  entryScore:    number;          // score at time of entry
  entryThesis:   string;          // KIRA's reasoning
  entrySignals:  Record<string, number>;
  openedAt:      number;          // timestamp

  // Exit (populated when closed)
  exitPrice?:    number;
  exitReason?:   string;
  closedAt?:     number;
  pnlEth?:       number;
  pnlPct?:       number;

  // Outcome grading (populated in learning loop)
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
  lastScore: number;              // most recent rescore
  scoredAt:  number;
}

export interface PortfolioSummary {
  totalPositions:    number;
  openPositions:     number;
  paperPositions:    number;
  livePositions:     number;
  totalInvestedEth:  number;
  unrealisedPnlEth:  number;
  realisedPnlEth:    number;
  winRate:           number;      // % of closed positions profitable
  avgHoldDays:       number;
  topPerformer?:     Position;
  worstPerformer?:   Position;
}

// Redis key prefixes
const KEYS = {
  position:  (id: string)        => `kira:position:${id}`,
  positions: ()                  => `kira:positions`,          // SET of all IDs
  open:      ()                  => `kira:positions:open`,     // SET of open IDs
  paper:     ()                  => `kira:positions:paper`,    // SET of paper IDs
  live:      ()                  => `kira:positions:live`,     // SET of live IDs
  watchlist: ()                  => `kira:watchlist`,          // SET of watchlist keys
  watchItem: (key: string)       => `kira:watch:${key}`,
  pnl:       ()                  => `kira:pnl:summary`,
  weights:   ()                  => `kira:signal_weights`,
};

// ── PORTFOLIO CLASS ────────────────────────────────────────────────────────────

export class KiraPortfolio {
  private redis: any;

  constructor(redisClient: any) {
    this.redis = redisClient;
  }

  // ── POSITION MANAGEMENT ────────────────────────────────────────────────────

  async openPosition(
    score:   NFTScore | TokenScore,
    name:    string,
    mode:    PositionMode = "paper",
    tokenId?: string
  ): Promise<Position> {

    const isNFT    = "collection" in score;
    const address  = isNFT
      ? (score as NFTScore).collection
      : (score as TokenScore).address;
    const symbol   = isNFT ? undefined : (score as TokenScore).symbol;

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
      entryPrice:   0,             // caller sets this from actual price
      entryScore:   score.totalScore,
      entryThesis:  score.thesis,
      entrySignals: score.signals as Record<string, number>,
      openedAt:     Date.now(),
    };

    await this.savePosition(position);
    await this.redis.sadd(KEYS.positions(), id);
    await this.redis.sadd(KEYS.open(), id);
    await this.redis.sadd(mode === "paper" ? KEYS.paper() : KEYS.live(), id);

    console.log(`[Portfolio] ${mode.toUpperCase()} position opened: ${name} (score: ${score.totalScore})`);
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
      ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
      : 0;

    await this.savePosition(pos);
    await this.redis.srem(KEYS.open(), positionId);

    console.log(
      `[Portfolio] Position closed: ${pos.name} | ` +
      `P&L: ${pos.pnlEth > 0 ? "+" : ""}${pos.pnlEth.toFixed(4)} ETH ` +
      `(${pos.pnlPct.toFixed(1)}%)`
    );

    return pos;
  }

  // ── WATCHLIST ──────────────────────────────────────────────────────────────

  async addToWatchlist(
    score:   NFTScore | TokenScore,
    name:    string,
    tokenId?: string
  ): Promise<WatchlistItem> {
    const isNFT   = "collection" in score;
    const address = isNFT
      ? (score as NFTScore).collection
      : (score as TokenScore).address;
    const symbol  = isNFT ? undefined : (score as TokenScore).symbol;
    const key     = `${score.chain}:${address}:${tokenId || "token"}`;

    const item: WatchlistItem = {
      type:     isNFT ? "nft" : "token",
      address,
      tokenId,
      symbol,
      chain:    score.chain,
      name,
      score:    score.totalScore,
      thesis:   score.thesis,
      signals:  score.signals as Record<string, number>,
      addedAt:  Date.now(),
      lastScore: score.totalScore,
      scoredAt:  Date.now(),
    };

    await this.redis.set(KEYS.watchItem(key), JSON.stringify(item));
    await this.redis.sadd(KEYS.watchlist(), key);

    console.log(`[Watchlist] Added: ${name} (score: ${score.totalScore})`);
    return item;
  }

  async updateWatchlistScore(
    key:   string,
    score: NFTScore | TokenScore
  ): Promise<void> {
    const raw = await this.redis.get(KEYS.watchItem(key));
    if (!raw) return;

    const item: WatchlistItem = JSON.parse(raw);
    item.lastScore = score.totalScore;
    item.thesis    = score.thesis;
    item.signals   = score.signals as Record<string, number>;
    item.scoredAt  = Date.now();

    await this.redis.set(KEYS.watchItem(key), JSON.stringify(item));
  }

  async getWatchlist(): Promise<WatchlistItem[]> {
    try {
      const keys = await this.redis.smembers(KEYS.watchlist());
      if (!keys?.length) return [];

      const items = await Promise.all(
        keys.map(async (k: string) => {
          const raw = await this.redis.get(KEYS.watchItem(k));
          return raw ? JSON.parse(raw) as WatchlistItem : null;
        })
      );

      return items
        .filter(Boolean)
        .sort((a, b) => b.lastScore - a.lastScore);

    } catch {
      return [];
    }
  }

  async removeFromWatchlist(key: string): Promise<void> {
    await this.redis.srem(KEYS.watchlist(), key);
    await this.redis.del(KEYS.watchItem(key));
  }

  // ── POSITION RETRIEVAL ─────────────────────────────────────────────────────

  async getPosition(id: string): Promise<Position | null> {
    try {
      const raw = await this.redis.get(KEYS.position(id));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async getOpenPositions(): Promise<Position[]> {
    return this.getPositionSet(KEYS.open());
  }

  async getPaperPositions(): Promise<Position[]> {
    return this.getPositionSet(KEYS.paper());
  }

  async getClosedPositions(limit: number = 50): Promise<Position[]> {
    const all    = await this.getAllPositions();
    const closed = all
      .filter(p => p.status === "closed")
      .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
    return closed.slice(0, limit);
  }

  async getAllPositions(): Promise<Position[]> {
    return this.getPositionSet(KEYS.positions());
  }

  private async getPositionSet(setKey: string): Promise<Position[]> {
    try {
      const ids = await this.redis.smembers(setKey);
      if (!ids?.length) return [];

      const positions = await Promise.all(
        ids.map((id: string) => this.getPosition(id))
      );
      return positions.filter(Boolean) as Position[];
    } catch {
      return [];
    }
  }

  private async savePosition(pos: Position): Promise<void> {
    await this.redis.set(KEYS.position(pos.id), JSON.stringify(pos));
  }

  // ── LEARNING LOOP ──────────────────────────────────────────────────────────

  // Grade a closed position — which signals predicted correctly?
  async gradePosition(
    positionId:      string,
    thesisAccurate:  boolean,
    workedSignals:   string[],
    failedSignals:   string[],
    note:            string
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

  // Run monthly review — analyse all graded positions and return weight adjustments
  async runLearningReview(): Promise<{
    signalPerformance: Record<string, { wins: number; losses: number; winRate: number }>;
    recommendations:   Array<{ signal: string; type: "nft" | "token"; adjust: "up" | "down"; magnitude: number }>;
    summary:           string;
  }> {
    const closed  = await this.getClosedPositions(200);
    const graded  = closed.filter(p => p.gradedAt);

    // Tally each signal's performance
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
        if (!profitable) signalPerf[signal].wins++;   // signal flagged a problem correctly
        else             signalPerf[signal].losses++;
      }
    }

    // Calculate win rates and make recommendations
    const performance: Record<string, { wins: number; losses: number; winRate: number }> = {};
    const recommendations: Array<{
      signal: string; type: "nft" | "token"; adjust: "up" | "down"; magnitude: number
    }> = [];

    for (const [signal, perf] of Object.entries(signalPerf)) {
      const total   = perf.wins + perf.losses;
      const winRate = total > 0 ? perf.wins / total : 0;
      performance[signal] = { ...perf, winRate };

      if (total >= 5) { // only adjust if enough data
        const type = signal.includes("normies") || signal.includes("token")
          ? "token" : "nft";

        if (winRate >= 0.7) {
          recommendations.push({ signal, type, adjust: "up", magnitude: 0.1 });
        } else if (winRate <= 0.3) {
          recommendations.push({ signal, type, adjust: "down", magnitude: 0.1 });
        }
      }
    }

    const totalGraded   = graded.length;
    const profitable    = graded.filter(p => (p.pnlPct || 0) > 0).length;
    const overallWinRate = totalGraded > 0 ? (profitable / totalGraded * 100).toFixed(1) : "N/A";
    const avgPnl        = graded.length > 0
      ? graded.reduce((s, p) => s + (p.pnlPct || 0), 0) / graded.length
      : 0;

    const summary = [
      `Learning review: ${totalGraded} graded positions.`,
      `Win rate: ${overallWinRate}%. Avg P&L: ${avgPnl > 0 ? "+" : ""}${avgPnl.toFixed(1)}%.`,
      `${recommendations.length} signal weight adjustments recommended.`,
      recommendations.map(r =>
        `${r.signal}: ${r.adjust === "up" ? "↑" : "↓"} (winRate: ${(performance[r.signal]?.winRate * 100).toFixed(0)}%)`
      ).join(", "),
    ].filter(Boolean).join(" ");

    return { signalPerformance: performance, recommendations, summary };
  }

  // ── PORTFOLIO SUMMARY ──────────────────────────────────────────────────────

  async getSummary(): Promise<PortfolioSummary> {
    const all    = await this.getAllPositions();
    const open   = all.filter(p => p.status === "open");
    const closed = all.filter(p => p.status === "closed");
    const paper  = open.filter(p => p.mode === "paper");
    const live   = open.filter(p => p.mode === "live");

    const totalInvested = open.reduce((s, p) => s + p.entryPrice, 0);
    const realisedPnl   = closed.reduce((s, p) => s + (p.pnlEth || 0), 0);

    const profitable = closed.filter(p => (p.pnlPct || 0) > 0);
    const winRate    = closed.length > 0
      ? (profitable.length / closed.length) * 100
      : 0;

    const holdTimes  = closed
      .filter(p => p.closedAt)
      .map(p => (p.closedAt! - p.openedAt) / (1000 * 3600 * 24));
    const avgHoldDays = holdTimes.length > 0
      ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length
      : 0;

    const byPnl = [...closed].sort((a, b) => (b.pnlPct || 0) - (a.pnlPct || 0));

    return {
      totalPositions:   all.length,
      openPositions:    open.length,
      paperPositions:   paper.length,
      livePositions:    live.length,
      totalInvestedEth: totalInvested,
      unrealisedPnlEth: 0,          // requires current price lookup
      realisedPnlEth:   realisedPnl,
      winRate,
      avgHoldDays,
      topPerformer:     byPnl[0],
      worstPerformer:   byPnl[byPnl.length - 1],
    };
  }

  async formatSummaryForContext(): Promise<string> {
    const s        = await this.getSummary();
    const watchlist = await this.getWatchlist();

    return [
      `Portfolio: ${s.openPositions} open (${s.paperPositions} paper / ${s.livePositions} live)`,
      `Invested: ${s.totalInvestedEth.toFixed(4)} ETH`,
      `Realised P&L: ${s.realisedPnlEth >= 0 ? "+" : ""}${s.realisedPnlEth.toFixed(4)} ETH`,
      `Win rate: ${s.winRate.toFixed(1)}% (${s.totalPositions} total)`,
      `Avg hold: ${s.avgHoldDays.toFixed(1)} days`,
      `Watchlist: ${watchlist.length} items`,
      watchlist.length > 0
        ? `Top watch: ${watchlist[0].name} (${watchlist[0].lastScore}/100)`
        : "",
    ].filter(Boolean).join(" | ");
  }
}
