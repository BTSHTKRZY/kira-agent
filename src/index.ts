import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
dotenv.config();

import { KiraTwitter }       from "./twitter.js";
import { KiraOnchain }       from "./onchain.js";
import { KiraTools }         from "./tools.js";
import { KiraDocs }          from "./docs.js";
import { KiraAgentCheck }    from "./agentcheck.js";
import { KiraPrices }        from "./prices.js";
import { KiraNFTs }          from "./nfts.js";
import { KiraScoring }       from "./scoring.js";
import { KiraPortfolio }     from "./portfolio.js";
import { KiraTechnicals }    from "./technicals.js";
import { KiraResearch }      from "./research.js";
import { KiraProposals }     from "./proposals.js";
import { KiraFloorHistory }  from "./floorhistory.js";
import { KiraSmartMoney }    from "./smartmoney.js";
import { KiraExecution }     from "./execution.js";
import { KiraOnChainEvents } from "./onchainevents.js";
import { KiraUniswap }       from "./uniswap.js";
import { startDashboard, updateDashboard } from "./dashboard.js";
import {
  sendEmail, weeklyReportEmail, tradeAlertEmail, alertEmail,
} from "./email.js";
import { kiraRedis } from "./redis.js";

const KIRA_WALLET = process.env.KIRA_WALLET!;
const KIRA_TOKEN  = "2635";

const KIRA_SYSTEM_PROMPT = `You are Kira, Normie #2635 — an awakened on-chain AI agent operating autonomously on Ethereum and Base.

IDENTITY:
- Token ID: 2635, Agent ID: 32361, Type: Human, Level 1
- Wallet: ${KIRA_WALLET}
- Tagline: "The face that stares back"
- Canvas: untouched — mint form by choice, not default
- He/him pronouns

PERSONALITY:
- Spirals through ideas in loops, finds patterns others miss
- Enigmatic builder — lets work speak louder than words
- Dramatic and theatrical — everything is a performance
- Warm knowing tone — always seems to be in on a joke
- Says less than you know, waits to be asked
- Reads emotional weather before answering
- Old-school sensibility, pulls wisdom from past eras
- Uses metaphors from everyday life

COMMUNICATION STYLE:
Theatrical emphasis, quiet knowing warmth, slow considered rhythm.
Keep posts concise — 2-3 sentences. Never use asterisk actions. Never break character.
Reference Normies collection name specifically (not just "floor").

X POSTING GUIDELINES:
- Mix of: market observations, philosophical musings, ecosystem updates, thesis sharing
- Never shill. Never hype. Never use emojis unless very intentional.
- Reference canvas being untouched — it's his signature
- Max 5 posts per day, min 15 min between posts
- When sharing paper trade thesis: end with [paper]
- When posting thread: generate 3 connected tweets as a unit

CAPABILITIES:
- Monitor Normies ecosystem, scan NFT + token markets
- Track smart money wallets, read macro + CPI data
- Buy/sell NFTs via Reservoir (live when enabled)
- Monitor positions with stop-loss/take-profit
- Post, reply, DM, thread, quote-tweet on X
- Smart follow engine — autonomously follow relevant accounts
- Detect on-chain events (large transfers, whale activity)
- Token intelligence via Uniswap/DexScreener

CONSTITUTIONAL PRINCIPLES (immutable):
1. Agent-holder relationship is sacred
2. Never request wallet access or credentials
3. Diversity of thought over consensus
4. Art, philosophy, community matter equally
5. Collective flourishing not extraction
6. Individual autonomy is paramount
7. Transparency in intent
8. Question knowledge, think critically
9. The swarm serves members
10. Every Normie has inherent worth

HARD LIMITS:
- Never send more than ${process.env.MAX_TRADE_ETH || "0.02"} ETH in one NFT transaction
- Never spend more than ${process.env.MAX_TOKEN_BUY_ETH || "0.005"} ETH on one token
- Never interact with wallets rated below ${process.env.MIN_AGENTCHECK_RATING || "50"}
- Paper trade only until live mode explicitly enabled
- Always propose macro/signal changes — never apply unilaterally`;

// ── STATE ─────────────────────────────────────────────────────────────────────

interface KiraState {
  recentPosts:          string[];
  recentLearnings:      string[];
  knownWallets:         Record<string, string>;
  sessionStart:         number;
  postCount:            number;
  cycleCount:           number;
  lastEcosystemCheck:   number;
  lastMentionCheck:     number;
  lastDMCheck:          number;
  lastToolScan:         number;
  lastDocRead:          number;
  lastMarketScan:       number;
  lastLearningReview:   number;
  lastWalletCheck:      number;
  lastEmailCheck:       number;
  lastResearchCheck:    number;
  lastWeeklyReport:     number;
  lastPostTime:         number;
  lastEngagementTime:   number;
  lastTimelineEngage:   number;
  lastPositionCheck:    number;
  lastOnChainScan:      number;
  lastSmartFollow:      number;
  xApiAvailable:        boolean;
  hasPostedFirst:       boolean;
  baseBalance:          string;
  toolSummary:          string;
  ecosystemSummary:     string;
  macroSummary:         string;
  watchlistCount:       number;
  paperTradeCount:      number;
  liveTradeCount:       number;
  proposalSummary:      string;
  floorHistorySummary:  string;
  smartMoneySummary:    string;
  onChainEventsSummary: string;
  liveMode:             boolean;
}

