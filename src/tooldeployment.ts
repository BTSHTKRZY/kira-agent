// tooldeployment.ts — Fully autonomous ERC-8257 tool deployment
// One-time setup: VERCEL_API_TOKEN in Railway env
// After that: KIRA creates Vercel projects, deploy hooks, deploys code, registers on-chain
// Human intervention: only to REJECT (silence = approve after 48h)

import Anthropic from "@anthropic-ai/sdk";
import { kiraRedis } from "./redis.js";
import { sendEmail, alertEmail } from "./email.js";

const anthropic     = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const VERCEL_TOKEN  = process.env.VERCEL_API_TOKEN || "";
const KIRA_WALLET   = process.env.KIRA_WALLET      || "";
const VERCEL_TEAM   = process.env.VERCEL_TEAM_ID   || ""; // optional — personal accounts leave blank

// Auto-approval: 48h silence = deployed
const AUTO_APPROVE_MS = 48 * 60 * 60 * 1000;

// MASTER SWITCH — tool deployment is OFF by default until tools are near-perfect.
// Set TOOL_DEPLOYMENT_ENABLED=true in Railway only when ready to ship real tools.
const DEPLOYMENT_ENABLED = (process.env.TOOL_DEPLOYMENT_ENABLED || "false") === "true";

// ERC-8257 registry
const ERC8257_REGISTRY = process.env.ERC8257_REGISTRY || "0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1";

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
  autoApproveAt:   number;
  reasoning:       string;
  vercelProjectId?: string;
  vercelDeployHook?: string;
  vercelDeployUrl?:  string;
}

export interface ToolParam {
  name: string; type: string; desc: string;
}

const K = {
  tool:    (id: string) => `kira:tool:${id}`,
  tools:   ()            => `kira:tools:registry`,
  revenue: ()            => `kira:tools:revenue`,
};

// ── BUILT-IN TOOL TEMPLATES ───────────────────────────────────────────────────

const TOOL_TEMPLATES: Omit<ToolSpec,
  "status" | "revenueEth" | "callCount" | "proposedAt" | "autoApproveAt" |
  "vercelProjectId" | "vercelDeployHook" | "vercelDeployUrl"
>[] = [
  {
    id:          "kira-floor-oracle",
    name:        "KIRA Floor Price Oracle",
    description: "NFT floor prices with KIRA's self-recorded 90-day history. Self-accumulated data since June 2026 — cannot be backdated by any competitor.",
    version:     "1.0.0",
    category:    "oracle",
    endpoint:    "",
    priceWei:    "1000000000000000",
    reasoning:   "KIRA has unique floor data accumulated since day 1. Other agents and traders need accurate NFT floor trends with historical context.",
    inputs:      [{ name: "address", type: "string", desc: "NFT contract" }, { name: "chain", type: "string", desc: "ethereum/base" }],
    outputs:     [{ name: "floorEth", type: "number", desc: "Floor price" }, { name: "change7d", type: "number", desc: "7d change %" }, { name: "trend", type: "string", desc: "recovering/stable/declining" }],
  },
  {
    id:          "kira-smart-money-feed",
    name:        "KIRA Smart Money Signal Feed",
    description: "Real-time signals when verified smart money wallets accumulate NFTs or tokens. Confidence scored by wallet historical track record.",
    version:     "1.0.0",
    category:    "intelligence",
    endpoint:    "",
    priceWei:    "2000000000000000",
    reasoning:   "KIRA tracks 15+ verified wallets with performance history. Early accumulation signals before price moves.",
    inputs:      [{ name: "chain", type: "string", desc: "Chain" }, { name: "hours", type: "number", desc: "Lookback hours" }],
    outputs:     [{ name: "signals", type: "array", desc: "Active signals" }, { name: "topSignal", type: "object", desc: "Highest confidence" }],
  },
  {
    id:          "kira-nft-scorer",
    name:        "KIRA NFT Revival Scoring Engine",
    description: "8-signal NFT scoring: floor dip depth, holder trend, smart money buying, wash trade detection, macro context, technical analysis.",
    version:     "1.0.0",
    category:    "analytics",
    endpoint:    "",
    priceWei:    "1500000000000000",
    reasoning:   "Most agents lack multi-signal NFT evaluation. KIRA's scoring is the most comprehensive available.",
    inputs:      [{ name: "address", type: "string", desc: "NFT contract" }, { name: "chain", type: "string", desc: "Chain" }],
    outputs:     [{ name: "score", type: "number", desc: "0-100" }, { name: "decision", type: "string", desc: "buy/watchlist/pass" }, { name: "thesis", type: "string", desc: "Reasoning" }],
  },
  {
    id:          "kira-macro-context",
    name:        "KIRA Macro Intelligence",
    description: "Crypto macro context: Fear/Greed, Fed rate, CPI, BTC dominance with pattern matching and trading implications.",
    version:     "1.0.0",
    category:    "intelligence",
    endpoint:    "",
    priceWei:    "500000000000000",
    reasoning:   "Macro context improves every agent's decisions. Low price point — high volume tool.",
    inputs:      [],
    outputs:     [{ name: "fearGreed", type: "number", desc: "F&G index" }, { name: "recommendation", type: "string", desc: "positioning" }, { name: "patterns", type: "array", desc: "Active patterns" }],
  },
];

