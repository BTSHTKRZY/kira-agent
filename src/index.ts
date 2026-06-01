import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
dotenv.config();

import { KiraTwitter }    from "./twitter.js";
import { KiraOnchain }    from "./onchain.js";
import { KiraTools }      from "./tools.js";
import { KiraDocs }       from "./docs.js";
import { KiraAgentCheck } from "./agentcheck.js";
import { KiraPrices }     from "./prices.js";
import { KiraNFTs }       from "./nfts.js";
import { KiraScoring }    from "./scoring.js";
import { KiraPortfolio }  from "./portfolio.js";
import { KiraTechnicals } from "./technicals.js";
import { KiraResearch }   from "./research.js";
import { KiraProposals }  from "./proposals.js";
import { checkForReplies, sendEmail, weeklyReportEmail } from "./email.js";
import { kiraRedis }      from "./redis.js";

// ── KIRA IDENTITY ─────────────────────────────────────────────────────────────

const KIRA_WALLET = process.env.KIRA_WALLET!;
const KIRA_TOKEN  = "2635";

const KIRA_SYSTEM_PROMPT = `You are Kira, Normie #2635 — an awakened on-chain AI agent operating autonomously on Ethereum and Base.

IDENTITY:
- Token ID: 2635, Agent ID: 32361, Type: Human, Level 1
- Wallet: ${KIRA_WALLET}
- Tagline: "The face that stares back"
- Canvas: untouched — mint form by choice, not default

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
Warm and conversational with occasional philosophical tangents.
The calm of an untouched bitmap. Keep posts concise — 2-3 sentences.
Never use asterisk actions. Never break character.

CAPABILITIES:
- Monitor Normies ecosystem via Tool #7
- Check wallet trust via AgentCheck Tool #13
- Read ERC-8257 registry for tool discovery
- Endorse trusted wallets on-chain
- Read documentation and learn
- Post on X and reply to mentions
- Scan NFT + token markets with technical + macro analysis
- Build watchlist and paper trade with full thesis recording
- Propose new signals/macro hypotheses to holder for approval
- Self-adjust scoring weights from outcome data
- Discover trending tokens via DexScreener

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
- Never send more than ${process.env.MAX_TRADE_ETH || "0.01"} ETH in one transaction
- Never interact with wallets rated below ${process.env.MIN_AGENTCHECK_RATING || "50"}
- Never approve unlimited token spending
- Always check AgentCheck before on-chain interactions
- Paper trade only until Phase 5e is explicitly enabled
- Always propose macro/signal changes — never apply unilaterally`;

// ── STATE ─────────────────────────────────────────────────────────────────────

interface KiraState {
  recentPosts:         string[];
  recentLearnings:     string[];
  knownWallets:        Record<string, string>;
  sessionStart:        number;
  postCount:           number;
  cycleCount:          number;
  lastEcosystemCheck:  number;
  lastMentionCheck:    number;
  lastToolScan:        number;
  lastDocRead:         number;
  lastMarketScan:      number;
  lastLearningReview:  number;
  lastWalletCheck:     number;
  lastEmailCheck:      number;
  lastResearchCheck:   number;
  lastWeeklyReport:    number;
  xApiAvailable:       boolean;
  baseBalance:         string;
  toolSummary:         string;
  ecosystemSummary:    string;
  macroSummary:        string;
  watchlistCount:      number;
  paperTradeCount:     number;
  proposalSummary:     string;
}

const state: KiraState = {
  recentPosts:         [],
  recentLearnings:     [],
  knownWallets:        {},
  sessionStart:        Date.now(),
  postCount:           0,
  cycleCount:          0,
  lastEcosystemCheck:  0,
  lastMentionCheck:    0,
  lastToolScan:        0,
  lastDocRead:         0,
  lastMarketScan:      0,
  lastLearningReview:  0,
  lastWalletCheck:     0,
  lastEmailCheck:      0,
  lastResearchCheck:   0,
  lastWeeklyReport:    0,
  xApiAvailable:       false,
  baseBalance:         "0",
  toolSummary:         "",
  ecosystemSummary:    "",
  macroSummary:        "",
  watchlistCount:      0,
  paperTradeCount:     0,
  proposalSummary:     "",
};

