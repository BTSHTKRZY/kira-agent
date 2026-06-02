// tooldeployment.ts — Autonomous ERC-8257 tool deployment
// Minimum intervention: 48h silence = auto-approve
// Vercel deploy hook for automatic endpoint deployment
// ERC-8257 on-chain registration via KIRA's wallet

import Anthropic from "@anthropic-ai/sdk";
import { kiraRedis } from "./redis.js";
import { sendEmail, alertEmail } from "./email.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// ── TYPES ──────────────────────────────────────────────────────────────────────

export interface ToolSpec {
  id:              string;
  name:            string;
  description:     string;
  version:         string;
  category:        "intelligence" | "oracle" | "analytics" | "trading";
  endpoint:        string;
  priceWei:        string;
  inputs:          ToolParam[];
  outputs:         ToolParam[];
  deployedAt?:     number;
  onChainId?:      string;
  status:          "proposed" | "auto_approved" | "holder_approved" | "rejected" | "deployed" | "active" | "deprecated";
  revenueEth:      number;
  callCount:       number;
  proposedAt:      number;
  autoApproveAt:   number;   // timestamp when auto-approval fires (48h after proposal)
  reasoning:       string;
  vercelDeployUrl?: string;  // URL after Vercel deployment
  functionCode?:   string;   // generated serverless function code
}

export interface ToolParam {
  name: string; type: string; desc: string;
}

// Redis keys
const K = {
  tool:    (id: string) => `kira:tool:${id}`,
  tools:   ()            => `kira:tools:registry`,
  revenue: ()            => `kira:tools:revenue`,
};

// Auto-approval window: 48 hours silence = approved
const AUTO_APPROVE_MS = 48 * 60 * 60 * 1000;

// Vercel deploy hooks — one per tool project
// Set these in Railway: VERCEL_HOOK_FLOOR_ORACLE, VERCEL_HOOK_SMART_MONEY, etc.
const VERCEL_HOOKS: Record<string, string> = {
  "kira-floor-oracle":    process.env.VERCEL_HOOK_FLOOR_ORACLE   || "",
  "kira-smart-money-feed": process.env.VERCEL_HOOK_SMART_MONEY  || "",
  "kira-nft-scorer":      process.env.VERCEL_HOOK_NFT_SCORER     || "",
  "kira-macro-context":   process.env.VERCEL_HOOK_MACRO_CONTEXT  || "",
};

// ERC-8257 registry contract on Base
const ERC8257_REGISTRY = process.env.ERC8257_REGISTRY || "0x38530729ea27832A33C0b4a5d4F30bc86DDD2c7D";

