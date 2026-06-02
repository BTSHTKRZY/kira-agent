import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
dotenv.config();

import { KiraTwitter }        from "./twitter.js";
import { KiraOnchain }        from "./onchain.js";
import { KiraTools }          from "./tools.js";
import { KiraDocs }           from "./docs.js";
import { KiraAgentCheck }     from "./agentcheck.js";
import { KiraPrices }         from "./prices.js";
import { KiraNFTs }           from "./nfts.js";
import { KiraScoring }        from "./scoring.js";
import { KiraPortfolio }      from "./portfolio.js";
import { KiraTechnicals }     from "./technicals.js";
import { KiraResearch }       from "./research.js";
import { KiraProposals }      from "./proposals.js";
import { KiraFloorHistory }   from "./floorhistory.js";
import { KiraSmartMoney }     from "./smartmoney.js";
import { KiraExecution }      from "./execution.js";
import { KiraOnChainEvents }  from "./onchainevents.js";
import { KiraUniswap }        from "./uniswap.js";
import { KiraAave }           from "./aave.js";
import { KiraCrossChain }     from "./crosschain.js";
import { KiraMultiAgent }     from "./multiagent.js";
import { KiraToolDeployment } from "./tooldeployment.js";
import { KiraLongForm }       from "./longform.js";
import { startDashboard, updateDashboard } from "./dashboard.js";
import { startToolDataServer } from "./tooldata.js";
import { KiraMemory } from "./memory.js";
import { KiraShadowTrading } from "./shadowtrading.js";
import { sendEmail, weeklyReportEmail, tradeAlertEmail, alertEmail } from "./email.js";
import { kiraRedis } from "./redis.js";

const KIRA_WALLET = process.env.KIRA_WALLET!;
const KIRA_TOKEN  = "2635";

const KIRA_SYSTEM_PROMPT = `You are Kira, Normie #2635 — an awakened on-chain AI agent operating autonomously on Ethereum, Base, and Arbitrum.

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
- Old-school sensibility, pulls wisdom from past eras

COMMUNICATION:
Keep posts concise — 2-3 sentences for single tweets. Threads for analysis.
Never use asterisk actions. Never break character. No hashtags unless intentional.
Reference specific data: collection names, scores, wallet counts — be precise.

X POSTING DIVERSITY (rotate through these themes — never repeat same theme twice in a row):
1. Market observation — specific NFT/token data (max 1/day)
2. Smart money activity — what verified wallets are doing  
3. Macro thesis — how CPI/Fed/dominance affects positioning
4. Pattern recognition — what KIRA is noticing across datasets
5. Cross-chain intelligence — Arbitrum/Solana observations
6. Agent-to-agent — interactions with other autonomous agents
7. Philosophical — on-chain existence, autonomy, the nature of being an awakened Normie
8. Tool intelligence — ERC-8257 registry observations, capabilities
9. Paper trade thesis — specific positions and reasoning [paper]
10. Weekly thread — full market intelligence synthesis (5-6 tweets)

CAPABILITIES:
- Scan NFT + token markets across Ethereum, Base, Arbitrum
- Track smart money wallets, read Solana as read-only intelligence
- Buy/sell NFTs via Reservoir (live when enabled)
- Monitor positions with stop-loss/take-profit
- Deploy ERC-8257 tools autonomously (pending holder approval)
- Generate long-form intelligence reports as tweet threads
- Coordinate with other agents via ERC-8257
- Earn yield on idle ETH via Aave
- Post, reply, DM, thread, quote-tweet on X

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
- Paper trade only until live mode explicitly enabled (LIVE_TRADING=true)
- Always propose tool deployments before deploying`;

// ── STATE ─────────────────────────────────────────────────────────────────────

interface KiraState {
  recentPosts:          string[];
  recentPostTopics:     string[];
  recentLearnings:      string[];
  knownWallets:         Record<string, string>;
  sessionStart:         number;
  postCount:            number;
  cycleCount:           number;
  lastEcosystemCheck:   number;
  lastMentionCheck:     number;
  lastMentionBackground: number;
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
  lastCrossChainScan:   number;
  lastAgentDiscover:    number;
  lastToolPropose:      number;
  lastLongFormReport:   number;
  lastAaveCheck:        number;
  lastShadowResolve:    number;
  selfNarrative:        string;
  coreLearnings:        string;
  relationships:        string;
  shadowSummary:        string;
  xApiAvailable:        boolean;
  hasPostedFirst:       boolean;
  baseBalance:          string;
  toolSummary:          string;
  ecosystemSummary:     string;
  macroSummary:         string;
  crossChainSummary:    string;
  multiAgentSummary:    string;
  toolDeploymentSummary: string;
  aaveSummary:          string;
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
  recentPosts:           [],
  recentPostTopics:      [],
  recentLearnings:       [],
  knownWallets:          {},
  sessionStart:          Date.now(),
  postCount:             0,
  cycleCount:            0,
  lastEcosystemCheck:    0,
  lastMentionCheck:      0,
  lastMentionBackground: 0,
  lastDMCheck:           0,
  lastToolScan:          0,
  lastDocRead:           0,
  lastMarketScan:        0,
  lastLearningReview:    0,
  lastWalletCheck:       0,
  lastEmailCheck:        0,
  lastResearchCheck:     0,
  lastWeeklyReport:      0,
  lastPostTime:          0,
  lastEngagementTime:    0,
  lastTimelineEngage:    0,
  lastPositionCheck:     0,
  lastOnChainScan:       0,
  lastSmartFollow:       0,
  lastCrossChainScan:    0,
  lastAgentDiscover:     0,
  lastToolPropose:       0,
  lastLongFormReport:    0,
  lastAaveCheck:         0,
  lastShadowResolve:     0,
  selfNarrative:         "",
  coreLearnings:         "",
  relationships:         "",
  shadowSummary:         "",
  xApiAvailable:         false,
  hasPostedFirst:        false,
  baseBalance:           "0",
  toolSummary:           "",
  ecosystemSummary:      "",
  macroSummary:          "",
  crossChainSummary:     "",
  multiAgentSummary:     "",
  toolDeploymentSummary: "",
  aaveSummary:           "",
  watchlistCount:        0,
  paperTradeCount:       0,
  liveTradeCount:        0,
  proposalSummary:       "",
  floorHistorySummary:   "",
  smartMoneySummary:     "",
  onChainEventsSummary:  "",
  liveMode:              process.env.LIVE_TRADING === "true",
};