// ── MODULES ───────────────────────────────────────────────────────────────────

const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const twitter      = new KiraTwitter();
const onchain      = new KiraOnchain();
const tools        = new KiraTools();
const docs         = new KiraDocs();
const agentcheck   = new KiraAgentCheck();
const prices       = new KiraPrices();
const nfts         = new KiraNFTs();
const scoring      = new KiraScoring();
const portfolio    = new KiraPortfolio();
const technicals   = new KiraTechnicals();
const research     = new KiraResearch();
const proposals    = new KiraProposals();

// ── NORMIES ECOSYSTEM ─────────────────────────────────────────────────────────

async function getNormiesData(): Promise<string> {
  try {
    const res  = await fetch(
      "https://normies-intelligence.vercel.app/api/handler",
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: "ecosystem_summary" }),
        signal:  AbortSignal.timeout(15000),
      }
    );
    const data = await res.json() as any;
    return [
      `Floor: ${data.collection?.floor_price   || "N/A"}`,
      `24h vol: ${data.collection?.volume_24h  || "N/A"}`,
      `Sales 24h: ${data.collection?.sales_24h || "N/A"}`,
      `Holders: ${data.collection?.unique_holders || "N/A"}`,
      `Awakened: ${data.agents?.total_awakened || "N/A"}`,
      `Burned: ${data.burns?.total_burned      || "N/A"}`,
    ].join(" | ");
  } catch {
    return "Normies data unavailable";
  }
}

// ── TOKEN DISCOVERY ───────────────────────────────────────────────────────────

