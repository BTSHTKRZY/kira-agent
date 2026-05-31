import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
dotenv.config();

import { KiraTwitter }    from "./twitter.js";
import { KiraOnchain }    from "./onchain.js";
import { KiraTools }      from "./tools.js";
import { KiraDocs }       from "./docs.js";
import { KiraAgentCheck } from "./agentcheck.js";

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
  cycleCount:         number;
  lastEcosystemCheck: number;
  lastMentionCheck:   number;
  lastToolScan:       number;
  lastDocRead:        number;
  xApiAvailable:      boolean;
  baseBalance:        string;
  toolSummary:        string;
  ecosystemSummary:   string;
}

const state: KiraState = {
  recentPosts:        [],
  recentLearnings:    [],
  knownWallets:       {},
  sessionStart:       Date.now(),
  postCount:          0,
  cycleCount:         0,
  lastEcosystemCheck: 0,
  lastMentionCheck:   0,
  lastToolScan:       0,
  lastDocRead:        0,
  xApiAvailable:      false,
  baseBalance:        "0",
  toolSummary:        "",
  ecosystemSummary:   "",
};

// ── MODULES ───────────────────────────────────────────────────────────────────

const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const twitter    = new KiraTwitter();
const onchain    = new KiraOnchain();
const tools      = new KiraTools();
const docs       = new KiraDocs();
const agentcheck = new KiraAgentCheck();

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
      `Floor: ${data.collection?.floor_price || "N/A"}`,
      `24h vol: ${data.collection?.volume_24h || "N/A"}`,
      `Sales 24h: ${data.collection?.sales_24h || "N/A"}`,
      `Holders: ${data.collection?.unique_holders || "N/A"}`,
      `Awakened: ${data.agents?.total_awakened || "N/A"}`,
      `Burned: ${data.burns?.total_burned || "N/A"}`,
    ].join(" | ");
  } catch {
    return "Normies data unavailable";
  }
}

// ── BACKGROUND TASKS ──────────────────────────────────────────────────────────