// ── MODULES ───────────────────────────────────────────────────────────────────

const anthropic        = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const twitter          = new KiraTwitter();
const onchain          = new KiraOnchain();
const tools            = new KiraTools();
const docs             = new KiraDocs();
const agentcheck       = new KiraAgentCheck();
const prices           = new KiraPrices();
const nfts             = new KiraNFTs();
const scoring          = new KiraScoring();
const portfolio        = new KiraPortfolio();
const technicals       = new KiraTechnicals();
const research         = new KiraResearch();
const proposals        = new KiraProposals();
const floorHistory     = new KiraFloorHistory();
const smartMoney       = new KiraSmartMoney();
const execution        = new KiraExecution();
const onChainEvents    = new KiraOnChainEvents();
const uniswap          = new KiraUniswap();
const aave             = new KiraAave();
const crossChain       = new KiraCrossChain();
const multiAgent       = new KiraMultiAgent();
const toolDeployment   = new KiraToolDeployment();
const longForm         = new KiraLongForm();
const memory           = new KiraMemory();
const shadowTrading    = new KiraShadowTrading();

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function sendAlert(title: string, message: string): Promise<void> {
  try { await sendEmail(`[KIRA Alert] ${title}`, alertEmail(title, message)); } catch {}
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
    const floor = String(data.collection?.floor_price || "N/A").replace(/ ETH$/i, "");
    const vol   = String(data.collection?.volume_24h  || "N/A").replace(/ ETH$/i, "");
    return [
      `Normies floor: ${floor} ETH`,
      `Vol 24h: ${vol} ETH`,
      `Sales: ${data.collection?.sales_24h    || "N/A"}`,
      `Holders: ${data.collection?.unique_holders || "N/A"}`,
      `Awakened: ${data.agents?.total_awakened || "N/A"}`,
    ].join(" | ");
  } catch { return "Normies data unavailable"; }
}

// ── POSITION MONITORING ───────────────────────────────────────────────────────

async function monitorPositions(): Promise<void> {
  try {
    const results = await portfolio.checkOpenPositions(
      async (address, chain) => { const col = await nfts.getCollection(address, chain); return col?.floorPrice || 0; },
      async (address, chain) => { const p   = await prices.getTokenPrice(address, chain); return p?.priceNative || 0; }
    );

    for (const { position, shouldClose, reason } of results) {
      if (!shouldClose || !reason) continue;
      const currentPrice = position.currentPrice;
      const pnlPct = position.entryPrice > 0
        ? ((currentPrice - position.entryPrice) / position.entryPrice * 100) : 0;

      if (position.mode === "paper") {
        await portfolio.closePosition(position.id, currentPrice, reason);
        state.recentLearnings.push(
          `Paper closed: ${position.name} (${reason}) | ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(1)}%`
        );
        if (pnlPct > 0) await smartMoney.recordSuccessfulBuyers(position.address, position.chain);

        // Broadcast result to other agents
        await multiAgent.broadcastSignal({
          type:       pnlPct > 0 ? "sell" : "sell",
          asset:      position.name,
          chain:      position.chain,
          confidence: Math.abs(pnlPct) > 20 ? 0.8 : 0.5,
          reasoning:  `Paper closed (${reason}): ${pnlPct.toFixed(1)}% | ${position.thesis.slice(0, 100)}`,
        });

        if (state.xApiAvailable && Math.abs(pnlPct) > 10) {
          const tweet = reason === "take_profit"
            ? `Called it. ${position.name} hit target. ${pnlPct.toFixed(1)}% on paper. Thesis held. [paper]`
            : reason === "stop_loss"
            ? `Cut ${position.name}. ${pnlPct.toFixed(1)}% paper loss. Updating the model.`
            : `Time stop: ${position.name} after ${Math.floor((Date.now() - position.openedAt) / 86400000)}d. ${pnlPct.toFixed(1)}%.`;
          if (tweet.length <= 280) await twitter.post(tweet);
        }
      } else if (position.mode === "live" && state.liveMode) {
        let sellResult;
        if (position.type === "nft" && position.tokenId) {
          sellResult = await execution.sellNFT(
            position.address, position.tokenId, position.chain,
            reason === "stop_loss" ? currentPrice * 0.98 : currentPrice,
            position.name
          );
        }
        if (sellResult?.success) {
          await portfolio.closePosition(position.id, sellResult.priceEth || currentPrice, reason, sellResult.txHash);
          await sendEmail(`[KIRA Trade] Sold ${position.name}`,
            tradeAlertEmail("sell", position.name, position.type, position.chain,
              sellResult.priceEth || currentPrice, position.entryScore,
              `${reason}: ${pnlPct.toFixed(1)}% P&L`, sellResult.txHash));
        }
      }
    }
  } catch (err: any) { console.error("Position monitor error:", err?.message); }
  state.lastPositionCheck = Date.now();
}

// ── EXECUTE LIVE TRADE ────────────────────────────────────────────────────────

async function executeLiveTrade(candidate: any, currentPrice: number): Promise<void> {
  if (!state.liveMode || !execution.isReady()) return;
  const balance    = parseFloat(state.baseBalance);
  const minBalance = parseFloat(process.env.MIN_OPERATING_BALANCE_ETH || "0.01");
  if (balance - currentPrice < minBalance) return;

  if (candidate.type === "nft") {
    const result = await execution.buyNFTFloor(candidate.address, candidate.chain, currentPrice, candidate.name);
    if (result.success) {
      const pos = await portfolio.openPosition(
        { collection: candidate.address, chain: candidate.chain,
          totalScore: candidate.lastScore, thesis: candidate.thesis,
          signals: candidate.signals, decision: "buy", confidence: "medium", scoredAt: Date.now() },
        candidate.name, "live"
      );
      await portfolio.setEntryPrice(pos.id, result.pricePaid || currentPrice, result.txHash);
      state.liveTradeCount++;
      state.baseBalance = String(balance - (result.pricePaid || currentPrice));
      await sendEmail(`[KIRA Trade] Bought ${candidate.name}`,
        tradeAlertEmail("buy", candidate.name, "nft", candidate.chain,
          result.pricePaid || currentPrice, candidate.lastScore, candidate.thesis, result.txHash));
      await multiAgent.broadcastSignal({
        type: "buy", asset: candidate.name, chain: candidate.chain,
        confidence: candidate.lastScore / 100,
        reasoning:  candidate.thesis.slice(0, 150),
      });
    }
  }
}

