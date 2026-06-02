// aave.ts — Idle ETH yield via Aave V3 on Base and Ethereum
// KIRA deposits idle ETH when no trades are pending, withdraws when needed

import { createWalletClient, createPublicClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, base } from "viem/chains";
import { kiraRedis } from "./redis.js";

// Aave V3 Pool addresses
const AAVE_POOL_BASE     = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const AAVE_POOL_ETH      = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
// WETH gateway for ETH deposits
const WETH_GATEWAY_BASE  = "0x8be473dCfA93132658821E67CbEB684ec8Ea2E74";
const WETH_GATEWAY_ETH   = "0xD322A49006FC828F9B5B37Ab215F99B4E5caB19C";

const KIRA_WALLET        = process.env.KIRA_WALLET || "";
const KIRA_PRIVATE_KEY   = process.env.KIRA_PRIVATE_KEY || "";

// Minimum ETH to keep liquid for gas + trades
const MIN_LIQUID_ETH = parseFloat(process.env.MIN_OPERATING_BALANCE_ETH || "0.02");
// Minimum idle ETH before depositing (not worth gas otherwise)
const MIN_DEPOSIT_ETH    = 0.005;

const K = {
  position: (chain: string) => `kira:aave:position:${chain}`,
  lastCheck: ()             => `kira:aave:lastcheck`,
};

export interface AavePosition {
  chain:          string;
  depositedEth:   number;
  currentValueEth: number;
  apy:            number;
  depositedAt:    number;
  lastUpdated:    number;
}