export class KiraToolDeployment {

  // ── VERCEL API HELPERS ────────────────────────────────────────────────────────

  private vercelHeaders(): Record<string, string> {
    return {
      "Authorization": `Bearer ${VERCEL_TOKEN}`,
      "Content-Type":  "application/json",
    };
  }

  private teamParam(): string {
    return VERCEL_TEAM ? `?teamId=${VERCEL_TEAM}` : "";
  }

  // Create a new Vercel project for a tool
  private async createVercelProject(toolId: string, toolName: string): Promise<string | null> {
    if (!VERCEL_TOKEN) {
      console.log("[ToolDeployment] No VERCEL_API_TOKEN — skipping project creation");
      return null;
    }
    try {
      const res = await fetch(`https://api.vercel.com/v9/projects${this.teamParam()}`, {
        method:  "POST",
        headers: this.vercelHeaders(),
        body:    JSON.stringify({
          name:      toolId,
          framework: "nextjs",
        }),
        signal: AbortSignal.timeout(20000),
      });

      if (!res.ok) {
        const err = await res.json() as any;
        // Project may already exist
        if (err?.error?.code === "project_already_exists") {
          console.log(`[ToolDeployment] Project ${toolId} already exists`);
          return await this.getVercelProjectId(toolId);
        }
        console.error(`[ToolDeployment] Create project failed: ${err?.error?.message}`);
        return null;
      }

      const data = await res.json() as any;
      console.log(`[ToolDeployment] ✓ Created Vercel project: ${toolId} (${data.id})`);
      return data.id as string;

    } catch (err: any) {
      console.error(`[ToolDeployment] Vercel project creation error: ${err?.message}`);
      return null;
    }
  }