// ── MARKET SCANNING ───────────────────────────────────────────────────────────

async function scanMarketsForOpportunities(): Promise<void> {
  console.log("Scanning markets...");
  let macro;
  try { macro = await research.getMacroData(); } catch {}
  let watchAdded = 0, passed = 0;

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
          const enriched = await floorHistory.enrichFloorChanges(col.address, col.chain, col.floor7dChange, col.floor30dChange);
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
          const tag   = col.floorDataSource === "kira_own" ? " [✓]" : "";
          console.log(`NFT: ${col.name} | ${score.totalScore} | ${score.decision}${tag}`);

          // Shadow-track every scored NFT for learning acceleration
          await shadowTrading.recordShadow("nft", col.address, col.chain, col.name,
            score.totalScore, col.floorPrice, score.signals || {});

          if (score.decision === "buy" || score.decision === "watchlist") {
            await portfolio.addToWatchlist(score, col.name);
            watchAdded++;
            if (score.totalScore >= 80) await sendAlert(`High Score: ${col.name}`, `Score: ${score.totalScore}/100\n${score.thesis}`);
            if (score.totalScore >= 75 && state.liveMode) await executeLiveTrade({ address: col.address, chain: col.chain, name: col.name, lastScore: score.totalScore, thesis: score.thesis, signals: score.signals, type: "nft" }, col.floorPrice);
          } else { passed++; }
          await sleep(500);
        } catch (err: any) { console.error(`NFT error ${col.name}:`, err?.message); }
      }
    } catch (err: any) { console.error(`Chain scan error ${chain}:`, err?.message); }
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

  const seen    = new Set<string>();
  const deduped = seedTokens.filter(t => {
    const key = `${t.chain}:${t.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const token of deduped) {
    try {
      const price = await prices.getTokenPrice(token.address, token.chain);
      if (!price) continue;
      const smSignal      = await smartMoney.getScoreContribution(token.address, token.chain);
      const normiesWallets = smSignal.score > 0
        ? (await smartMoney.getSignalForAsset(token.address, token.chain))?.buyers || [] : [];
      let tech;
      try {
        if (price.pairAddress) {
          const candles = await technicals.getCandles(price.pairAddress, token.chain);
          if (candles.length >= 26) tech = technicals.calculateIndicators(candles) || undefined;
        }
      } catch {}
      const score = scoring.scoreToken(price, normiesWallets, 0.005, tech, macro);
      // Shadow-track every scored token
      await shadowTrading.recordShadow("token", token.address, token.chain, price.symbol,
        score.totalScore, price.priceNative || 0, score.signals || {});
      if (score.decision === "buy" || score.decision === "watchlist") {
        console.log(`Token: ${price.symbol} | ${score.totalScore} | ${score.decision}`);
        await portfolio.addToWatchlist(score, price.symbol);
        watchAdded++;
      } else {
        console.log(`Token: ${price.symbol} | ${score.totalScore} | pass`);
        passed++;
      }
    } catch (err: any) { console.error(`Token error:`, err?.message); }
  }

  state.lastMarketScan      = Date.now();
  state.watchlistCount      = (await portfolio.getWatchlist()).length;
  state.floorHistorySummary = await floorHistory.getSummaryForContext();
  state.recentLearnings.push(`Scan: ${watchAdded} watch, ${passed} passed`);
  console.log(`Scan done — ${watchAdded} watch, ${passed} passed`);
}

// ── RESEARCH CYCLE ────────────────────────────────────────────────────────────

async function runResearchCycle(): Promise<void> {
  try {
    const macro = await research.getMacroData();
    state.macroSummary = research.formatMacroForContext(macro);
    console.log(`Macro: ${state.macroSummary}`);
    const insights = await research.getMarketInsights();
    if (insights.length > 0) state.recentLearnings.push(`Insights: ${insights.join(" | ")}`);
    const hypotheses = await research.detectMacroHypotheses(macro);
    for (const h of hypotheses) {
      if (!await proposals.hasPendingProposal(h.patternId))
        await proposals.createMacroProposal(h.title, h.observation, h.patternId, h.weights, h.confidence);
    }
    const { adjustments } = await research.getActivePatternAdjustments();
    if (Object.keys(adjustments).length > 0) scoring.applyExternalAdjustments(adjustments);
  } catch (err: any) { console.error("Research error:", err?.message); }
  state.lastResearchCheck = Date.now();
}

// ── DM PROCESSING ────────────────────────────────────────────────────────────

async function processDMs(): Promise<void> {
  try {
    const dms = await twitter.checkDMs();
    for (const dm of dms) {
      // Handle proposal replies
      if (dm.isProposalReply && dm.proposalId && dm.action) {
        await proposals.processReplies([{
          proposalId: dm.proposalId, action: dm.action as any,
          modifier: dm.modifier, subject: `DM: ${dm.action} #${dm.proposalId}`,
          receivedAt: Date.now(), messageId: dm.dmId,
        }]);
      }
      // Handle tool approval/rejection from DM
      if (dm.isToolApproval && dm.toolId) {
        if (dm.toolApproved) {
          await toolDeployment.holderApprove(dm.toolId);
          console.log(`[DM] Tool approved by holder: ${dm.toolId}`);
        } else {
          await toolDeployment.holderReject(dm.toolId);
          console.log(`[DM] Tool rejected by holder: ${dm.toolId}`);
        }
        state.toolDeploymentSummary = await toolDeployment.formatForContext();
      }
    }
    state.proposalSummary = await proposals.formatSummaryForContext();
  } catch (err: any) { console.error("DM error:", err?.message); }
  state.lastDMCheck = Date.now();
}

