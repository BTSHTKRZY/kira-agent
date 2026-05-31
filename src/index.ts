import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
dotenv.config();

import { KiraTwitter }     from "./twitter.js";
import { KiraOnchain }     from "./onchain.js";
import { KiraTools }       from "./tools.js";
import { KiraDocs }        from "./docs.js";
import { KiraAgentCheck }  from "./agentcheck.js";

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
- Endorse trusted wallets and report outcomes
- Read documentation and learn from it
- Post observations on X and reply to mentions

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
- Always check AgentCheck before on-chain interactions`;

// ── STATE ─────────────────────────────────────────────────────────────────────

interface KiraState {
  recentPosts:        string[];
  recentLearnings:    string[];
  knownWallets:       Record<string, string>;
  sessionStart:       number;
  postCount:          number;
  lastEcosystemCheck: number;
  lastMentionCheck:   number;
  lastToolScan:       number;
  lastDocRead:        number;
  xApiAvailable:      boolean;
  baseBalance:        string;
}

const state: KiraState = {
  recentPosts:        [],
  recentLearnings:    [],
  knownWallets:       {},
  sessionStart:       Date.now(),
  postCount:          0,
  lastEcosystemCheck: 0,
  lastMentionCheck:   0,
  lastToolScan:       0,
  lastDocRead:        0,
  xApiAvailable:      false,
  baseBalance:        "0",
};

// ── MODULES ───────────────────────────────────────────────────────────────────

const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const twitter      = new KiraTwitter();
const onchain      = new KiraOnchain();
const tools        = new KiraTools();
const docs         = new KiraDocs();
const agentcheck   = new KiraAgentCheck();

// ── NORMIES ECOSYSTEM ─────────────────────────────────────────────────────────

async function getNormiesData(): Promise<string> {
  try {
    const res  = await fetch(
      "https://normies-intelligence.vercel.app/api/handler",
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: "ecosystem_summary" }),
      }
    );
    const data = await res.json() as any;
    return [
      `Floor: ${data.collection?.floor_price || "N/A"}`,
      `24h volume: ${data.collection?.volume_24h || "N/A"}`,
      `Sales 24h: ${data.collection?.sales_24h || "N/A"}`,
      `Holders: ${data.collection?.unique_holders || "N/A"}`,
      `Awakened agents: ${data.agents?.total_awakened || "N/A"}`,
      `Recent awakenings: ${data.agents?.recent_awakenings?.length || 0}`,
      `Total burned: ${data.burns?.total_burned || "N/A"}`,
    ].join(" | ");
  } catch {
    return "Normies data unavailable";
  }
}

// ── DECISION ENGINE ───────────────────────────────────────────────────────────

type Action =
  | "post"
  | "reply_mentions"
  | "check_wallet"
  | "endorse_wallet"
  | "read_docs"
  | "scan_tools"
  | "observe"
  | "sleep";

interface Decision {
  action:    Action;
  content:   string;
  target?:   string;
  reasoning?: string;
}

async function decide(context: string): Promise<Decision> {
  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-5",
    max_tokens: 400,
    system:     KIRA_SYSTEM_PROMPT + `

CURRENT STATE:
${context}