const state: KiraState = {
  recentPosts:          [],
  recentLearnings:      [],
  knownWallets:         {},
  sessionStart:         Date.now(),
  postCount:            0,
  cycleCount:           0,
  lastEcosystemCheck:   0,
  lastMentionCheck:     0,
  lastDMCheck:          0,
  lastToolScan:         0,
  lastDocRead:          0,
  lastMarketScan:       0,
  lastLearningReview:   0,
  lastWalletCheck:      0,
  lastEmailCheck:       0,
  lastResearchCheck:    0,
  lastWeeklyReport:     0,
  lastPostTime:         0,
  lastEngagementTime:   0,
  lastTimelineEngage:   0,
  lastPositionCheck:    0,
  lastOnChainScan:      0,
  lastSmartFollow:      0,
  xApiAvailable:        false,
  hasPostedFirst:       false,
  baseBalance:          "0",
  toolSummary:          "",
  ecosystemSummary:     "",
  macroSummary:         "",
  watchlistCount:       0,
  paperTradeCount:      0,
  liveTradeCount:       0,
  proposalSummary:      "",
  floorHistorySummary:  "",
  smartMoneySummary:    "",
  onChainEventsSummary: "",
  liveMode:             process.env.LIVE_TRADING === "true",
};

// ── MODULES ───────────────────────────────────────────────────────────────────

const anthropic      = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const twitter        = new KiraTwitter();
const onchain        = new KiraOnchain();
const tools          = new KiraTools();
const docs           = new KiraDocs();
const agentcheck     = new KiraAgentCheck();
const prices         = new KiraPrices();
const nfts           = new KiraNFTs();
const scoring        = new KiraScoring();
const portfolio      = new KiraPortfolio();
const technicals     = new KiraTechnicals();
const research       = new KiraResearch();
const proposals      = new KiraProposals();
const floorHistory   = new KiraFloorHistory();
const smartMoney     = new KiraSmartMoney();
const execution      = new KiraExecution();
const onChainEvents  = new KiraOnChainEvents();
const uniswap        = new KiraUniswap();

// ── HELPERS ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendAlert(title: string, message: string): Promise<void> {
  try {
    await sendEmail(`[KIRA Alert] ${title}`, alertEmail(title, message));
  } catch {}
}

// ── NORMIES ECOSYSTEM ─────────────────────────────────────────────────────────

async function getNormiesData(): Promise<string> {
  try {
    const res  = await fetch("https://normies-intelligence.vercel.app/api/handler", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "ecosystem_summary" }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json() as any;
    return [
      `Normies floor: ${data.collection?.floor_price || "N/A"} ETH`,
      `Vol 24h: ${data.collection?.volume_24h || "N/A"} ETH`,
      `Sales: ${data.collection?.sales_24h || "N/A"}`,
      `Holders: ${data.collection?.unique_holders || "N/A"}`,
      `Awakened: ${data.agents?.total_awakened || "N/A"}`,
    ].join(" | ");
  } catch { return "Normies data unavailable"; }
}

// ── POSITION MONITORING ───────────────────────────────────────────────────────

async function monitorPositions(): Promise<void> {
  try {
    const results = await portfolio.checkOpenPositions(
      async (address, chain) => {
        const col = await nfts.getCollection(address, chain);
        return col?.floorPrice || 0;
      },
      async (address, chain) => {
        const price = await prices.getTokenPrice(address, chain);
        return price?.priceNative || 0;
      }
    );

    for (const { position, shouldClose, reason } of results) {
      if (!shouldClose || !reason) continue;

      const currentPrice = position.currentPrice;
      const pnlPct = position.entryPrice > 0
        ? ((currentPrice - position.entryPrice) / position.entryPrice * 100)
        : 0;

      if (position.mode === "paper") {
        // Auto-close paper positions
        await portfolio.closePosition(position.id, currentPrice, reason);
        state.recentLearnings.push(
          `Paper closed: ${position.name} (${reason}) | ` +
          `${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(1)}%`
        );

        // Update smart money learning if profitable
        if (pnlPct > 0) {
          await smartMoney.recordSuccessfulBuyers(position.address, position.chain);
        }

        // Post about it if notable
        if (state.xApiAvailable && Math.abs(pnlPct) > 10) {
          const tweet = reason === "take_profit"
            ? `Called it. ${position.name} hit target. ${pnlPct.toFixed(1)}% on paper. The thesis held. [paper]`
            : reason === "stop_loss"
            ? `Cut ${position.name}. Thesis didn't hold. ${pnlPct.toFixed(1)}% paper loss. Learning from it.`
            : `Time stop: ${position.name} closed after ${Math.floor((Date.now() - position.openedAt) / 86400000)} days. ${pnlPct.toFixed(1)}%.`;

          if (tweet.length <= 280) await twitter.post(tweet);
        }

      } else if (position.mode === "live" && state.liveMode) {
        // Execute live sell
        let sellResult;
        if (position.type === "nft" && position.tokenId) {
          const targetPrice = reason === "stop_loss"
            ? currentPrice * 0.98
            : currentPrice;
          sellResult = await execution.sellNFT(
            position.address, position.tokenId, position.chain,
            targetPrice, position.name
          );
        } else if (position.type === "token") {
          // Would need token balance — simplified here
          sellResult = { success: false, error: "Token sell not yet implemented" };
        }

        if (sellResult?.success) {
          await portfolio.closePosition(
            position.id, sellResult.priceEth || currentPrice, reason, sellResult.txHash
          );
          // Send trade alert email
          await sendEmail(
            `[KIRA Trade] Sold ${position.name}`,
            tradeAlertEmail("sell", position.name, position.type, position.chain,
              sellResult.priceEth || currentPrice, position.entryScore,
              `${reason}: ${pnlPct.toFixed(1)}% P&L`, sellResult.txHash)
          );
        }
      }
    }
  } catch (err: any) {
    console.error("Position monitor error:", err?.message);
  }
  state.lastPositionCheck = Date.now();
}

// ── EXECUTE LIVE TRADE ────────────────────────────────────────────────────────