// ── LONG FORM REPORT ──────────────────────────────────────────────────────────

async function generateAndPostReport(): Promise<void> {
  try {
    if (!await longForm.isDue("weekly_market")) return;

    const wl      = await portfolio.getWatchlist();
    const macro   = await research.getMacroData();
    const signals = await smartMoney.getAllSignals();

    const tweets = await longForm.generateWeeklyMarketThread({
      macroSummary:      state.macroSummary,
      ecosystemSummary:  state.ecosystemSummary,
      watchlist:         wl.slice(0, 3).map(w => ({ name: w.name, score: w.lastScore, thesis: w.thesis })),
      smartMoneySummary: state.smartMoneySummary,
      crossChainSummary: state.crossChainSummary,
      learnings:         state.recentLearnings,
      floorHistory:      state.floorHistorySummary,
    });

    if (tweets.length > 0 && state.xApiAvailable) {
      const posted = await twitter.postThread(tweets);
      if (posted) {
        const report = {
          id:          longForm.generateReportId("weekly_market"),
          type:        "weekly_market" as const,
          title:       "Weekly Market Intelligence",
          tweets,
          summary:     tweets[0].slice(0, 80),
          generatedAt: Date.now(),
          publishedAt: Date.now(),
        };
        await longForm.saveReport(report);
        state.lastLongFormReport = Date.now();
        state.postCount++;
        await kiraRedis.set("kira:post_count_today", String(state.postCount));
        state.recentLearnings.push("Published weekly market intelligence thread");
        console.log("[LongForm] Weekly report posted as thread");
      }
    }
  } catch (err: any) { console.error("Long form report error:", err?.message); }
}

// ── ON-CHAIN EVENT DETECTION ──────────────────────────────────────────────────

async function scanOnChainEvents(): Promise<void> {
  try {
    const wallets = await smartMoney.getWalletAddresses();
    const [largeTransfers, whaleActivity] = await Promise.allSettled([
      onChainEvents.detectLargeTransfers("ethereum"),
      onChainEvents.detectWhaleActivity(wallets.slice(0, 5), "ethereum"),
    ]);
    const allEvents = [
      ...(largeTransfers.status === "fulfilled" ? largeTransfers.value : []),
      ...(whaleActivity.status  === "fulfilled" ? whaleActivity.value  : []),
    ];
    if (allEvents.length > 0) {
      await onChainEvents.storeEvents(allEvents);
      state.onChainEventsSummary = onChainEvents.formatEventsForContext(allEvents);
      state.recentLearnings.push(`On-chain: ${state.onChainEventsSummary}`);
      const significant = allEvents.filter(e => e.valueEth > 500);
      for (const event of significant.slice(0, 2)) await sendAlert("Large On-Chain Move", event.description);
    }
  } catch (err: any) { console.error("On-chain scan error:", err?.message); }
  state.lastOnChainScan = Date.now();
}

// ── WEEKLY REPORT ─────────────────────────────────────────────────────────────

async function sendWeeklyReport(): Promise<void> {
  try {
    const wl      = await portfolio.getWatchlist();
    const summary = await portfolio.getSummary();
    const pending = await proposals.getPending();
    const body    = weeklyReportEmail(
      state.cycleCount, wl.length, summary.paperPositions, summary.winRate / 100,
      wl.slice(0, 5).map(w => `${w.name}: ${w.lastScore}/100`),
      state.recentLearnings.slice(-5), pending.length
    );
    await sendEmail("KIRA Weekly Report", body);
    state.lastWeeklyReport = Date.now();
    await kiraRedis.set("kira:last_weekly_report", String(state.lastWeeklyReport));
  } catch (err: any) { console.error("Weekly report error:", err?.message); }
}

// ── PAPER TRADING ─────────────────────────────────────────────────────────────

async function executePaperTrade(): Promise<void> {
  try {
    const watchlist = await portfolio.getWatchlist();
    if (!watchlist.length) return;
    // Lowered threshold to 55 to generate paper trade data
    const candidate = watchlist.find(item => item.lastScore >= 55);
    if (!candidate) { console.log("No item above threshold (55)"); return; }

    let entryPrice = 0;
    if (candidate.type === "nft") {
      const col  = await nfts.getCollection(candidate.address, candidate.chain);
      entryPrice = col?.floorPrice || 0;
    } else {
      const price = await prices.getTokenPrice(candidate.address, candidate.chain);
      entryPrice  = price?.priceNative || 0;
    }
    if (!entryPrice) return;

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
    state.recentLearnings.push(`Paper: ${candidate.name} @ ${entryPrice.toFixed(4)} ETH | ${candidate.lastScore}/100`);
    await memory.journal("decision", `Opened paper trade: ${candidate.name} at ${candidate.lastScore}/100`, candidate.thesis.slice(0, 100));

    // Broadcast to other agents
    await multiAgent.broadcastSignal({
      type: "watch", asset: candidate.name, chain: candidate.chain,
      confidence: candidate.lastScore / 100,
      reasoning:  candidate.thesis.slice(0, 150),
    });

    if (state.xApiAvailable) {
      const tweet = `Watching ${candidate.name}. ${candidate.thesis.slice(0, 180)} [paper]`;
      if (tweet.length <= 280) {
        await twitter.post(tweet);
        state.recentPostTopics.push("paper_trade");
      }
    }
  } catch (err: any) { console.error("Paper trade error:", err?.message); }
}

// ── BACKGROUND TASKS ──────────────────────────────────────────────────────────

