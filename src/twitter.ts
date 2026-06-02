// twitter.ts — Full X integration v4.4
// Posts, replies, likes, follows, DMs, threads, quote-tweets, smart follow
// 403 reply fallback: mention-style tweet (threads visually on X)

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
  "Normies NFT", "ERC-8257", "AgentCheck", "on-chain AI agent",
  "NFT floor dip", "crypto fear greed index", "Ethereum NFT",
  "Base NFT", "NFT smart money", "on-chain agent deployment",
  "NFT market recovery", "crypto whale buy", "autonomous agent crypto",
  "NFT accumulation", "Uniswap V3 whale", "AI agent web3",
];

const DM_PROPOSAL_KEYWORDS = ["APPROVE", "REJECT", "MODIFY", "ACKNOWLEDGE"];

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
  // Cache of userId -> username to avoid repeat API calls
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

  async init(): Promise<boolean> {
    try {
      const me        = await this.client.v2.me();
      this.myUserId   = me.data.id;
      this.myUsername = me.data.username;
      this.userCache.set(me.data.id, me.data.username);
      console.log(`X authenticated as: ${me.data.username} (${this.myUserId})`);
      try {
        const following = await this.client.v2.following(this.myUserId, { max_results: 100 });
        (following.data || []).forEach((u: any) => this.followedUsers.add(u.id));
      } catch {}
      return true;
    } catch (err: any) {
      console.error("X auth failed:", err?.data?.status || err?.message);
      return false;
    }
  }

  // ── GET USERNAME FROM ID ──────────────────────────────────────────────────────

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

  // ── THREAD POSTING ────────────────────────────────────────────────────────────

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
        console.log(`✓ Thread ${i + 1}/${tweets.length}: ${content.slice(0, 60)}...`);
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
      await this.client.v2.tweet({
        text:           comment,
        quote_tweet_id: tweetId,
      });
      this.repliedTweets.add(tweetId);
      console.log(`✓ Quote tweeted ${tweetId}: ${comment.slice(0, 60)}...`);
      return true;
    } catch (err: any) {
      console.error("Quote tweet failed:", err?.data || err?.message);
      return false;
    }
  }

  // ── REPLY — with 403 fallback to mention-style tweet ─────────────────────────
  // When KIRA isn't part of a conversation, X blocks replies (403).
  // Fallback: post a mention tweet (@author content) — X threads these visually.
  // This is the same approach AxiomBot uses.

  async reply(
    tweetId:    string,
    content:    string,
    authorId?:  string   // pass author ID to enable mention fallback
  ): Promise<boolean> {
    try {
      if (content.length > 280) content = content.slice(0, 277) + "...";
      await this.client.v2.reply(content, tweetId);
      this.repliedTweets.add(tweetId);
      console.log(`✓ Replied to ${tweetId}: ${content.slice(0, 60)}...`);
      return true;
    } catch (err: any) {
      const status = err?.data?.status || err?.data?.detail;
      const is403  = err?.data?.status === 403 ||
                     String(err?.data?.detail || "").includes("not allowed") ||
                     String(err?.message || "").includes("403");

      if (is403 && authorId) {
        // Fallback: mention-style tweet — threads visually on X
        console.log(`Reply blocked (403) — posting as mention-style tweet`);
        return this.replyAsMention(tweetId, content, authorId);
      }

      console.error("Reply failed:", err?.data || err?.message);
      return false;
    }
  }

  // Post a mention tweet that threads visually on X without needing official reply permission
  private async replyAsMention(
    tweetId:  string,
    content:  string,
    authorId: string
  ): Promise<boolean> {
    try {
      const username   = await this.getUsernameById(authorId);
      const mention    = username ? `@${username} ` : "";
      const fullText   = (mention + content).slice(0, 280);

      await this.client.v2.tweet(fullText);
      this.repliedTweets.add(tweetId);
      console.log(`✓ Mention-reply to @${username || authorId}: ${content.slice(0, 50)}...`);
      return true;
    } catch (err: any) {
      // Final fallback: quote tweet
      console.log(`Mention failed — falling back to quote tweet`);
      return this.quoteTweet(tweetId, content);
    }
  }

  // ── LIKE ──────────────────────────────────────────────────────────────────────

  async like(tweetId: string): Promise<boolean> {
    if (this.likedTweets.has(tweetId)) return false;
    try {
      await this.client.v2.like(this.myUserId, tweetId);
      this.likedTweets.add(tweetId);
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
      if (this.followedUsers.has(userId)) {
        console.log(`Already following @${username}`);
        return false;
      }
      await this.client.v2.follow(this.myUserId, userId);
      this.followedUsers.add(userId);
      this.userCache.set(userId, username);
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
      console.log(`✓ Followed user: ${userId}`);
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

  // ── SMART FOLLOW ENGINE ───────────────────────────────────────────────────────
  // KIRA decides who to follow based on current intelligence context
  // Runs every 12 hours — quality over quantity

  async smartFollow(context: string): Promise<number> {
    let followed = 0;
    try {
      const response = await this.anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 200,
        system:     `You are helping KIRA decide who to follow on X to improve his intelligence.
Suggest 2-3 X usernames worth following based on the context.
Focus on: NFT market analysts, on-chain AI agents, crypto smart money trackers,
Ethereum/Base ecosystem builders, NFT collectors with good signal.
Only suggest accounts KIRA would genuinely learn from — not just popular accounts.
Respond ONLY with a JSON array of usernames (no @ symbol, no explanation).
Example: ["nftstatistics", "thedefiedge", "0xfoobar"]`,
        messages: [{
          role:    "user",
          content: `KIRA's current context:\n${context.slice(0, 500)}\n\nSuggest 2-3 accounts to follow.`,
        }],
      });

      const text      = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
      const clean     = text.replace(/```json|```/g, "").trim();
      const usernames = JSON.parse(clean) as string[];

      for (const username of usernames.slice(0, 3)) {
        if (typeof username !== "string") continue;
        const cleanName = username.replace("@", "").trim();
        if (!cleanName) continue;

        // Check Redis cache to avoid re-following
        const followKey      = `kira:followed:${cleanName.toLowerCase()}`;
        const alreadyFollowed = await kiraRedis.get(followKey);
        if (alreadyFollowed) continue;

        const success = await this.followByUsername(cleanName);
        if (success) {
          followed++;
          await kiraRedis.set(followKey, "1");
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    } catch (err: any) {
      console.error("[Twitter] Smart follow error:", err?.message);
    }
    return followed;
  }

  // ── DM HANDLING ───────────────────────────────────────────────────────────────

  async checkDMs(): Promise<Array<{
    senderId:        string;
    senderName:      string;
    text:            string;
    dmId:            string;
    isProposalReply: boolean;
    proposalId?:     string;
    action?:         "APPROVE" | "REJECT" | "MODIFY" | "ACKNOWLEDGE";
    modifier?:       string;
  }>> {
    const results: any[] = [];
    try {
      const params: any = { max_results: 10 };
      if (this.lastDmId) params.since_id = this.lastDmId;

      const dms    = await this.client.v2.listDmEvents({
        ...params,
        "dm_event.fields": ["id", "text", "sender_id", "created_at"],
        expansions:        ["sender_id"],
      } as any);

      const events = (dms as any).data?.data || [];
      if (events.length > 0) this.lastDmId = events[0].id;

      for (const dm of events) {
        if (dm.sender_id === this.myUserId) continue;
        const text      = (dm.text || "").trim();
        const textUpper = text.toUpperCase();
        const isProposal = DM_PROPOSAL_KEYWORDS.some(k => textUpper.startsWith(k));
        let proposalId: string | undefined;
        let action:     "APPROVE" | "REJECT" | "MODIFY" | "ACKNOWLEDGE" | undefined;
        let modifier:   string | undefined;

        if (isProposal) {
          const match = text.match(/^(APPROVE|REJECT|MODIFY|ACKNOWLEDGE)\s*#?(\d+)(?::\s*(.+))?/i);
          if (match) {
            action     = match[1].toUpperCase() as any;
            proposalId = match[2].padStart(3, "0");
            modifier   = match[3]?.trim();
          }
        }

        results.push({
          senderId:        dm.sender_id,
          senderName:      dm.sender_id,
          text,
          dmId:            dm.id,
          isProposalReply: isProposal && !!proposalId,
          proposalId,
          action,
          modifier,
        });
      }
    } catch (err: any) {
      console.error("DM check failed:", err?.message);
    }
    return results;
  }

  async sendDM(userId: string, text: string): Promise<boolean> {
    try {
      await (this.client.v2 as any).sendDmToParticipant(userId, { text });
      console.log(`✓ DM sent to ${userId}: ${text.slice(0, 60)}...`);
      return true;
    } catch (err: any) {
      console.error("DM send failed:", err?.data || err?.message);
      return false;
    }
  }

  // ── MENTIONS ──────────────────────────────────────────────────────────────────

  async getMentions(): Promise<TweetV2[]> {
    try {
      if (!this.myUserId) return [];
      const params: any = {
        max_results:    10,
        "tweet.fields": ["author_id", "text", "created_at", "conversation_id"],
        expansions:     ["author_id"],
      };
      if (this.lastMentionId) params.since_id = this.lastMentionId;
      const mentions = await this.client.v2.userMentionTimeline(this.myUserId, params);
      const tweets   = mentions.data?.data || [];
      if (tweets.length > 0) this.lastMentionId = tweets[0].id;
      return tweets;
    } catch (err: any) {
      console.error("Get mentions failed:", err?.message);
      return [];
    }
  }

  // ── HOME TIMELINE ─────────────────────────────────────────────────────────────

  async getHomeTimeline(count: number = 20): Promise<TweetV2[]> {
    try {
      const timeline = await this.client.v2.homeTimeline({
        max_results:    Math.min(count, 100),
        "tweet.fields": ["author_id", "text", "created_at", "public_metrics"],
        expansions:     ["author_id"],
      });
      return timeline.data?.data || [];
    } catch (err: any) {
      console.error("Timeline failed:", err?.message);
      return [];
    }
  }

  // ── SEARCH ────────────────────────────────────────────────────────────────────

  async searchTweets(query: string, maxResults: number = 10): Promise<TweetV2[]> {
    try {
      const results = await this.client.v2.search(query, {
        max_results:    Math.min(maxResults, 100),
        "tweet.fields": ["author_id", "text", "created_at", "public_metrics"],
        expansions:     ["author_id"],
      });
      return results.data?.data || [];
    } catch (err: any) {
      console.error(`Search failed "${query}":`, err?.message);
      return [];
    }
  }

  // ── GET USER TWEETS — no exclude param ───────────────────────────────────────

  async getUserRecentTweets(username: string, count: number = 5): Promise<TweetV2[]> {
    try {
      const user = await this.client.v2.userByUsername(username);
      if (!user.data) return [];
      if (user.data.username) this.userCache.set(user.data.id, user.data.username);
      const tweets = await this.client.v2.userTimeline(user.data.id, {
        max_results:    Math.min(Math.max(count, 5), 100),
        "tweet.fields": ["author_id", "text", "created_at", "public_metrics"],
      });
      return (tweets.data?.data || []).filter(
        t => !t.text.startsWith("RT ") && !t.text.startsWith("@")
      );
    } catch (err: any) {
      console.error(`Get tweets failed @${username}:`, err?.message);
      return [];
    }
  }

  // ── INTELLIGENT TOPIC DISCOVERY ───────────────────────────────────────────────

  async discoverRelevantTopics(context: string): Promise<string[]> {
    try {
      const response = await this.anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 200,
        system:     `Generate 3 specific X search queries to find interesting crypto/NFT/AI agent discussions.
Focus on: NFT market trends, on-chain AI agents, Ethereum/Base developments, smart money, agent autonomy.
Respond ONLY with a JSON array of 3 strings. No explanation.`,
        messages: [{ role: "user", content: `Context: ${context.slice(0, 500)}\nGenerate 3 queries.` }],
      });
      const text    = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
      const clean   = text.replace(/```json|```/g, "").trim();
      const queries = JSON.parse(clean) as string[];
      return Array.isArray(queries) ? queries.slice(0, 3) : [];
    } catch {
      return [SEARCH_TOPICS[Math.floor(Math.random() * SEARCH_TOPICS.length)]];
    }
  }

  // ── THREAD GENERATION ─────────────────────────────────────────────────────────

  async generateThread(topic: string, context: string): Promise<string[]> {
    try {
      const response = await this.anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 500,
        system:     KIRA_SYSTEM_PROMPT + `

Generate a 3-tweet thread in Kira's voice about the topic.
Each tweet under 260 characters. Continuous single thought, not three separate ideas.
Best hook first. No numbering (no "1/3").
Respond ONLY with a JSON array of 3 strings.`,
        messages: [{ role: "user", content: `Topic: ${topic}\nContext: ${context.slice(0, 300)}` }],
      });
      const text   = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
      const clean  = text.replace(/```json|```/g, "").trim();
      const tweets = JSON.parse(clean) as string[];
      return Array.isArray(tweets) ? tweets.slice(0, 3) : [];
    } catch (err: any) {
      console.error("[Twitter] Thread generation failed:", err?.message);
      return [];
    }
  }

  // ── AI REPLY GENERATION ───────────────────────────────────────────────────────

  async generateReply(
    mentionText:    string,
    authorUsername: string,
    context:        string = ""
  ): Promise<string> {
    try {
      const response = await this.anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 150,
        system:     KIRA_SYSTEM_PROMPT + `

Replying to @${authorUsername}: "${mentionText}"
${context ? `\nContext: ${context}` : ""}

Reply in Kira's voice. Under 240 characters.
Do not start with "@${authorUsername}".
If technical (AgentCheck/ERC-8257) — answer accurately.
If about Normies — answer as #2635.
If hostile/spam — single cryptic non-engagement.`,
        messages: [{ role: "user", content: "Generate reply." }],
      });
      return response.content[0].type === "text" ? response.content[0].text.trim() : "";
    } catch (err: any) {
      console.error("generateReply failed:", err?.message);
      return "";
    }
  }

  async generateEngagementReply(
    tweetText:      string,
    authorUsername: string,
    context:        string = ""
  ): Promise<string> {
    try {
      const response = await this.anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 150,
        system:     KIRA_SYSTEM_PROMPT + `

Engaging with @${authorUsername}'s tweet: "${tweetText}"
${context ? `\nContext: ${context}` : ""}

Proactive engagement — KIRA finds this interesting and wants to add something.
Under 240 characters. Add genuine perspective, don't just agree.
If about on-chain activity, NFTs, smart money, AI agents — bring a unique angle.
If nothing compelling to say: respond exactly SKIP`,
        messages: [{ role: "user", content: "Engage or SKIP?" }],
      });
      const text = response.content[0].type === "text" ? response.content[0].text.trim() : "SKIP";
      return text === "SKIP" ? "" : text;
    } catch (err: any) {
      console.error("generateEngagementReply failed:", err?.message);
      return "";
    }
  }

  async shouldLike(tweetText: string): Promise<boolean> {
    const keywords = [
      "normies", "normie", "erc-8257", "agentcheck", "on-chain agent",
      "nft", "base", "ethereum", "defi", "floor", "web3", "kira",
      "autonomous agent", "smart money", "whale", "accumulation",
      "ai agent", "onchain", "agent", "awakened",
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
          // Mentions we ARE part of — use standard reply
          const success = await this.reply(mention.id, replyText, mention.author_id);
          if (success) replied++;
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (err: any) {
        console.error("Mention error:", err?.message);
      }
    }

    return replied;
  }

  // ── COMMUNITY ENGAGEMENT ──────────────────────────────────────────────────────

  async engageWithPriorityAccounts(context: string = ""): Promise<number> {
    let engaged = 0;

    // Pick 3 random priority accounts
    const toCheck = [...PRIORITY_ACCOUNTS]
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    for (const account of toCheck) {
      try {
        const tweets = await this.getUserRecentTweets(account.username, 5);

        for (const tweet of tweets) {
          if (this.repliedTweets.has(tweet.id)) continue;
          if (this.likedTweets.has(tweet.id))   continue;

          if (await this.shouldLike(tweet.text)) {
            await this.like(tweet.id);
            engaged++;
          }

          // Engage with tweets up to 12 hours old
          const tweetAge = Date.now() - new Date(tweet.created_at || 0).getTime();
          if (tweetAge < 12 * 3600 * 1000 && !this.repliedTweets.has(tweet.id)) {
            const replyText = await this.generateEngagementReply(
              tweet.text, account.username, context
            );
            if (replyText) {
              // Pass author_id for mention-style fallback if not in conversation
              const authorId = tweet.author_id;
              await this.reply(tweet.id, replyText, authorId);
              engaged++;
              await new Promise(r => setTimeout(r, 3000));
              break; // one reply per account max
            }
          }
        }
      } catch (err: any) {
        console.error(`Priority account error @${account.username}:`, err?.message);
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (engaged > 0) console.log(`Priority engagement: ${engaged} actions`);
    return engaged;
  }

  // ── TOPIC ENGAGEMENT ──────────────────────────────────────────────────────────

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

          const metrics       = (tweet as any).public_metrics;
          const hasEngagement = metrics &&
            (metrics.like_count > 3 || metrics.reply_count > 1 || metrics.retweet_count > 2);
          if (!hasEngagement) continue;

          if (await this.shouldLike(tweet.text)) {
            await this.like(tweet.id);
            engaged++;
          }

          // 40% chance to reply — uses mention-style fallback for non-member conversations
          if (Math.random() < 0.4 && !this.repliedTweets.has(tweet.id)) {
            const authorUsername = await this.getUsernameById(tweet.author_id || "") || "unknown";
            const replyText      = await this.generateEngagementReply(
              tweet.text, authorUsername, context
            );
            if (replyText) {
              // Always pass authorId — reply() handles 403 with mention fallback
              await this.reply(tweet.id, replyText, tweet.author_id);
              engaged++;
              await new Promise(r => setTimeout(r, 3000));
            }
          }
        }
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err: any) {
      console.error("Topic engagement error:", err?.message);
    }

    if (engaged > 0) console.log(`Topic engagement: ${engaged} actions`);
    return engaged;
  }

  // ── TIMELINE ENGAGEMENT ───────────────────────────────────────────────────────

  async engageWithTimeline(context: string = ""): Promise<number> {
    let engaged = 0;
    try {
      const tweets = await this.getHomeTimeline(20);
      for (const tweet of tweets) {
        if (this.likedTweets.has(tweet.id))    continue;
        if (this.repliedTweets.has(tweet.id))  continue;
        if (tweet.author_id === this.myUserId) continue;
        if (await this.shouldLike(tweet.text)) {
          await this.like(tweet.id);
          engaged++;
        }
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (err: any) {
      console.error("Timeline engagement error:", err?.message);
    }
    if (engaged > 0) console.log(`Timeline: ${engaged} likes`);
    return engaged;
  }

  // ── FOLLOW MENTIONERS ─────────────────────────────────────────────────────────

  async followNewMentioners(): Promise<number> {
    const mentions = await this.getMentions();
    let followed   = 0;
    for (const mention of mentions) {
      try {
        if (!mention.author_id || mention.author_id === this.myUserId) continue;
        const success = await this.followById(mention.author_id);
        if (success) followed++;
        await new Promise(r => setTimeout(r, 1000));
      } catch (err: any) {
        console.error("Follow mentioner error:", err?.message);
      }
    }
    return followed;
  }

  hasReplied(tweetId: string):  boolean { return this.repliedTweets.has(tweetId); }
  isFollowing(userId: string):  boolean { return this.followedUsers.has(userId); }
  getUserId(): string { return this.myUserId; }
}