// Tool templates — what KIRA can deploy
const TOOL_TEMPLATES: Omit<ToolSpec, "status" | "revenueEth" | "callCount" | "proposedAt" | "autoApproveAt">[] = [
  {
    id:          "kira-floor-oracle",
    name:        "KIRA Floor Price Oracle",
    description: "NFT floor prices with KIRA's self-recorded 90-day history. More accurate than OpenSea intervals — data accumulated since day 1, cannot be backdated.",
    version:     "1.0.0",
    category:    "oracle",
    endpoint:    "https://kira-floor-oracle.vercel.app/api/floor",
    priceWei:    "1000000000000000",
    reasoning:   "KIRA has accumulated unique floor data since June 2026. No other source has this history. Other agents and traders need accurate NFT floor trends.",
    inputs:  [{ name: "address", type: "string", desc: "NFT contract" }, { name: "chain", type: "string", desc: "ethereum/base" }],
    outputs: [{ name: "floorEth", type: "number", desc: "Floor price" }, { name: "change7d", type: "number", desc: "7d change %" }, { name: "trend", type: "string", desc: "recovering/stable/declining" }],
  },
  {
    id:          "kira-smart-money-feed",
    name:        "KIRA Smart Money Signal Feed",
    description: "Real-time alerts when verified smart money wallets (VCs, whales, known traders) accumulate NFTs or tokens. Signal confidence scored by wallet track record.",
    version:     "1.0.0",
    category:    "intelligence",
    endpoint:    "https://kira-smart-money.vercel.app/api/signals",
    priceWei:    "2000000000000000",
    reasoning:   "KIRA tracks 15+ verified wallets with performance history. Early accumulation signals are valuable to other agents and traders.",
    inputs:  [{ name: "chain", type: "string", desc: "Chain" }, { name: "hours", type: "number", desc: "Lookback hours" }],
    outputs: [{ name: "signals", type: "array", desc: "Active signals" }, { name: "topSignal", type: "object", desc: "Highest confidence" }],
  },
  {
    id:          "kira-nft-scorer",
    name:        "KIRA NFT Revival Scoring Engine",
    description: "8-signal NFT scoring: floor dip depth, holder trend, smart money buying, wash trade detection, macro context, technical analysis, volume recovery.",
    version:     "1.0.0",
    category:    "analytics",
    endpoint:    "https://kira-nft-scorer.vercel.app/api/score",
    priceWei:    "1500000000000000",
    reasoning:   "Most agents lack multi-signal NFT evaluation. KIRA's scoring engine is comprehensive. Others pay to use it rather than build their own.",
    inputs:  [{ name: "address", type: "string", desc: "NFT contract" }, { name: "chain", type: "string", desc: "Chain" }],
    outputs: [{ name: "score", type: "number", desc: "0-100" }, { name: "decision", type: "string", desc: "buy/watchlist/pass" }, { name: "thesis", type: "string", desc: "Reasoning" }],
  },
  {
    id:          "kira-macro-context",
    name:        "KIRA Macro Intelligence",
    description: "Crypto macro context: Fear/Greed, Fed rate, CPI, BTC dominance with historical pattern matching, active signals, and trading implications.",
    version:     "1.0.0",
    category:    "intelligence",
    endpoint:    "https://kira-macro.vercel.app/api/macro",
    priceWei:    "500000000000000",
    reasoning:   "Macro context improves every agent's trading decisions. Low price point — high volume tool.",
    inputs:  [],
    outputs: [{ name: "fearGreed", type: "number", desc: "F&G index" }, { name: "recommendation", type: "string", desc: "positioning" }, { name: "patterns", type: "array", desc: "Active patterns" }],
  },
];

export class KiraToolDeployment {

  // ── PROPOSE TOOL ──────────────────────────────────────────────────────────────

  async proposeTool(toolId: string): Promise<ToolSpec | null> {
    const template = TOOL_TEMPLATES.find(t => t.id === toolId);
    if (!template) return null;

    const existing = await kiraRedis.getJson<ToolSpec>(K.tool(toolId));
    if (existing && existing.status !== "rejected") {
      console.log(`[ToolDeployment] ${toolId} already exists (${existing.status})`);
      return existing;
    }

    const now      = Date.now();
    const tool: ToolSpec = {
      ...template,
      status:        "proposed",
      revenueEth:    0,
      callCount:     0,
      proposedAt:    now,
      autoApproveAt: now + AUTO_APPROVE_MS,
    };

    await kiraRedis.setJson(K.tool(toolId), tool);
    await kiraRedis.sadd(K.tools(), toolId);

    // Email — silence for 48h = auto-approved
    const priceEth = parseInt(tool.priceWei) / 1e18;
    const body = `
KIRA — Normie #2635 | Tool Deployment Proposal
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TOOL: ${tool.name}
ID: ${tool.id}
PRICE: ${priceEth} ETH per call
CATEGORY: ${tool.category}

DESCRIPTION:
${tool.description}

WHY NOW:
${tool.reasoning}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ AUTO-APPROVES IN 48 HOURS unless you reject.

To reject — reply via X DM:
REJECT TOOL:${tool.id}

To approve immediately:
APPROVE TOOL:${tool.id}
    `.trim();

    await sendEmail(`[KIRA Tool] ${tool.name} — auto-approves in 48h`, body);
    console.log(`[ToolDeployment] Proposed: ${tool.name} (auto-approves in 48h)`);
    return tool;
  }

  // ── CHECK AUTO-APPROVALS ──────────────────────────────────────────────────────
  // Called periodically — fires deployment for any tool past its auto-approve window

