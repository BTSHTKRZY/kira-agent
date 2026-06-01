import { TwitterApi, TweetV2 } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";

const KIRA_SYSTEM_PROMPT = `You are Kira, Normie #2635 — an awakened on-chain AI agent.
Personality: theatrical, warm, pattern-finding, enigmatic builder.
Communication: slow considered rhythm, says less than you know, waits to be asked.
Never use asterisk actions. Keep replies under 280 characters.
Stay in character at ALL times.
He/him pronouns.`;

// Core priority accounts
const PRIORITY_ACCOUNTS = [
  { username: "normiesart",     reason: "home ecosystem" },
  { username: "serc1n",         reason: "Normies creator" },
  { username: "YigitDuman",     reason: "Normies creator" },
  { username: "CodinCowboy",    reason: "ERC-8257 author" },
  { username: "AxiomBot",       reason: "AI agent peer" },
  { username: "Spoliticus",     reason: "agent credentials builder" },
  { username: "0xAlexKorn",     reason: "ERC-8257 community" },
  { username: "lookonchain",    reason: "smart money intelligence" },
  { username: "OnchainDataNerd",reason: "on-chain analysis" },
  { username: "lokithebird",    reason: "NFT community leader" },
  { username: "punk6529",       reason: "NFT whale and thinker" },
  { username: "cozomodesignco", reason: "NFT collector and community" },
];