// Minimal ABI for Aave WETH Gateway
const WETH_GATEWAY_ABI = [
  {
    name: "depositETH",
    type: "function",
    inputs: [
      { name: "pool",     type: "address" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    name: "withdrawETH",
    type: "function",
    inputs: [
      { name: "pool",   type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to",     type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;

export class KiraAave {
  private account:         any;
  private baseClient:      any;
  private ethClient:       any;
  private publicBase:      any;
  private publicEth:       any;
  private ready:           boolean = false;

  constructor() {
    if (KIRA_PRIVATE_KEY && KIRA_WALLET) {
      try {
        const pk = KIRA_PRIVATE_KEY.startsWith("0x")
          ? KIRA_PRIVATE_KEY as `0x${string}`
          : `0x${KIRA_PRIVATE_KEY}` as `0x${string}`;

        this.account    = privateKeyToAccount(pk);
        this.baseClient = createWalletClient({
          account:   this.account,
          chain:     base,
          transport: http(process.env.BASE_RPC || "https://mainnet.base.org"),
        });
        this.ethClient  = createWalletClient({
          account:   this.account,
          chain:     mainnet,
          transport: http(process.env.ETH_RPC || "https://eth.llamarpc.com"),
        });
        this.publicBase = createPublicClient({
          chain:     base,
          transport: http(process.env.BASE_RPC || "https://mainnet.base.org"),
        });
        this.publicEth  = createPublicClient({
          chain:     mainnet,
          transport: http(process.env.ETH_RPC || "https://eth.llamarpc.com"),
        });
        this.ready = true;
        console.log("[Aave] Ready");
      } catch (err: any) {
        console.error("[Aave] Init failed:", err?.message);
      }
    }
  }

  // ── GET AAVE APY ──────────────────────────────────────────────────────────────

  async getETHApy(chain: string = "base"): Promise<number> {
    try {
      // Aave V3 subgraph for current APY
      const chainId = chain === "base" ? "base" : "mainnet";
      const res = await fetch(
        `https://aave-api-v2.aave.com/data/markets-data?version=3&networkId=${chainId === "base" ? 8453 : 1}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return 0;
      const data     = await res.json() as any;
      const reserves = data.reserves || data.data?.reserves || [];
      const weth     = reserves.find((r: any) =>
        r.symbol === "WETH" || r.underlyingAsset?.toLowerCase().includes("weth")
      );
      return weth ? parseFloat(weth.supplyAPY || weth.liquidityRate || "0") * 100 : 0;
    } catch { return 0; }
  }

  // ── DEPOSIT IDLE ETH ──────────────────────────────────────────────────────────

  async depositIdleETH(
    chain:       string = "base",
    amountEth:   number
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    if (!this.ready) return { success: false, error: "Not initialised" };
    if (amountEth < MIN_DEPOSIT_ETH) {
      return { success: false, error: `Amount ${amountEth} below minimum ${MIN_DEPOSIT_ETH}` };
    }

    try {
      const poolAddress    = chain === "base" ? AAVE_POOL_BASE    : AAVE_POOL_ETH;
      const gatewayAddress = chain === "base" ? WETH_GATEWAY_BASE : WETH_GATEWAY_ETH;
      const client         = chain === "base" ? this.baseClient   : this.ethClient;
      const value          = parseEther(amountEth.toFixed(6));

      console.log(`[Aave] Depositing ${amountEth} ETH on ${chain}...`);

      const txHash = await client.writeContract({
        address:      gatewayAddress as `0x${string}`,
        abi:          WETH_GATEWAY_ABI,
        functionName: "depositETH",
        args:         [poolAddress as `0x${string}`, KIRA_WALLET as `0x${string}`, 0],
        value,
      });

      const publicClient = chain === "base" ? this.publicBase : this.publicEth;
      const receipt      = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === "reverted") {
        return { success: false, txHash, error: "Deposit reverted" };
      }

      // Save position
      const existing = await kiraRedis.getJson<AavePosition>(K.position(chain)) || {
        chain, depositedEth: 0, currentValueEth: 0,
        apy: 0, depositedAt: Date.now(), lastUpdated: Date.now(),
      };
      const apy = await this.getETHApy(chain);
      const position: AavePosition = {
        ...existing,
        depositedEth:    existing.depositedEth + amountEth,
        currentValueEth: existing.depositedEth + amountEth,
        apy,
        lastUpdated:     Date.now(),
      };
      await kiraRedis.setJson(K.position(chain), position);

      console.log(`[Aave] ✓ Deposited ${amountEth} ETH @ ${apy.toFixed(2)}% APY (${txHash})`);
      return { success: true, txHash };

    } catch (err: any) {
      console.error("[Aave] Deposit failed:", err?.message);
      return { success: false, error: err?.message };
    }
  }

  // ── WITHDRAW ETH ──────────────────────────────────────────────────────────────

  async withdrawETH(
    chain:     string = "base",
    amountEth: number
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    if (!this.ready) return { success: false, error: "Not initialised" };

    try {
      const poolAddress    = chain === "base" ? AAVE_POOL_BASE    : AAVE_POOL_ETH;
      const gatewayAddress = chain === "base" ? WETH_GATEWAY_BASE : WETH_GATEWAY_ETH;
      const client         = chain === "base" ? this.baseClient   : this.ethClient;
      const amount         = parseEther(amountEth.toFixed(6));

      console.log(`[Aave] Withdrawing ${amountEth} ETH from ${chain}...`);

      const txHash = await client.writeContract({
        address:      gatewayAddress as `0x${string}`,
        abi:          WETH_GATEWAY_ABI,
        functionName: "withdrawETH",
        args:         [poolAddress as `0x${string}`, amount, KIRA_WALLET as `0x${string}`],
      });

      const publicClient = chain === "base" ? this.publicBase : this.publicEth;
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      // Update position
      const existing = await kiraRedis.getJson<AavePosition>(K.position(chain));
      if (existing) {
        existing.depositedEth    = Math.max(0, existing.depositedEth - amountEth);
        existing.currentValueEth = existing.depositedEth;
        existing.lastUpdated     = Date.now();
        await kiraRedis.setJson(K.position(chain), existing);
      }

      console.log(`[Aave] ✓ Withdrew ${amountEth} ETH from ${chain} (${txHash})`);
      return { success: true, txHash };

    } catch (err: any) {
      console.error("[Aave] Withdraw failed:", err?.message);
      return { success: false, error: err?.message };
    }
  }

  // ── AUTO-MANAGE YIELD ─────────────────────────────────────────────────────────
  // Called periodically — deposits idle ETH above liquid threshold

  async autoManageYield(
    chain:          string = "base",
    currentBalance: number
  ): Promise<string> {
    if (!this.ready) return "Not initialised";

    const position    = await kiraRedis.getJson<AavePosition>(K.position(chain));
    const deposited   = position?.depositedEth || 0;
    const idleEth     = currentBalance - MIN_LIQUID_ETH;

    if (idleEth >= MIN_DEPOSIT_ETH && deposited === 0) {
      const toDeposit = Math.floor(idleEth * 100) / 100; // round down
      const result    = await this.depositIdleETH(chain, toDeposit);
      if (result.success) {
        const apy = await this.getETHApy(chain);
        return `Deposited ${toDeposit} ETH into Aave @ ${apy.toFixed(2)}% APY`;
      }
      return `Deposit failed: ${result.error}`;
    }

    return deposited > 0
      ? `${deposited.toFixed(4)} ETH earning yield in Aave`
      : "Not enough idle ETH to deposit";
  }

  async getPosition(chain: string = "base"): Promise<AavePosition | null> {
    return kiraRedis.getJson<AavePosition>(K.position(chain));
  }

  async formatForContext(): Promise<string> {
    const base = await this.getPosition("base");
    const eth  = await this.getPosition("ethereum");
    const parts: string[] = [];
    if (base && base.depositedEth > 0)
      parts.push(`Base: ${base.depositedEth.toFixed(4)} ETH @ ${base.apy.toFixed(1)}% APY`);
    if (eth && eth.depositedEth > 0)
      parts.push(`ETH: ${eth.depositedEth.toFixed(4)} ETH @ ${eth.apy.toFixed(1)}% APY`);
    return parts.length > 0 ? `Aave yield: ${parts.join(" | ")}` : "No Aave positions";
  }

  isReady(): boolean { return this.ready; }
}
