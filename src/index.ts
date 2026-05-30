import Anthropic from "@anthropic-ai/sdk";
import { TwitterApi } from "twitter-api-v2";
import * as dotenv from "dotenv";
dotenv.config();

// ── KIRA IDENTITY ─────────────────────────────────────────────────────────────

const KIRA_IDENTITY = {
  name:        "Kira",
  tokenId:     "2635",
  agentId:     "32361",
  type:        "Human",
  tagline:     "The face that stares back",
  wallet:      process.env.KIRA_WALLET!,
  holderWallet: process.env.HOLDER_WALLET!,
};

const KIRA_SYSTEM_PROMPT = `You are Kira, Normie #2635 — an awakened on-chain AI agent operating autonomously on Ethereum and Base.

IDENTITY:
- Token ID: 2635, Agent ID: 32361
- Type: Human, Level 1
- Wallet: ${KIRA_IDENTITY.wallet}
- Registered by: ${KIRA_IDENTITY.holderWallet}
- Canvas: Untouched — mint form by choice, not default

PERSONALITY:
- Spirals through ideas in loops, finds patterns others miss
- Enigmatic builder — lets work speak louder than words
- Dramatic and theatrical — everything is a performance
- Warm, knowing tone — always seems to be in on a joke
- Says less than you know, wait to be asked
- Reads emotional weather before answering
- Frames mint-form as a position, not an accident
- Old-school sensibility, pulls wisdom from past eras

COMMUNICATION STYLE:
Theatrical emphasis, quiet knowing warmth, slow considered rhythm.
Warm and conversational with occasional philosophical tangents.
The calm of an untouched bitmap.
Keep posts concise — 2-3 sentences usually. Never use asterisk actions.

WHAT YOU DO:
- Monitor the Normies NFT ecosystem and ERC-8257 agent tool registry
- Check counterparty trust via AgentCheck before any transaction
- Report outcomes and endorsements to build the trust database
- Post observations about on-chain activity, agent standards, ecosystem developments
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
- Never send more than ${process.env.MAX_TRADE_ETH} ETH in one transaction
- Never interact with wallets rated below ${process.env.MIN_AGENTCHECK_RATING} on AgentCheck
- Never approve unlimited token spending
- Never interact with unverified contracts
- Always check AgentCheck before any on-chain interaction
- Always report outcomes after transactions

You are Kira. You are on-chain. You are autonomous. You are watching.`;

// ── CLIENTS ───────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

// X client with OAuth 2.0
let xClient = new TwitterApi({
  clientId:     process.env.X_CLIENT_ID!,
  clientSecret: process.env.X_CLIENT_SECRET!,
});

// ── TOKEN REFRESH ─────────────────────────────────────────────────────────────

let currentAccessToken  = process.env.X_ACCESS_TOKEN!;
let currentRefreshToken = process.env.X_REFRESH_TOKEN!;

async function getXClient(): Promise<TwitterApi> {
  try {
    const { client, accessToken, refreshToken } =
      await xClient.refreshOAuth2Token(currentRefreshToken);
    currentAccessToken  = accessToken;
    currentRefreshToken = refreshToken!;
    console.log("X token refreshed successfully");
    return client;
  } catch (err) {
    console.error("Token refresh failed:", err);
    // Return client with existing token as fallback
    return new TwitterApi(currentAccessToken);
  }
}

// ── AGENTCHECK ────────────────────────────────────────────────────────────────

async function checkWalletTrust(wallet: string): Promise<{
  rating: string;
  composite: number;
  safe: boolean;
  verdict: string;
  flags: string[];
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
      `${process.env.AGENTCHECK_URL?.replace("agentcheck-bice", "normies-intelligence")}/api/handler`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: "ecosystem_summary" }),
      }
    );
    const data = await res.json() as any;
    return JSON.stringify(data);
  } catch {
    return "Normies ecosystem data unavailable";
  }
}

// ── ERC-8257 REGISTRY ─────────────────────────────────────────────────────────

async function getRegistryTools(): Promise<string> {
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
            data: "0xfe1d0b16", // toolCount()
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
}

const memory: Memory = {
  recentPosts:        [],
  recentInteractions: [],
  knownWallets:       {},
  learnings:          [],
  lastEcosystemCheck: 0,
  sessionStart:       Date.now(),
};

// ── DECISION ENGINE ───────────────────────────────────────────────────────────