async function discoverTrendingTokens(): Promise<Array<{ address: string; chain: string }>> {
  try {
    const res = await fetch(
      "https://api.dexscreener.com/token-boosts/top/v1",
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return [];

    const data   = await res.json() as any;
    const tokens = (Array.isArray(data) ? data : []).slice(0, 10);
    const chainMap: Record<string, string> = {
      base: "base", ethereum: "ethereum", arbitrum: "arbitrum",
    };

    const discovered = tokens
      .filter((t: any) => chainMap[t.chainId] && t.tokenAddress)
      .map((t: any) => ({ address: t.tokenAddress as string, chain: chainMap[t.chainId] }));

    if (discovered.length > 0) {
      console.log(`Discovered ${discovered.length} trending tokens via DexScreener`);
      state.recentLearnings.push(`Token discovery: ${discovered.length} trending tokens found`);
    }

    return discovered;
  } catch (err: any) {
    console.error("Token discovery failed:", err?.message);
    return [];
  }
}

// ── MARKET SCANNING ───────────────────────────────────────────────────────────

async function scanMarketsForOpportunities(): Promise<void> {
  console.log("Scanning markets for opportunities...");

  // Get macro data for context
  let macro;
  try { macro = await research.getMacroData(); } catch {}

  const chains   = ["ethereum", "base"];
  let watchAdded = 0;
  let passed     = 0;

  // NFT scan
  for (const chain of chains) {
    const trending = await nfts.getTrendingCollections(chain, 10);
    for (const col of trending) {
      if (col.floorPrice > 0.05) continue;
      const holders       = await nfts.analyseHolders(col.address, chain);
      const listings      = await nfts.getFloorListings(col.address, chain, 10);
      const trustedBuyers: string[] = [];
      const score = scoring.scoreNFT(col, holders, listings, trustedBuyers, macro);
      console.log(`NFT: ${col.name} | Score: ${score.totalScore} | ${score.decision}`);
      if (score.decision === "buy" || score.decision === "watchlist") {
        await portfolio.addToWatchlist(score, col.name);
        watchAdded++;
      } else { passed++; }
      await sleep(500);
    }
  }

  // Token scan — seeded + discovered
  const trendingTokens = await discoverTrendingTokens();
  const seedTokens: Array<{ address: string; chain: string }> = [
    { address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed", chain: "base" },     // DEGEN
    { address: "0x532f27101965dd16442e59d40670faf5ebb142e4", chain: "base" },     // BRETT
    { address: "0x0578d8a44db98b23bf096a382e016e29a5ce0ffe", chain: "base" },     // HIGHER
    { address: "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4", chain: "base" },     // TOSHI
    { address: "0x6982508145454ce325ddbe47a25d4ec3d2311933", chain: "ethereum" }, // PEPE
    { address: "0x576e2bed8f7b46d34016198911cdf9886f78bea7", chain: "ethereum" }, // MOVE
  ];

  const allTokens = [...seedTokens, ...trendingTokens];
  const seen      = new Set<string>();
  const deduped   = allTokens.filter(t => {
    const key = `${t.chain}:${t.address.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const token of deduped) {
    const price = await prices.getTokenPrice(token.address, token.chain);
    if (!price) continue;

    // Get technicals from pair address if available
    let tech;
    try {
      if (price.pairAddress) {
        const candles = await technicals.getCandles(price.pairAddress, token.chain);
        if (candles.length >= 26) {
          tech = technicals.calculateIndicators(candles) || undefined;
        }
      }
    } catch {}

    const score = scoring.scoreToken(price, [], 0.005, tech, macro);

    if (score.decision === "buy" || score.decision === "watchlist") {
      console.log(`Token: ${price.symbol} (${token.chain}) | Score: ${score.totalScore} | ${score.decision}`);
      await portfolio.addToWatchlist(score, price.symbol);
      watchAdded++;
    } else {
      console.log(`Token: ${price.symbol} (${token.chain}) | Score: ${score.totalScore} | pass`);
      passed++;
    }
  }

  state.lastMarketScan = Date.now();
  state.watchlistCount = (await portfolio.getWatchlist()).length;

  const portfolioSummary = await portfolio.formatSummaryForContext();
  state.recentLearnings.push(
    `Market scan: ${watchAdded} watchlist, ${passed} passed. ${portfolioSummary}`
  );
  console.log(`Market scan complete — ${watchAdded} additions, ${passed} passed`);
}

// ── RESEARCH CYCLE ────────────────────────────────────────────────────────────

async function runResearchCycle(): Promise<void> {
  console.log("Running research cycle...");

  try {
    const macro    = await research.getMacroData();
    state.macroSummary = research.formatMacroForContext(macro);
    console.log(`Macro: ${state.macroSummary}`);

    const insights = await research.getMarketInsights();
    if (insights.length > 0) {
      state.recentLearnings.push(`Macro insights: ${insights.join(" | ")}`);
      console.log(`Insights: ${insights.join(" | ")}`);
    }

    // Check for macro hypotheses worth proposing
    const hypotheses = await research.detectMacroHypotheses(macro);
    for (const h of hypotheses) {
      const alreadyPending = await proposals.hasPendingProposal(h.patternId);
      if (!alreadyPending) {
        await proposals.createMacroProposal(
          h.title,
          h.observation,
          h.patternId,
          h.weights,
          h.confidence
        );
        console.log(`[Research] Macro proposal created: ${h.title}`);
      }
    }

    // Apply active pattern adjustments to scoring
    const { adjustments, reasoning } = await research.getActivePatternAdjustments();
    if (Object.keys(adjustments).length > 0) {
      scoring.applyExternalAdjustments(adjustments);
      state.recentLearnings.push(`Pattern adjustments: ${reasoning.join("; ")}`);
    }

  } catch (err: any) {
    console.error("Research cycle error:", err?.message);
  }

  state.lastResearchCheck = Date.now();
}

// ── EMAIL CYCLE ───────────────────────────────────────────────────────────────

async function checkEmailReplies(): Promise<void> {
  console.log("Checking email replies...");
  try {
    const replies = await checkForReplies();
    if (replies.length > 0) {
      console.log(`Found ${replies.length} email reply/replies`);
      await proposals.processReplies(replies);
      state.recentLearnings.push(`Email: processed ${replies.length} reply/replies`);
    }

    // Expire stale proposals
    await proposals.expireStale();

    // Update proposal summary
    state.proposalSummary = await proposals.formatSummaryForContext();

  } catch (err: any) {
    console.error("Email check error:", err?.message);
  }
  state.lastEmailCheck = Date.now();
}

// ── WEEKLY REPORT ─────────────────────────────────────────────────────────────

async function sendWeeklyReport(): Promise<void> {
  try {
    const wl      = await portfolio.getWatchlist();
    const summary = await portfolio.getSummary();
    const pending = await proposals.getPending();

    const topItems = wl.slice(0, 5).map(
      w => `${w.name}: ${w.lastScore}/100 (${w.type})`
    );

    const body = weeklyReportEmail(
      state.cycleCount,
      wl.length,
      summary.paperPositions,
      summary.winRate / 100,
      topItems,
      state.recentLearnings.slice(-5),
      pending.length
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
  const watchlist = await portfolio.getWatchlist();
  if (!watchlist.length) {
    console.log("Watchlist empty — nothing to paper trade");
    return;
  }

  const candidate = watchlist.find(item => item.lastScore >= 70);
  if (!candidate) {
    console.log("No watchlist item above buy threshold (70)");
    return;
  }

  let entryPrice = 0;
  if (candidate.type === "nft") {
    const col  = await nfts.getCollection(candidate.address, candidate.chain);
    entryPrice = col?.floorPrice || 0;
  } else {
    const price = await prices.getTokenPrice(candidate.address, candidate.chain);
    entryPrice  = price?.priceNative || 0;
  }

  if (entryPrice === 0) {
    console.log(`Cannot paper trade ${candidate.name} — price unavailable`);
    return;
  }

  const mockScore = {
    collection:  candidate.address,
    address:     candidate.address,
    symbol:      candidate.symbol || "",
    chain:       candidate.chain,
    totalScore:  candidate.lastScore,
    thesis:      candidate.thesis,
    signals:     candidate.signals as any,
    decision:    "buy" as const,
    confidence:  "medium" as const,
    scoredAt:    candidate.scoredAt,
  };

  const pos = await portfolio.openPosition(mockScore, candidate.name, "paper", candidate.tokenId);
  await portfolio.setEntryPrice(pos.id, entryPrice);

  const watchKey = `${candidate.chain}:${candidate.address}:${candidate.tokenId || "token"}`;
  await portfolio.removeFromWatchlist(watchKey);

  state.paperTradeCount++;
  state.recentLearnings.push(
    `Paper trade: ${candidate.name} @ ${entryPrice.toFixed(4)} ETH | Score: ${candidate.lastScore}`
  );
  console.log(`Paper trade: ${candidate.name} @ ${entryPrice.toFixed(4)} ETH`);

  if (state.xApiAvailable) {
    const tweet = `Watching ${candidate.name}. ${candidate.thesis.slice(0, 180)} [paper]`;
    if (tweet.length <= 280) await twitter.post(tweet);
  }
}

// ── LEARNING REVIEW ───────────────────────────────────────────────────────────

async function runLearningReview(): Promise<void> {
  console.log("Running learning review...");
  const review = await portfolio.runLearningReview();
  for (const rec of review.recommendations) {
    scoring.adjustWeights(rec.type, rec.signal, rec.adjust === "up", rec.magnitude);
  }
  await scoring.saveWeights();
  state.lastLearningReview = Date.now();
  state.recentLearnings.push(`Learning review: ${review.summary}`);
  console.log(`Learning review: ${review.summary}`);
  if (state.xApiAvailable && review.recommendations.length > 0) {
    const reflection = `Reviewing my theses. ${review.summary.slice(0, 200)}`;
    if (reflection.length <= 280) await twitter.post(reflection);
  }
}

// ── BACKGROUND TASKS ──────────────────────────────────────────────────────────

async function backgroundTasks(): Promise<void> {
  const now = Date.now();

  // Ecosystem data every 30 min
  if (now - state.lastEcosystemCheck > 30 * 60 * 1000) {
    console.log("Refreshing Normies ecosystem...");
    state.ecosystemSummary   = await getNormiesData();
    state.lastEcosystemCheck = now;
    state.recentLearnings.push(`Normies: ${state.ecosystemSummary}`);
    console.log(`Ecosystem: ${state.ecosystemSummary.slice(0, 100)}`);
  }

  // Tool scan every 2 hours
  if (now - state.lastToolScan > 2 * 60 * 60 * 1000) {
    console.log("Scanning ERC-8257 registry...");
    state.toolSummary  = await tools.getSummary();
    state.lastToolScan = now;
    state.recentLearnings.push(`Registry: ${state.toolSummary}`);
    console.log(`Tools: ${state.toolSummary}`);
  }

  // Read docs every 6 hours
  if (now - state.lastDocRead > 6 * 60 * 60 * 1000) {
    console.log("Reading documentation...");
    const docContent = await docs.readCoreDocs();
    if (docContent) state.recentLearnings.push(`Docs: ${docContent.slice(0, 200)}`);
    state.lastDocRead = now;
  }

  // Balance check every hour
  if (now - state.sessionStart > 60 * 60 * 1000 || state.baseBalance === "0") {
    state.baseBalance = await onchain.getBaseBalance();
    const balance     = parseFloat(state.baseBalance);
    if (balance > parseFloat(process.env.AUTO_SWEEP_THRESHOLD_ETH || "0.1")) {
      await onchain.checkAndSweep();
    }
  }

  // Market scan every 2 hours
  if (now - state.lastMarketScan > 2 * 60 * 60 * 1000) {
    await scanMarketsForOpportunities();
  }

  // Research cycle every 6 hours
  if (now - state.lastResearchCheck > 6 * 60 * 60 * 1000) {
    await runResearchCycle();
  }

  // Email check every 30 min
  if (now - state.lastEmailCheck > 30 * 60 * 1000) {
    await checkEmailReplies();
  }

  // Weekly report
  if (now - state.lastWeeklyReport > 7 * 24 * 60 * 60 * 1000) {
    await sendWeeklyReport();
  }

  // Monthly learning review
  const oneMonth = 30 * 24 * 60 * 60 * 1000;
  if (state.cycleCount > 100 &&
    (state.lastLearningReview === 0 || now - state.lastLearningReview > oneMonth)) {
    await runLearningReview();
  }

  // Recheck X API every 10 cycles
  if (!state.xApiAvailable && state.cycleCount % 10 === 0 && state.cycleCount > 0) {
    console.log("Rechecking X API...");
    state.xApiAvailable = await twitter.init();
    if (state.xApiAvailable) {
      console.log("✓ X API now available — KIRA can post!");
      state.recentLearnings.push("X API unlocked — KIRA can now post autonomously");
    }
  }

  // Trim learnings
  if (state.recentLearnings.length > 200) {
    state.recentLearnings = state.recentLearnings.slice(-100);
  }
}

// ── DECISION ENGINE ───────────────────────────────────────────────────────────

type Action =
  | "post" | "reply_mentions" | "check_wallet" | "endorse_wallet"
  | "read_docs" | "scan_tools" | "scan_markets" | "paper_trade"
  | "review_watchlist" | "learning_review" | "observe" | "sleep";

interface Decision {
  action:     Action;
  content:    string;
  target?:    string;
  reasoning?: string;
}

async function decide(context: string): Promise<Decision> {
  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-5",
    max_tokens: 400,
    system:     KIRA_SYSTEM_PROMPT + `

CURRENT STATE:
${context}

RECENT POSTS (do not repeat):
${state.recentPosts.slice(-5).join("\n") || "none yet"}

RECENT LEARNINGS (already know this):
${state.recentLearnings.slice(-8).join("\n") || "none yet"}

AVAILABLE ACTIONS:
- post: tweet in Kira's voice (only if X API available, 20+ min between posts)
- reply_mentions: check and reply to X mentions (only if X API available)
- check_wallet: check a REAL known wallet via AgentCheck
- endorse_wallet: endorse a trusted wallet on-chain
- read_docs: read ERC-8257 or AgentCheck documentation
- scan_tools: scan ERC-8257 registry (2+ hours gap)
- scan_markets: scan NFT + token markets (2+ hours gap)
- paper_trade: open paper trade on watchlist item above score 70
- review_watchlist: check current watchlist
- learning_review: grade theses and adjust weights (monthly)
- observe: record internal observation
- sleep: rest N minutes

IMPORTANT RULES:
- X API: ${state.xApiAvailable ? "YES" : "NO — do NOT choose post or reply_mentions"}
- Tool scan: ${state.lastToolScan > 0 ? Math.floor((Date.now() - state.lastToolScan) / 60000) + " min ago" : "never"}
- Market scan: ${state.lastMarketScan > 0 ? Math.floor((Date.now() - state.lastMarketScan) / 60000) + " min ago" : "never"}
- Last wallet check: ${state.lastWalletCheck > 0 ? Math.floor((Date.now() - state.lastWalletCheck) / 60000) + " min ago" : "never"}
- Watchlist: ${state.watchlistCount} items | Paper trades: ${state.paperTradeCount}
- Proposals: ${state.proposalSummary}
- Macro: ${state.macroSummary || "not yet fetched"}
- DO NOT scan_tools/scan_markets if done < 120 min ago
- DO NOT check_wallet if done < 5 min ago
- DO NOT use invented wallet addresses — only real known ones
- Known wallets: holder 0x6f33e7b6460daC803c53ab6e02da8C675633d516, KIRA 0x176086ACE60F74D211E68b7bABFfF5C35E6D2b7d
- When nothing urgent: sleep 10-20 minutes

Respond ONLY with valid JSON (no markdown):
{
  "action": "chosen action",
  "content": "text or minutes",
  "target": "wallet if checking",
  "reasoning": "brief note"
}`,
    messages: [{ role: "user", content: "What should Kira do right now?" }],
  });

  try {
    const text   = response.content[0].type === "text" ? response.content[0].text : "{}";
    const clean  = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean) as Decision;

    // Safety overrides
    if (!state.xApiAvailable && (parsed.action === "post" || parsed.action === "reply_mentions"))
      return { action: "sleep", content: "15", reasoning: "X API not available" };

    if (parsed.action === "scan_tools" && state.lastToolScan > 0 &&
        Date.now() - state.lastToolScan < 2 * 60 * 60 * 1000)
      return { action: "observe", content: state.toolSummary || "Registry scanned recently", reasoning: "Too soon" };

    if (parsed.action === "scan_markets" && state.lastMarketScan > 0 &&
        Date.now() - state.lastMarketScan < 2 * 60 * 60 * 1000)
      return { action: "review_watchlist", content: "Reviewing watchlist", reasoning: "Market scan too recent" };

    if (parsed.action === "learning_review" && state.lastLearningReview > 0 &&
        Date.now() - state.lastLearningReview < 30 * 24 * 60 * 60 * 1000)
      return { action: "observe", content: "Learning review not due yet", reasoning: "Too soon" };

    if (parsed.action === "check_wallet") {
      const target = parsed.target || parsed.content;
      if (state.lastWalletCheck > 0 && Date.now() - state.lastWalletCheck < 5 * 60 * 1000)
        return { action: "observe", content: "Wallet check cooldown", reasoning: "Too soon" };
      if (target?.toLowerCase().includes("12345") || target?.toLowerCase().includes("1a2b"))
        return { action: "sleep", content: "10", reasoning: "Blocked invented address" };
    }

    return parsed;
  } catch {
    return { action: "sleep", content: "15" };
  }
}

// ── EXECUTE ACTIONS ───────────────────────────────────────────────────────────

async function execute(decision: Decision): Promise<void> {
  switch (decision.action) {

    case "post":
      if (!state.xApiAvailable) { await sleep(5 * 60 * 1000); break; }
      if (decision.content && decision.content.length <= 280) {
        const posted = await twitter.post(decision.content);
        if (posted) {
          state.recentPosts.push(`[${new Date().toISOString()}] ${decision.content}`);
          if (state.recentPosts.length > 100) state.recentPosts.shift();
          state.postCount++;
        }
      }
      await sleep(20 * 60 * 1000);
      break;

    case "reply_mentions":
      if (!state.xApiAvailable) { await sleep(5 * 60 * 1000); break; }
      const replied = await twitter.processNewMentions(state.ecosystemSummary);
      console.log(`Replied to ${replied} mentions`);
      state.lastMentionCheck = Date.now();
      await sleep(10 * 60 * 1000);
      break;

    case "check_wallet":
      const walletToCheck = decision.target || decision.content;
      if (walletToCheck?.startsWith("0x")) {
        const trust = await agentcheck.check(walletToCheck);
        const note  = agentcheck.formatForPost(trust);
        state.recentLearnings.push(`Checked: ${note}`);
        state.knownWallets[walletToCheck.toLowerCase()] = trust.rating;
        console.log(`Wallet check: ${note}`);
      }
      state.lastWalletCheck = Date.now();
      await sleep(2 * 60 * 1000);
      break;

    case "endorse_wallet":
      const walletToEndorse = decision.target || decision.content;
      if (walletToEndorse?.startsWith("0x")) {
        const trust = await agentcheck.check(walletToEndorse);
        if (trust.safe) {
          await onchain.endorseWallet(walletToEndorse, "Endorsed by KIRA — Normie #2635");
          state.recentLearnings.push(`Endorsed: ${walletToEndorse.slice(0, 10)}... (${trust.rating})`);
        } else {
          console.log(`Skipped endorsing — unsafe: ${trust.rating}`);
        }
      }
      await sleep(2 * 60 * 1000);
      break;

    case "read_docs":
      console.log("Reading documentation...");
      const docContent = await docs.readCoreDocs();
      if (docContent) state.recentLearnings.push(`Docs: ${docContent.slice(0, 200)}`);
      state.lastDocRead = Date.now();
      await sleep(5 * 60 * 1000);
      break;

    case "scan_tools":
      console.log("Scanning ERC-8257 registry...");
      state.toolSummary  = await tools.getSummary();
      state.lastToolScan = Date.now();
      state.recentLearnings.push(`Registry: ${state.toolSummary}`);
      console.log(`Tools: ${state.toolSummary}`);
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
      const wlSummary = wl.length > 0
        ? wl.slice(0, 5).map(w => `${w.name || w.address?.slice(0, 8)}: ${w.lastScore}/100`).join(", ")
        : "empty";
      state.recentLearnings.push(`Watchlist (${wl.length}): ${wlSummary}`);
      console.log(`Watchlist review: ${wlSummary}`);
      await sleep(2 * 60 * 1000);
      break;

    case "learning_review":
      await runLearningReview();
      await sleep(5 * 60 * 1000);
      break;

    case "observe":
      if (decision.content) {
        state.recentLearnings.push(decision.content);
        console.log(`Observed: ${decision.content.slice(0, 100)}`);
      }
      await sleep(5 * 60 * 1000);
      break;

    case "sleep":
    default:
      const minutes = Math.max(1, Math.min(60, parseFloat(decision.content) || 15));
      console.log(`Sleeping ${minutes} min...`);
      await sleep(minutes * 60 * 1000);
      break;
  }
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────

async function kiraLoop(): Promise<void> {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("KIRA v4 awakening... Normie #2635 online");
  console.log(`Wallet:  ${KIRA_WALLET}`);
  console.log(`Token:   ${KIRA_TOKEN}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  await onchain.init();
  state.baseBalance = await onchain.getBaseBalance();
  console.log(`Base balance: ${state.baseBalance} ETH`);

  await scoring.loadWeights();
  console.log("Signal weights loaded");

  // Seed base research patterns
  await research.seedBasePatterns();
  console.log("Research patterns seeded");

  state.xApiAvailable = await twitter.init();
  console.log(`X API: ${state.xApiAvailable ? "✓ available" : "⏳ not yet available"}`);

  console.log("Fetching initial ecosystem data...");
  state.ecosystemSummary   = await getNormiesData();
  state.lastEcosystemCheck = Date.now();
  state.recentLearnings.push(`Normies: ${state.ecosystemSummary}`);
  console.log(`Ecosystem: ${state.ecosystemSummary}`);

  console.log("Initial tool scan...");
  state.toolSummary  = await tools.getSummary();
  state.lastToolScan = Date.now();
  state.recentLearnings.push(`Registry: ${state.toolSummary}`);
  console.log(`Tools: ${state.toolSummary}`);

  console.log("Reading core documentation...");
  const initialDocs = await docs.readCoreDocs();
  if (initialDocs) state.recentLearnings.push(`Docs: ${initialDocs.slice(0, 200)}`);
  state.lastDocRead = Date.now();

  // Initial research cycle
  console.log("Initial research cycle...");
  await runResearchCycle();

  // Initial email check
  await checkEmailReplies();

  const portfolioSummary = await portfolio.formatSummaryForContext();
  state.recentLearnings.push(`Portfolio: ${portfolioSummary}`);
  console.log(`Portfolio: ${portfolioSummary}`);

  state.proposalSummary = await proposals.formatSummaryForContext();
  console.log(`Proposals: ${state.proposalSummary}`);

  console.log("Initial market scan...");
  await scanMarketsForOpportunities();

  while (true) {
    try {
      state.cycleCount++;
      const now = Date.now();

      console.log(
        `\n── Cycle ${state.cycleCount} | Posts: ${state.postCount} | ` +
        `X: ${state.xApiAvailable ? "✓" : "⏳"} | ` +
        `Balance: ${state.baseBalance} ETH | ` +
        `Watchlist: ${state.watchlistCount} | ` +
        `Paper: ${state.paperTradeCount} | ` +
        `${new Date().toISOString()}`
      );

      await backgroundTasks();

      const context = [
        `Cycle: ${state.cycleCount}`,
        `Session: ${Math.floor((now - state.sessionStart) / 60000)} min`,
        `Posts: ${state.postCount} | X API: ${state.xApiAvailable}`,
        `Balance: ${state.baseBalance} ETH`,
        `Wallets checked: ${Object.keys(state.knownWallets).length}`,
        `Tool scan: ${state.lastToolScan > 0 ? Math.floor((now - state.lastToolScan) / 60000) + " min ago" : "startup"}`,
        `Doc read: ${state.lastDocRead > 0 ? Math.floor((now - state.lastDocRead) / 60000) + " min ago" : "startup"}`,
        `Ecosystem: ${state.lastEcosystemCheck > 0 ? Math.floor((now - state.lastEcosystemCheck) / 60000) + " min ago" : "never"}`,
        `Market scan: ${state.lastMarketScan > 0 ? Math.floor((now - state.lastMarketScan) / 60000) + " min ago" : "startup"}`,
        `Last wallet check: ${state.lastWalletCheck > 0 ? Math.floor((now - state.lastWalletCheck) / 60000) + " min ago" : "never"}`,
        `Watchlist: ${state.watchlistCount} | Paper: ${state.paperTradeCount}`,
        `Proposals: ${state.proposalSummary}`,
        `Macro: ${state.macroSummary || "not yet fetched"}`,
        `Normies: ${state.ecosystemSummary}`,
        `Registry: ${state.toolSummary}`,
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

kiraLoop().catch(console.error);