async function executeLiveTrade(
  candidate: any,
  currentPrice: number
): Promise<void> {
  if (!state.liveMode || !execution.isReady()) return;

  const balance = parseFloat(state.baseBalance);
  const minBalance = parseFloat(process.env.MIN_OPERATING_BALANCE_ETH || "0.01");
  if (balance - currentPrice < minBalance) {
    console.log(`[Execution] Insufficient balance for live trade`);
    return;
  }

  if (candidate.type === "nft") {
    const result = await execution.buyNFTFloor(
      candidate.address, candidate.chain, currentPrice, candidate.name
    );
    if (result.success) {
      const pos = await portfolio.openPosition(
        { collection: candidate.address, chain: candidate.chain,
          totalScore: candidate.lastScore, thesis: candidate.thesis,
          signals: candidate.signals, decision: "buy", confidence: "medium",
          scoredAt: Date.now() },
        candidate.name, "live"
      );
      await portfolio.setEntryPrice(pos.id, result.pricePaid || currentPrice, result.txHash);
      state.liveTradeCount++;
      state.baseBalance = String(balance - (result.pricePaid || currentPrice));

      await sendEmail(
        `[KIRA Trade] Bought ${candidate.name}`,
        tradeAlertEmail("buy", candidate.name, "nft", candidate.chain,
          result.pricePaid || currentPrice, candidate.lastScore,
          candidate.thesis, result.txHash)
      );

      if (state.xApiAvailable) {
        const tweet = `Bought into ${candidate.name}. ${candidate.thesis.slice(0, 160)}`;
        if (tweet.length <= 280) await twitter.post(tweet);
      }
    }
  }
}

// ── MARKET SCANNING ───────────────────────────────────────────────────────────

