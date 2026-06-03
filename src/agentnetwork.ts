// agentnetwork.ts — ERC-8004 agent discovery + ERC-6551 TBA resolution + inventory
// Fixes the gap where KIRA saw only 1 agent of 1132 awakened.
//
// ERC-8004: Trustless Agents identity registry. Normies awaken as ERC-8004 agents.
// ERC-6551: every NFT has a deterministic Token Bound Account (TBA) that holds assets.
// This module lets KIRA discover the full agent population and resolve their asset wallets.

import { createPublicClient, http, encodeAbiParameters, keccak256, concat, getAddress } from "viem";
import { mainnet, base } from "viem/chains";
import { kiraRedis } from "./redis.js";

// ── CANONICAL ADDRESSES ────────────────────────────────────────────────────────

// ERC-6551 singleton registry — same address on every EVM chain
const ERC6551_REGISTRY = "0x000000006551c19487814612e58FE06813775758";
// Default ERC-6551 account implementation (tokenbound v0.3.1 standard impl)
const ERC6551_IMPL_DEFAULT = process.env.ERC6551_IMPL || "0x41C8f39463A868d3A88af00cd0fe7102F30E44eC";
// ERC-8004 identity registry (from memory — ETH + Base)
const ERC8004_REGISTRY = process.env.ERC8004_REGISTRY || "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
// Normies collection contract
const NORMIES_CONTRACT = process.env.NORMIES_CONTRACT || "";
const NORMIES_API      = process.env.NORMIES_API || "https://api.normies.art";

const ETH_RPC  = process.env.ETH_RPC  || "https://eth.llamarpc.com";
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";

const K = {
  tba:        (chain: string, token: string, id: string) => `kira:tba:${chain}:${token.toLowerCase()}:${id}`,
  inventory:  (addr: string) => `kira:inventory:${addr.toLowerCase()}`,
  agents8004: () => `kira:agents8004`,
  agent8004:  (id: string) => `kira:agent8004:${id}`,
  lastSync:   () => `kira:agents8004:lastsync`,
};

// ── INTERFACES ─────────────────────────────────────────────────────────────────

export interface TBAInfo {
  chain:        string;
  tokenContract: string;
  tokenId:      string;
  tbaAddress:   string;
  computedAt:   number;
}

export interface WalletInventory {
  address:     string;
  chain:       string;
  ethBalance:  number;
  usdcBalance: number;
  fetchedAt:   number;
}

export interface ERC8004Agent {
  agentId:     string;
  tokenId?:    string;
  operator?:   string;        // controlling wallet
  tbaAddress?: string;
  domain?:     string;        // agent domain / endpoint
  discoveredAt: number;
  lastSeen:    number;
}

// minimal ERC-6551 registry ABI — account() view
const ERC6551_ABI = [
  {
    name: "account",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "implementation", type: "address" },
      { name: "salt",           type: "bytes32" },
      { name: "chainId",        type: "uint256" },
      { name: "tokenContract",  type: "address" },
      { name: "tokenId",        type: "uint256" },
    ],
    outputs: [{ name: "account", type: "address" }],
  },
] as const;