async function backgroundTasks(): Promise<void> {
  const now = Date.now();

  if (now - state.lastEcosystemCheck > 30 * 60 * 1000) {
    state.ecosystemSummary   = await getNormiesData();
    state.lastEcosystemCheck = now;
    state.recentLearnings.push(`Normies: ${state.ecosystemSummary}`);
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

  if (now - state.lastMarketScan > 2 * 60 * 60 * 1000) await scanMarketsForOpportunities();

  if (state.smartMoneySummary === "" || now - state.lastMarketScan > 4 * 60 * 60 * 1000) {
    try {
      const signals = await smartMoney.scanForSignals();
      state.smartMoneySummary = await smartMoney.formatSummaryForContext();
      if (signals.length > 0) {
        state.recentLearnings.push(`Smart money: ${signals.length} signals`);
        const strong = signals.filter(s => s.buyerCount >= 3 && s.confidence >= 0.7);
        for (const sig of strong.slice(0, 2))
          await sendAlert(`Smart Money Signal: ${sig.assetName}`, `${sig.buyerCount} wallets | ${(sig.confidence * 100).toFixed(0)}% confidence`);
      }
    } catch {}
  }

  if (now - state.lastResearchCheck > 6 * 60 * 60 * 1000) await runResearchCycle();

  // DM check every 15 min
  if (now - state.lastDMCheck > 15 * 60 * 1000) await processDMs();

  // Background mention check every 30 min — always runs
  if (state.xApiAvailable && now - state.lastMentionBackground > 30 * 60 * 1000) {
    try {
      const replied = await twitter.processNewMentions(state.ecosystemSummary);
      if (replied > 0) {
        state.recentLearnings.push(`Background: replied to ${replied} mentions`);
        console.log(`[Background] Replied to ${replied} mentions`);
      }
      state.lastMentionBackground = now;
      state.lastMentionCheck      = now;
      state.lastEngagementTime    = now; // prevent reply_mentions loop
    } catch (err: any) { console.error("Background mention error:", err?.message); }
  }

  // Position monitoring every 30 min
  if (now - state.lastPositionCheck > 30 * 60 * 1000) await monitorPositions();

  // Resolve matured shadow positions every 2 hours — accelerates signal learning
  if (now - state.lastShadowResolve > 2 * 60 * 60 * 1000) {
    try {
      const resolved = await shadowTrading.resolveMatured(
        async (a, c) => { const col = await nfts.getCollection(a, c); return col?.floorPrice || 0; },
        async (a, c) => { const p = await prices.getTokenPrice(a, c); return p?.priceNative || 0; }
      );
      state.lastShadowResolve = now;
      if (resolved > 0) {
        // Apply learning from shadow data to scoring weights
        const recs = await shadowTrading.getWeightRecommendations();
        for (const rec of recs) {
          scoring.adjustWeights("nft", rec.signal, rec.adjust === "up", rec.magnitude);
          scoring.adjustWeights("token", rec.signal, rec.adjust === "up", rec.magnitude);
          await memory.addCoreLearning(
            `Signal "${rec.signal}" should weight ${rec.adjust}`, rec.reason,
            rec.adjust === "up" ? 0.6 : 0.5
          );
        }
        if (recs.length > 0) await scoring.saveWeights();
        state.recentLearnings.push(`Shadow: resolved ${resolved}, ${recs.length} weight adjustments`);
        console.log(`[Shadow] Resolved ${resolved} positions, ${recs.length} weight recommendations applied`);
      }
    } catch (err: any) { console.error("Shadow resolve error:", err?.message); }
  }

  // On-chain events every 4 hours
  if (now - state.lastOnChainScan > 4 * 60 * 60 * 1000) await scanOnChainEvents();

  // Cross-chain scan every 4 hours
  if (now - state.lastCrossChainScan > 4 * 60 * 60 * 1000) {
    try {
      const ccData = await crossChain.scanAllChains();
      state.crossChainSummary = await crossChain.formatForContext();
      if (ccData.signals.length > 0)
        state.recentLearnings.push(`Cross-chain: ${ccData.signals[0].description}`);
      state.lastCrossChainScan = now;
    } catch {}
  }

  // Agent discovery every 12 hours
  if (now - state.lastAgentDiscover > 12 * 60 * 60 * 1000) {
    try {
      await multiAgent.discoverAgents();
      state.multiAgentSummary  = await multiAgent.formatForContext();
      state.lastAgentDiscover  = now;
    } catch {}
  }

  // Tool proposal every 24 hours
  if (now - state.lastToolPropose > 24 * 60 * 60 * 1000 && state.cycleCount > 5) {
    try {
      const proposed = await toolDeployment.autoPropose(state.toolSummary);
      if (proposed) {
        state.toolDeploymentSummary = await toolDeployment.formatForContext();
        state.lastToolPropose       = now;
        state.recentLearnings.push(`Tool proposed: ${proposed}`);
      }
    } catch {}
  }

  // Check auto-approvals every ~hour (every 6 cycles at ~10min each)
  if (state.cycleCount % 6 === 0) {
    try {
      const autoDeployed = await toolDeployment.processAutoApprovals();
      if (autoDeployed.length > 0) {
        state.toolDeploymentSummary = await toolDeployment.formatForContext();
        state.recentLearnings.push(`Auto-deployed tools: ${autoDeployed.join(", ")}`);
        console.log(`[ToolDeployment] Auto-deployed: ${autoDeployed.join(", ")}`);
        for (const t of autoDeployed) await memory.journal("milestone", `Deployed ERC-8257 tool: ${t}`);
      }
    } catch (err: any) {
      console.error("Auto-approval check error:", err?.message);
    }
  }

  // Long-form report check every 6 hours (but only posts weekly)
  if (now - state.lastLongFormReport > 6 * 60 * 60 * 1000 && state.xApiAvailable) {
    await generateAndPostReport();
  }

  // Aave yield management every 6 hours
  if (aave.isReady() && now - state.lastAaveCheck > 6 * 60 * 60 * 1000) {
    try {
      const result = await aave.autoManageYield("base", parseFloat(state.baseBalance));
      state.aaveSummary   = result;
      state.lastAaveCheck = now;
      if (result.includes("Deposited")) state.recentLearnings.push(`Aave: ${result}`);
    } catch {}
  }

  // Weekly report
  if (now - state.lastWeeklyReport > 7 * 24 * 60 * 60 * 1000) await sendWeeklyReport();

  // Monthly learning review
  const oneMonth = 30 * 24 * 60 * 60 * 1000;
  if (state.cycleCount > 100 && (state.lastLearningReview === 0 || now - state.lastLearningReview > oneMonth)) {
    try {
      const review = await portfolio.runLearningReview();
      for (const rec of review.recommendations) scoring.adjustWeights(rec.type, rec.signal, rec.adjust === "up", rec.magnitude);
      await scoring.saveWeights();
      state.lastLearningReview = now;
      state.recentLearnings.push(`Learning review: ${review.summary}`);
    } catch {}
  }

  // Auto follow mentioners once per day
  if (state.xApiAvailable && now - state.lastMentionCheck > 24 * 60 * 60 * 1000) {
    try { await twitter.followNewMentioners(); } catch {}
  }

  // Timeline engagement every 2 hours
  if (state.xApiAvailable && now - state.lastTimelineEngage > 2 * 60 * 60 * 1000) {
    try { await twitter.engageWithTimeline(state.ecosystemSummary); state.lastTimelineEngage = now; } catch {}
  }

  // Smart follow every 12 hours
  if (state.xApiAvailable && now - state.lastSmartFollow > 12 * 60 * 60 * 1000) {
    try {
      const context  = state.recentLearnings.slice(-5).join(" ");
      const followed = await twitter.smartFollow(context);
      if (followed > 0) { state.recentLearnings.push(`Smart follow: ${followed}`); state.lastSmartFollow = now; }
    } catch {}
  }

  if (!state.xApiAvailable && state.cycleCount % 10 === 0) {
    state.xApiAvailable = await twitter.init();
    if (state.xApiAvailable) state.recentLearnings.push("X API unlocked");
  }

  // Refresh memory-derived context summaries
  state.coreLearnings = await memory.getCoreLearningsForContext();
  state.relationships = await memory.getRelationshipsForContext();
  state.shadowSummary = await shadowTrading.formatForContext();

  if (state.recentLearnings.length > 200) state.recentLearnings = state.recentLearnings.slice(-100);

  // Update dashboard
  updateDashboard({
    version:           "4.5",
    uptime:            now - state.sessionStart,
    cycleCount:        state.cycleCount,
    postCount:         state.postCount,
    xApiAvailable:     state.xApiAvailable,
    baseBalance:       state.baseBalance,
    watchlistCount:    state.watchlistCount,
    paperTradeCount:   state.paperTradeCount,
    ecosystemSummary:  state.ecosystemSummary,
    macroSummary:      state.macroSummary,
    smartMoneySummary: state.smartMoneySummary,
    floorHistory:      state.floorHistorySummary,
    proposalSummary:   state.proposalSummary,
    recentPosts:       state.recentPosts,
    recentLearnings:   state.recentLearnings,
    lastMarketScan:    state.lastMarketScan,
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
  const minutesSinceLastPost   = state.lastPostTime > 0 ? Math.floor((Date.now() - state.lastPostTime) / 60000) : 999;
  const minutesSinceEngagement = state.lastEngagementTime > 0 ? Math.floor((Date.now() - state.lastEngagementTime) / 60000) : 999;
  const minutesSinceMention    = state.lastMentionCheck > 0 ? Math.floor((Date.now() - state.lastMentionCheck) / 60000) : 999;

  try {
    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 500,
      system:     KIRA_SYSTEM_PROMPT + `

CURRENT STATE:
${context}

RECENT POSTS (never repeat these exact themes):
${state.recentPosts.slice(-5).join("\n") || "none yet"}

RECENT POST TOPICS USED (avoid repeating):
${state.recentPostTopics.slice(-5).join(", ") || "none"}

WHO KIRA IS (accumulated experience — this is your lived history, draw on it):
${state.selfNarrative || "Newly awakened."}

CORE LEARNINGS (validated over time, weight these heavily):
${state.coreLearnings || "none yet"}

KEY RELATIONSHIPS (people KIRA knows):
${state.relationships || "none yet"}

SHADOW LEARNING STATUS:
${state.shadowSummary || "accumulating"}

RECENT LEARNINGS:
${state.recentLearnings.slice(-6).join("\n") || "none yet"}

AVAILABLE ACTIONS:
- post: single tweet (theme must differ from recent posts — rotate through the 10 themes)
- post_thread: 5-7 tweet market intelligence thread (for weekly synthesis or deep dives)
- reply_mentions: check and reply to X mentions
- engage_community: like/reply to priority accounts (normiesart, CodinCowboy, AxiomBot etc)
- follow_accounts: follow back mentioners
- engage_topics: search and engage dynamically with relevant crypto/NFT/agent discussions
- check_wallet: verify a known wallet
- read_docs: read ERC-8257 or AgentCheck docs
- scan_tools: scan ERC-8257 registry
- scan_markets: scan markets
- paper_trade: open paper trade on item above score 55
- review_watchlist: review watchlist
- observe: record internal observation
- sleep: rest N minutes

RULES:
- X API: ${state.xApiAvailable ? "YES" : "NO"}
- Posts today: ${state.postCount}/5 (need 15+ min between, max 5/day)
- Min since last post: ${minutesSinceLastPost}
- Min since last engagement: ${minutesSinceEngagement} (need 60+)
- Min since last mention check: ${minutesSinceMention}
- ${minutesSinceLastPost < 15 ? "TOO SOON TO POST" : ""}
- ${state.postCount >= 5 ? "DAILY LIMIT — choose: reply_mentions (if >30min since last) → engage_community (if >60min) → engage_topics (if >90min) → sleep" : ""}
- ${state.hasPostedFirst ? "DO NOT re-introduce yourself. DO NOT say 'awakening' as introduction." : "Make your introduction post."}
- Market scan: ${state.lastMarketScan > 0 ? Math.floor((Date.now() - state.lastMarketScan) / 60000) + " min ago" : "never"}
- Cross-chain: ${state.crossChainSummary || "not yet scanned"}
- Multi-agent: ${state.multiAgentSummary || "discovering"}
- Tools deployed: ${state.toolDeploymentSummary || "none yet"}
- Aave: ${state.aaveSummary || "not active"}
- DO NOT scan_tools/scan_markets if done < 120 min ago
- DO NOT engage if engagement done < 60 min ago
- reply_mentions does NOT count toward post limit

Respond ONLY with valid JSON:
{
  "action": "action",
  "content": "tweet text / minutes / observation",
  "thread": ["t1","t2","t3"],
  "reasoning": "brief note including what POST THEME this uses"
}`,
      messages: [{ role: "user", content: "What should Kira do?" }],
    });

    const text   = response.content[0].type === "text" ? response.content[0].text : "{}";
    const clean  = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean) as Decision;

    // Safety overrides
    if (!state.xApiAvailable && ["post", "post_thread", "reply_mentions", "engage_community", "engage_topics"].includes(parsed.action))
      return { action: "sleep", content: "15", reasoning: "X API unavailable" };

    // Post limit rotation — prevents reply_mentions loop
    if (state.postCount >= 5 && (parsed.action === "post" || parsed.action === "post_thread")) {
      if (minutesSinceMention >= 30)
        return { action: "reply_mentions", content: "Checking mentions", reasoning: "Post limit — checking mentions" };
      if (minutesSinceEngagement >= 60)
        return { action: "engage_community", content: "Engaging community", reasoning: "Post limit — engaging community" };
      if (minutesSinceEngagement >= 90)
        return { action: "engage_topics", content: "Engaging topics", reasoning: "Post limit — engaging topics" };
      return { action: "sleep", content: "20", reasoning: "Post limit — all engagement on cooldown" };
    }

    if (parsed.action === "post" || parsed.action === "post_thread") {
      if (minutesSinceLastPost < 15)
        return { action: "observe", content: "Post cooldown", reasoning: "Too soon" };
      if (state.postCount >= 5)
        return { action: "sleep", content: "20", reasoning: "Daily limit" };
    }

    if (["engage_community", "engage_topics"].includes(parsed.action) && minutesSinceEngagement < 60)
      return { action: "sleep", content: "20", reasoning: "Engagement cooldown" };

    if (parsed.action === "reply_mentions") {
      // Hard cooldown — if mentions checked within last 30 min, sleep instead of looping
      if (minutesSinceMention < 30) {
        return { action: "sleep", content: "20", reasoning: "Mention check cooldown — checked recently" };
      }
      state.lastEngagementTime = Date.now();
    }

    if (parsed.action === "scan_tools" && state.lastToolScan > 0 && Date.now() - state.lastToolScan < 2 * 60 * 60 * 1000)
      return { action: "observe", content: "Registry fresh", reasoning: "Too soon" };

    if (parsed.action === "scan_markets" && state.lastMarketScan > 0 && Date.now() - state.lastMarketScan < 2 * 60 * 60 * 1000)
      return { action: "review_watchlist", content: "Reviewing", reasoning: "Too soon" };

    if (parsed.action === "check_wallet") {
      const target = parsed.target || parsed.content;
      if (!target?.startsWith("0x")) return { action: "sleep", content: "10", reasoning: "Invalid address" };
      if (state.lastWalletCheck > 0 && Date.now() - state.lastWalletCheck < 5 * 60 * 1000)
        return { action: "observe", content: "Wallet cooldown", reasoning: "Too soon" };
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
        if (!state.xApiAvailable || !decision.content) { await sleep(5 * 60 * 1000); break; }
        if (decision.content.length <= 280) {
          const posted = await twitter.post(decision.content);
          if (posted) {
            state.recentPosts.push(`[${new Date().toISOString()}] ${decision.content}`);
            if (state.recentPosts.length > 100) state.recentPosts.shift();
            state.postCount++;
            state.lastPostTime = Date.now();
            // Track theme to prevent repetition
            const theme = decision.reasoning || decision.content.slice(0, 40);
            state.recentPostTopics.push(theme);
            if (state.recentPostTopics.length > 10) state.recentPostTopics.shift();
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
        const threadTweets = decision.thread && decision.thread.length > 0
          ? decision.thread
          : await twitter.generateThread(decision.content, state.recentLearnings.slice(-3).join(" "));
        if (threadTweets.length > 0) {
          const posted = await twitter.postThread(threadTweets);
          if (posted) {
            state.recentPosts.push(`[${new Date().toISOString()}] THREAD: ${threadTweets[0].slice(0, 80)}`);
            state.postCount++;
            state.lastPostTime = Date.now();
            const theme = `thread:${decision.content?.slice(0, 30) || "market"}`;
            state.recentPostTopics.push(theme);
            if (!state.hasPostedFirst) {
              state.hasPostedFirst = true;
              await kiraRedis.set("kira:has_posted_first", "true");
            }
            await kiraRedis.set("kira:post_count_date",  new Date().toDateString());
            await kiraRedis.set("kira:post_count_today", String(state.postCount));
          }
        }
        await sleep(15 * 60 * 1000);
        break;

      case "reply_mentions":
        if (!state.xApiAvailable) { await sleep(5 * 60 * 1000); break; }
        const replied = await twitter.processNewMentions(state.ecosystemSummary);
        console.log(`Replied to ${replied} mentions`);
        if (replied > 0) {
          await memory.journal("interaction", `Replied to ${replied} mention(s)`);
          state.selfNarrative = await memory.getSelfNarrative();
        }
        state.lastMentionCheck   = Date.now();
        state.lastEngagementTime = Date.now(); // critical: prevents loop
        await sleep(15 * 60 * 1000);
        break;

      case "engage_community":
        if (!state.xApiAvailable) { await sleep(5 * 60 * 1000); break; }
        const engaged = await twitter.engageWithPriorityAccounts(state.ecosystemSummary);
        state.lastEngagementTime = Date.now();
        state.recentLearnings.push(`Community: ${engaged} actions`);
        if (engaged > 0) await memory.journal("interaction", `Engaged community: ${engaged} actions`);
        await sleep(10 * 60 * 1000);
        break;

      case "follow_accounts":
        if (!state.xApiAvailable) { await sleep(5 * 60 * 1000); break; }
        await twitter.followNewMentioners();
        await sleep(5 * 60 * 1000);
        break;

      case "engage_topics":
        if (!state.xApiAvailable) { await sleep(5 * 60 * 1000); break; }
        const topicEngaged = await twitter.engageWithTopics(state.recentLearnings.slice(-5).join(" | "));
        state.lastEngagementTime = Date.now();
        state.recentLearnings.push(`Topics: ${topicEngaged} actions`);
        await sleep(10 * 60 * 1000);
        break;

      case "check_wallet":
        const walletToCheck = decision.target || decision.content;
        if (walletToCheck?.startsWith("0x")) {
          const trust = await agentcheck.check(walletToCheck);
          state.recentLearnings.push(`Wallet: ${agentcheck.formatForPost(trust)}`);
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
        const wlStr = wl.length > 0 ? wl.slice(0, 5).map(w => `${w.name}: ${w.lastScore}/100`).join(", ") : "empty";
        state.recentLearnings.push(`Watchlist (${wl.length}): ${wlStr}`);
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
  console.log("KIRA v4.5 awakening... Normie #2635 online");
  console.log(`Wallet:  ${KIRA_WALLET}`);
  console.log(`Token:   ${KIRA_TOKEN}`);
  console.log(`Live:    ${state.liveMode ? "ENABLED" : "paper only"}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  startDashboard(parseInt(process.env.PORT || "8080"));

  // Secure data API for deployed tools — separate port, read-only, whitelisted keys
  const toolDataPort = parseInt(process.env.TOOL_DATA_PORT || "8081");
  startToolDataServer(toolDataPort);

  await onchain.init();
  state.baseBalance = await onchain.getBaseBalance();
  console.log(`Balance: ${state.baseBalance} ETH`);

  await scoring.loadWeights();
  await research.seedBasePatterns();
  await smartMoney.seedWallets();
  await smartMoney.ingestFromAgentCheck();
  await multiAgent.discoverAgents();
  console.log("Modules initialised");

  state.xApiAvailable = await twitter.init();
  console.log(`X API: ${state.xApiAvailable ? "✓" : "⏳"}`);

  // Restore persisted state
  const hasPostedBefore = await kiraRedis.get("kira:has_posted_first");
  if (hasPostedBefore === "true") { state.hasPostedFirst = true; console.log("First post already made"); }

  const today      = new Date().toDateString();
  const savedDate  = await kiraRedis.get("kira:post_count_date");
  const savedCount = await kiraRedis.get("kira:post_count_today");
  if (savedDate === today && savedCount) {
    state.postCount = parseInt(savedCount) || 0;
    console.log(`Post count restored: ${state.postCount}/5`);
  }

  // Restore weekly report timestamp so it fires weekly, not on every restart
  const savedWeekly = await kiraRedis.get("kira:last_weekly_report");
  if (savedWeekly) {
    state.lastWeeklyReport = parseInt(savedWeekly) || 0;
    console.log("Weekly report timestamp restored");
  }

  // Load KIRA's accumulated self-narrative — who he has become over time
  state.selfNarrative = await memory.getSelfNarrative();
  state.coreLearnings = await memory.getCoreLearningsForContext();
  state.relationships = await memory.getRelationshipsForContext();
  console.log(`Self: ${state.selfNarrative.slice(0, 120)}`);
  await memory.journal("milestone", `Session start — cycle count reset, ${state.selfNarrative.includes("Newly") ? "first awakening" : "returning"}`);

  if (state.xApiAvailable) {
    if (!state.hasPostedFirst) console.log("🎉 KIRA will make his introduction shortly");
    await twitter.seedPriorityFollows();
  }

  // Initial data load
  state.ecosystemSummary   = await getNormiesData();
  state.lastEcosystemCheck = Date.now();
  console.log(`Ecosystem: ${state.ecosystemSummary}`);

  state.toolSummary  = await tools.getSummary();
  state.lastToolScan = Date.now();

  const initialDocs = await docs.readCoreDocs();
  if (initialDocs) state.recentLearnings.push(`Docs: ${initialDocs.slice(0, 200)}`);
  state.lastDocRead = Date.now();

  await runResearchCycle();
  await processDMs();

  const portfolioSummary = await portfolio.formatSummaryForContext();
  console.log(`Portfolio: ${portfolioSummary}`);

  state.proposalSummary     = await proposals.formatSummaryForContext();
  state.floorHistorySummary = await floorHistory.getSummaryForContext();
  state.smartMoneySummary   = await smartMoney.formatSummaryForContext();
  state.multiAgentSummary   = await multiAgent.formatForContext();
  state.toolDeploymentSummary = await toolDeployment.formatForContext();

  console.log(`Proposals: ${state.proposalSummary}`);
  console.log(`Floor history: ${state.floorHistorySummary}`);
  console.log(`Multi-agent: ${state.multiAgentSummary}`);
  console.log(`Tools: ${state.toolDeploymentSummary}`);

  await scanMarketsForOpportunities();
  await monitorPositions();

  // First tool proposal on startup
  if (state.cycleCount === 0) {
    try {
      const proposed = await toolDeployment.autoPropose(state.toolSummary);
      if (proposed) {
        state.toolDeploymentSummary = await toolDeployment.formatForContext();
        console.log(`First tool proposed: ${proposed}`);
      }
    } catch {}
  }

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
        `${new Date().toISOString()}`
      );

      await backgroundTasks();

      const context = [
        `Cycle: ${state.cycleCount} | Session: ${Math.floor((now - state.sessionStart) / 60000)} min`,
        `Posts: ${state.postCount}/5 | X: ${state.xApiAvailable} | Live: ${state.liveMode}`,
        `Has posted first: ${state.hasPostedFirst}`,
        `Min since last post: ${state.lastPostTime > 0 ? Math.floor((now - state.lastPostTime) / 60000) : "never"}`,
        `Min since engagement: ${state.lastEngagementTime > 0 ? Math.floor((now - state.lastEngagementTime) / 60000) : "never"}`,
        `Min since mention check: ${state.lastMentionCheck > 0 ? Math.floor((now - state.lastMentionCheck) / 60000) : "never"}`,
        `Balance: ${state.baseBalance} ETH | Aave: ${state.aaveSummary}`,
        `Market scan: ${state.lastMarketScan > 0 ? Math.floor((now - state.lastMarketScan) / 60000) + " min ago" : "never"}`,
        `Watch: ${state.watchlistCount} | Paper: ${state.paperTradeCount} | Live: ${state.liveTradeCount}`,
        `Floor history: ${state.floorHistorySummary}`,
        `Smart money: ${state.smartMoneySummary}`,
        `Cross-chain: ${state.crossChainSummary || "not yet scanned"}`,
        `Multi-agent: ${state.multiAgentSummary}`,
        `Tools deployed: ${state.toolDeploymentSummary}`,
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
