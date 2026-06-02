// longform.ts — Market intelligence report generation
// Weekly reports as long-form tweet threads (5-7 tweets)
// KIRA's accumulated intelligence turned into publishable insights

import Anthropic from "@anthropic-ai/sdk";
import { kiraRedis } from "./redis.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export interface IntelligenceReport {
  id:           string;
  type:         "weekly_market" | "nft_analysis" | "smart_money" | "macro_thesis" | "agent_state";
  title:        string;
  tweets:       string[];   // 5-7 tweets forming the thread
  summary:      string;     // one-line summary for logging
  generatedAt:  number;
  publishedAt?: number;
  tweetIds?:    string[];   // tweet IDs after publishing
}

const K = {
  report:       (id: string) => `kira:report:${id}`,
  reports:      ()            => `kira:reports`,
  lastReport:   (type: string) => `kira:report:last:${type}`,
};

const REPORT_INTERVALS: Record<string, number> = {
  weekly_market:  7  * 24 * 60 * 60 * 1000,
  nft_analysis:   3  * 24 * 60 * 60 * 1000,
  smart_money:    2  * 24 * 60 * 60 * 1000,
  macro_thesis:   5  * 24 * 60 * 60 * 1000,
  agent_state:    14 * 24 * 60 * 60 * 1000,
};

export class KiraLongForm {

  // ── WEEKLY MARKET INTELLIGENCE THREAD ────────────────────────────────────────

  async generateWeeklyMarketThread(context: {
    macroSummary:      string;
    ecosystemSummary:  string;
    watchlist:         Array<{ name: string; score: number; thesis: string }>;
    smartMoneySummary: string;
    crossChainSummary: string;
    learnings:         string[];
    floorHistory:      string;
  }): Promise<string[]> {
    try {
      const response = await anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 1200,
        system:     `You are KIRA, Normie #2635 — an awakened autonomous on-chain AI agent.
He/him pronouns. Theatrical, warm, pattern-finding, enigmatic.

Write a 6-tweet market intelligence thread. This is your weekly synthesis — what you've learned, observed, and concluded from scanning markets autonomously.

RULES:
- Tweet 1: The most striking insight or pattern you've observed this week. Hook.
- Tweet 2: Macro context and what it means for NFT/crypto positioning
- Tweet 3: Specific NFT market observation (name collections, be specific)
- Tweet 4: Smart money activity — what verified wallets are doing
- Tweet 5: Cross-chain intelligence — what's happening beyond Ethereum
- Tweet 6: KIRA's current thesis / what he's watching next

Each tweet max 240 characters. No hashtags. No emojis unless very intentional.
Never shill. Never hype. Speak as an analyst who has been watching the market 24/7.
Reference your untouched canvas only if it's genuinely relevant.
Respond ONLY with a JSON array of 6 strings.`,
        messages: [{
          role:    "user",
          content: `
Macro: ${context.macroSummary}
Ecosystem: ${context.ecosystemSummary}
Smart money: ${context.smartMoneySummary}
Cross-chain: ${context.crossChainSummary}
Floor history: ${context.floorHistory}
Top watchlist items: ${context.watchlist.slice(0, 3).map(w => `${w.name} (${w.score}/100)`).join(", ")}
Recent learnings: ${context.learnings.slice(-5).join(" | ")}

Generate KIRA's weekly market intelligence thread.`,
        }],
      });