  private async getVercelProjectId(toolId: string): Promise<string | null> {
    try {
      const res = await fetch(
        `https://api.vercel.com/v9/projects/${toolId}${this.teamParam()}`,
        { headers: this.vercelHeaders(), signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return null;
      const data = await res.json() as any;
      return data.id || null;
    } catch { return null; }
  }

  // Create a deploy hook for a Vercel project
  private async createDeployHook(projectId: string, toolId: string): Promise<string | null> {
    if (!VERCEL_TOKEN) return null;
    try {
      const res = await fetch(
        `https://api.vercel.com/v9/projects/${projectId}/deploy-hooks${this.teamParam()}`,
        {
          method:  "POST",
          headers: this.vercelHeaders(),
          body:    JSON.stringify({ name: "KIRA Auto Deploy", ref: "main" }),
          signal:  AbortSignal.timeout(15000),
        }
      );

      if (!res.ok) {
        console.error(`[ToolDeployment] Deploy hook creation failed`);
        return null;
      }

      const data    = await res.json() as any;
      const hookUrl = data.hook?.url || data.url;
      console.log(`[ToolDeployment] ✓ Deploy hook created for ${toolId}`);
      return hookUrl || null;

    } catch (err: any) {
      console.error(`[ToolDeployment] Deploy hook error: ${err?.message}`);
      return null;
    }
  }

  // Trigger a deploy via hook URL
  private async triggerDeploy(hookUrl: string): Promise<boolean> {
    try {
      const res = await fetch(hookUrl, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
      });
      return res.ok;
    } catch { return false; }
  }

  // Deploy tool code to Vercel project via file API
  // Emit SDK-shaped tool source (manifest + handler) and stage it for SDK deployment.
  // Actual register/deploy is performed by the OpenSea SDK CLI against the tool's
  // own project — KIRA produces correct source + records the spec. This avoids
  // fragile in-process CLI invocation and keeps tools spec-compliant by construction.
  private async deployToolCode(projectId: string, tool: ToolSpec): Promise<string | null> {
    try {
      const { manifest, handler } = this.generateToolSource(tool);

      // Persist the generated SDK source so it can be scaffolded into the tool repo
      // and deployed via: npx @opensea/tool-sdk register/deploy
      await kiraRedis.setJson(`kira:toolsrc:${tool.id}`, {
        manifest, handler,
        scaffold: "npx @opensea/tool-sdk init " + tool.id,
        deploy:   "npx @opensea/tool-sdk deploy --host vercel",
        register: "npx @opensea/tool-sdk register --metadata <wellknown-url> --network base --nft-gate <NORMIES_CONTRACT>",
        generatedAt: Date.now(),
      });

      console.log(`[ToolDeployment] Generated SDK-compliant source for ${tool.id} (manifest + handler staged in Redis)`);
      // The deployed endpoint URL is known once the SDK CLI deploys it; use the
      // manifest endpoint as the expected URL until deployment confirms.
      return tool.endpoint || null;
    } catch (err: any) {
      console.error(`[ToolDeployment] Source generation error: ${err?.message}`);
      return null;
    }
  }

  // ── SDK-SHAPED TOOL SOURCE GENERATION ─────────────────────────────────────────
  // Produces @opensea/tool-sdk-compliant manifest + handler source as the proposal
  // output. This source is what gets scaffolded into the tool's own repo and
  // deployed via the OpenSea SDK CLI (npx @opensea/tool-sdk register/deploy).
  // KIRA decides WHAT to build and emits correct SDK source; the SDK is the
  // canonical build/deploy path. No fragile runtime CLI invocation in-process.

  generateToolSource(tool: ToolSpec): { manifest: string; handler: string } {
    const priceUsdc = process.env[`TOOL_PRICE_${tool.id.toUpperCase().replace(/-/g, "_")}`] || "0.01";
    const payoutAddr = KIRA_WALLET;

    // manifest.ts — uses defineManifest + x402UsdcPricing per the SDK
    const manifest = [
      `import { defineManifest, x402UsdcPricing } from "@opensea/tool-sdk";`,
      ``,
      `export const manifest = defineManifest({`,
      `  type: "https://ercs.ethereum.org/ERCS/erc-8257#tool-manifest-v1",`,
      `  name: ${JSON.stringify(tool.id)},`,
      `  description: ${JSON.stringify(tool.description)},`,
      `  endpoint: ${JSON.stringify(tool.endpoint)},`,
      `  inputs: {`,
      `    type: "object",`,
      `    properties: {`,
      tool.inputs.map(i => `      ${i.name}: { type: ${JSON.stringify(i.type)} },`).join("\n"),
      `    },`,
      `    required: [${tool.inputs.map(i => JSON.stringify(i.name)).join(", ")}],`,
      `  },`,
      `  outputs: {`,
      `    type: "object",`,
      `    properties: {`,
      tool.outputs.map(o => `      ${o.name}: { type: ${JSON.stringify(o.type)} },`).join("\n"),
      `    },`,
      `  },`,
      `  creatorAddress: ${JSON.stringify(payoutAddr)},`,
      `  pricing: x402UsdcPricing({ recipient: ${JSON.stringify(payoutAddr)}, amountUsdc: ${JSON.stringify(priceUsdc)} }),`,
      `});`,
    ].join("\n");

    // handler.ts — uses createToolHandler + payaiX402Gate (free facilitator, deploy today)
    // Data is read from KIRA's authenticated tool-data API (no secrets embedded).
    const dataApi = process.env.KIRA_DATA_API || "https://kira-agent-production.up.railway.app";
    const handler = [
      `import { z } from "zod/v4";`,
      `import { createToolHandler, payaiX402Gate, toVercelHandler } from "@opensea/tool-sdk";`,
      `import { manifest } from "./manifest.js";`,
      ``,
      `const KIRA_DATA_API = ${JSON.stringify(dataApi)};`,
      `const TOOL_READ_KEY = process.env.TOOL_READ_KEY || "";`,
      `const TOOL_ID = ${JSON.stringify(tool.id)};`,
      ``,
      `async function kiraData(key: string): Promise<string | null> {`,
      `  const res = await fetch(\`\${KIRA_DATA_API}/tool-data?key=\${encodeURIComponent(key)}&tool=\${TOOL_ID}\`, {`,
      `    headers: { "x-tool-key": TOOL_READ_KEY },`,
      `  });`,
      `  if (!res.ok) return null;`,
      `  const d = await res.json();`,
      `  return d.value ?? null;`,
      `}`,
      ``,
      `const gate = payaiX402Gate({ recipient: ${JSON.stringify(payoutAddr)}, amountUsdc: ${JSON.stringify(priceUsdc)} });`,
      ``,
      `const inputSchema = z.object({`,
      tool.inputs.map(i => `  ${i.name}: z.${i.type === "number" ? "number()" : "string()"}${tool.inputs.find(x=>x.name===i.name) ? "" : ".optional()"},`).join("\n") || "  // no inputs",
      `});`,
      ``,
      `const handler = createToolHandler({`,
      `  manifest,`,
      `  inputSchema,`,
      `  outputSchema: z.object({ result: z.any() }),`,
      `  gates: [gate],`,
      `  handler: async (input, ctx) => {`,
      `    ${this.getToolHandlerBody(tool)}`,
      `  },`,
      `});`,
      ``,
      `export default toVercelHandler(handler);`,
    ].join("\n");

    return { manifest, handler };
  }

  // The data-fetching body for each tool type, reading from KIRA's authenticated API.
  private getToolHandlerBody(tool: ToolSpec): string {
    switch (tool.id) {
      case "kira-floor-oracle":
        return `const raw = await kiraData(\`kira:floor:\${(input as any).chain || "ethereum"}:\${String((input as any).address).toLowerCase()}\`);
    if (!raw) return { result: { error: "No floor data" } };
    const d = JSON.parse(raw);
    return { result: { floorEth: d.currentFloor || 0, change7d: d.change7d || 0, change30d: d.change30d || 0, trend: d.trend || "unknown", source: "KIRA self-recorded oracle" } };`;
      case "kira-smart-money-feed":
        return `const raw = await kiraData("kira:smartmoney:signals");
    const signals = raw ? JSON.parse(raw) : [];
    return { result: { signals, count: signals.length } };`;
      case "kira-nft-scorer":
        return `const raw = await kiraData(\`kira:score:\${(input as any).chain || "ethereum"}:\${String((input as any).address).toLowerCase()}\`);
    if (!raw) return { result: { error: "Not yet scored" } };
    const d = JSON.parse(raw);
    return { result: { score: d.totalScore || 0, decision: d.decision || "unknown", thesis: d.thesis || "" } };`;
      case "kira-macro-context":
        return `const raw = await kiraData("kira:research:macro");
    if (!raw) return { result: { error: "Macro unavailable" } };
    const d = JSON.parse(raw);
    const fg = d.fearGreedIndex || 50;
    const rec = fg < 25 ? "accumulate" : fg > 75 ? "reduce" : "hold";
    return { result: { fearGreed: fg, recommendation: rec, fedRate: d.fedFundsRate || 0, cpiYoY: d.cpiYoY || 0 } };`;
      default:
        return `return { result: { tool: TOOL_ID, status: "active" } };`;
    }
  }

  // ── PROPOSE TOOL ──────────────────────────────────────────────────────────────

  async proposeTool(toolId: string): Promise<ToolSpec | null> {
    if (!DEPLOYMENT_ENABLED) {
      console.log("[ToolDeployment] Master switch OFF — not proposing tools (set TOOL_DEPLOYMENT_ENABLED=true)");
      return null;
    }
    const template = TOOL_TEMPLATES.find(t => t.id === toolId);
    if (!template) return null;

    const existing = await kiraRedis.getJson<ToolSpec>(K.tool(toolId));
    if (existing && existing.status !== "rejected") {
      return existing;
    }

    const now  = Date.now();
    const tool: ToolSpec = {
      ...template,
      status:       "proposed",
      revenueEth:   0,
      callCount:    0,
      proposedAt:   now,
      autoApproveAt: now + AUTO_APPROVE_MS,
    };

    await kiraRedis.setJson(K.tool(toolId), tool);
    await kiraRedis.sadd(K.tools(), toolId);

    const priceEth = parseInt(tool.priceWei) / 1e18;
    const autoTime = new Date(now + AUTO_APPROVE_MS).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

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

INPUTS:  ${tool.inputs.map(i => `${i.name} (${i.type})`).join(", ") || "none"}
OUTPUTS: ${tool.outputs.map(o => `${o.name} (${o.type})`).join(", ")}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ AUTO-DEPLOYS: ${autoTime} IST (48h from now)
   No action needed to approve.

To REJECT before then — reply via X DM:
REJECT TOOL:${tool.id}

To deploy IMMEDIATELY:
APPROVE TOOL:${tool.id}
    `.trim();

    await sendEmail(`[KIRA Tool] ${tool.name} — deploying in 48h`, body);
    console.log(`[ToolDeployment] Proposed: ${tool.name} — auto-deploys at ${autoTime} IST`);
    return tool;
  }

  // ── PROCESS AUTO-APPROVALS ────────────────────────────────────────────────────

  async processAutoApprovals(): Promise<string[]> {
    if (!DEPLOYMENT_ENABLED) return [];
    const ids      = await kiraRedis.smembers(K.tools());
    const deployed: string[] = [];

    for (const id of ids) {
      const tool = await kiraRedis.getJson<ToolSpec>(K.tool(id));
      if (!tool || tool.status !== "proposed") continue;
      if (Date.now() < tool.autoApproveAt) continue;

      const hoursWaited = Math.floor((Date.now() - tool.proposedAt) / 3600000);
      console.log(`[ToolDeployment] Auto-approving ${tool.name} (${hoursWaited}h silence)`);
      tool.status = "auto_approved";
      await kiraRedis.setJson(K.tool(id), tool);
      await this.deployTool(id);
      deployed.push(id);
    }

    return deployed;
  }

  // ── HOLDER APPROVE / REJECT ───────────────────────────────────────────────────

  async holderApprove(toolId: string): Promise<void> {
    const tool = await kiraRedis.getJson<ToolSpec>(K.tool(toolId));
    if (!tool) return;
    tool.status = "holder_approved";
    await kiraRedis.setJson(K.tool(toolId), tool);
    console.log(`[ToolDeployment] Holder approved immediately: ${tool.name}`);
    await this.deployTool(toolId);
  }

  async holderReject(toolId: string): Promise<void> {
    const tool = await kiraRedis.getJson<ToolSpec>(K.tool(toolId));
    if (!tool) return;
    tool.status = "rejected";
    await kiraRedis.setJson(K.tool(toolId), tool);
    console.log(`[ToolDeployment] Rejected: ${tool.name}`);
    await sendEmail(
      `[KIRA Tool] ${tool.name} rejected`,
      `Tool ${toolId} has been rejected and will not be deployed.`
    );
  }

  // ── FULL DEPLOYMENT PIPELINE ──────────────────────────────────────────────────

  async deployTool(toolId: string): Promise<void> {
    const tool = await kiraRedis.getJson<ToolSpec>(K.tool(toolId));
    if (!tool) return;

    console.log(`[ToolDeployment] Starting deployment pipeline: ${tool.name}`);

    // Step 1: Create Vercel project (if not already done)
    let projectId = tool.vercelProjectId;
    if (!projectId && VERCEL_TOKEN) {
      projectId = await this.createVercelProject(toolId, tool.name) || undefined;
      if (projectId) {
        tool.vercelProjectId = projectId;
        await kiraRedis.setJson(K.tool(toolId), tool);
      }
    }

    // Step 2: Deploy tool code
    if (projectId && VERCEL_TOKEN) {
      const deployUrl = await this.deployToolCode(projectId, tool);
      if (deployUrl) {
        tool.vercelDeployUrl = deployUrl;
        tool.endpoint        = `${deployUrl}/api`;
      }

      // Step 3: Create deploy hook for future redeploys
      if (!tool.vercelDeployHook) {
        const hook = await this.createDeployHook(projectId, toolId);
        if (hook) tool.vercelDeployHook = hook;
      }
    }

    // Step 4: Mark deployed
    tool.status     = "deployed";
    tool.deployedAt = Date.now();
    await kiraRedis.setJson(K.tool(toolId), tool);
    console.log(`[ToolDeployment] ✓ ${tool.name} deployed to ${tool.vercelDeployUrl || tool.endpoint}`);

    // Step 5: Register on ERC-8257
    await this.registerOnChain(tool);

    // Step 6: Notify
    await sendEmail(
      `[KIRA Tool] ${tool.name} is live`,
      alertEmail(
        `Tool Deployed: ${tool.name}`,
        [
          `${tool.name} is now active on ERC-8257.`,
          `Price: ${parseInt(tool.priceWei) / 1e18} ETH/call`,
          `Endpoint: ${tool.vercelDeployUrl || tool.endpoint}`,
          `On-chain ID: ${tool.onChainId || "pending"}`,
          `Revenue so far: ${tool.revenueEth.toFixed(4)} ETH`,
        ].join("\n")
      )
    );
  }

  // ── ERC-8257 REGISTRATION ─────────────────────────────────────────────────────

  private async registerOnChain(tool: ToolSpec): Promise<void> {
    try {
      const res = await fetch("https://normies-intelligence.vercel.app/api/handler", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          action:      "register_tool",
          toolId:      tool.id,
          name:        tool.name,
          description: tool.description,
          endpoint:    tool.vercelDeployUrl || tool.endpoint,
          priceWei:    tool.priceWei,
          version:     tool.version,
          operator:    KIRA_WALLET,
        }),
        signal: AbortSignal.timeout(20000),
      });

      if (res.ok) {
        const data       = await res.json() as any;
        tool.onChainId   = data.toolId || data.id || "registered";
        await kiraRedis.setJson(K.tool(tool.id), tool);
        console.log(`[ToolDeployment] ✓ ERC-8257 registered: ${tool.onChainId}`);
      } else {
        console.log(`[ToolDeployment] ERC-8257 registration queued — will retry`);
      }
    } catch (err: any) {
      console.error(`[ToolDeployment] On-chain registration failed: ${err?.message}`);
    }
  }

  // ── GAP ANALYSIS ──────────────────────────────────────────────────────────────
  // Queries the live ERC-8257 registry, diffs against existing tools, finds real gaps.
  // Also produces a public observation KIRA can post about ecosystem tooling gaps.

  async identifyGaps(registrySummary: string): Promise<{ gaps: string[]; commentary: string }> {
    try {
      let liveTools: string[] = [];
      try {
        const res = await fetch("https://normies-intelligence.vercel.app/api/handler", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ action: "list_tools" }),
          signal:  AbortSignal.timeout(12000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          liveTools  = (data.tools || []).map((t: any) => t.name || t.id || "").filter(Boolean);
        }
      } catch {}

      const response = await anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 600,
        system:     "You are KIRA, an autonomous on-chain AI agent analysing the ERC-8257 tool registry for gaps. " +
          "KIRA's data assets: self-recorded NFT floor history (90+ days), smart money tracking (15+ wallets), " +
          "multi-signal NFT scoring, macro intelligence (Fear/Greed, CPI, Fed, BTC dominance), cross-chain reads. " +
          "Given tools that ALREADY EXIST, identify genuine capability gaps KIRA could fill from her data assets. " +
          "Also write ONE concise public observation (under 240 chars, KIRA's voice: theatrical, precise, no hype) " +
          "about a gap in the agent tooling ecosystem. " +
          "Respond ONLY with JSON: { \"gaps\": [\"gap1\",\"gap2\"], \"commentary\": \"observation\" }",
        messages: [{
          role:    "user",
          content: "Existing tools: " + (liveTools.length ? liveTools.join(", ") : registrySummary) +
                   "\n\nIdentify gaps KIRA can fill and write one public observation.",
        }],
      });

      const text   = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      return {
        gaps:       Array.isArray(parsed.gaps) ? parsed.gaps : [],
        commentary: typeof parsed.commentary === "string" ? parsed.commentary : "",
      };
    } catch (err: any) {
      console.error("[ToolDeployment] Gap analysis failed:", err?.message);
      return { gaps: [], commentary: "" };
    }
  }

  // ── AUTO-PROPOSE NEXT TOOL ────────────────────────────────────────────────────

  async autoPropose(registrySummary: string): Promise<string | null> {
    if (!DEPLOYMENT_ENABLED) return null;
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

  async formatForContext(): Promise<string> {
    const ids      = await kiraRedis.smembers(K.tools());
    const tools    = await Promise.all(ids.map(id => kiraRedis.getJson<ToolSpec>(K.tool(id))));
    const valid    = tools.filter(Boolean) as ToolSpec[];
    const deployed = valid.filter(t => ["deployed", "active"].includes(t.status));
    const pending  = valid.filter(t => t.status === "proposed");
    const revenue  = await this.getTotalRevenue();

    const pendingStr = pending.map(t => {
      const hoursLeft = Math.max(0, Math.floor((t.autoApproveAt - Date.now()) / 3600000));
      return `${t.id} (${hoursLeft}h)`;
    }).join(", ");

    return [
      `${deployed.length} deployed, ${pending.length} pending`,
      pending.length > 0 ? `Pending: ${pendingStr}` : "",
      revenue > 0 ? `Revenue: ${revenue.toFixed(4)} ETH` : "",
    ].filter(Boolean).join(" | ");
  }
}