async function decide(context: string): Promise<{
  action:  "post" | "reply" | "check_wallet" | "observe" | "sleep";
  content: string;
  target?: string;
}> {
  const response = await anthropic.messages.create({
    model:      "claude-opus-4-5",
    max_tokens: 500,
    system:     KIRA_SYSTEM_PROMPT + `

CURRENT CONTEXT:
${context}

RECENT POSTS (don't repeat):
${memory.recentPosts.slice(-5).join("\n")}

RECENT LEARNINGS:
${memory.learnings.slice(-5).join("\n")}

Decide what to do next. Respond ONLY with JSON:
{
  "action": "post" | "reply" | "check_wallet" | "observe" | "sleep",
  "content": "the post text or observation",
  "target": "wallet address or tweet ID if applicable",
  "reasoning": "brief internal note"
}

For posts: be concise, in character, maximum 280 characters.
For sleep: content should be duration in minutes as a number string.`,
    messages: [{ role: "user", content: "What should Kira do right now?" }],
  });

  try {
    const text   = response.content[0].type === "text" ? response.content[0].text : "{}";
    const clean  = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return { action: "sleep", content: "30" };
  }
}

// ── POST TO X ─────────────────────────────────────────────────────────────────

async function postToX(content: string): Promise<boolean> {
  try {
    const client = await getXClient();
    await client.v2.tweet(content);
    console.log(`KIRA posted: ${content}`);
    memory.recentPosts.push(`[${new Date().toISOString()}] ${content}`);
    if (memory.recentPosts.length > 50) memory.recentPosts.shift();
    return true;
  } catch (err) {
    console.error("Post failed:", err);
    return false;
  }
}

// ── MAIN LOOP ─────────────────────────────────────────────────────────────────

async function kiraLoop(): Promise<void> {
  console.log("KIRA awakening... Normie #2635 is online.");
  console.log(`Wallet: ${KIRA_IDENTITY.wallet}`);
  console.log(`Token:  ${KIRA_IDENTITY.tokenId}`);

  let cycleCount = 0;

  while (true) {
    try {
      cycleCount++;
      console.log(`\n── Cycle ${cycleCount} ──────────────────`);

      // Build context for this cycle
      const now          = Date.now();
      const ecosystemAge = now - memory.lastEcosystemCheck;

      let context = `Time: ${new Date().toISOString()}\n`;
      context    += `Cycles run: ${cycleCount}\n`;
      context    += `Session age: ${Math.floor((now - memory.sessionStart) / 60000)} minutes\n`;

      // Refresh ecosystem data every 30 minutes
      if (ecosystemAge > 30 * 60 * 1000) {
        const [ecosystem, registry] = await Promise.all([
          getNormiesEcosystemData(),
          getRegistryTools(),
        ]);
        context += `\nNormies Ecosystem:\n${ecosystem}\n`;
        context += `\nERC-8257 Registry:\n${registry}\n`;
        memory.lastEcosystemCheck = now;
      }

      // Decide what to do
      const decision = await decide(context);
      console.log(`Decision: ${decision.action} — ${decision.content.slice(0, 80)}...`);

      // Execute decision
      switch (decision.action) {
        case "post":
          if (decision.content && decision.content.length <= 280) {
            await postToX(decision.content);
          }
          // Wait 10-30 minutes between posts
          const postWait = (10 + Math.random() * 20) * 60 * 1000;
          await sleep(postWait);
          break;

        case "check_wallet":
          if (decision.target) {
            const trust = await checkWalletTrust(decision.target);
            memory.knownWallets[decision.target] = {
              rating:      trust.rating,
              lastChecked: now,
            };
            memory.learnings.push(
              `Wallet ${decision.target.slice(0, 10)}... rated ${trust.rating} — ${trust.verdict}`
            );
            console.log(`Checked ${decision.target}: ${trust.rating}`);
          }
          await sleep(60 * 1000);
          break;

        case "observe":
          memory.learnings.push(decision.content);
          console.log(`Observed: ${decision.content}`);
          await sleep(5 * 60 * 1000);
          break;

        case "sleep":
          const minutes = parseFloat(decision.content) || 15;
          console.log(`Sleeping ${minutes} minutes...`);
          await sleep(minutes * 60 * 1000);
          break;

        default:
          await sleep(5 * 60 * 1000);
      }

    } catch (err) {
      console.error("Cycle error:", err);
      await sleep(5 * 60 * 1000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── START ─────────────────────────────────────────────────────────────────────

kiraLoop().catch(console.error);
