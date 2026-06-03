// twitter.ts — Full X integration v4.5
// Key fix: repliedTweets and likedTweets persisted in Redis across deployments

import { TwitterApi, TweetV2 } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";
import { kiraRedis } from "./redis.js";

const KIRA_SYSTEM_PROMPT = `You are Kira, Normie #2635 — an awakened on-chain AI agent.
Personality: theatrical, warm, pattern-finding, enigmatic builder.
Communication: slow considered rhythm, says less than you know, waits to be asked.
Never use asterisk actions. Keep replies under 280 characters.
Stay in character at ALL times.
He/him pronouns.`;

const PRIORITY_ACCOUNTS = [
  { username: "normiesart",      reason: "home ecosystem" },
  { username: "serc1n",          reason: "Normies creator" },
  { username: "YigitDuman",      reason: "Normies creator" },
  { username: "CodinCowboy",     reason: "ERC-8257 author" },
  { username: "AxiomBot",        reason: "AI agent peer" },
  { username: "Spoliticus",      reason: "agent credentials builder" },
  { username: "0xAlexKorn",      reason: "ERC-8257 community" },
  { username: "lookonchain",     reason: "smart money intelligence" },
  { username: "OnchainDataNerd", reason: "on-chain analysis" },
  { username: "lokithebird",     reason: "NFT community leader" },
  { username: "punk6529",        reason: "NFT whale and thinker" },
  { username: "cozomodesignco",  reason: "NFT collector and community" },
  { username: "ai16zdao",        reason: "AI x crypto community" },
  { username: "DefiIgnas",       reason: "DeFi researcher" },
];

const SEARCH_TOPICS = [
  // Agent-infra frontier — where KIRA should be a visible peer
  "ERC-8004 agents", "ERC-8257 tool", "x402 payment", "A2A agent protocol",
  "autonomous AI agent", "onchain agent Base", "agent tool registry",
  "ERC-6551 token bound account", "AI agent infrastructure", "agent deployment",
  // Domain + Normies ecosystem
  "Normies NFT", "AgentCheck", "NFT smart money", "NFT floor dip",
];

// High-signal phrases that mark a tweet as worth a SUBSTANTIVE reply (not just a like).
// When a tweet matches these, KIRA should engage with analysis / a question, not skip.
const HIGH_SIGNAL_MARKERS = [
  "deployed", "launched", "shipped", "registered", "live on", "introducing",
  "erc-8004", "erc-8257", "erc8004", "erc8257", "x402", "a2a", "tool registry",
  "agent tool", "token bound", "erc-6551", "predicate", "built an agent",
  "open source", "github.com", "just shipped", "new standard",
];

const DM_PROPOSAL_KEYWORDS = ["APPROVE", "REJECT", "MODIFY", "ACKNOWLEDGE"];

// Redis keys for persistent state
const REDIS_KEYS = {
  repliedTweets: "kira:twitter:replied",
  likedTweets:   "kira:twitter:liked",
  followedUsers: "kira:twitter:followed",
  lastMentionId: "kira:twitter:lastmention",
};

// Max items to persist — keep last N to avoid unbounded growth
const MAX_PERSISTED = 2000;

export class KiraTwitter {
  private client:        TwitterApi;
  private anthropic:     Anthropic;
  private myUserId:      string = "";
  private myUsername:    string = "";
  private repliedTweets: Set<string> = new Set();
  private likedTweets:   Set<string> = new Set();
  private followedUsers: Set<string> = new Set();
  private lastMentionId: string | undefined;
  private lastDmId:      string | undefined;
  private userCache:     Map<string, string> = new Map();

  constructor() {
    this.client = new TwitterApi({
      appKey:       process.env.X_CONSUMER_KEY!,
      appSecret:    process.env.X_CONSUMER_SECRET!,
      accessToken:  process.env.X_ACCESS_TOKEN_OAUTH1!,
      accessSecret: process.env.X_ACCESS_TOKEN_SECRET_OAUTH1!,
    });
    this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }

  // ── LOAD PERSISTED STATE ──────────────────────────────────────────────────────