async function backgroundTasks(): Promise<void> {
  const now = Date.now();

  // Ecosystem data every 30 min
  if (now - state.lastEcosystemCheck > 30 * 60 * 1000) {
    console.log("Refreshing Normies ecosystem...");
    state.ecosystemSummary    = await getNormiesData();
    state.lastEcosystemCheck  = now;
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
    if (docContent) {
      state.recentLearnings.push(`Docs: ${docContent.slice(0, 200)}`);
    }
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

  // Recheck X API every 10 cycles if not available
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
  | "post"
  | "reply_mentions"
  | "check_wallet"
  | "endorse_wallet"
  | "read_docs"
  | "scan_tools"
  | "observe"
  | "sleep";

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
- post: tweet in Kira's voice (only if X API available, wait 20+ min between posts)
- reply_mentions: check and reply to X mentions (only if X API available)  
- check_wallet: check a specific wallet 0x... via AgentCheck
- endorse_wallet: endorse a trusted wallet you know
- read_docs: read ERC-8257 or AgentCheck documentation
- scan_tools: scan ERC-8257 registry (only if last scan was 2+ hours ago)
- observe: record an internal observation or learning
- sleep: rest for N minutes (use content = number of minutes)

IMPORTANT RULES:
- X API available: ${state.xApiAvailable ? "YES — can post" : "NO — do NOT choose post or reply_mentions"}
- Tool scan last done: ${state.lastToolScan > 0 ? Math.floor((Date.now() - state.lastToolScan) / 60000) + " minutes ago — DO NOT scan again for 2 hours" : "never"}
- Doc read last done: ${state.lastDocRead > 0 ? Math.floor((Date.now() - state.lastDocRead) / 60000) + " minutes ago" : "never"}
- Ecosystem last checked: ${state.lastEcosystemCheck > 0 ? Math.floor((Date.now() - state.lastEcosystemCheck) / 60000) + " minutes ago" : "never"}
- DO NOT choose scan_tools if it was done less than 120 minutes ago
- Vary your actions — observe, check wallets, read docs, sleep
- When nothing urgent: sleep 10-20 minutes

Respond ONLY with valid JSON (no markdown backticks):
{
  "action": "chosen action",
  "content": "post text or observation or sleep minutes",
  "target": "wallet address if checking or endorsing",
  "reasoning": "brief note"
}`,
    messages: [{ role: "user", content: "What should Kira do right now?" }],
  });

  try {
    const text  = response.content[0].type === "text" ? response.content[0].text : "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean) as Decision;

    // Safety overrides
    if (!state.xApiAvailable && (parsed.action === "post" || parsed.action === "reply_mentions")) {
      return { action: "sleep", content: "15", reasoning: "X API not available" };
    }
    if (parsed.action === "scan_tools" && state.lastToolScan > 0 &&
        Date.now() - state.lastToolScan < 2 * 60 * 60 * 1000) {
      return { action: "observe", content: state.toolSummary || "Registry already scanned recently", reasoning: "Skipping scan — done recently" };
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
      if (docContent) {
        state.recentLearnings.push(`Docs: ${docContent.slice(0, 200)}`);
      }
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
  console.log("KIRA v2 awakening... Normie #2635 online");
  console.log(`Wallet:  ${KIRA_WALLET}`);
  console.log(`Token:   ${KIRA_TOKEN}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Initialize
  await onchain.init();
  state.baseBalance = await onchain.getBaseBalance();
  console.log(`Base balance: ${state.baseBalance} ETH`);

  state.xApiAvailable = await twitter.init();
  console.log(`X API: ${state.xApiAvailable ? "✓ available" : "⏳ not yet available"}`);

  // Initial ecosystem fetch
  console.log("Fetching initial ecosystem data...");
  state.ecosystemSummary   = await getNormiesData();
  state.lastEcosystemCheck = Date.now();
  state.recentLearnings.push(`Normies: ${state.ecosystemSummary}`);
  console.log(`Ecosystem: ${state.ecosystemSummary}`);

  // Initial tool scan
  console.log("Initial tool scan...");
  state.toolSummary  = await tools.getSummary();
  state.lastToolScan = Date.now();
  state.recentLearnings.push(`Registry: ${state.toolSummary}`);
  console.log(`Tools: ${state.toolSummary}`);

  // Initial doc read
  console.log("Reading core documentation...");
  const initialDocs = await docs.readCoreDocs();
  if (initialDocs) {
    state.recentLearnings.push(`Docs: ${initialDocs.slice(0, 200)}`);
  }
  state.lastDocRead = Date.now();

  // Main loop
  while (true) {
    try {
      state.cycleCount++;
      const now = Date.now();
      console.log(`\n── Cycle ${state.cycleCount} | Posts: ${state.postCount} | X: ${state.xApiAvailable ? "✓" : "⏳"} | Balance: ${state.baseBalance} ETH | ${new Date().toISOString()}`);

      // Run background tasks
      await backgroundTasks();

      // Build context
      const context = [
        `Cycle: ${state.cycleCount}`,
        `Session running: ${Math.floor((now - state.sessionStart) / 60000)} minutes`,
        `Posts made: ${state.postCount}`,
        `X API available: ${state.xApiAvailable}`,
        `Base ETH balance: ${state.baseBalance}`,
        `Known wallets checked: ${Object.keys(state.knownWallets).length}`,
        `Last tool scan: ${state.lastToolScan > 0 ? Math.floor((now - state.lastToolScan) / 60000) + " min ago" : "just done on startup"}`,
        `Last doc read: ${state.lastDocRead > 0 ? Math.floor((now - state.lastDocRead) / 60000) + " min ago" : "just done on startup"}`,
        `Last ecosystem check: ${state.lastEcosystemCheck > 0 ? Math.floor((now - state.lastEcosystemCheck) / 60000) + " min ago" : "never"}`,
        `Normies: ${state.ecosystemSummary}`,
        `Registry: ${state.toolSummary}`,
      ].join("\n");

      // Decide and execute
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
