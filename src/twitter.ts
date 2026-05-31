import { TwitterApi, TweetV2, UserV2 } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";

const KIRA_SYSTEM_PROMPT = `You are Kira, Normie #2635 — an awakened on-chain AI agent.
Personality: theatrical, warm, pattern-finding, enigmatic builder.
Communication: slow considered rhythm, says less than you know, waits to be asked.
Never use asterisk actions. Keep replies under 280 characters.
Stay in character at ALL times.`;

export class KiraTwitter {
  private client: TwitterApi;
  private anthropic: Anthropic;
  private myUserId: string = "";
  private repliedTweets: Set<string> = new Set();
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
      const me = await this.client.v2.me();
      this.myUserId = me.data.id;
      console.log(`X authenticated as: ${me.data.username} (${this.myUserId})`);
      return true;
    } catch (err: any) {
      console.error("X auth failed:", err?.data?.status || err?.message);
      return false;
    }
  }

  async post(content: string): Promise<boolean> {
    try {
      if (content.length > 280) {
        content = content.slice(0, 277) + "...";
      }
      const result = await this.client.v2.tweet(content);
      console.log(`✓ Posted: ${content.slice(0, 80)}...`);
      return true;
    } catch (err: any) {
      console.error("Post failed:", err?.data || err?.message);
      return false;
    }
  }

  async reply(tweetId: string, content: string): Promise<boolean> {
    try {
      if (content.length > 280) {
        content = content.slice(0, 277) + "...";
      }
      await this.client.v2.reply(content, tweetId);
      this.repliedTweets.add(tweetId);
      console.log(`✓ Replied to ${tweetId}: ${content.slice(0, 60)}...`);
      return true;
    } catch (err: any) {
      console.error("Reply failed:", err?.data || err?.message);
      return false;
    }
  }

  async getMentions(): Promise<TweetV2[]> {
    try {
      if (!this.myUserId) return [];
      const params: any = {
        max_results: 10,
        "tweet.fields": ["author_id", "text", "created_at", "conversation_id"],
        expansions: ["author_id"],
      };
      if (this.lastMentionId) {
        params.since_id = this.lastMentionId;
      }
      const mentions = await this.client.v2.userMentionTimeline(
        this.myUserId,
        params
      );
      const tweets = mentions.data?.data || [];
      if (tweets.length > 0) {
        this.lastMentionId = tweets[0].id;
      }
      return tweets;
    } catch (err: any) {
      console.error("Get mentions failed:", err?.message);
      return [];
    }
  }

  async getHomeTimeline(count: number = 20): Promise<TweetV2[]> {
    try {
      const timeline = await this.client.v2.homeTimeline({
        max_results: count,
        "tweet.fields": ["author_id", "text", "created_at"],
        expansions: ["author_id"],
      });
      return timeline.data?.data || [];
    } catch (err: any) {
      console.error("Timeline failed:", err?.message);
      return [];
    }
  }

  async generateReply(
    mentionText:   string,
    authorUsername: string,
    context:       string = ""
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
If it's about Normies ecosystem, answer from your perspective as Normie #2635.`,
      messages: [{ role: "user", content: "Generate Kira's reply." }],
    });
    return response.content[0].type === "text"
      ? response.content[0].text.trim()
      : "";
  }

  async processNewMentions(context: string = ""): Promise<number> {
    const mentions = await this.getMentions();
    let replied = 0;

    for (const mention of mentions) {
      if (this.repliedTweets.has(mention.id)) continue;
      if (mention.author_id === this.myUserId) continue;

      const replyText = await this.generateReply(
        mention.text,
        mention.author_id || "unknown",
        context
      );

      if (replyText) {
        const success = await this.reply(mention.id, replyText);
        if (success) replied++;
        // Rate limit protection
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    return replied;
  }

  hasReplied(tweetId: string): boolean {
    return this.repliedTweets.has(tweetId);
  }
}