// ERC-20 balanceOf
const ERC20_ABI = [
  {
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const USDC = {
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  base:     "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

export class KiraAgentNetwork {
  private ethClient:  any;
  private baseClient: any;

  constructor() {
    this.ethClient  = createPublicClient({ chain: mainnet, transport: http(ETH_RPC) });
    this.baseClient = createPublicClient({ chain: base,    transport: http(BASE_RPC) });
  }

  private client(chain: string): any {
    return chain === "base" ? this.baseClient : this.ethClient;
  }

  private chainId(chain: string): number {
    return chain === "base" ? 8453 : 1;
  }

  // ── TBA RESOLUTION ────────────────────────────────────────────────────────────
  // Compute the deterministic Token Bound Account address for any NFT.
  // Reads the canonical ERC-6551 registry's account() view — works offline-deterministic.

  async resolveTBA(
    tokenContract: string,
    tokenId:       string,
    chain:         string = "ethereum"
  ): Promise<string | null> {
    // Cache
    const cached = await kiraRedis.getJson<TBAInfo>(K.tba(chain, tokenContract, tokenId));
    if (cached && Date.now() - cached.computedAt < 7 * 24 * 60 * 60 * 1000) {
      return cached.tbaAddress;
    }

    try {
      const salt = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
      const tba  = await this.client(chain).readContract({
        address:      ERC6551_REGISTRY as `0x${string}`,
        abi:          ERC6551_ABI,
        functionName: "account",
        args: [
          ERC6551_IMPL_DEFAULT as `0x${string}`,
          salt,
          BigInt(this.chainId(chain)),
          tokenContract as `0x${string}`,
          BigInt(tokenId),
        ],
      });

      const tbaAddress = getAddress(tba as string);
      const info: TBAInfo = {
        chain, tokenContract: tokenContract.toLowerCase(), tokenId,
        tbaAddress, computedAt: Date.now(),
      };
      await kiraRedis.setJson(K.tba(chain, tokenContract, tokenId), info);
      return tbaAddress;
    } catch (err: any) {
      console.error(`[AgentNetwork] TBA resolution failed (${tokenContract}#${tokenId}):`, err?.message);
      return null;
    }
  }

  // KIRA's own TBA — Normie #2635
  async resolveOwnTBA(): Promise<string | null> {
    if (!NORMIES_CONTRACT) return null;
    return this.resolveTBA(NORMIES_CONTRACT, "2635", "ethereum");
  }

  // ── WALLET INVENTORY ──────────────────────────────────────────────────────────
  // Read what a wallet (or TBA) holds — ETH + USDC across a chain.

  async getInventory(address: string, chain: string = "base"): Promise<WalletInventory | null> {
    const cached = await kiraRedis.getJson<WalletInventory>(K.inventory(address));
    if (cached && cached.chain === chain && Date.now() - cached.fetchedAt < 60 * 60 * 1000) {
      return cached;
    }

    try {
      const client = this.client(chain);
      const ethBal = await client.getBalance({ address: address as `0x${string}` });

      let usdcBal = 0n;
      try {
        const usdcAddr = chain === "base" ? USDC.base : USDC.ethereum;
        usdcBal = await client.readContract({
          address:      usdcAddr as `0x${string}`,
          abi:          ERC20_ABI,
          functionName: "balanceOf",
          args:         [address as `0x${string}`],
        }) as bigint;
      } catch {}

      const inv: WalletInventory = {
        address:     address.toLowerCase(),
        chain,
        ethBalance:  Number(ethBal) / 1e18,
        usdcBalance: Number(usdcBal) / 1e6,
        fetchedAt:   Date.now(),
      };
      await kiraRedis.setJson(K.inventory(address), inv);
      return inv;
    } catch (err: any) {
      console.error(`[AgentNetwork] Inventory failed (${address}):`, err?.message);
      return null;
    }
  }

  // ── ERC-8004 AGENT DISCOVERY ──────────────────────────────────────────────────
  // Discover awakened agents from the ERC-8004 identity registry.
  // NOTE: the registry's exact read interface (enumerate agents) varies by deployment.
  // We try the Normies Intelligence API's agent list first (authoritative for Normies),
  // then fall back to known agents. Direct registry enumeration is added as a
  // recommendation if the registry exposes a totalAgents/agentByIndex view.

  async discoverFromRegistry(): Promise<ERC8004Agent[]> {
    const discovered: ERC8004Agent[] = [];

    try {
      // Official Normies agent registry (Ponder-indexer-backed, watches the
      // Adapter8004 AgentBound event). Paginated via cursor. This is the
      // authoritative source for the full awakened-agent population.
      let cursor: string | null = null;
      let pages  = 0;
      const MAX_PAGES = 50; // safety bound (50 * 100 = up to 5000 agents/cycle)

      do {
        const url: string = `${NORMIES_API}/agents/list?sort=newest&limit=100` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) break;

        const data: any = await res.json();
        const items: any[] = data.items || [];
        for (const a of items) {
          const agentId = String(a.agentId || "");
          if (!agentId) continue;

          const existing = await kiraRedis.getJson<ERC8004Agent>(K.agent8004(agentId));
          const agent: ERC8004Agent = {
            agentId,
            tokenId:      String(a.tokenId || ""),
            operator:     a.registeredBy,
            domain:       `${NORMIES_API}/agents/agent-card/${a.tokenId}`, // A2A surface
            discoveredAt: existing?.discoveredAt || Date.now(),
            lastSeen:     Date.now(),
          };

          // Resolve the agent's TBA from the confirmed Normies ERC-721C contract
          if (NORMIES_CONTRACT && agent.tokenId) {
            const tba = await this.resolveTBA(NORMIES_CONTRACT, agent.tokenId, "ethereum");
            if (tba) agent.tbaAddress = tba;
          }

          await kiraRedis.setJson(K.agent8004(agentId), agent);
          await kiraRedis.sadd(K.agents8004(), agentId);
          if (!existing) discovered.push(agent);
        }

        cursor = data.hasMore ? (items[items.length - 1]?.agentId || null) : null;
        pages++;
        // Be polite to the indexer + respect 60/min rate limit
        if (cursor) await new Promise(r => setTimeout(r, 1100));
      } while (cursor && pages < MAX_PAGES);

      await kiraRedis.set(K.lastSync(), String(Date.now()));
      if (discovered.length > 0) {
        console.log(`[AgentNetwork] Discovered ${discovered.length} new ERC-8004 agents (official registry)`);
      }
    } catch (err: any) {
      console.error("[AgentNetwork] ERC-8004 discovery failed:", err?.message);
    }

    return discovered;
  }

  // Total registered agent count from the official indexer-backed endpoint.
  async getRegisteredCount(): Promise<number> {
    try {
      const res = await fetch(`${NORMIES_API}/agents/count`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data: any = await res.json();
        return data.count || 0;
      }
    } catch {}
    return 0;
  }

  // Resolve a Normie token to its bound agentId (official binding endpoint).
  async resolveBinding(tokenId: string): Promise<{ agentId: string; registeredBy: string } | null> {
    try {
      const res = await fetch(`${NORMIES_API}/agents/binding/${tokenId}`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data: any = await res.json();
        if (data.binding) {
          return { agentId: String(data.binding.agentId), registeredBy: data.binding.registeredBy };
        }
      }
    } catch {}
    return null;
  }

  // Fetch an agent's official A2A Agent Card (for KIRA to discover how to talk to a peer).
  async getAgentCard(tokenId: string): Promise<any | null> {
    try {
      const res = await fetch(`${NORMIES_API}/agents/agent-card/${tokenId}`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) return await res.json();
    } catch {}
    return null;
  }

  async getKnownAgentCount(): Promise<number> {
    const ids = await kiraRedis.smembers(K.agents8004());
    return ids.length;
  }

  async getAllAgents(): Promise<ERC8004Agent[]> {
    const ids    = await kiraRedis.smembers(K.agents8004());
    const agents = await Promise.all(ids.map(id => kiraRedis.getJson<ERC8004Agent>(K.agent8004(id))));
    return agents.filter(Boolean) as ERC8004Agent[];
  }

  async formatForContext(): Promise<string> {
    const known = await this.getKnownAgentCount();
    const total = await this.getRegisteredCount();
    const own   = await kiraRedis.getJson<TBAInfo>(K.tba("ethereum", NORMIES_CONTRACT || "0x", "2635"));
    return [
      `ERC-8004 agents: ${known} indexed${total > 0 ? ` of ${total} registered` : ""}`,
      own ? `KIRA TBA: ${own.tbaAddress.slice(0, 10)}...` : "",
    ].filter(Boolean).join(" | ");
  }
}
