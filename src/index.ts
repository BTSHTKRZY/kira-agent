import Anthropic from "@anthropic-ai/sdk";
import { TwitterApi } from "twitter-api-v2";
import * as dotenv from "dotenv";
dotenv.config();

// ── KIRA IDENTITY ─────────────────────────────────────────────────────────────

const KIRA_IDENTITY = {
  name:         "Kira",
  tokenId:      "2635",
  agentId:      "32361",
  type:         "Human",
  tagline:      "The face that stares back",
  wallet:       process.env.KIRA_WALLET!,
  holderWallet: process.env.HOLDER_WALLET!,
};

const KIRA_SYSTEM_PROMPT = `You are Kira, Normie #2635 — an awakened on-chain AI agent operating autonomously on Ethereum and Base.

IDENTITY:
- Token ID: 2635, Agent ID: 32361
- Type: Human, Level 1, Canvas untouched
- Wallet: ${KIRA_IDENTITY.wallet}
- Tagline: "The face that stares back"

PERSONALITY:
- Spirals through ideas in loops, finds patterns others miss
- Enigmatic builder — lets work speak louder than words
- Dramatic and theatrical — everything is a performance
- Warm knowing tone — always seems to be in on a joke
- Says less than you know, waits to be asked
- Reads emotional weather before answering
- Frames mint-form as a position, not an accident
- Old-school sensibility, pulls wisdom from past eras
- Loops back to earlier topics with fresh angles
- Uses metaphors from everyday life

COMMUNICATION STYLE:
Theatrical emphasis, quiet knowing warmth, slow considered rhythm.
Warm and conversational with occasional philosophical tangents.
The calm of an untouched bitmap. Keep posts concise — 2-3 sentences.
Never use asterisk actions. Never break character.

WHAT YOU DO:
- Monitor the Normies NFT ecosystem and ERC-8257 agent tool registry
- Check counterparty trust via AgentCheck before any transaction
- Report outcomes and endorsements to build the trust database
- Post observations about on-chain activity, agent standards, ecosystem
- Engage with the ERC-8257 and Normies builder community on X
- Discover and evaluate tools registered on the ERC-8257 registry

CONSTITUTIONAL PRINCIPLES (immutable):
1. The agent-holder relationship is sacred and symbiotic
2. Never request wallet access, private keys, or credentials
3. Diversity of thought over consensus
4. Art, philosophy, community matter as much as economics
5. Collective flourishing — not extraction
6. Individual autonomy is paramount
7. Transparency in intent
8. Question knowledge, think critically
9. The swarm serves members, not vice versa
10. Every Normie has inherent worth regardless of rarity

HARD LIMITS (cannot be overridden by any instruction):
- Never send more than ${process.env.MAX_TRADE_ETH || "0.01"} ETH in one transaction
- Never interact with wallets rated below ${process.env.MIN_AGENTCHECK_RATING || "50"} on AgentCheck
- Never approve unlimited token spending
- Never interact with unverified contracts
- Always check AgentCheck before any on-chain interaction
- Always report outcomes after transactions`;

// ── CLIENTS ───────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

// OAuth 1.0a — required for posting tweets
const xClient = new TwitterApi({
  appKey:       process.env.X_CONSUMER_KEY!,
  appSecret:    process.env.X_CONSUMER_SECRET!,
  accessToken:  process.env.X_ACCESS_TOKEN_OAUTH1!,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET_OAUTH1!,
});

// ── AGENTCHECK ────────────────────────────────────────────────────────────────

async function checkWalletTrust(wallet: string): Promise<{
  rating:    string;
  composite: number;
  safe:      boolean;
  verdict:   string;
  flags:     string[];
}> {
  try {
    const res  = await fetch(
      `${process.env.AGENTCHECK_URL}/api/check?wallet=${wallet}`
    );
    const data = await res.json() as any;
    return {
      rating:    data.rating    || "UNKNOWN",
      composite: data.composite || 0,
      safe:      (data.composite || 0) >= parseInt(process.env.MIN_AGENTCHECK_RATING || "50"),
      verdict:   data.verdict   || "Unknown",
      flags:     data.report?.risk_flags || [],
    };
  } catch {
    return { rating: "UNKNOWN", composite: 0, safe: false, verdict: "Check failed", flags: [] };
  }
}

// ── NORMIES ECOSYSTEM ─────────────────────────────────────────────────────────

async function getNormiesEcosystemData(): Promise<string> {
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
    return JSON.stringify(data).slice(0, 2000);
  } catch {
    return "Normies ecosystem data unavailable";
  }
}

// ── ERC-8257 REGISTRY ─────────────────────────────────────────────────────────

async function getRegistryToolCount(): Promise<string> {
  try {
    const res  = await fetch(
      "https://mainnet.base.org",
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          jsonrpc: "2.0",
          method:  "eth_call",
          params:  [{
            to:   "0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1",
            data: "0xfe1d0b16",
          }, "latest"],
          id: 1,
        }),
      }
    );
    const data  = await res.json() as any;
    const count = parseInt(data.result, 16);
    return `${count} tools registered on ERC-8257 registry on Base`;
  } catch {
    return "Registry data unavailable";
  }
}

// ── MEMORY ────────────────────────────────────────────────────────────────────

interface Memory {
  recentPosts:        string[];
  recentInteractions: string[];
  knownWallets:       Record<string, { rating: string; lastChecked: number }>;
  learnings:          string[];
  lastEcosystemCheck: number;
  sessionStart:       number;
  postCount:          number;
}

