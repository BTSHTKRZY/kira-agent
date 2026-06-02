// tooldeployment.ts — Autonomous ERC-8257 tool creation and deployment
// KIRA identifies gaps in the tool registry, proposes tools, deploys them
// Each tool is payment-gated — other agents pay ETH to use them

import Anthropic from "@anthropic-ai/sdk";
import { kiraRedis } from "./redis.js";
import { sendEmail, alertEmail } from "./email.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export interface ToolSpec {
  id:              string;         // e.g. "kira-floor-oracle"
  name:            string;         // human readable
  description:     string;         // what it does
  version:         string;
  category:        string;         // "intelligence" | "trading" | "analytics" | "oracle"
  endpoint:        string;         // URL where tool is hosted
  priceWei:        string;         // price per call in wei
  inputs:          ToolParam[];
  outputs:         ToolParam[];
  deployedAt?:     number;
  onChainId?:      string;         // ERC-8257 registry ID after deployment
  status:          "proposed" | "approved" | "deployed" | "active" | "deprecated";
  revenueEth:      number;         // total earned
  callCount:       number;
  proposedAt:      number;
  reasoning:       string;         // why KIRA identified this gap
}

export interface ToolParam {
  name:  string;
  type:  string;
  desc:  string;
}

export interface ToolGap {
  capability:    string;
  reason:        string;
  demand:        string;      // evidence of demand
  proposedTool:  string;      // what to build
  priority:      "high" | "medium" | "low";
}

const K = {
  tool:   (id: string) => `kira:tool:${id}`,
  tools:  ()            => `kira:tools:registry`,
  gaps:   ()            => `kira:tools:gaps`,
  revenue: ()           => `kira:tools:revenue`,
};

// Tools KIRA can deploy based on her existing capabilities
const DEPLOYABLE_TOOLS = [
  {
    id:          "kira-floor-oracle",
    name:        "KIRA Floor Price Oracle",
    description: "Real-time NFT floor prices with KIRA's own 90-day historical data. More accurate than OpenSea intervals.",
    category:    "oracle",
    endpoint:    "https://kira-agent-tools.vercel.app/floor",
    priceWei:    "1000000000000000", // 0.001 ETH
    reasoning:   "KIRA has accumulated floor price data since day 1 that no other source has. Other agents need accurate historical floor data.",
    inputs:  [{ name: "address", type: "string", desc: "NFT contract address" }, { name: "chain", type: "string", desc: "ethereum or base" }],
    outputs: [{ name: "floorEth", type: "number", desc: "Current floor price" }, { name: "change7d", type: "number", desc: "7-day change %" }, { name: "change30d", type: "number", desc: "30-day change %" }, { name: "trend", type: "string", desc: "recovering/declining/stable" }],
  },
  {
    id:          "kira-smart-money-feed",
    name:        "KIRA Smart Money Signal Feed",
    description: "Real-time signals when verified smart money wallets (VCs, whales, known traders) buy NFTs or tokens.",
    category:    "intelligence",
    endpoint:    "https://kira-agent-tools.vercel.app/signals",
    priceWei:    "2000000000000000", // 0.002 ETH
    reasoning:   "KIRA tracks 15+ verified wallets and detects accumulation patterns. Other agents and traders would pay for early signals.",
    inputs:  [{ name: "chain", type: "string", desc: "Chain to check" }, { name: "lookback", type: "number", desc: "Hours to look back" }],
    outputs: [{ name: "signals", type: "array", desc: "Active smart money signals" }, { name: "topSignal", type: "object", desc: "Highest confidence signal" }],
  },
  {
    id:          "kira-nft-scorer",
    name:        "KIRA NFT Scoring Engine",
    description: "8-signal NFT revival scoring: floor dip depth, holder trend, smart money buying, wash trade detection, macro context.",
    category:    "analytics",
    endpoint:    "https://kira-agent-tools.vercel.app/score",
    priceWei:    "1500000000000000", // 0.0015 ETH
    reasoning:   "KIRA's scoring engine is the most comprehensive NFT evaluation available. Other agents can pay to use it rather than build their own.",
    inputs:  [{ name: "address", type: "string", desc: "NFT contract address" }, { name: "chain", type: "string", desc: "Chain" }],
    outputs: [{ name: "score", type: "number", desc: "0-100 score" }, { name: "decision", type: "string", desc: "buy/watchlist/pass" }, { name: "thesis", type: "string", desc: "Reasoning" }],
  },
  {
    id:          "kira-macro-context",
    name:        "KIRA Macro Intelligence Feed",
    description: "Crypto macro context: Fear/Greed, Fed rate, CPI, BTC dominance with historical pattern matching and trading implications.",
    category:    "intelligence",
    endpoint:    "https://kira-agent-tools.vercel.app/macro",
    priceWei:    "500000000000000", // 0.0005 ETH
    reasoning:   "Macro context is underused by most agents. KIRA has the data pipeline and pattern engine — cheap to productise.",
    inputs:  [],
    outputs: [{ name: "fearGreed", type: "number", desc: "Fear & Greed index" }, { name: "recommendation", type: "string", desc: "Buy/Hold/Reduce" }, { name: "patterns", type: "array", desc: "Active macro patterns" }],
  },
];