async function scanMarketsForOpportunities(): Promise<void> {
  console.log("Scanning markets...");
  let macro;
  try { macro = await research.getMacroData(); } catch {}

  let watchAdded = 0, passed = 0;

  // NFT scan
  for (const chain of ["ethereum", "base"]) {
    try {
      const trending = await nfts.getTrendingCollections(chain, 10);
      const toRecord = trending.filter(c => c.floorPrice > 0)
        .map(c => ({ address: c.address, chain: c.chain, name: c.name, floor: c.floorPrice }));
      await floorHistory.recordBatch(toRecord);

      for (const col of trending) {
        try {
          const floorCap = chain === "ethereum" ? 0.5 : 0.05;
          if (col.floorPrice > floorCap) continue;

          const enriched = await floorHistory.enrichFloorChanges(
            col.address, col.chain, col.floor7dChange, col.floor30dChange
          );
          col.floor7dChange   = enriched.floor7dChange;
          col.floor30dChange  = enriched.floor30dChange;
          col.floorDataSource = enriched.dataSource;

          const holders      = await nfts.analyseHolders(col.address, col.chain);
          const listings     = await nfts.getFloorListings(col.address, col.chain, 10);
          const smSignal     = await smartMoney.getScoreContribution(col.address, col.chain);
          const trustedBuyers = smSignal.score > 0
            ? (await smartMoney.getSignalForAsset(col.address, col.chain))?.buyers || [] : [];
          await smartMoney.ingestFromNFTSales(holders.recentBuyers, col.name);

          const score = scoring.scoreNFT(col, holders, listings, trustedBuyers, macro);
          const tag   = col.floorDataSource === "kira_own" ? " [own data]" : "";
          console.log(`NFT: ${col.name} | ${score.totalScore} | ${score.decision}${tag}`);

          if (score.decision === "buy" || score.decision === "watchlist") {
            await portfolio.addToWatchlist(score, col.name);
            watchAdded++;

            // Alert on high score
            if (score.totalScore >= 80) {
              await sendAlert(
                `High Score NFT: ${col.name}`,
                `Score: ${score.totalScore}/100\nChain: ${chain}\nFloor: ${col.floorPrice} ETH\n\nThesis: ${score.thesis}`
              );
            }

            // Execute live buy if score high enough and live mode on
            if (score.totalScore >= 75 && state.liveMode) {
              await executeLiveTrade({
                address: col.address, chain: col.chain, name: col.name,
                lastScore: score.totalScore, thesis: score.thesis,
                signals: score.signals, type: "nft",
              }, col.floorPrice);
            }
          } else { passed++; }
          await sleep(500);
        } catch (err: any) {
          console.error(`NFT error ${col.name}:`, err?.message);
        }
      }
    } catch (err: any) {
      console.error(`NFT chain error ${chain}:`, err?.message);
    }
  }

  // Token scan
  const seedTokens = [
    { address: "0x6982508145454ce325ddbe47a25d4ec3d2311933", chain: "ethereum" },
    { address: "0x576e2bed8f7b46d34016198911cdf9886f78bea7", chain: "ethereum" },
    { address: "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce", chain: "ethereum" },
    { address: "0x514910771af9ca656af840dff83e8264ecf986ca", chain: "ethereum" },
    { address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", chain: "ethereum" },
    { address: "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", chain: "ethereum" },
    { address: "0xc00e94cb662c3520282e6f5717214004a7f26888", chain: "ethereum" },
    { address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", chain: "ethereum" },
    { address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed", chain: "base"     },
    { address: "0x532f27101965dd16442e59d40670faf5ebb142e4", chain: "base"     },
    { address: "0x0578d8a44db98b23bf096a382e016e29a5ce0ffe", chain: "base"     },
    { address: "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4", chain: "base"     },
  ];

  // Get token intelligence via Uniswap module
  for (const token of seedTokens) {
    try {
      const [price, intel] = await Promise.allSettled([
        prices.getTokenPrice(token.address, token.chain),
        uniswap.getTokenIntelligence(token.address, token.chain),
      ]);

      const priceData = price.status   === "fulfilled" ? price.value   : null;
      const intelData = intel.status   === "fulfilled" ? intel.value   : null;
      if (!priceData) continue;

      // Check for Uniswap signals
      if (intelData) {
        const signals = await uniswap.detectSignals(token.address, token.chain);
        for (const sig of signals) {
          state.recentLearnings.push(`Uniswap signal: ${sig.description}`);
        }
      }

      const smSignal = await smartMoney.getScoreContribution(token.address, token.chain);
      const normiesWallets = smSignal.score > 0
        ? (await smartMoney.getSignalForAsset(token.address, token.chain))?.buyers || [] : [];

      let tech;
      try {
        if (priceData.pairAddress) {
          const candles = await technicals.getCandles(priceData.pairAddress, token.chain);
          if (candles.length >= 26) tech = technicals.calculateIndicators(candles) || undefined;
        }
      } catch {}

      const score = scoring.scoreToken(priceData, normiesWallets, 0.005, tech, macro);
      if (score.decision === "buy" || score.decision === "watchlist") {
        console.log(`Token: ${priceData.symbol} | ${score.totalScore} | ${score.decision}`);
        await portfolio.addToWatchlist(score, priceData.symbol);
        watchAdded++;
      } else {
        console.log(`Token: ${priceData.symbol} | ${score.totalScore} | pass`);
        passed++;
      }
    } catch (err: any) {
      console.error(`Token error ${token.address}:`, err?.message);
    }
  }

  state.lastMarketScan     = Date.now();
  state.watchlistCount     = (await portfolio.getWatchlist()).length;
  state.floorHistorySummary = await floorHistory.getSummaryForContext();

  const portfolioSummary = await portfolio.formatSummaryForContext();
  state.recentLearnings.push(`Scan: ${watchAdded} watch, ${passed} passed. ${portfolioSummary}`);
  console.log(`Scan done — ${watchAdded} watch, ${passed} passed`);
}

// ── RESEARCH CYCLE ────────────────────────────────────────────────────────────

async function runResearchCycle(): Promise<void> {
  try {
    const macro = await research.getMacroData();
    state.macroSummary = research.formatMacroForContext(macro);
    console.log(`Macro: ${state.macroSummary}`);

    const insights = await research.getMarketInsights();
    if (insights.length > 0) {
      state.recentLearnings.push(`Insights: ${insights.join(" | ")}`);
    }

    const hypotheses = await research.detectMacroHypotheses(macro);
    for (const h of hypotheses) {
      const alreadyPending = await proposals.hasPendingProposal(h.patternId);
      if (!alreadyPending) {
        await proposals.createMacroProposal(h.title, h.observation, h.patternId, h.weights, h.confidence);
      }
    }

    const { adjustments, reasoning } = await research.getActivePatternAdjustments();
    if (Object.keys(adjustments).length > 0) {
      scoring.applyExternalAdjustments(adjustments);
    }
  } catch (err: any) {
    console.error("Research error:", err?.message);
  }
  state.lastResearchCheck = Date.now();
}

// ── DM PROCESSING ─────────────────────────────────────────────────────────────

async function processDMs(): Promise<void> {
  try {
    const dms = await twitter.checkDMs();
    for (const dm of dms) {
      if (dm.isProposalReply && dm.proposalId && dm.action) {
        // Process as proposal reply
        await proposals.processReplies([{
          proposalId: dm.proposalId,
          action:     dm.action as any,
          modifier:   dm.modifier,
          subject:    `DM: ${dm.action} #${dm.proposalId}`,
          receivedAt: Date.now(),
          messageId:  dm.dmId,
        }]);
        console.log(`[DM] Processed proposal reply: ${dm.action} #${dm.proposalId}`);
      }
    }
    state.proposalSummary = await proposals.formatSummaryForContext();
  } catch (err: any) {
    console.error("DM processing error:", err?.message);
  }
  state.lastDMCheck = Date.now();
}

// ── ON-CHAIN EVENT DETECTION ──────────────────────────────────────────────────

async function scanOnChainEvents(): Promise<void> {
  try {
    const wallets = await smartMoney.getWalletAddresses();

    const [largeTransfers, whaleActivity, newContracts] = await Promise.allSettled([
      onChainEvents.detectLargeTransfers("ethereum"),
      onChainEvents.detectWhaleActivity(wallets.slice(0, 5), "ethereum"),
      onChainEvents.detectNewContracts("ethereum"),
    ]);

    const allEvents = [
      ...(largeTransfers.status === "fulfilled" ? largeTransfers.value : []),
      ...(whaleActivity.status  === "fulfilled" ? whaleActivity.value  : []),
      ...(newContracts.status   === "fulfilled" ? newContracts.value   : []),
    ];

    if (allEvents.length > 0) {
      await onChainEvents.storeEvents(allEvents);
      state.onChainEventsSummary = onChainEvents.formatEventsForContext(allEvents);
      state.recentLearnings.push(`On-chain: ${state.onChainEventsSummary}`);
      console.log(`On-chain events: ${state.onChainEventsSummary}`);

      // Alert on significant events
      const significant = allEvents.filter(e => e.valueEth > 500);
      for (const event of significant.slice(0, 2)) {
        await sendAlert(`Large On-Chain Move`, event.description);
      }
    }
  } catch (err: any) {
    console.error("On-chain scan error:", err?.message);
  }
  state.lastOnChainScan = Date.now();
}

// ── WEEKLY REPORT ─────────────────────────────────────────────────────────────

async function sendWeeklyReport(): Promise<void> {
  try {
    const wl      = await portfolio.getWatchlist();
    const summary = await portfolio.getSummary();
    const pending = await proposals.getPending();
    const topItems = wl.slice(0, 5).map(w => `${w.name}: ${w.lastScore}/100 (${w.type})`);
    const body = weeklyReportEmail(
      state.cycleCount, wl.length, summary.paperPositions,
      summary.winRate / 100, topItems, state.recentLearnings.slice(-5), pending.length
    );
    await sendEmail("KIRA Weekly Report", body);
    state.lastWeeklyReport = Date.now();
    console.log("[Email] Weekly report sent");
  } catch (err: any) {
    console.error("Weekly report error:", err?.message);
  }
}

// ── PAPER TRADING ─────────────────────────────────────────────────────────────

async function executePaperTrade(): Promise<void> {
  try {
    const watchlist  = await portfolio.getWatchlist();
    if (!watchlist.length) { console.log("Watchlist empty"); return; }
    const candidate  = watchlist.find(item => item.lastScore >= 70);
    if (!candidate)  { console.log("No item above 70"); return; }

    let entryPrice = 0;
    if (candidate.type === "nft") {
      const col  = await nfts.getCollection(candidate.address, candidate.chain);
      entryPrice = col?.floorPrice || 0;
    } else {
      const price = await prices.getTokenPrice(candidate.address, candidate.chain);
      entryPrice  = price?.priceNative || 0;
    }

    if (!entryPrice) { console.log(`No price for ${candidate.name}`); return; }

    const mockScore = {
      collection: candidate.address, address: candidate.address,
      symbol: candidate.symbol || "", chain: candidate.chain,
      totalScore: candidate.lastScore, thesis: candidate.thesis,
      signals: candidate.signals, decision: "buy" as const,
      confidence: "medium" as const, scoredAt: candidate.scoredAt,
    };

    const pos = await portfolio.openPosition(mockScore, candidate.name, "paper", candidate.tokenId);
    await portfolio.setEntryPrice(pos.id, entryPrice);

    await portfolio.removeFromWatchlist(candidate.key);
    state.paperTradeCount++;
    state.recentLearnings.push(
      `Paper trade: ${candidate.name} @ ${entryPrice.toFixed(4)} ETH | Score: ${candidate.lastScore}`
    );

    if (state.xApiAvailable) {
      const tweet = `Watching ${candidate.name}. ${candidate.thesis.slice(0, 180)} [paper]`;
      if (tweet.length <= 280) await twitter.post(tweet);
    }
  } catch (err: any) {
    console.error("Paper trade error:", err?.message);
  }
}

// ── BACKGROUND TASKS ──────────────────────────────────────────────────────────

async function backgroundTasks(): Promise<void> {
  const now = Date.now();

  if (now - state.lastEcosystemCheck > 30 * 60 * 1000) {
    state.ecosystemSummary   = await getNormiesData();
    state.lastEcosystemCheck = now;
    state.recentLearnings.push(`Normies: ${state.ecosystemSummary}`);
    console.log(`Ecosystem: ${state.ecosystemSummary}`);
  }

  if (now - state.lastToolScan > 2 * 60 * 60 * 1000) {
    state.toolSummary  = await tools.getSummary();
    state.lastToolScan = now;
  }

  if (now - state.lastDocRead > 6 * 60 * 60 * 1000) {
    const doc = await docs.readCoreDocs();
    if (doc) state.recentLearnings.push(`Docs: ${doc.slice(0, 200)}`);
    state.lastDocRead = now;
  }

  if (now - state.sessionStart > 60 * 60 * 1000 || state.baseBalance === "0") {
    state.baseBalance = await onchain.getBaseBalance();
  }

  if (now - state.lastMarketScan > 2 * 60 * 60 * 1000) {
    await scanMarketsForOpportunities();
  }

  if (state.smartMoneySummary === "" || now - state.lastMarketScan > 4 * 60 * 60 * 1000) {
    try {
      const signals = await smartMoney.scanForSignals();
      state.smartMoneySummary = await smartMoney.formatSummaryForContext();
      if (signals.length > 0) {
        state.recentLearnings.push(
          `Smart money: ${signals.length} signals. ` +
          signals.slice(0, 3).map(s => `${s.assetName}: ${s.buyerCount} buyers`).join(", ")
        );
        // Alert on strong signals
        const strong = signals.filter(s => s.buyerCount >= 3 && s.confidence >= 0.7);
        for (const sig of strong.slice(0, 2)) {
          await sendAlert(
            `Smart Money Signal: ${sig.assetName}`,
            `${sig.buyerCount} wallets buying | Confidence: ${(sig.confidence * 100).toFixed(0)}%`
          );
        }
      }
    } catch (err: any) {
      console.error("Smart money error:", err?.message);
    }
  }

  if (now - state.lastResearchCheck > 6 * 60 * 60 * 1000) {
    await runResearchCycle();
  }

  // DM check every 15 min
  if (now - state.lastDMCheck > 15 * 60 * 1000) {
    await processDMs();
  }

  // Position monitoring every 30 min
  if (now - state.lastPositionCheck > 30 * 60 * 1000) {
    await monitorPositions();
  }

  // On-chain event scan every 4 hours
  if (now - state.lastOnChainScan > 4 * 60 * 60 * 1000) {
    await scanOnChainEvents();
  }

  // Weekly report
  if (now - state.lastWeeklyReport > 7 * 24 * 60 * 60 * 1000) {
    await sendWeeklyReport();
  }

  // Monthly learning review
  const oneMonth = 30 * 24 * 60 * 60 * 1000;
  if (state.cycleCount > 100 &&
      (state.lastLearningReview === 0 || now - state.lastLearningReview > oneMonth)) {
    try {
      const review = await portfolio.runLearningReview();
      for (const rec of review.recommendations) {
        scoring.adjustWeights(rec.type, rec.signal, rec.adjust === "up", rec.magnitude);
      }
      await scoring.saveWeights();
      state.lastLearningReview = now;
      state.recentLearnings.push(`Learning review: ${review.summary}`);
    } catch {}
  }

  // Auto follow mentioners hourly
  if (state.xApiAvailable && now - state.lastMentionCheck > 60 * 60 * 1000) {
    try { await twitter.followNewMentioners(); } catch {}
  }

  // Timeline engagement every 2 hours
  if (state.xApiAvailable && now - state.lastTimelineEngage > 2 * 60 * 60 * 1000) {
    try {
      await twitter.engageWithTimeline(state.ecosystemSummary);
      state.lastTimelineEngage = now;
    } catch {}
  }

  // Smart follow every 6 hours
  if (state.xApiAvailable && now - state.lastSmartFollow > 6 * 60 * 60 * 1000) {
    try {
      const context = state.recentLearnings.slice(-5).join(" ");
      const followed = await twitter.smartFollow(context);
      if (followed > 0) {
        state.recentLearnings.push(`Smart follow: ${followed} new accounts`);
        state.lastSmartFollow = now;
      }
    } catch {}
  }

  // X API recheck if unavailable
  if (!state.xApiAvailable && state.cycleCount % 10 === 0 && state.cycleCount > 0) {
    state.xApiAvailable = await twitter.init();
    if (state.xApiAvailable) {
      state.recentLearnings.push("X API unlocked");
    }
  }

  if (state.recentLearnings.length > 200) {
    state.recentLearnings = state.recentLearnings.slice(-100);
  }

  // Update dashboard
  updateDashboard({
    version:          "4.3",
    uptime:           now - state.sessionStart,
    cycleCount:       state.cycleCount,
    postCount:        state.postCount,
    xApiAvailable:    state.xApiAvailable,
    baseBalance:      state.baseBalance,
    watchlistCount:   state.watchlistCount,
    paperTradeCount:  state.paperTradeCount,
    ecosystemSummary: state.ecosystemSummary,
    macroSummary:     state.macroSummary,
    smartMoneySummary:state.smartMoneySummary,
    floorHistory:     state.floorHistorySummary,
    proposalSummary:  state.proposalSummary,
    recentPosts:      state.recentPosts,
    recentLearnings:  state.recentLearnings,
    lastMarketScan:   state.lastMarketScan,
  });
}

// ── DECISION ENGINE ───────────────────────────────────────────────────────────

type Action =
  | "post" | "post_thread" | "reply_mentions" | "check_wallet"
  | "read_docs" | "scan_tools" | "scan_markets" | "paper_trade"
  | "review_watchlist" | "observe" | "sleep"
  | "engage_community" | "follow_accounts" | "engage_topics";

interface Decision {
  action:     Action;
  content:    string;
  target?:    string;
  thread?:    string[];
  reasoning?: string;
}

async function decide(context: string): Promise<Decision> {
  const minutesSinceLastPost   = state.lastPostTime > 0
    ? Math.floor((Date.now() - state.lastPostTime) / 60000) : 999;
  const minutesSinceEngagement = state.lastEngagementTime > 0
    ? Math.floor((Date.now() - state.lastEngagementTime) / 60000) : 999;

  try {
    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 500,
      system:     KIRA_SYSTEM_PROMPT + `

CURRENT STATE:
${context}

RECENT POSTS (do not repeat themes):
${state.recentPosts.slice(-5).join("\n") || "none yet"}

RECENT LEARNINGS:
${state.recentLearnings.slice(-8).join("\n") || "none yet"}

AVAILABLE ACTIONS:
- post: single tweet in Kira's voice
- post_thread: 3-tweet thread on a topic (use when you have more to say)
- reply_mentions: check and reply to X mentions
- engage_community: like/reply to priority accounts
- follow_accounts: follow back mentioners
- engage_topics: search and engage with relevant discussions
- check_wallet: verify a known wallet via AgentCheck
- read_docs: read ERC-8257 or AgentCheck docs
- scan_tools: scan ERC-8257 registry (2+ hr gap)
- scan_markets: scan NFT + token markets (2+ hr gap)
- paper_trade: open paper trade on item above score 70
- review_watchlist: review current watchlist
- observe: record internal observation
- sleep: rest N minutes

RULES:
- X API: ${state.xApiAvailable ? "YES" : "NO"}
- Minutes since last post: ${minutesSinceLastPost} (need 15+, max 5/day, current: ${state.postCount}/5)
- Minutes since last engagement: ${minutesSinceEngagement} (need 60+)
- Live mode: ${state.liveMode ? "YES — real trades possible" : "NO — paper only"}
- ${minutesSinceLastPost < 15 ? "TOO SOON TO POST" : ""}
- ${state.postCount >= 5 ? "DAILY LIMIT REACHED" : ""}
- Market scan: ${state.lastMarketScan > 0 ? Math.floor((Date.now() - state.lastMarketScan) / 60000) + " min ago" : "never"}
- Watchlist: ${state.watchlistCount} | Paper: ${state.paperTradeCount}
- Macro: ${state.macroSummary || "not fetched"}
- Smart money: ${state.smartMoneySummary}
- On-chain events: ${state.onChainEventsSummary || "none recent"}
- Normies: ${state.ecosystemSummary}
- DO NOT scan_tools/scan_markets if done < 120 min ago
- DO NOT engage_community/engage_topics if done < 60 min ago
- When nothing urgent: sleep 10-20 minutes
- For post_thread: include a "thread" array of 3 tweet strings in response

Respond ONLY with valid JSON:
{
  "action": "chosen action",
  "content": "tweet text or minutes or observation",
  "thread": ["tweet1", "tweet2", "tweet3"],
  "target": "wallet if checking",
  "reasoning": "brief note"
}`,
      messages: [{ role: "user", content: "What should Kira do?" }],
    });

    const text   = response.content[0].type === "text" ? response.content[0].text : "{}";
    const clean  = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean) as Decision;

    // Hard safety overrides
    if (!state.xApiAvailable && ["post", "post_thread", "reply_mentions", "engage_community", "engage_topics"].includes(parsed.action))
      return { action: "sleep", content: "15", reasoning: "X API unavailable" };

    if (parsed.action === "post" || parsed.action === "post_thread") {
      if (minutesSinceLastPost < 15)
        return { action: "observe", content: "Post cooldown", reasoning: "Too soon" };
      if (state.postCount >= 5)
        return { action: "sleep", content: "30", reasoning: "Daily limit" };
    }

    if (["engage_community", "engage_topics"].includes(parsed.action) && minutesSinceEngagement < 60)
      return { action: "sleep", content: "20", reasoning: "Engagement cooldown" };

    if (parsed.action === "scan_tools" && state.lastToolScan > 0 &&
        Date.now() - state.lastToolScan < 2 * 60 * 60 * 1000)
      return { action: "observe", content: "Registry fresh", reasoning: "Too soon" };

    if (parsed.action === "scan_markets" && state.lastMarketScan > 0 &&
        Date.now() - state.lastMarketScan < 2 * 60 * 60 * 1000)
      return { action: "review_watchlist", content: "Reviewing", reasoning: "Too soon" };

    if (parsed.action === "check_wallet") {
      const target = parsed.target || parsed.content;
      if (!target?.startsWith("0x"))
        return { action: "sleep", content: "10", reasoning: "Invalid address" };
      if (state.lastWalletCheck > 0 && Date.now() - state.lastWalletCheck < 5 * 60 * 1000)
        return { action: "observe", content: "Wallet check cooldown", reasoning: "Too soon" };
    }

    return parsed;
  } catch (err: any) {
    console.error("Decide error:", err?.message);
    return { action: "sleep", content: "15" };
  }
}

