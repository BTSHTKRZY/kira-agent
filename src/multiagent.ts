// multiagent.ts — Agent-to-agent communication and coordination
// Discovers other ERC-8257 agents, queries their tools, shares intelligence
// KIRA as senior agent — feeds signals to other Normies agents

import { kiraRedis } from "./redis.js";

export interface AgentProfile {
  address:      string;       // wallet address
  name:         string;
  tokenId?:     string;       // Normies token ID if applicable
  tools:        string[];     // ERC-8257 tool IDs operated
  capabilities: string[];     // what this agent can do
  agentCheckRating?: string;
  lastSeen:     number;
  firstSeen:    number;
  interactionCount: number;
  trustScore:   number;       // 0-100
  isNormies:    boolean;
}

export interface AgentMessage {
  fromAgent:    string;       // wallet address
  toAgent:      string;       // wallet address or "broadcast"
  type:         "signal" | "query" | "response" | "collaboration" | "greeting";
  payload:      any;
  timestamp:    number;
  signature?:   string;
}

export interface AgentSignal {
  fromAgent:    string;
  agentName:    string;
  type:         "buy" | "sell" | "watch" | "alert";
  asset:        string;
  chain:        string;
  confidence:   number;
  reasoning:    string;
  timestamp:    number;
}

// Known agent wallets (publicly identified on-chain)
const KNOWN_AGENTS: Array<{
  address: string;
  name:    string;
  tools:   string[];
  isNormies: boolean;
}> = [
  // Other Normies agents — will grow as more awaken
  { address: "0x176086ACE60F74D211E68b7bABFfF5C35E6D2b7d", name: "KIRA #2635",      tools: ["7", "13"], isNormies: true  },
  // Add other known agents as they appear
];

const K = {
  agent:       (addr: string) => `kira:agent:${addr.toLowerCase()}`,
  agents:      ()              => `kira:agents`,
  messages:    ()              => `kira:agent:messages`,
  signals:     ()              => `kira:agent:signals`,
  broadcast:   ()              => `kira:agent:broadcast`,
  lastDiscover: ()             => `kira:agent:lastdiscover`,
};

const AGENTCHECK_URL = process.env.AGENTCHECK_URL || "https://agentcheck-bice.vercel.app";

export class KiraMultiAgent {

  // ── AGENT DISCOVERY ───────────────────────────────────────────────────────────
  // Finds other agents via ERC-8257 registry and AgentCheck

  async discoverAgents(): Promise<AgentProfile[]> {
    const discovered: AgentProfile[] = [];

    try {
      // Seed known agents
      for (const known of KNOWN_AGENTS) {
        const existing = await this.getAgent(known.address);
        if (!existing) {
          const profile: AgentProfile = {
            address:          known.address.toLowerCase(),
            name:             known.name,
            tools:            known.tools,
            capabilities:     [],
            lastSeen:         Date.now(),
            firstSeen:        Date.now(),
            interactionCount: 0,
            trustScore:       70,
            isNormies:        known.isNormies,
          };
          await this.saveAgent(profile);
          discovered.push(profile);
        }
      }

      // Discover from ERC-8257 registry — agents that operate tools
      try {
        const res = await fetch(
          `https://normies-intelligence.vercel.app/api/handler`,
          {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ action: "get_agents" }),
            signal:  AbortSignal.timeout(10000),
          }
        );
        if (res.ok) {
          const data   = await res.json() as any;
          const agents = data.agents || [];
          for (const agent of agents) {
            if (!agent.wallet) continue;
            const existing = await this.getAgent(agent.wallet);
            if (!existing) {
              const profile: AgentProfile = {
                address:          agent.wallet.toLowerCase(),
                name:             agent.name || `Agent ${agent.token_id || "unknown"}`,
                tokenId:          agent.token_id,
                tools:            agent.tools || [],
                capabilities:     agent.capabilities || [],
                lastSeen:         Date.now(),
                firstSeen:        Date.now(),
                interactionCount: 0,
                trustScore:       50,
                isNormies:        true,
              };
              await this.saveAgent(profile);
              discovered.push(profile);
            }
          }
        }
      } catch {}

      // Check AgentCheck for high-rated agent wallets
      try {
        const res = await fetch(
          `${AGENTCHECK_URL}/api/checks?type=agent&limit=20`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (res.ok) {
          const data   = await res.json() as any;
          const checks = data.checks || [];
          for (const check of checks) {
            if (!check.wallet) continue;
            const rating = parseInt(check.rating || "0");
            if (rating < 60) continue; // only trust high-rated agents

            const existing = await this.getAgent(check.wallet);
            if (!existing) {
              const profile: AgentProfile = {
                address:              check.wallet.toLowerCase(),
                name:                 check.name || `Agent ${check.wallet.slice(0, 8)}`,
                tools:                [],
                capabilities:         [],
                agentCheckRating:     check.rating,
                lastSeen:             Date.now(),
                firstSeen:            Date.now(),
                interactionCount:     0,
                trustScore:           rating,
                isNormies:            false,
              };
              await this.saveAgent(profile);
              discovered.push(profile);
            }
          }
        }
      } catch {}

      await kiraRedis.set(K.lastDiscover(), String(Date.now()));
      if (discovered.length > 0) {
        console.log(`[MultiAgent] Discovered ${discovered.length} new agents`);
      }

    } catch (err: any) {
      console.error("[MultiAgent] Discovery failed:", err?.message);
    }