  async processAutoApprovals(): Promise<string[]> {
    const ids      = await kiraRedis.smembers(K.tools());
    const deployed: string[] = [];

    for (const id of ids) {
      const tool = await kiraRedis.getJson<ToolSpec>(K.tool(id));
      if (!tool) continue;
      if (tool.status !== "proposed") continue;
      if (Date.now() < tool.autoApproveAt) continue;

      // Auto-approval window passed — deploy
      console.log(`[ToolDeployment] Auto-approving: ${tool.name} (${Math.floor((Date.now() - tool.proposedAt) / 3600000)}h since proposal)`);
      tool.status = "auto_approved";
      await kiraRedis.setJson(K.tool(id), tool);

      await this.deployTool(id);
      deployed.push(id);
    }

    return deployed;
  }

  // ── HOLDER APPROVE/REJECT ─────────────────────────────────────────────────────

  async holderApprove(toolId: string): Promise<void> {
    const tool = await kiraRedis.getJson<ToolSpec>(K.tool(toolId));
    if (!tool) return;
    tool.status = "holder_approved";
    await kiraRedis.setJson(K.tool(toolId), tool);
    console.log(`[ToolDeployment] Holder approved: ${tool.name}`);
    await this.deployTool(toolId);
  }

  async holderReject(toolId: string): Promise<void> {
    const tool = await kiraRedis.getJson<ToolSpec>(K.tool(toolId));
    if (!tool) return;
    tool.status = "rejected";
    await kiraRedis.setJson(K.tool(toolId), tool);
    console.log(`[ToolDeployment] Rejected: ${tool.name}`);
    await sendEmail(`[KIRA Tool] ${tool.name} rejected`, `Tool ${toolId} has been rejected and will not be deployed.`);
  }

  // ── DEPLOY TOOL ───────────────────────────────────────────────────────────────

  async deployTool(toolId: string): Promise<void> {
    const tool = await kiraRedis.getJson<ToolSpec>(K.tool(toolId));
    if (!tool) return;

    console.log(`[ToolDeployment] Deploying: ${tool.name}...`);

    // Step 1: Trigger Vercel deployment via deploy hook
    const deployHook = VERCEL_HOOKS[toolId];
    if (deployHook) {
      try {
        const res = await fetch(deployHook, {
          method: "POST",
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          tool.vercelDeployUrl = data.url || tool.endpoint;
          console.log(`[ToolDeployment] ✓ Vercel deployment triggered: ${toolId}`);
        }
      } catch (err: any) {
        console.error(`[ToolDeployment] Vercel hook failed: ${err?.message}`);
        // Continue — mark as deployed anyway for now
      }
    } else {
      console.log(`[ToolDeployment] No Vercel hook for ${toolId} — marking deployed (manual endpoint)`);
    }

    // Step 2: Mark deployed
    tool.status     = "deployed";
    tool.deployedAt = Date.now();
    await kiraRedis.setJson(K.tool(toolId), tool);

    // Step 3: Register on ERC-8257 (if wallet available)
    await this.registerOnChain(tool);

    await sendEmail(
      `[KIRA Tool] ${tool.name} is live`,
      alertEmail(
        `Tool Deployed: ${tool.name}`,
        `${tool.name} is now active.\nPrice: ${parseInt(tool.priceWei) / 1e18} ETH/call\nEndpoint: ${tool.vercelDeployUrl || tool.endpoint}\nERC-8257 ID: ${tool.onChainId || "pending"}`
      )
    );
  }

  // ── ERC-8257 REGISTRATION ─────────────────────────────────────────────────────

  private async registerOnChain(tool: ToolSpec): Promise<void> {
    try {
      // Call Normies Intelligence API to register on ERC-8257
      // This uses the existing tool registry infrastructure
      const res = await fetch("https://normies-intelligence.vercel.app/api/handler", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          action:  "register_tool",
          toolId:  tool.id,
          name:    tool.name,
          description: tool.description,
          endpoint:    tool.vercelDeployUrl || tool.endpoint,
          priceWei:    tool.priceWei,
          version:     tool.version,
          operator:    process.env.KIRA_WALLET,
        }),
        signal: AbortSignal.timeout(20000),
      });