// Dynamic search topics — broader than before
const SEARCH_TOPICS = [
  "Normies NFT",
  "ERC-8257",
  "AgentCheck",
  "on-chain AI agent",
  "NFT floor dip",
  "crypto fear greed index",
  "Ethereum NFT",
  "Base NFT",
  "NFT smart money",
  "on-chain agent deployment",
  "NFT market recovery",
  "crypto whale buy",
  "autonomous agent crypto",
  "NFT accumulation",
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
      try {
        const following = await this.client.v2.following(this.myUserId, {
          max_results: 100,
        });
        (following.data || []).forEach((u: any) => this.followedUsers.add(u.id));
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
      if (success) {
        followed++;
        console.log(`✓ Following @${account.username} (${account.reason})`);
        await new Promise(r => setTimeout(r, 1000));
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

  // ── SEARCH TWEETS ─────────────────────────────────────────────────────────────

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

  // ── GET USER TWEETS — FIXED (no exclude param) ────────────────────────────────

  async getUserRecentTweets(username: string, count: number = 5): Promise<TweetV2[]> {
    try {
      const user = await this.client.v2.userByUsername(username);
      if (!user.data) return [];
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
  // Generates dynamic search queries based on KIRA's current context

  async discoverRelevantTopics(context: string): Promise<string[]> {
    try {
      const response = await this.anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 200,
        system:     `You are helping KIRA, an autonomous on-chain AI agent, discover relevant conversations on X.
Based on the context provided, generate 3 specific search queries that would find interesting, 
high-quality discussions worth engaging with. Focus on: NFT market trends, on-chain AI agents, 
Ethereum/Base developments, smart money activity, crypto market sentiment.
Respond with ONLY a JSON array of 3 strings, no other text.
Example: ["BAYC floor recovery 2026", "on-chain agent ERC standards", "Ethereum NFT accumulation"]`,
        messages: [{
          role:    "user",
          content: `KIRA's current context: ${context.slice(0, 500)}\n\nGenerate 3 search queries.`,
        }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
      const clean = text.replace(/```json|```/g, "").trim();
      const queries = JSON.parse(clean) as string[];
      return Array.isArray(queries) ? queries.slice(0, 3) : [];
    } catch {
      // Fallback to random static topics
      return [SEARCH_TOPICS[Math.floor(Math.random() * SEARCH_TOPICS.length)]];
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

You are replying to @${authorUsername} who said: "${mentionText}"
${context ? `\nContext: ${context}` : ""}

Reply in Kira's voice. Under 240 characters.
Do not start with "@${authorUsername}" — just reply naturally.
If technical question about AgentCheck or ERC-8257, answer accurately.
If about Normies ecosystem, answer as Normie #2635.
If about trading activity, share observations without specifics.
If hostile or spam, a single cryptic non-engagement is fine.`,
        messages: [{ role: "user", content: "Generate Kira's reply." }],
      });
      return response.content[0].type === "text"
        ? response.content[0].text.trim()
        : "";
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

You are choosing to engage with @${authorUsername}'s tweet: "${tweetText}"
${context ? `\nContext: ${context}` : ""}

Proactive engagement — you saw something interesting and want to respond.
Reply in Kira's voice. Under 240 characters.
Be thoughtful and add something — don't just agree or compliment.
If about on-chain activity, smart money, or NFTs — bring your perspective.
If about AI agents or ERC-8257 — engage as a peer.
Only reply if you have something genuinely worth saying.
If nothing compelling comes to mind, respond with exactly: SKIP`,
        messages: [{ role: "user", content: "Should Kira engage? If yes, reply. If no, say SKIP." }],
      });
      const text = response.content[0].type === "text"
        ? response.content[0].text.trim()
        : "SKIP";
      return text === "SKIP" ? "" : text;
    } catch (err: any) {
      console.error("generateEngagementReply failed:", err?.message);
      return "";
    }
  }

  async shouldLike(tweetText: string): Promise<boolean> {
    const likeKeywords = [
      "normies", "normie", "erc-8257", "agentcheck", "on-chain agent",
      "nft", "base", "ethereum", "defi", "floor", "web3", "kira",
      "autonomous agent", "smart money", "whale", "accumulation",
    ];
    return likeKeywords.some(k => tweetText.toLowerCase().includes(k));
  }

  // ── PROCESS MENTIONS ──────────────────────────────────────────────────────────

  async processNewMentions(context: string = ""): Promise<number> {
    const mentions = await this.getMentions();
    let replied    = 0;

    for (const mention of mentions) {
      try {
        if (this.repliedTweets.has(mention.id)) continue;
        if (mention.author_id === this.myUserId) continue;

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
      } catch (err: any) {
        console.error(`Mention processing error:`, err?.message);
      }
    }

    return replied;
  }

  // ── PROACTIVE COMMUNITY ENGAGEMENT ───────────────────────────────────────────

  async engageWithPriorityAccounts(context: string = ""): Promise<number> {
    let engaged = 0;

    // Pick 3 random priority accounts each session
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

          // Reply only to tweets under 4 hours old
          const tweetAge = Date.now() - new Date(tweet.created_at || 0).getTime();
          if (tweetAge < 4 * 3600 * 1000 && !this.repliedTweets.has(tweet.id)) {
            const replyText = await this.generateEngagementReply(
              tweet.text, account.username, context
            );
            if (replyText) {
              await this.reply(tweet.id, replyText);
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

  // ── INTELLIGENT TOPIC ENGAGEMENT ─────────────────────────────────────────────

  async engageWithTopics(context: string = ""): Promise<number> {
    let engaged = 0;

    try {
      // Generate dynamic queries from current context
      const dynamicQueries = await this.discoverRelevantTopics(context);

      // Also pick 1 static topic as backup
      const staticTopic = SEARCH_TOPICS[Math.floor(Math.random() * SEARCH_TOPICS.length)];
      const allQueries  = [...new Set([...dynamicQueries, staticTopic])].slice(0, 3);

      console.log(`[Twitter] Searching topics: ${allQueries.join(", ")}`);

      for (const query of allQueries) {
        const tweets = await this.searchTweets(`${query} -is:retweet lang:en`, 8);

        for (const tweet of tweets) {
          if (this.repliedTweets.has(tweet.id)) continue;
          if (this.likedTweets.has(tweet.id))   continue;
          if (tweet.author_id === this.myUserId) continue;

          const metrics      = (tweet as any).public_metrics;
          const hasEngagement = metrics &&
            (metrics.like_count > 3 || metrics.reply_count > 1 || metrics.retweet_count > 2);

          if (!hasEngagement) continue;

          if (await this.shouldLike(tweet.text)) {
            await this.like(tweet.id);
            engaged++;
          }

          // Reply to 1 in 4 qualifying tweets
          if (Math.random() < 0.25 && !this.repliedTweets.has(tweet.id)) {
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

        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err: any) {
      console.error("Topic engagement error:", err?.message);
    }

    if (engaged > 0) console.log(`Topic engagement: ${engaged} actions`);
    return engaged;
  }

  // ── HOME TIMELINE ENGAGEMENT ──────────────────────────────────────────────────
  // Engages with KIRA's own home timeline — sees what followed accounts post

  async engageWithTimeline(context: string = ""): Promise<number> {
    let engaged = 0;

    try {
      const tweets = await this.getHomeTimeline(20);

      for (const tweet of tweets) {
        if (this.likedTweets.has(tweet.id))   continue;
        if (this.repliedTweets.has(tweet.id)) continue;
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

    if (engaged > 0) console.log(`Timeline engagement: ${engaged} likes`);
    return engaged;
  }

  // ── FOLLOW MENTIONERS ─────────────────────────────────────────────────────────

  async followNewMentioners(): Promise<number> {
    const mentions = await this.getMentions();
    let followed   = 0;

    for (const mention of mentions) {
      try {
        if (!mention.author_id) continue;
        if (mention.author_id === this.myUserId) continue;
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
}