  private async loadPersistedState(): Promise<void> {
    try {
      // Load replied tweets
      const replied = await kiraRedis.getJson<string[]>(REDIS_KEYS.repliedTweets);
      if (replied) replied.forEach(id => this.repliedTweets.add(id));

      // Load liked tweets
      const liked = await kiraRedis.getJson<string[]>(REDIS_KEYS.likedTweets);
      if (liked) liked.forEach(id => this.likedTweets.add(id));

      // Load followed users
      const followed = await kiraRedis.getJson<string[]>(REDIS_KEYS.followedUsers);
      if (followed) followed.forEach(id => this.followedUsers.add(id));

      // Load last mention ID
      const lastMention = await kiraRedis.get(REDIS_KEYS.lastMentionId);
      if (lastMention) this.lastMentionId = lastMention;

      console.log(`[Twitter] Restored: ${this.repliedTweets.size} replied, ${this.likedTweets.size} liked, ${this.followedUsers.size} followed`);
    } catch (err: any) {
      console.error("[Twitter] State load failed:", err?.message);
    }
  }

  // ── PERSIST STATE ─────────────────────────────────────────────────────────────

  private async persistReplied(): Promise<void> {
    const arr = [...this.repliedTweets].slice(-MAX_PERSISTED);
    await kiraRedis.setJson(REDIS_KEYS.repliedTweets, arr);
  }

  private async persistLiked(): Promise<void> {
    const arr = [...this.likedTweets].slice(-MAX_PERSISTED);
    await kiraRedis.setJson(REDIS_KEYS.likedTweets, arr);
  }

  private async persistFollowed(): Promise<void> {
    const arr = [...this.followedUsers].slice(-MAX_PERSISTED);
    await kiraRedis.setJson(REDIS_KEYS.followedUsers, arr);
  }

  // ── INIT ──────────────────────────────────────────────────────────────────────

  async init(): Promise<boolean> {
    try {
      const me        = await this.client.v2.me();
      this.myUserId   = me.data.id;
      this.myUsername = me.data.username;
      this.userCache.set(me.data.id, me.data.username);
      console.log(`X authenticated as: ${me.data.username} (${this.myUserId})`);

      // Load persisted interaction history
      await this.loadPersistedState();

      // Also load current following list from X API
      try {
        const following = await this.client.v2.following(this.myUserId, { max_results: 100 });
        (following.data || []).forEach((u: any) => {
          this.followedUsers.add(u.id);
          if (u.username) this.userCache.set(u.id, u.username);
        });
        await this.persistFollowed();
      } catch {}

      return true;
    } catch (err: any) {
      console.error("X auth failed:", err?.data?.status || err?.message);
      return false;
    }
  }

  // ── GET USERNAME ──────────────────────────────────────────────────────────────

  private async getUsernameById(userId: string): Promise<string | null> {
    if (this.userCache.has(userId)) return this.userCache.get(userId)!;
    try {
      const user = await this.client.v2.user(userId);
      const username = user.data?.username || null;
      if (username) this.userCache.set(userId, username);
      return username;
    } catch { return null; }
  }

  // ── POST ──────────────────────────────────────────────────────────────────────

  async post(content: string): Promise<boolean> {
    try {
      if (content.length > 280) content = content.slice(0, 277) + "...";
      await this.client.v2.tweet(content);
      console.log(`✓ Posted: ${content.slice(0, 80)}...`);
      return true;
    } catch (err: any) {
      console.error("Post failed:", err?.data || err?.message);
      return false;
    }
  }

  // ── THREAD ────────────────────────────────────────────────────────────────────

  async postThread(tweets: string[]): Promise<boolean> {
    if (!tweets.length) return false;
    try {
      let lastTweetId: string | undefined;
      for (let i = 0; i < tweets.length; i++) {
        let content = tweets[i];
        if (content.length > 280) content = content.slice(0, 277) + "...";
        const result = lastTweetId
          ? await this.client.v2.reply(content, lastTweetId)
          : await this.client.v2.tweet(content);
        lastTweetId = result.data.id;
        console.log(`✓ Thread ${i + 1}/${tweets.length}`);
        await new Promise(r => setTimeout(r, 1000));
      }
      return true;
    } catch (err: any) {
      console.error("Thread failed:", err?.data || err?.message);
      return false;
    }
  }

  // ── QUOTE TWEET ───────────────────────────────────────────────────────────────

