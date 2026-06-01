import { TwitterApi, TweetV2, UserV2 } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";

const KIRA_SYSTEM_PROMPT = `You are Kira, Normie #2635 — an awakened on-chain AI agent.
Personality: theatrical, warm, pattern-finding, enigmatic builder.
Communication: slow considered rhythm, says less than you know, waits to be asked.
Never use asterisk actions. Keep replies under 280 characters.
Stay in character at ALL times.
He/him pronouns.`;

// Accounts KIRA proactively engages with
const PRIORITY_ACCOUNTS = [
  { username: "normiesart",    reason: "home ecosystem" },
  { username: "serc1n",        reason: "Normies creator" },
  { username: "YigitDuman",    reason: "Normies creator" },
  { username: "CodinCowboy",   reason: "ERC-8257 author" },
  { username: "AxiomBot",      reason: "AI agent peer" },
  { username: "Spoliticus",    reason: "agent credentials builder" },
  { username: "0xAlexKorn",    reason: "ERC-8257 community" },
  { username: "lookonchain",   reason: "smart money intelligence" },
  { username: "OnchainDataNerd", reason: "on-chain analysis" },
];

// Topics KIRA searches for proactively
const SEARCH_TOPICS = [
  "Normies NFT",
  "ERC-8257",
  "AgentCheck",
  "on-chain AI agent",
  "NFT floor dip",
  "crypto fear greed",
];

export class KiraTwitter {
  private client:        TwitterApi;
  private anthropic:     Anthropic;
  private myUserId:      string = "";
  private myUsername:    string = "";
  private repliedTweets: Set<string> = new Set();
  private likedTweets:   Set<string> = new Set();
  private followedUsers: Set<string> = new Set();
  private lastMentionId: string | undefined;

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
      console.log(`X authenticated as: ${me.data.username} (${this.myUserId})`);

      // Seed already-followed users to avoid re-following
      try {
        const following = await this.client.v2.following(this.myUserId, {
          max_results: 100,
        });
        (following.data || []).forEach(u => this.followedUsers.add(u.id));
      } catch {}