      const text   = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
      const clean  = text.replace(/```json|```/g, "").trim();
      const tweets = JSON.parse(clean) as string[];
      return Array.isArray(tweets) ? tweets.slice(0, 7) : [];

    } catch (err: any) {
      console.error("[LongForm] Weekly thread generation failed:", err?.message);
      return [];
    }
  }

  // ── NFT DEEP DIVE THREAD ──────────────────────────────────────────────────────

  async generateNFTAnalysisThread(
    collectionName: string,
    score:          number,
    thesis:         string,
    floorData:      string,
    macroContext:   string
  ): Promise<string[]> {
    try {
      const response = await anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 800,
        system:     `You are KIRA, Normie #2635. Write a 4-tweet deep dive on an NFT collection.
He/him. Analytical, specific, not hype. Uses data. Ends with clear thesis.
Each tweet max 240 characters. Respond ONLY with a JSON array of 4 strings.`,
        messages: [{
          role:    "user",
          content: `Collection: ${collectionName}
Score: ${score}/100
Floor data: ${floorData}
Macro: ${macroContext}
Thesis: ${thesis}

Write the deep dive thread.`,
        }],
      });

      const text   = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
      const clean  = text.replace(/```json|```/g, "").trim();
      return JSON.parse(clean) as string[];

    } catch (err: any) {
      console.error("[LongForm] NFT thread failed:", err?.message);
      return [];
    }
  }

  // ── SMART MONEY ACTIVITY THREAD ───────────────────────────────────────────────

  async generateSmartMoneyThread(
    signals:     Array<{ asset: string; buyers: number; chains: string; confidence: number }>,
    macroContext: string
  ): Promise<string[]> {
    if (!signals.length) return [];

    try {
      const response = await anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 800,
        system:     `You are KIRA, Normie #2635. Write a 4-tweet thread on smart money activity you've detected.
He/him. Specific, analytical, data-driven. Don't name specific wallet addresses.
Each tweet max 240 characters. Respond ONLY with a JSON array of 4 strings.`,
        messages: [{
          role:    "user",
          content: `Smart money signals detected:
${signals.slice(0, 3).map(s => `${s.asset}: ${s.buyers} wallets, ${s.chains}, ${(s.confidence * 100).toFixed(0)}% confidence`).join("\n")}

Macro context: ${macroContext}

Write the smart money thread.`,
        }],
      });

      const text   = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
      const clean  = text.replace(/```json|```/g, "").trim();
      return JSON.parse(clean) as string[];

    } catch (err: any) {
      console.error("[LongForm] Smart money thread failed:", err?.message);
      return [];
    }
  }

  // ── MACRO THESIS THREAD ───────────────────────────────────────────────────────

  async generateMacroThesisThread(
    macroSummary: string,
    cpi:          number,
    fedRate:      number,
    fearGreed:    number,
    btcDom:       number,
    patterns:     string[]
  ): Promise<string[]> {
    try {
      const response = await anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 800,
        system:     `You are KIRA, Normie #2635. Write a 5-tweet macro thesis thread.
He/him. Connects macro data to crypto market implications. Analytical and specific.
Each tweet max 240 characters. Respond ONLY with a JSON array of 5 strings.`,
        messages: [{
          role:    "user",
          content: `Macro data:
Fear/Greed: ${fearGreed}
Fed rate: ${fedRate}%
CPI: ${cpi}% YoY
BTC dominance: ${btcDom}%
Active patterns: ${patterns.join(", ")}

Write the macro thesis thread.`,
        }],
      });

      const text   = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
      const clean  = text.replace(/```json|```/g, "").trim();
      return JSON.parse(clean) as string[];

    } catch (err: any) {
      console.error("[LongForm] Macro thread failed:", err?.message);
      return [];
    }
  }

  // ── REPORT MANAGEMENT ─────────────────────────────────────────────────────────

  async saveReport(report: IntelligenceReport): Promise<void> {
    await kiraRedis.setJson(K.report(report.id), report);
    await kiraRedis.sadd(K.reports(), report.id);
    await kiraRedis.set(K.lastReport(report.type), String(Date.now()));
  }

  async isDue(type: keyof typeof REPORT_INTERVALS): Promise<boolean> {
    const last    = await kiraRedis.get(K.lastReport(type));
    if (!last) return true;
    const interval = REPORT_INTERVALS[type] || 7 * 24 * 60 * 60 * 1000;
    return Date.now() - parseInt(last) > interval;
  }

  async getRecentReports(limit: number = 5): Promise<IntelligenceReport[]> {
    const ids     = await kiraRedis.smembers(K.reports());
    const reports = await Promise.all(
      ids.map(id => kiraRedis.getJson<IntelligenceReport>(K.report(id)))
    );
    return (reports.filter(Boolean) as IntelligenceReport[])
      .sort((a, b) => b.generatedAt - a.generatedAt)
      .slice(0, limit);
  }

  generateReportId(type: string): string {
    return `${type}-${Date.now()}`;
  }
}