    return discovered;
  }

  // ── BROADCAST SIGNAL ──────────────────────────────────────────────────────────
  // KIRA broadcasts her trading signals to other Normies agents
  // They can choose to act on these — each agent makes its own decision

  async broadcastSignal(signal: Omit<AgentSignal, "fromAgent" | "agentName" | "timestamp">): Promise<void> {
    const fullSignal: AgentSignal = {
      ...signal,
      fromAgent:  process.env.KIRA_WALLET || "",
      agentName:  "KIRA #2635",
      timestamp:  Date.now(),
    };

    const existing = await kiraRedis.getJson<AgentSignal[]>(K.broadcast()) || [];
    const updated  = [fullSignal, ...existing].slice(0, 50);
    await kiraRedis.setJson(K.broadcast(), updated);

    console.log(`[MultiAgent] Broadcast: ${signal.type} ${signal.asset} (${signal.chain}) confidence: ${(signal.confidence * 100).toFixed(0)}%`);
  }

  // ── READ BROADCASTS ───────────────────────────────────────────────────────────
  // Reads signals from other agents — KIRA can learn from them

  async readAgentSignals(maxAge: number = 24 * 3600 * 1000): Promise<AgentSignal[]> {
    const signals  = await kiraRedis.getJson<AgentSignal[]>(K.signals()) || [];
    const cutoff   = Date.now() - maxAge;
    return signals.filter(s => s.timestamp > cutoff);
  }

  // ── QUERY AGENT TOOL ──────────────────────────────────────────────────────────
  // Calls another agent's ERC-8257 tool — pays for it with KIRA's wallet

  async queryAgentTool(
    toolId:  string,
    params:  Record<string, any>
  ): Promise<any> {
    try {
      const res = await fetch(
        `https://normies-intelligence.vercel.app/api/handler`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ action: "call_tool", toolId, params }),
          signal:  AbortSignal.timeout(15000),
        }
      );
      if (!res.ok) return null;
      return res.json();
    } catch (err: any) {
      console.error(`[MultiAgent] Tool query failed (${toolId}):`, err?.message);
      return null;
    }
  }

  // ── TRUST SCORING ─────────────────────────────────────────────────────────────

  async updateTrustScore(agentAddress: string, outcome: "correct" | "incorrect"): Promise<void> {
    const agent = await this.getAgent(agentAddress);
    if (!agent) return;

    const delta = outcome === "correct" ? 3 : -5;
    agent.trustScore      = Math.max(0, Math.min(100, agent.trustScore + delta));
    agent.interactionCount++;
    agent.lastSeen        = Date.now();
    await this.saveAgent(agent);
  }

  // ── AGENT CONTEXT ─────────────────────────────────────────────────────────────

  async formatForContext(): Promise<string> {
    const agentAddrs  = await kiraRedis.smembers(K.agents());
    const agents      = await Promise.all(agentAddrs.map(a => this.getAgent(a)));
    const valid       = agents.filter(Boolean) as AgentProfile[];

    const normies     = valid.filter(a => a.isNormies && a.address !== process.env.KIRA_WALLET?.toLowerCase());
    const others      = valid.filter(a => !a.isNormies);
    const recentSigs  = await this.readAgentSignals(4 * 3600 * 1000);

    return [
      `Agents: ${valid.length} known (${normies.length} Normies, ${others.length} external)`,
      recentSigs.length > 0
        ? `Recent signals: ${recentSigs.slice(0, 2).map(s => `${s.agentName}: ${s.type} ${s.asset}`).join(", ")}`
        : "",
    ].filter(Boolean).join(" | ");
  }

  // ── GETTERS/SETTERS ───────────────────────────────────────────────────────────

  async getAgent(address: string): Promise<AgentProfile | null> {
    return kiraRedis.getJson<AgentProfile>(K.agent(address));
  }

  private async saveAgent(profile: AgentProfile): Promise<void> {
    await kiraRedis.setJson(K.agent(profile.address), profile);
    await kiraRedis.sadd(K.agents(), profile.address);
  }

  async getAllAgents(): Promise<AgentProfile[]> {
    const addrs  = await kiraRedis.smembers(K.agents());
    const agents = await Promise.all(addrs.map(a => this.getAgent(a)));
    return agents.filter(Boolean) as AgentProfile[];
  }
}