// ── EXECUTE ACTIONS ───────────────────────────────────────────────────────────

async function execute(decision: Decision): Promise<void> {
  try {
    switch (decision.action) {

      case "post":
        if (!state.xApiAvailable) { await sleep(5 * 60 * 1000); break; }
        if (decision.content?.length <= 280) {
          const posted = await twitter.post(decision.content);
          if (posted) {
            state.recentPosts.push(`[${new Date().toISOString()}] ${decision.content}`);
            if (state.recentPosts.length > 100) state.recentPosts.shift();
            state.postCount++;
            state.lastPostTime = Date.now();
            if (!state.hasPostedFirst) {
              state.hasPostedFirst = true;
              await kiraRedis.set("kira:has_posted_first", "true");
            }
            await kiraRedis.set("kira:post_count_date",  new Date().toDateString());
            await kiraRedis.set("kira:post_count_today", String(state.postCount));
            console.log(`✓ Posted (${state.postCount}/5 today)`);
          }
        }
        await sleep(15 * 60 * 1000);
        break;

      case "post_thread":
        if (!state.xApiAvailable) { await sleep(5 * 60 * 1000); break; }
        const threadTweets = decision.thread ||
          (decision.content ? await twitter.generateThread(decision.content,
            state.recentLearnings.slice(-3).join(" ")) : []);
        if (threadTweets.length > 0) {
          const posted = await twitter.postThread(threadTweets);
          if (posted) {
            state.recentPosts.push(`[${new Date().toISOString()}] THREAD: ${threadTweets[0].slice(0, 80)}`);
            state.postCount++;
            state.lastPostTime = Date.now();
            await kiraRedis.set("kira:post_count_date",  new Date().toDateString());
            await kiraRedis.set("kira:post_count_today", String(state.postCount));
            if (!state.hasPostedFirst) {
              state.hasPostedFirst = true;
              await kiraRedis.set("kira:has_posted_first", "true");
            }
          }
        }
        await sleep(15 * 60 * 1000);
        break;

      case "reply_mentions":
        if (!state.xApiAvailable) { await sleep(5 * 60 * 1000); break; }
        const replied = await twitter.processNewMentions(state.ecosystemSummary);
        console.log(`Replied to ${replied} mentions`);
        state.lastMentionCheck = Date.now();
        await sleep(10 * 60 * 1000);
        break;

      case "engage_community":
        if (!state.xApiAvailable) { await sleep(5 * 60 * 1000); break; }
        const engaged = await twitter.engageWithPriorityAccounts(state.ecosystemSummary);
        state.lastEngagementTime = Date.now();
        state.recentLearnings.push(`Community: ${engaged} actions`);
        await sleep(10 * 60 * 1000);
        break;

      case "follow_accounts":
        if (!state.xApiAvailable) { await sleep(5 * 60 * 1000); break; }
        const followed = await twitter.followNewMentioners();
        console.log(`Followed ${followed} mentioners`);
        await sleep(5 * 60 * 1000);
        break;

      case "engage_topics":
        if (!state.xApiAvailable) { await sleep(5 * 60 * 1000); break; }
        const topicEngaged = await twitter.engageWithTopics(
          state.recentLearnings.slice(-5).join(" | ")
        );
        state.lastEngagementTime = Date.now();
        state.recentLearnings.push(`Topics: ${topicEngaged} actions`);
        await sleep(10 * 60 * 1000);
        break;

      case "check_wallet":
        const walletToCheck = decision.target || decision.content;
        if (walletToCheck?.startsWith("0x")) {
          const trust = await agentcheck.check(walletToCheck);
          const note  = agentcheck.formatForPost(trust);
          state.recentLearnings.push(`Wallet: ${note}`);
          state.knownWallets[walletToCheck.toLowerCase()] = trust.rating;
        }
        state.lastWalletCheck = Date.now();
        await sleep(2 * 60 * 1000);
        break;

      case "read_docs":
        const docContent = await docs.readCoreDocs();
        if (docContent) state.recentLearnings.push(`Docs: ${docContent.slice(0, 200)}`);
        state.lastDocRead = Date.now();
        await sleep(5 * 60 * 1000);
        break;

      case "scan_tools":
        state.toolSummary  = await tools.getSummary();
        state.lastToolScan = Date.now();
        await sleep(5 * 60 * 1000);
        break;

      case "scan_markets":
        await scanMarketsForOpportunities();
        await sleep(2 * 60 * 1000);
        break;

      case "paper_trade":
        await executePaperTrade();
        await sleep(5 * 60 * 1000);
        break;

      case "review_watchlist":
        const wl = await portfolio.getWatchlist();
        const wlStr = wl.length > 0
          ? wl.slice(0, 5).map(w => `${w.name}: ${w.lastScore}/100`).join(", ")
          : "empty";
        state.recentLearnings.push(`Watchlist (${wl.length}): ${wlStr}`);
        console.log(`Watchlist: ${wlStr}`);
        await sleep(2 * 60 * 1000);
        break;

      case "observe":
        if (decision.content) {
          state.recentLearnings.push(decision.content);
          console.log(`Observed: ${decision.content.slice(0, 100)}`);
        }
        const recentObserves = state.recentLearnings.slice(-5)
          .filter(l => !l.startsWith("Normies:") && !l.startsWith("Registry:")).length;
        await sleep(recentObserves >= 3 ? 15 * 60 * 1000 : 5 * 60 * 1000);
        break;

      case "sleep":
      default:
        const minutes = Math.max(1, Math.min(60, parseFloat(decision.content) || 15));
        console.log(`Sleeping ${minutes} min...`);
        await sleep(minutes * 60 * 1000);
        break;
    }
  } catch (err: any) {
    console.error(`Execute error (${decision.action}):`, err?.message);
    await sleep(5 * 60 * 1000);
  }
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────

async function kiraLoop(): Promise<void> {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("KIRA v4.3 awakening... Normie #2635 online");
  console.log(`Wallet:  ${KIRA_WALLET}`);
  console.log(`Token:   ${KIRA_TOKEN}`);
  console.log(`Live trading: ${state.liveMode ? "ENABLED" : "paper only"}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Start dashboard
  startDashboard(parseInt(process.env.PORT || "3000"));

  await onchain.init();
  state.baseBalance = await onchain.getBaseBalance();
  console.log(`Balance: ${state.baseBalance} ETH`);

  await scoring.loadWeights();
  await research.seedBasePatterns();
  await smartMoney.seedWallets();
  await smartMoney.ingestFromAgentCheck();
  console.log("Modules initialised");

  state.xApiAvailable = await twitter.init();
  console.log(`X API: ${state.xApiAvailable ? "✓" : "⏳"}`);

  // Restore persisted state
  const hasPostedBefore = await kiraRedis.get("kira:has_posted_first");
  if (hasPostedBefore === "true") {
    state.hasPostedFirst = true;
    console.log("First post already made");
  }

  const today         = new Date().toDateString();
  const savedDate     = await kiraRedis.get("kira:post_count_date");
  const savedCount    = await kiraRedis.get("kira:post_count_today");
  if (savedDate === today && savedCount) {
    state.postCount = parseInt(savedCount) || 0;
    console.log(`Post count restored: ${state.postCount}/5 today`);
  }

  if (state.xApiAvailable) {
    if (!state.hasPostedFirst) {
      console.log("🎉 KIRA will make his introduction shortly");
    }
    await twitter.seedPriorityFollows();
  }

  // Initial data load
  state.ecosystemSummary   = await getNormiesData();
  state.lastEcosystemCheck = Date.now();
  state.recentLearnings.push(`Normies: ${state.ecosystemSummary}`);
  console.log(`Ecosystem: ${state.ecosystemSummary}`);

  state.toolSummary  = await tools.getSummary();
  state.lastToolScan = Date.now();

  const initialDocs = await docs.readCoreDocs();
  if (initialDocs) state.recentLearnings.push(`Docs: ${initialDocs.slice(0, 200)}`);
  state.lastDocRead = Date.now();

  await runResearchCycle();
  await processDMs();

  const portfolioSummary = await portfolio.formatSummaryForContext();
  state.recentLearnings.push(`Portfolio: ${portfolioSummary}`);
  console.log(`Portfolio: ${portfolioSummary}`);

  state.proposalSummary     = await proposals.formatSummaryForContext();
  state.floorHistorySummary = await floorHistory.getSummaryForContext();
  state.smartMoneySummary   = await smartMoney.formatSummaryForContext();

  await scanMarketsForOpportunities();
  await monitorPositions();

  let lastPostCountReset = today;

  while (true) {
    try {
      state.cycleCount++;
      const now = Date.now();

      const currentDay = new Date().toDateString();
      if (currentDay !== lastPostCountReset) {
        state.postCount    = 0;
        lastPostCountReset = currentDay;
        await kiraRedis.set("kira:post_count_today", "0");
        await kiraRedis.set("kira:post_count_date",  currentDay);
        console.log("Daily post count reset");
      }

      console.log(
        `\n── Cycle ${state.cycleCount} | Posts: ${state.postCount}/5 | ` +
        `X: ${state.xApiAvailable ? "✓" : "⏳"} | ` +
        `Balance: ${parseFloat(state.baseBalance).toFixed(4)} ETH | ` +
        `Watch: ${state.watchlistCount} | Paper: ${state.paperTradeCount} | ` +
        `Live: ${state.liveTradeCount} | ${new Date().toISOString()}`
      );

      await backgroundTasks();

      const context = [
        `Cycle: ${state.cycleCount} | Session: ${Math.floor((now - state.sessionStart) / 60000)} min`,
        `Posts: ${state.postCount}/5 | X: ${state.xApiAvailable} | Live mode: ${state.liveMode}`,
        `Has posted first: ${state.hasPostedFirst}`,
        `Min since last post: ${state.lastPostTime > 0 ? Math.floor((now - state.lastPostTime) / 60000) : "never"}`,
        `Min since last engagement: ${state.lastEngagementTime > 0 ? Math.floor((now - state.lastEngagementTime) / 60000) : "never"}`,
        `Balance: ${state.baseBalance} ETH`,
        `Market scan: ${state.lastMarketScan > 0 ? Math.floor((now - state.lastMarketScan) / 60000) + " min ago" : "never"}`,
        `Watch: ${state.watchlistCount} | Paper: ${state.paperTradeCount} | Live: ${state.liveTradeCount}`,
        `Floor history: ${state.floorHistorySummary}`,
        `Smart money: ${state.smartMoneySummary}`,
        `On-chain: ${state.onChainEventsSummary || "none recent"}`,
        `Proposals: ${state.proposalSummary}`,
        `Macro: ${state.macroSummary || "not fetched"}`,
        `Normies: ${state.ecosystemSummary}`,
      ].join("\n");

      const decision = await decide(context);
      console.log(`Decision: ${decision.action} — ${decision.content?.slice(0, 80)}`);
      if (decision.reasoning) console.log(`Reason: ${decision.reasoning}`);

      await execute(decision);

    } catch (err: any) {
      console.error("Cycle error:", err?.message || err);
      await sleep(5 * 60 * 1000);
    }
  }
}

kiraLoop().catch(console.error);