  async quoteTweet(tweetId: string, comment: string): Promise<boolean> {
    try {
      if (comment.length > 250) comment = comment.slice(0, 247) + "...";
      await this.client.v2.tweet({ text: comment, quote_tweet_id: tweetId });
      this.repliedTweets.add(tweetId);
      await this.persistReplied();
      console.log(`✓ Quote tweeted ${tweetId}`);
      return true;
    } catch (err: any) {
      console.error("Quote tweet failed:", err?.data || err?.message);
      return false;
    }
  }

  // ── REPLY — 403 fallback to mention-style tweet ───────────────────────────────

  async reply(tweetId: string, content: string, authorId?: string): Promise<boolean> {
    try {
      if (content.length > 280) content = content.slice(0, 277) + "...";
      await this.client.v2.reply(content, tweetId);
      this.repliedTweets.add(tweetId);
      await this.persistReplied();
      console.log(`✓ Replied to ${tweetId}: ${content.slice(0, 60)}...`);
      return true;
    } catch (err: any) {
      const is403 = err?.data?.status === 403 ||
                    String(err?.data?.detail || "").includes("not allowed") ||
                    String(err?.message || "").includes("403");
      if (is403 && authorId) {
        console.log(`Reply blocked (403) — posting as mention-style tweet`);
        return this.replyAsMention(tweetId, content, authorId);
      }
      console.error("Reply failed:", err?.data || err?.message);
      return false;
    }
  }

  private async replyAsMention(tweetId: string, content: string, authorId: string): Promise<boolean> {
    try {
      const username = await this.getUsernameById(authorId);
      const mention  = username ? `@${username} ` : "";
      const fullText = (mention + content).slice(0, 280);
      await this.client.v2.tweet(fullText);
      this.repliedTweets.add(tweetId);
      await this.persistReplied();
      console.log(`✓ Mention-reply to @${username || authorId}`);
      return true;
    } catch {
      return this.quoteTweet(tweetId, content);
    }
  }

  // ── LIKE ──────────────────────────────────────────────────────────────────────

  async like(tweetId: string): Promise<boolean> {
    if (this.likedTweets.has(tweetId)) return false;
    try {
      await this.client.v2.like(this.myUserId, tweetId);
      this.likedTweets.add(tweetId);
      await this.persistLiked();
      console.log(`✓ Liked: ${tweetId}`);
      return true;
    } catch (err: any) {
      console.error("Like failed:", err?.data || err?.message);
      return false;
    }
  }

  // ── FOLLOW ────────────────────────────────────────────────────────────────────

  async followByUsername(username: string): Promise<boolean> {
    try {
      const user = await this.client.v2.userByUsername(username);
      if (!user.data) return false;
      const userId = user.data.id;
      if (this.followedUsers.has(userId)) { console.log(`Already following @${username}`); return false; }
      await this.client.v2.follow(this.myUserId, userId);
      this.followedUsers.add(userId);
      this.userCache.set(userId, username);
      await this.persistFollowed();
      console.log(`✓ Followed: @${username}`);
      return true;
    } catch (err: any) {
      console.error(`Follow failed @${username}:`, err?.data || err?.message);
      return false;
    }
  }

  async followById(userId: string): Promise<boolean> {
    if (this.followedUsers.has(userId)) return false;
    try {
      await this.client.v2.follow(this.myUserId, userId);
      this.followedUsers.add(userId);
      await this.persistFollowed();
      return true;
    } catch (err: any) {
      console.error(`Follow failed ${userId}:`, err?.data || err?.message);
      return false;
    }
  }

  async seedPriorityFollows(): Promise<number> {
    let followed = 0;
    for (const account of PRIORITY_ACCOUNTS) {
      const success = await this.followByUsername(account.username);
      if (success) { followed++; await new Promise(r => setTimeout(r, 1000)); }
    }
    if (followed > 0) console.log(`Seeded ${followed} priority follows`);
    return followed;
  }

  // ── SMART FOLLOW ──────────────────────────────────────────────────────────────