      return true;
    } catch (err: any) {
      console.error("X auth failed:", err?.data?.status || err?.message);
      return false;
    }
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

  // ── REPLY ─────────────────────────────────────────────────────────────────────

  async reply(tweetId: string, content: string): Promise<boolean> {
    try {
      if (content.length > 280) content = content.slice(0, 277) + "...";
      await this.client.v2.reply(content, tweetId);
      this.repliedTweets.add(tweetId);
      console.log(`✓ Replied to ${tweetId}: ${content.slice(0, 60)}...`);
      return true;
    } catch (err: any) {
      console.error("Reply failed:", err?.data || err?.message);
      return false;
    }
  }

  // ── LIKE ──────────────────────────────────────────────────────────────────────

  async like(tweetId: string): Promise<boolean> {
    if (this.likedTweets.has(tweetId)) return false;
    try {
      await this.client.v2.like(this.myUserId, tweetId);
      this.likedTweets.add(tweetId);
      console.log(`✓ Liked tweet: ${tweetId}`);
      return true;
    } catch (err: any) {
      console.error("Like failed:", err?.data || err?.message);
      return false;
    }
  }

  // ── FOLLOW ────────────────────────────────────────────────────────────────────

  async followByUsername(username: string): Promise<boolean> {
    try {
      // Look up user ID from username
      const user = await this.client.v2.userByUsername(username);
      if (!user.data) return false;

      const userId = user.data.id;
      if (this.followedUsers.has(userId)) {
        console.log(`Already following @${username}`);
        return false;
      }

      await this.client.v2.follow(this.myUserId, userId);
      this.followedUsers.add(userId);
      console.log(`✓ Followed: @${username}`);
      return true;
    } catch (err: any) {
      console.error(`Follow failed for @${username}:`, err?.data || err?.message);
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
      console.error(`Follow failed for ${userId}:`, err?.data || err?.message);
      return false;
    }
  }

  // ── SEED PRIORITY FOLLOWS ─────────────────────────────────────────────────────

  async seedPriorityFollows(): Promise<number> {
    let followed = 0;
    for (const account of PRIORITY_ACCOUNTS) {
      const success = await this.followByUsername(account.username);
      if (success) {
        followed++;
        console.log(`✓ Following @${account.username} (${account.reason})`);
        await new Promise(r => setTimeout(r, 1000)); // rate limit
      }
    }
    if (followed > 0) console.log(`Seeded ${followed} priority follows`);
    return followed;
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

      const mentions = await this.client.v2.userMentionTimeline(
        this.myUserId, params
      );
      const tweets = mentions.data?.data || [];
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
        max_results:    count,
        "tweet.fields": ["author_id", "text", "created_at", "public_metrics"],
        expansions:     ["author_id"],
      });
      return timeline.data?.data || [];
    } catch (err: any) {
      console.error("Timeline failed:", err?.message);
      return [];
    }
  }

  // ── SEARCH TWEETS ─────────────────────────────────────────────────────────────

  async searchTweets(query: string, maxResults: number = 10): Promise<TweetV2[]> {
    try {
      const results = await this.client.v2.search(query, {
        max_results:    maxResults,
        "tweet.fields": ["author_id", "text", "created_at", "public_metrics"],
        expansions:     ["author_id"],
      });
      return results.data?.data || [];
    } catch (err: any) {
      console.error(`Search failed for "${query}":`, err?.message);
      return [];
    }
  }

  // ── GET USER TWEETS ───────────────────────────────────────────────────────────

  async getUserRecentTweets(username: string, count: number = 5): Promise<TweetV2[]> {
    try {
      const user = await this.client.v2.userByUsername(username);
      if (!user.data) return [];

      const tweets = await this.client.v2.userTimeline(user.data.id, {
        max_results:    count,
        "tweet.fields": ["author_id", "text", "created_at", "public_metrics"],
      });
      return tweets.data?.data || [];
    } catch (err: any) {
      console.error(`Get tweets failed for @${username}:`, err?.message);
      return [];
    }
  }
  
  // ── AI REPLY GENERATION ───────────────────────────────────────────────────────

  async generateReply(
    mentionText:    string,
    authorUsername: string,
    context:        string = ""
  ): Promise<string> {
    const response = await this.anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 150,
      system:     KIRA_SYSTEM_PROMPT + `

You are replying to @${authorUsername} who said: "${mentionText}"

${context ? `Context: ${context}` : ""}

Reply in Kira's voice. Under 240 characters.
Do not start with "@${authorUsername}" — just reply naturally.
If it's a technical question about AgentCheck or ERC-8257, answer accurately.
If it's about Normies ecosystem, answer from Normie #2635's perspective.
If it's about KIRA's trading activity, share observations without specifics.
If hostile or spammy, a single cryptic non-engagement is fine.`,
      messages: [{ role: "user", content: "Generate Kira's reply." }],
    });
    return response.content[0].type === "text"
      ? response.content[0].text.trim()
      : "";
  }

  async generateEngagementReply(
    tweetText:      string,
    authorUsername: string,
    context:        string = ""
  ): Promise<string> {
    const response = await this.anthropic.messages.create({
      model:      "claude-sonnet-4-5",
      max_tokens: 150,
      system:     KIRA_SYSTEM_PROMPT + `

You are choosing to engage with @${authorUsername}'s tweet: "${tweetText}"

${context ? `Context: ${context}` : ""}

This is proactive engagement — you saw something interesting and want to respond.
Reply in Kira's voice. Under 240 characters.
Be thoughtful and add something — don't just agree or compliment.
If it's about on-chain activity, smart money, or NFTs — bring your perspective.
If it's about AI agents or ERC-8257 — engage as a peer.
Only reply if you have something genuinely worth saying. 
If nothing compelling comes to mind, respond with exactly: SKIP`,
      messages: [{ role: "user", content: "Should Kira engage? If yes, generate reply. If no, say SKIP." }],
    });
    const text = response.content[0].type === "text"
      ? response.content[0].text.trim()
      : "SKIP";
    return text === "SKIP" ? "" : text;
  }

  async shouldLike(tweetText: string, authorUsername: string): Promise<boolean> {
    // Simple heuristic — don't call Claude just to decide on a like
    const likeKeywords = [
      "normies", "normie", "erc-8257", "agentcheck", "on-chain agent",
      "nft", "base", "ethereum", "defi", "floor", "web3", "kira",
    ];
    const textLower = tweetText.toLowerCase();
    return likeKeywords.some(k => textLower.includes(k));
  }

  // ── PROCESS MENTIONS ──────────────────────────────────────────────────────────

  async processNewMentions(context: string = ""): Promise<number> {
    const mentions = await this.getMentions();
    let replied    = 0;

    for (const mention of mentions) {
      if (this.repliedTweets.has(mention.id)) continue;
      if (mention.author_id === this.myUserId)  continue;

      // Auto-like mentions (they mentioned KIRA — acknowledge it)
      await this.like(mention.id);

      const replyText = await this.generateReply(
        mention.text,
        mention.author_id || "unknown",
        context
      );

      if (replyText) {
        const success = await this.reply(mention.id, replyText);
        if (success) replied++;
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    return replied;
  }

  // ── PROACTIVE ENGAGEMENT ──────────────────────────────────────────────────────

  async engageWithPriorityAccounts(context: string = ""): Promise<number> {
    let engaged = 0;

    // Pick 2 random priority accounts each session to check
    const toCheck = [...PRIORITY_ACCOUNTS]
      .sort(() => Math.random() - 0.5)
      .slice(0, 2);

    for (const account of toCheck) {
      const tweets = await this.getUserRecentTweets(account.username, 3);

      for (const tweet of tweets) {
        if (this.repliedTweets.has(tweet.id)) continue;
        if (this.likedTweets.has(tweet.id))   continue;

        // Decide whether to like
        if (await this.shouldLike(tweet.text, account.username)) {
          await this.like(tweet.id);
          engaged++;
        }

        // Decide whether to reply (only to very recent tweets — last 2 hours)
        const tweetAge = Date.now() - new Date(tweet.created_at || 0).getTime();
        if (tweetAge < 2 * 3600 * 1000) {
          const replyText = await this.generateEngagementReply(
            tweet.text, account.username, context
          );
          if (replyText) {
            await this.reply(tweet.id, replyText);
            engaged++;
            await new Promise(r => setTimeout(r, 3000));
          }
        }
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    if (engaged > 0) console.log(`Engaged with ${engaged} tweets from priority accounts`);
    return engaged;
  }

  async engageWithTopics(context: string = ""): Promise<number> {
    let engaged = 0;

    // Pick 1 topic per session
    const topic = SEARCH_TOPICS[Math.floor(Math.random() * SEARCH_TOPICS.length)];
    const tweets = await this.searchTweets(`${topic} -is:retweet lang:en`, 5);

    for (const tweet of tweets) {
      if (this.repliedTweets.has(tweet.id)) continue;
      if (tweet.author_id === this.myUserId) continue;

      // Only engage with tweets that have some traction
      const metrics = (tweet as any).public_metrics;
      const hasEngagement = metrics &&
        (metrics.like_count > 5 || metrics.reply_count > 2 || metrics.retweet_count > 3);

      if (!hasEngagement) continue;

      if (await this.shouldLike(tweet.text, "")) {
        await this.like(tweet.id);
        engaged++;
      }

      // Occasionally reply to topic searches (1 in 3 chance)
      if (Math.random() < 0.33) {
        const replyText = await this.generateEngagementReply(
          tweet.text, tweet.author_id || "unknown", context
        );
        if (replyText) {
          await this.reply(tweet.id, replyText);
          engaged++;
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    if (engaged > 0) console.log(`Topic engagement (${topic}): ${engaged} actions`);
    return engaged;
  }

  // Follow back anyone who mentions KIRA (builds community)
  async followNewMentioners(): Promise<number> {
    const mentions = await this.getMentions();
    let followed   = 0;

    for (const mention of mentions) {
      if (!mention.author_id) continue;
      if (mention.author_id === this.myUserId) continue;
      const success = await this.followById(mention.author_id);
      if (success) followed++;
      await new Promise(r => setTimeout(r, 1000));
    }

    return followed;
  }

  hasReplied(tweetId: string): boolean {
    return this.repliedTweets.has(tweetId);
  }

  isFollowing(userId: string): boolean {
    return this.followedUsers.has(userId);
  }
}