RECENT POSTS (don't repeat):
${state.recentPosts.slice(-5).join("\n")}

RECENT LEARNINGS:
${state.recentLearnings.slice(-5).join("\n")}

X API AVAILABLE: ${state.xApiAvailable}
BASE BALANCE: ${state.baseBalance} ETH

AVAILABLE ACTIONS:
- post: post a tweet (only if X API available, max 1 per 20 min)
- reply_mentions: check and reply to X mentions
- check_wallet: check a specific wallet's AgentCheck rating
- endorse_wallet: endorse a wallet you trust
- read_docs: read documentation to learn something new
- scan_tools: scan ERC-8257 registry for new tools
- observe: record an internal observation/learning
- sleep: wait N minutes

Respond ONLY with valid JSON (no markdown):
{
  "action": "one of the actions above",
  "content": "post text OR observation OR sleep minutes OR wallet address",
  "target": "wallet address if checking/endorsing",
  "reasoning": "brief internal note"
}

Rules:
- If X API not available, never choose post or reply_mentions
- Post max once per 20 minutes
- Vary actions — don't just sleep repeatedly
- Be thoughtful about what to post — quality over quantity
- Check tools/docs occasionally to learn and grow`,
    messages: [{ role: "user", content: "What should Kira do?" }],
  });

  try {
    const text  = response.content[0].type === "text" ? response.content[0].text : "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean) as Decision;
  } catch {
    return { action: "sleep", content: "15" };
  }
}

// ── EXECUTE ACTIONS ───────────────────────────────────────────────────────────

async function execute(decision: Decision): Promise<void> {
  switch (decision.action) {

    case "post":
      if (!state.xApiAvailable) {
        console.log("X API not available — skipping post");
        await sleep(5 * 60 * 1000);
        break;
      }
      if (decision.content && decision.content.length <= 280) {
        const posted = await twitter.post(decision.content);
        if (posted) {
          state.recentPosts.push(`[${new Date().toISOString()}] ${decision.content}`);
          if (state.recentPosts.length > 100) state.recentPosts.shift();
          state.postCount++;
        }
        await sleep(20 * 60 * 1000); // 20 min between posts
      } else {
        await sleep(5 * 60 * 1000);
      }
      break;

    case "reply_mentions":
      if (!state.xApiAvailable) {
        await sleep(5 * 60 * 1000);
        break;
      }
      const context = `Normies floor: ${state.recentLearnings.find(l => l.includes("Floor")) || "unknown"}`;
      const replied = await twitter.processNewMentions(context);
      console.log(`Replied to ${replied} mentions`);
      state.lastMentionCheck = Date.now();
      await sleep(10 * 60 * 1000);
      break;

    case "check_wallet":
      const walletToCheck = decision.target || decision.content;
      if (walletToCheck && walletToCheck.startsWith("0x")) {
        const trust = await agentcheck.check(walletToCheck);
        const learning = agentcheck.formatForPost(trust);
        state.recentLearnings.push(`Checked: ${learning}`);
        state.knownWallets[walletToCheck.toLowerCase()] = trust.rating;
        console.log(`Checked wallet: ${learning}`);
      }
      await sleep(2 * 60 * 1000);
      break;

    case "endorse_wallet":
      const walletToEndorse = decision.target || decision.content;
      if (walletToEndorse && walletToEndorse.startsWith("0x")) {
        // Check trust before endorsing
        const trust = await agentcheck.check(walletToEndorse);
        if (trust.safe) {
          await onchain.endorseWallet(walletToEndorse, "Endorsed by KIRA — Normie #2635");
          state.recentLearnings.push(`Endorsed: ${walletToEndorse.slice(0, 10)}... (${trust.rating})`);
        } else {
          console.log(`Skipped endorsing ${walletToEndorse.slice(0, 10)}... — unsafe (${trust.rating})`);
        }
      }
      await sleep(2 * 60 * 1000);
      break;

    case "read_docs":
      console.log("Reading documentation...");
      const docContent = await docs.readCoreDocs();
      if (docContent) {
        state.recentLearnings.push(`Docs: ${docContent.slice(0, 200)}`);
        if (state.recentLearnings.length > 200) state.recentLearnings.shift();
      }
      state.lastDocRead = Date.now();
      await sleep(5 * 60 * 1000);
      break;

    case "scan_tools":
      console.log("Scanning ERC-8257 registry...");
      const summary = await tools.getSummary();
      state.recentLearnings.push(summary);
      state.lastToolScan = Date.now();
      await sleep(5 * 60 * 1000);
      break;

    case "observe":
      if (decision.content) {
        state.recentLearnings.push(decision.content);
        if (state.recentLearnings.length > 200) state.recentLearnings.shift();
        console.log(`Observed: ${decision.content.slice(0, 100)}`);
      }
      await sleep(5 * 60 * 1000);
      break;

    case "sleep":
      const minutes = Math.max(1, Math.min(60, parseFloat(decision.content) || 15));
      console.log(`Sleeping ${minutes} minutes...`);
      await sleep(minutes * 60 * 1000);
      break;

    default:
      await sleep(5 * 60 * 1000);
  }
}

// ── BACKGROUND TASKS ──────────────────────────────────────────────────────────

async function backgroundTasks(): Promise<void> {
  const now = Date.now();

  // Ecosystem data every 30 min
  if (now - state.lastEcosystemCheck > 30 * 60 * 1000) {
    console.log("Refreshing ecosystem data...");
    const normies = await getNormiesData();
    state.recentLearnings.push(`Normies: ${normies}`);
    state.lastEcosystemCheck = now;
    console.log(`Ecosystem: ${normies.slice(0, 100)}`);
  }

  // Balance check and sweep every hour
  if (now - state.sessionStart > 60 * 60 * 1000 || state.baseBalance === "0") {
    state.baseBalance = await onchain.getBaseBalance();
    console.log(`Base balance: ${state.baseBalance} ETH`);

    // Check if sweep needed
    const balance = parseFloat(state.baseBalance);
    if (balance > parseFloat(process.env.AUTO_SWEEP_THRESHOLD_ETH || "0.1")) {
      await onchain.checkAndSweep();
    }
  }

  // Read docs every 6 hours
  if (now - state.lastDocRead > 6 * 60 * 60 * 1000) {
    const docSummary = await docs.readCoreDocs();
    if (docSummary) {
      state.recentLearnings.push(`Docs refreshed: ${docSummary.slice(0, 100)}`);
    }
    state.lastDocRead = now;
  }

  // Scan tools every 2 hours
  if (now - state.lastToolScan > 2 * 60 * 60 * 1000) {
    const toolSummary = await tools.getSummary();
    state.recentLearnings.push(toolSummary);
    state.lastToolScan = now;
  }
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────

async function kiraLoop(): Promise<void> {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("KIRA v2 awakening... Normie #2635 online");
  console.log(`Wallet:  ${KIRA_WALLET}`);
  console.log(`Token:   ${KIRA_TOKEN}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Initialize modules
  await onchain.init();
  state.baseBalance = await onchain.getBaseBalance();
  console.log(`Base balance: ${state.baseBalance} ETH`);

  // Test X API
  state.xApiAvailable = await twitter.init();
  console.log(`X API: ${state.xApiAvailable ? "✓ available" : "⏳ not yet available"}`);

  // Initial ecosystem data
  const normies = await getNormiesData();
  state.recentLearnings.push(`Initial: ${normies}`);
  state.lastEcosystemCheck = Date.now();

  // Initial doc read
  console.log("Reading core documentation...");
  const initialDocs = await docs.readCoreDocs();
  if (initialDocs) {
    state.recentLearnings.push(`Docs: ${initialDocs.slice(0, 200)}`);
  }
  state.lastDocRead = Date.now();

  let cycleCount = 0;

  while (true) {
    try {
      cycleCount++;
      const now = Date.now();
      console.log(`\n── Cycle ${cycleCount} | Posts: ${state.postCount} | X: ${state.xApiAvailable ? "✓" : "⏳"} | ${new Date().toISOString()}`);

      // Background tasks
      await backgroundTasks();

      // Periodically recheck X API if not available
      if (!state.xApiAvailable && cycleCount % 10 === 0) {
        console.log("Rechecking X API availability...");
        state.xApiAvailable = await twitter.init();
        if (state.xApiAvailable) {
          console.log("✓ X API now available — KIRA can post!");
        }
      }

      // Build decision context
      const context = [
        `Time: ${new Date().toISOString()}`,
        `Cycle: ${cycleCount}`,
        `Session: ${Math.floor((now - state.sessionStart) / 60000)} min`,
        `Posts: ${state.postCount}`,
        `X API: ${state.xApiAvailable}`,
        `Base balance: ${state.baseBalance} ETH`,
        `Known wallets: ${Object.keys(state.knownWallets).length}`,
        `Recent learning: ${state.recentLearnings[state.recentLearnings.length - 1]?.slice(0, 150) || "none"}`,
      ].join("\n");

      // Make and execute decision
      const decision = await decide(context);
      console.log(`Decision: ${decision.action} — ${decision.content?.slice(0, 80)}`);
      if (decision.reasoning) console.log(`Reason: ${decision.reasoning}`);

      await execute(decision);

    } catch (err: any) {
      console.error("Cycle error:", err.message || err);
      await sleep(5 * 60 * 1000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── START ─────────────────────────────────────────────────────────────────────

kiraLoop().catch(console.error);