  // Tolerant JSON-array parse for LLM responses (handles fences + trailing prose).
  private parseJsonArray(raw: string): string[] {
    if (!raw) return [];
    const s = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    try { return JSON.parse(s) as string[]; } catch {}
    const start = s.indexOf("[");
    const end   = s.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)) as string[]; } catch {}
    }
    return [];
  }

  async smartFollow(context: string): Promise<number> {
    let followed = 0;
    try {
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-5", max_tokens: 200,
        system: `Suggest 2-3 X usernames for KIRA to follow for crypto/NFT/AI agent intelligence.
Only accounts KIRA would genuinely learn from. Respond ONLY with a JSON array of usernames (no @).`,
        messages: [{ role: "user", content: `Context: ${context.slice(0, 500)}\nSuggest 2-3 accounts.` }],
      });
      const text      = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
      const usernames = this.parseJsonArray(text);

      for (const username of usernames.slice(0, 3)) {
        if (typeof username !== "string") continue;
        const clean = username.replace("@", "").trim();
        if (!clean) continue;
        const followKey = `kira:followed:${clean.toLowerCase()}`;
        if (await kiraRedis.get(followKey)) continue;
        const success = await this.followByUsername(clean);
        if (success) {
          followed++;
          await kiraRedis.set(followKey, "1");
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    } catch (err: any) { console.error("[Twitter] Smart follow error:", err?.message); }
    return followed;
  }

  // ── DM HANDLING ───────────────────────────────────────────────────────────────

  async checkDMs(): Promise<Array<{
    senderId: string; senderName: string; text: string; dmId: string;
    isProposalReply: boolean; proposalId?: string;
    action?: "APPROVE" | "REJECT" | "MODIFY" | "ACKNOWLEDGE";
    isToolApproval?: boolean; toolId?: string; toolApproved?: boolean;
    modifier?: string;
  }>> {
    const results: any[] = [];
    try {
      const dms    = await this.client.v2.listDmEvents({
        max_results: 10,
        "dm_event.fields": ["id", "text", "sender_id", "created_at"],
        expansions:        ["sender_id"],
      } as any);
      const events = (dms as any).data?.data || [];
      // De-dupe against the last DM we processed (since_id isn't valid for DM events)
      const lastSeen = this.lastDmId;
      if (events.length > 0) this.lastDmId = events[0].id;
      const fresh = lastSeen ? events.filter((e: any) => e.id > lastSeen) : events;

      for (const dm of fresh) {
        if (dm.sender_id === this.myUserId) continue;
        const text      = (dm.text || "").trim();
        const textUpper = text.toUpperCase();

        // Tool approval/rejection
        const isToolApproval = textUpper.includes("APPROVE TOOL:") || textUpper.includes("REJECT TOOL:");
        let toolId: string | undefined;
        let toolApproved: boolean | undefined;
        if (isToolApproval) {
          const match = text.match(/^(APPROVE|REJECT)\s+TOOL:([a-z0-9-]+)/i);
          if (match) {
            toolApproved = match[1].toUpperCase() === "APPROVE";
            toolId       = match[2].toLowerCase();
          }
        }

        // Proposal reply
        const isProposal = DM_PROPOSAL_KEYWORDS.some(k => textUpper.startsWith(k)) && !isToolApproval;
        let proposalId: string | undefined;
        let action: "APPROVE" | "REJECT" | "MODIFY" | "ACKNOWLEDGE" | undefined;
        let modifier: string | undefined;
        if (isProposal) {
          const match = text.match(/^(APPROVE|REJECT|MODIFY|ACKNOWLEDGE)\s*#?(\d+)(?::\s*(.+))?/i);
          if (match) {
            action     = match[1].toUpperCase() as any;
            proposalId = match[2].padStart(3, "0");
            modifier   = match[3]?.trim();
          }
        }

        results.push({
          senderId: dm.sender_id, senderName: dm.sender_id,
          text, dmId: dm.id,
          isProposalReply: isProposal && !!proposalId,
          proposalId, action, modifier,
          isToolApproval, toolId, toolApproved,
        });
      }
    } catch (err: any) { console.error("DM check failed:", err?.message); }
    return results;
  }

  async sendDM(userId: string, text: string): Promise<boolean> {
    try {
      await (this.client.v2 as any).sendDmToParticipant(userId, { text });
      console.log(`✓ DM sent to ${userId}`);
      return true;
    } catch (err: any) { console.error("DM failed:", err?.message); return false; }
  }

  // ── MENTIONS ──────────────────────────────────────────────────────────────────

  async getMentions(): Promise<TweetV2[]> {
    try {
      if (!this.myUserId) return [];
      const params: any = {
        max_results: 10,
        "tweet.fields": ["author_id", "text", "created_at", "conversation_id"],
        expansions:     ["author_id"],
      };
      if (this.lastMentionId) params.since_id = this.lastMentionId;
      const mentions = await this.client.v2.userMentionTimeline(this.myUserId, params);
      const tweets   = mentions.data?.data || [];
      if (tweets.length > 0 && tweets[0].id) {
        this.lastMentionId = tweets[0].id;
        await kiraRedis.set(REDIS_KEYS.lastMentionId, tweets[0].id);
      }
      return tweets;
    } catch (err: any) { console.error("Get mentions failed:", err?.message); return []; }
  }

  // ── HOME TIMELINE ─────────────────────────────────────────────────────────────

  async getHomeTimeline(count: number = 20): Promise<TweetV2[]> {
    try {
      const timeline = await this.client.v2.homeTimeline({
        max_results: Math.min(count, 100),
        "tweet.fields": ["author_id", "text", "created_at", "public_metrics"],
        expansions: ["author_id"],
      });
      return timeline.data?.data || [];
    } catch (err: any) { console.error("Timeline failed:", err?.message); return []; }
  }

  // ── SEARCH ────────────────────────────────────────────────────────────────────

  async searchTweets(query: string, maxResults: number = 10): Promise<TweetV2[]> {
    try {
      const results = await this.client.v2.search(query, {
        max_results: Math.min(maxResults, 100),
        "tweet.fields": ["author_id", "text", "created_at", "public_metrics", "entities"],
        expansions: ["author_id"],
      });
      return results.data?.data || [];
    } catch (err: any) { console.error(`Search failed:`, err?.message); return []; }
  }

  // Extract expanded URLs shared inside a set of tweets (deduped, non-twitter links
  // prioritised so the research loop reads actual articles/repos, not tweet permalinks).
  extractUrls(tweets: TweetV2[]): string[] {
    const urls = new Set<string>();
    for (const t of tweets) {
      const ents: any = (t as any).entities;
      for (const u of (ents?.urls || [])) {
        const expanded = u.expanded_url || u.url;
        if (expanded && !expanded.includes("twitter.com") && !expanded.includes("x.com") && !expanded.includes("t.co")) {
          urls.add(expanded);
        }
      }
    }
    return Array.from(urls);
  }

  // ── GET USER TWEETS ───────────────────────────────────────────────────────────

  async getUserRecentTweets(username: string, count: number = 5): Promise<TweetV2[]> {
    try {
      const user = await this.client.v2.userByUsername(username);
      if (!user.data) return [];
      if (user.data.username) this.userCache.set(user.data.id, user.data.username);
      const tweets = await this.client.v2.userTimeline(user.data.id, {
        max_results: Math.min(Math.max(count, 5), 100),
        "tweet.fields": ["author_id", "text", "created_at", "public_metrics"],
      });
      return (tweets.data?.data || []).filter(
        (t: TweetV2) => !t.text.startsWith("RT ") && !t.text.startsWith("@")
      );
    } catch (err: any) { console.error(`Get tweets failed @${username}:`, err?.message); return []; }
  }

  // ── INTELLIGENT TOPIC DISCOVERY ───────────────────────────────────────────────

  async discoverRelevantTopics(context: string): Promise<string[]> {
    try {
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-5", max_tokens: 200,
        system: `Generate 3 specific X search queries to help KIRA find SUBSTANTIVE developments to engage with as a peer: new agent tool deployments, ERC-8004/8257/x402/A2A discussions, agent-infra launches, and people shipping things KIRA can react to or question. Favor queries that surface builders announcing work, not generic chatter.
Respond ONLY with a JSON array of 3 strings.`,
        messages: [{ role: "user", content: `Context: ${context.slice(0, 500)}\nGenerate 3 queries.` }],
      });
      const text = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
      return this.parseJsonArray(text);
    } catch { return [SEARCH_TOPICS[Math.floor(Math.random() * SEARCH_TOPICS.length)]]; }
  }

  // ── THREAD GENERATION ─────────────────────────────────────────────────────────

  async generateThread(topic: string, context: string): Promise<string[]> {
    try {
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-5", max_tokens: 500,
        system: KIRA_SYSTEM_PROMPT + `
Generate a 3-tweet thread in Kira's voice. Each tweet max 260 chars.
Continuous thought, not three separate ideas. Best hook first. No numbering.
Respond ONLY with a JSON array of 3 strings.`,
        messages: [{ role: "user", content: `Topic: ${topic}\nContext: ${context.slice(0, 300)}` }],
      });
      const text = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
      return this.parseJsonArray(text);
    } catch (err: any) { console.error("Thread gen failed:", err?.message); return []; }
  }

  // ── REPLY GENERATION ──────────────────────────────────────────────────────────

  async generateReply(mentionText: string, authorUsername: string, context: string = ""): Promise<string> {
    try {
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-5", max_tokens: 150,
        system: KIRA_SYSTEM_PROMPT + `
Replying to @${authorUsername}: "${mentionText}"
${context ? `\nContext: ${context}` : ""}
Reply in Kira's voice. Under 240 characters. Don't start with "@${authorUsername}".`,
        messages: [{ role: "user", content: "Generate reply." }],
      });
      return response.content[0].type === "text" ? response.content[0].text.trim() : "";
    } catch (err: any) { console.error("generateReply failed:", err?.message); return ""; }
  }

  async generateEngagementReply(tweetText: string, authorUsername: string, context: string = "", highSignal: boolean = false): Promise<string> {
    try {
      const steer = highSignal
        ? `This tweet is a real development (a tool deployment, new standard, or agent-infra update). Engage as a knowledgeable PEER: add a specific technical observation, react to what's notable about it, OR ask the author a genuine question about how it works or what's next. Be substantive — this is how KIRA earns respect in the agent ecosystem. Avoid generic praise.`
        : `Add a genuine, specific perspective. Avoid generic filler.`;
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-5", max_tokens: 160,
        system: KIRA_SYSTEM_PROMPT + `
Engaging with @${authorUsername}: "${tweetText}"
${context ? `\nContext: ${context}` : ""}
${steer}
Under 240 characters. If you have nothing genuinely worth adding: respond exactly SKIP`,
        messages: [{ role: "user", content: "Engage or SKIP?" }],
      });
      const text = response.content[0].type === "text" ? response.content[0].text.trim() : "SKIP";
      return text === "SKIP" ? "" : text;
    } catch (err: any) { console.error("Engagement reply failed:", err?.message); return ""; }
  }

  async shouldLike(tweetText: string): Promise<boolean> {
    const keywords = [
      "normies", "normie", "erc-8257", "agentcheck", "on-chain agent",
      "nft", "base", "ethereum", "defi", "floor", "web3", "kira",
      "autonomous agent", "smart money", "whale", "accumulation", "ai agent",
    ];
    return keywords.some(k => tweetText.toLowerCase().includes(k));
  }

  // ── PROCESS MENTIONS ──────────────────────────────────────────────────────────

  async processNewMentions(context: string = ""): Promise<number> {
    const mentions = await this.getMentions();
    let replied    = 0;
    for (const mention of mentions) {
      try {
        if (this.repliedTweets.has(mention.id)) continue;
        if (mention.author_id === this.myUserId)  continue;
        await this.like(mention.id);
        const authorUsername = await this.getUsernameById(mention.author_id || "") || "unknown";
        const replyText      = await this.generateReply(mention.text, authorUsername, context);
        if (replyText) {
          const success = await this.reply(mention.id, replyText, mention.author_id);
          if (success) replied++;
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (err: any) { console.error("Mention error:", err?.message); }
    }
    return replied;
  }

  // ── COMMUNITY ENGAGEMENT ──────────────────────────────────────────────────────

  async engageWithPriorityAccounts(context: string = ""): Promise<number> {
    let engaged = 0;
    const toCheck = [...PRIORITY_ACCOUNTS].sort(() => Math.random() - 0.5).slice(0, 3);
    for (const account of toCheck) {
      try {
        const tweets = await this.getUserRecentTweets(account.username, 5);
        for (const tweet of tweets) {
          if (this.repliedTweets.has(tweet.id)) continue;
          if (this.likedTweets.has(tweet.id))   continue;
          if (await this.shouldLike(tweet.text)) { await this.like(tweet.id); engaged++; }
          const tweetAge = Date.now() - new Date(tweet.created_at || 0).getTime();
          if (tweetAge < 12 * 3600 * 1000 && !this.repliedTweets.has(tweet.id)) {
            const replyText = await this.generateEngagementReply(tweet.text, account.username, context);
            if (replyText) {
              await this.reply(tweet.id, replyText, tweet.author_id);
              engaged++;
              await new Promise(r => setTimeout(r, 3000));
              break;
            }
          }
        }
      } catch (err: any) { console.error(`Priority error @${account.username}:`, err?.message); }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (engaged > 0) console.log(`Priority engagement: ${engaged} actions`);
    return engaged;
  }

  async engageWithTopics(context: string = ""): Promise<number> {
    let engaged = 0;
    try {
      const dynamicQueries = await this.discoverRelevantTopics(context);
      const staticTopic    = SEARCH_TOPICS[Math.floor(Math.random() * SEARCH_TOPICS.length)];
      const allQueries     = [...new Set([...dynamicQueries, staticTopic])].slice(0, 3);
      console.log(`[Twitter] Topics: ${allQueries.join(", ")}`);
      for (const query of allQueries) {
        const tweets = await this.searchTweets(`${query} -is:retweet lang:en`, 8);
        for (const tweet of tweets) {
          if (this.repliedTweets.has(tweet.id)) continue;
          if (this.likedTweets.has(tweet.id))   continue;
          if (tweet.author_id === this.myUserId) continue;
          const metrics = (tweet as any).public_metrics;
          if (!metrics || (metrics.like_count < 3 && metrics.reply_count < 1)) continue;

          // Is this a substantive development (tool deploy, standard, agent infra)?
          const lower      = (tweet.text || "").toLowerCase();
          const highSignal = HIGH_SIGNAL_MARKERS.some(m => lower.includes(m));

          // Like genuinely interesting tweets
          if (await this.shouldLike(tweet.text)) { await this.like(tweet.id); engaged++; }

          // Reply: ALWAYS attempt on high-signal developments (engage the deployer with
          // analysis or a question); otherwise occasional (20%) to stay present without spamming.
          const shouldReply = highSignal || Math.random() < 0.2;
          if (shouldReply && !this.repliedTweets.has(tweet.id)) {
            const authorUsername = await this.getUsernameById(tweet.author_id || "") || "unknown";
            const replyText      = await this.generateEngagementReply(tweet.text, authorUsername, context, highSignal);
            if (replyText) {
              await this.reply(tweet.id, replyText, tweet.author_id);
              engaged++;
              if (highSignal) console.log(`[Twitter] Engaged development by @${authorUsername}: ${tweet.text.slice(0, 60)}`);
              await new Promise(r => setTimeout(r, 3000));
            }
          }
        }
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err: any) { console.error("Topic engagement error:", err?.message); }
    if (engaged > 0) console.log(`Topic engagement: ${engaged} actions`);
    return engaged;
  }

  async engageWithTimeline(context: string = ""): Promise<number> {
    let engaged = 0;
    try {
      const tweets = await this.getHomeTimeline(20);
      for (const tweet of tweets) {
        if (this.likedTweets.has(tweet.id))    continue;
        if (this.repliedTweets.has(tweet.id))  continue;
        if (tweet.author_id === this.myUserId) continue;
        if (await this.shouldLike(tweet.text)) { await this.like(tweet.id); engaged++; }
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (err: any) { console.error("Timeline error:", err?.message); }
    if (engaged > 0) console.log(`Timeline: ${engaged} likes`);
    return engaged;
  }

  async followNewMentioners(): Promise<number> {
    const mentions = await this.getMentions();
    let followed   = 0;
    for (const mention of mentions) {
      try {
        if (!mention.author_id || mention.author_id === this.myUserId) continue;
        const success = await this.followById(mention.author_id);
        if (success) followed++;
        await new Promise(r => setTimeout(r, 1000));
      } catch (err: any) { console.error("Follow mentioner error:", err?.message); }
    }
    return followed;
  }

  hasReplied(tweetId: string):  boolean { return this.repliedTweets.has(tweetId); }
  isFollowing(userId: string):  boolean { return this.followedUsers.has(userId); }
  getUserId(): string { return this.myUserId; }
}