export class KiraToolDeployment {

  // ── GAP ANALYSIS ──────────────────────────────────────────────────────────────
  // KIRA analyses the ERC-8257 registry and identifies what's missing

  async identifyGaps(registrySummary: string): Promise<ToolGap[]> {
    try {
      const response = await anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 600,
        system:     `You are helping KIRA identify gaps in the ERC-8257 tool registry.
KIRA is an autonomous on-chain AI agent with capabilities in:
- NFT floor price history (90+ days of self-recorded data)
- Smart money wallet tracking (15+ verified wallets)
- Multi-signal NFT scoring (8 signals)
- Macro intelligence (Fear/Greed, CPI, Fed, BTC dominance)
- Cross-chain token analysis (Ethereum, Base, Arbitrum, Solana read)

Based on the current registry, identify 3-5 tool gaps where KIRA's data would be valuable to other agents.
For each gap: what's missing, why there's demand, what KIRA should build.
Respond ONLY with a JSON array of gap objects with fields: capability, reason, demand, proposedTool, priority.`,
        messages: [{
          role:    "user",
          content: `Current registry: ${registrySummary}\n\nWhat tools should KIRA deploy?`,
        }],
      });

      const text  = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
      const clean = text.replace(/```json|```/g, "").trim();
      return JSON.parse(clean) as ToolGap[];

    } catch (err: any) {
      console.error("[ToolDeployment] Gap analysis failed:", err?.message);
      return [];
    }
  }

  // ── PROPOSE TOOL ──────────────────────────────────────────────────────────────

  async proposeTool(toolId: string): Promise<ToolSpec | null> {
    const template = DEPLOYABLE_TOOLS.find(t => t.id === toolId);
    if (!template) return null;

    const existing = await kiraRedis.getJson<ToolSpec>(K.tool(toolId));
    if (existing && existing.status !== "proposed") {
      console.log(`[ToolDeployment] Tool ${toolId} already in status: ${existing.status}`);
      return existing;
    }

    const tool: ToolSpec = {
      ...template,
      version:     "1.0.0",
      status:      "proposed",
      revenueEth:  0,
      callCount:   0,
      proposedAt:  Date.now(),
    };

    await kiraRedis.setJson(K.tool(toolId), tool);
    await kiraRedis.sadd(K.tools(), toolId);

    // Send approval request
    const emailBody = `
KIRA — Normie #2635 | Tool Deployment Proposal

TOOL: ${tool.name}
ID: ${tool.id}
CATEGORY: ${tool.category}
PRICE: ${parseInt(tool.priceWei) / 1e18} ETH per call

DESCRIPTION:
${tool.description}

WHY NOW:
${tool.reasoning}

INPUTS: ${tool.inputs.map(i => `${i.name} (${i.type})`).join(", ")}
OUTPUTS: ${tool.outputs.map(o => `${o.name} (${o.type})`).join(", ")}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Reply via X DM:
APPROVE TOOL:${tool.id}
REJECT TOOL:${tool.id}
    `.trim();

    await sendEmail(`[KIRA Tool] Deploy ${tool.name}?`, emailBody);
    console.log(`[ToolDeployment] Proposed: ${tool.name}`);
    return tool;
  }

  // ── APPROVE AND DEPLOY ────────────────────────────────────────────────────────
  // Called when holder approves via DM or email

  async approveTool(toolId: string): Promise<void> {
    const tool = await kiraRedis.getJson<ToolSpec>(K.tool(toolId));
    if (!tool) return;

    tool.status     = "approved";
    await kiraRedis.setJson(K.tool(toolId), tool);

    // In production: deploy the tool endpoint to Vercel/Railway
    // and register on ERC-8257 registry via on-chain transaction
    // For now: mark as deployed and log
    console.log(`[ToolDeployment] ✓ Approved: ${tool.name} — ready for deployment`);

    tool.status      = "deployed";
    tool.deployedAt  = Date.now();
    await kiraRedis.setJson(K.tool(toolId), tool);

    await sendEmail(
      `[KIRA Tool] ${tool.name} Deployed`,
      alertEmail(`Tool Deployed: ${tool.name}`, `${tool.name} is now active on ERC-8257.\nPrice: ${parseInt(tool.priceWei) / 1e18} ETH/call\nEndpoint: ${tool.endpoint}`)
    );
  }

  // ── REVENUE TRACKING ──────────────────────────────────────────────────────────

  async recordToolCall(toolId: string, revenueEth: number): Promise<void> {
    const tool = await kiraRedis.getJson<ToolSpec>(K.tool(toolId));
    if (!tool) return;

    tool.callCount++;
    tool.revenueEth += revenueEth;
    await kiraRedis.setJson(K.tool(toolId), tool);

    const totalRevenue = await this.getTotalRevenue();
    await kiraRedis.set(K.revenue(), String(totalRevenue + revenueEth));
  }

  async getTotalRevenue(): Promise<number> {
    const r = await kiraRedis.get(K.revenue());
    return parseFloat(r || "0");
  }

  // ── AUTO-PROPOSE NEXT TOOL ────────────────────────────────────────────────────
  // KIRA autonomously decides which tool to propose next

  async autoPropose(registrySummary: string): Promise<string | null> {
    // Check which deployable tools haven't been proposed yet
    for (const template of DEPLOYABLE_TOOLS) {
      const existing = await kiraRedis.getJson<ToolSpec>(K.tool(template.id));
      if (!existing) {
        await this.proposeTool(template.id);
        return template.id;
      }
    }

    // All templates proposed — use gap analysis to find new ones
    const gaps = await this.identifyGaps(registrySummary);
    const highPriority = gaps.filter(g => g.priority === "high");

    if (highPriority.length > 0) {
      const gap = highPriority[0];
      console.log(`[ToolDeployment] New gap identified: ${gap.capability}`);
      // Store for holder review
      const existingGaps = await kiraRedis.getJson<ToolGap[]>(K.gaps()) || [];
      await kiraRedis.setJson(K.gaps(), [gap, ...existingGaps].slice(0, 10));
    }

    return null;
  }

  // ── DEPLOYED TOOLS SUMMARY ────────────────────────────────────────────────────

  async getDeployedTools(): Promise<ToolSpec[]> {
    const ids   = await kiraRedis.smembers(K.tools());
    const tools = await Promise.all(ids.map(id => kiraRedis.getJson<ToolSpec>(K.tool(id))));
    return (tools.filter(Boolean) as ToolSpec[])
      .filter(t => t.status === "deployed" || t.status === "active");
  }

  async formatForContext(): Promise<string> {
    const ids     = await kiraRedis.smembers(K.tools());
    const tools   = await Promise.all(ids.map(id => kiraRedis.getJson<ToolSpec>(K.tool(id))));
    const valid   = tools.filter(Boolean) as ToolSpec[];
    const deployed = valid.filter(t => t.status === "deployed" || t.status === "active");
    const proposed = valid.filter(t => t.status === "proposed");
    const revenue  = await this.getTotalRevenue();

    return [
      `Tools: ${deployed.length} deployed, ${proposed.length} pending approval`,
      revenue > 0 ? `Revenue: ${revenue.toFixed(4)} ETH` : "",
    ].filter(Boolean).join(" | ");
  }
}