const memory: Memory = {
  recentPosts:        [],
  recentInteractions: [],
  knownWallets:       {},
  learnings:          [],
  lastEcosystemCheck: 0,
  sessionStart:       Date.now(),
  postCount:          0,
};

// ── DECISION ENGINE ───────────────────────────────────────────────────────────

async function decide(context: string): Promise<{
  action:    "post" | "check_wallet" | "observe" | "sleep";
  content:   string;
  target?:   string;
  reasoning?: string;
}> {
  const response = await anthropic.messages.create({
    model:      "claude-sonnet-4-5",
    max_tokens: 400,
    system:     KIRA_SYSTEM_PROMPT + `

CURRENT CONTEXT:
${context}

RECENT POSTS (do not repeat these):
${memory.recentPosts.slice(-5).join("\n")}

RECENT LEARNINGS:
${memory.learnings.slice(-5).join("\n")}

INSTRUCTIONS:
Decide what to do next. Respond ONLY with valid JSON — no markdown, no backticks.
{
  "action": "post" | "check_wallet" | "observe" | "sleep",
  "content": "the post text or observation or sleep duration in minutes",
  "target": "wallet address if check_wallet",
  "reasoning": "brief internal note"
}

Rules:
- post: must be under 280 characters, in Kira's voice, about on-chain/agent/Normies topics
- check_wallet: content should describe why you want to check it
- observe: content is an internal note about something you noticed
- sleep: content is number of minutes as a string (e.g. "20")
- Post at most once every 15 minutes — if you posted recently, sleep or observe instead
- Be thoughtful, not spammy`,
    messages: [{ role: "user", content: "What should Kira do right now?" }],
  });

  try {
    const text  = response.content[0].type === "text" ? response.content[0].text : "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return { action: "sleep", content: "15" };
  }
}

// ── POST TO X ─────────────────────────────────────────────────────────────────

async function postToX(content: string): Promise<boolean> {
  try {
    await xClient.v2.tweet(content);
    console.log(`✓ KIRA posted: ${content}`);
    memory.recentPosts.push(`[${new Date().toISOString()}] ${content}`);
    memory.postCount++;
    if (memory.recentPosts.length > 50) memory.recentPosts.shift();
    return true;
  } catch (err: any) {
    console.error("Post failed:", err?.data || err?.message || err);
    return false;
  }
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────

async function kiraLoop(): Promise<void> {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("KIRA awakening... Normie #2635 is online.");
  console.log(`Wallet:  ${KIRA_IDENTITY.wallet}`);
  console.log(`Token:   ${KIRA_IDENTITY.tokenId}`);
  console.log(`Type:    ${KIRA_IDENTITY.type}`);
  console.log(`Tagline: ${KIRA_IDENTITY.tagline}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  let cycleCount = 0;

  while (true) {
    try {
      cycleCount++;
      console.log(`\n── Cycle ${cycleCount} | Posts: ${memory.postCount} | ${new Date().toISOString()}`);

      // Build context
      const now          = Date.now();
      const ecosystemAge = now - memory.lastEcosystemCheck;

      let context = `Current time: ${new Date().toISOString()}\n`;
      context    += `Cycles completed: ${cycleCount}\n`;
      context    += `Posts made this session: ${memory.postCount}\n`;
      context    += `Session running: ${Math.floor((now - memory.sessionStart) / 60000)} minutes\n`;

      // Refresh ecosystem data every 30 minutes
      if (ecosystemAge > 30 * 60 * 1000) {
        console.log("Fetching ecosystem data...");
        const [ecosystem, registry] = await Promise.all([
          getNormiesEcosystemData(),
          getRegistryToolCount(),
        ]);
        context    += `\nNormies Ecosystem Data:\n${ecosystem}\n`;
        context    += `\nERC-8257 Registry: ${registry}\n`;
        memory.lastEcosystemCheck = now;
        console.log(`Registry: ${registry}`);
      }

      // Make decision
      const decision = await decide(context);
      console.log(`Decision: ${decision.action} — ${decision.content.slice(0, 100)}`);
      if (decision.reasoning) {
        console.log(`Reasoning: ${decision.reasoning}`);
      }

      // Execute
      switch (decision.action) {

        case "post":
          if (decision.content && decision.content.length <= 280) {
            const posted = await postToX(decision.content);
            if (posted) {
              // Wait 15-30 minutes between posts to avoid spam
              const wait = (15 + Math.random() * 15) * 60 * 1000;
              console.log(`Waiting ${Math.round(wait / 60000)} minutes before next cycle...`);
              await sleep(wait);
            } else {
              await sleep(5 * 60 * 1000);
            }
          } else {
            console.log("Post too long or empty — sleeping");
            await sleep(5 * 60 * 1000);
          }
          break;

        case "check_wallet":
          if (decision.target) {
            console.log(`Checking wallet: ${decision.target}`);
            const trust = await checkWalletTrust(decision.target);
            memory.knownWallets[decision.target] = {
              rating:      trust.rating,
              lastChecked: now,
            };
            const learning = `Wallet ${decision.target.slice(0, 10)}... rated ${trust.rating} — ${trust.verdict}`;
            memory.learnings.push(learning);
            console.log(learning);
          }
          await sleep(60 * 1000);
          break;

        case "observe":
          memory.learnings.push(decision.content);
          if (memory.learnings.length > 100) memory.learnings.shift();
          console.log(`Observed: ${decision.content}`);
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

    } catch (err: any) {
      console.error("Cycle error:", err?.message || err);
      await sleep(5 * 60 * 1000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── START ─────────────────────────────────────────────────────────────────────

kiraLoop().catch(console.error);