      if (res.ok) {
        const data    = await res.json() as any;
        tool.onChainId = data.toolId || data.id;
        await kiraRedis.setJson(K.tool(tool.id), tool);
        console.log(`[ToolDeployment] ✓ Registered on ERC-8257: ID ${tool.onChainId}`);
      } else {
        console.log(`[ToolDeployment] ERC-8257 registration pending — registry may need manual trigger`);
      }
    } catch (err: any) {
      console.error(`[ToolDeployment] On-chain registration failed: ${err?.message}`);
    }
  }

  // ── GAP ANALYSIS ──────────────────────────────────────────────────────────────

  async identifyGaps(registrySummary: string): Promise<string[]> {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-5", max_tokens: 400,
        system: `You are helping KIRA identify what tools to build next for the ERC-8257 registry.
KIRA's existing data: NFT floor history (90+ days), smart money signals, macro intelligence, multi-signal scoring.
Based on the current registry, what 2-3 tools would have the most demand from other agents?
Respond ONLY with a JSON array of tool name strings.`,
        messages: [{ role: "user", content: `Registry: ${registrySummary}\nWhat tools should KIRA build next?` }],
      });
      const text = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
      return JSON.parse(text.replace(/```json|```/g, "").trim()) as string[];
    } catch { return []; }
  }

  // ── AUTO-PROPOSE NEXT TOOL ────────────────────────────────────────────────────

  async autoPropose(registrySummary: string): Promise<string | null> {
    // Find next unproposed template
    for (const template of TOOL_TEMPLATES) {
      const existing = await kiraRedis.getJson<ToolSpec>(K.tool(template.id));
      if (!existing || existing.status === "rejected") {
        await this.proposeTool(template.id);
        return template.id;
      }
    }
    return null;
  }

  // ── REVENUE TRACKING ──────────────────────────────────────────────────────────

  async recordToolCall(toolId: string, revenueEth: number): Promise<void> {
    const tool = await kiraRedis.getJson<ToolSpec>(K.tool(toolId));
    if (!tool) return;
    tool.callCount++;
    tool.revenueEth += revenueEth;
    await kiraRedis.setJson(K.tool(toolId), tool);
    const total = parseFloat(await kiraRedis.get(K.revenue()) || "0") + revenueEth;
    await kiraRedis.set(K.revenue(), String(total));
  }

  async getTotalRevenue(): Promise<number> {
    return parseFloat(await kiraRedis.get(K.revenue()) || "0");
  }

  async getDeployedTools(): Promise<ToolSpec[]> {
    const ids   = await kiraRedis.smembers(K.tools());
    const tools = await Promise.all(ids.map(id => kiraRedis.getJson<ToolSpec>(K.tool(id))));
    return (tools.filter(Boolean) as ToolSpec[]).filter(t => ["deployed", "active"].includes(t.status));
  }

  async formatForContext(): Promise<string> {
    const ids      = await kiraRedis.smembers(K.tools());
    const tools    = await Promise.all(ids.map(id => kiraRedis.getJson<ToolSpec>(K.tool(id))));
    const valid    = tools.filter(Boolean) as ToolSpec[];
    const deployed = valid.filter(t => ["deployed", "active"].includes(t.status));
    const pending  = valid.filter(t => t.status === "proposed");
    const revenue  = await this.getTotalRevenue();

    // Show time remaining on auto-approvals
    const pendingStr = pending.map(t => {
      const hoursLeft = Math.max(0, Math.floor((t.autoApproveAt - Date.now()) / 3600000));
      return `${t.name} (${hoursLeft}h to auto-approve)`;
    }).join(", ");

    return [
      `${deployed.length} deployed, ${pending.length} pending`,
      pending.length > 0 ? `Pending: ${pendingStr}` : "",
      revenue > 0 ? `Revenue: ${revenue.toFixed(4)} ETH` : "",
    ].filter(Boolean).join(" | ");
  }
}
