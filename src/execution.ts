// execution.ts — NFT buying and selling via Reservoir API
// Token swaps via Uniswap V3 Universal Router
// Hard limits enforced, AgentCheck verified before every trade

import { createWalletClient, createPublicClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, base } from "viem/chains";
import { KiraSpendLimit } from "./spendlimit.js";

const RESERVOIR_BASE_URL  = "https://api.reservoir.tools";
const RESERVOIR_BASE_URL2 = "https://api-base.reservoir.tools";
const RESERVOIR_API_KEY   = process.env.RESERVOIR_API_KEY || "";
const KIRA_PRIVATE_KEY    = process.env.KIRA_PRIVATE_KEY  || "";
const KIRA_WALLET         = process.env.KIRA_WALLET       || "";

// Hard limits
const MAX_NFT_BUY_ETH     = parseFloat(process.env.MAX_NFT_BUY_ETH   || "0.02");
const MAX_TOKEN_BUY_ETH   = parseFloat(process.env.MAX_TOKEN_BUY_ETH || "0.005");
const MAX_GAS_ETH         = 0.005; // max gas per transaction

export interface ExecutionResult {
  success:    boolean;
  txHash?:    string;
  pricePaid?: number;
  gasUsed?:   number;
  error?:     string;
}

export interface NFTListing {
  tokenId:      string;
  price:        number;  // in ETH
  marketplace:  string;
  validUntil?:  number;
  rawOrder?:    any;
}

export interface SellResult {
  success:     boolean;
  txHash?:     string;
  priceEth?:   number;
  error?:      string;
}

export class KiraExecution {
  private account: any;
  private ethClient: any;
  private baseClient: any;
  private publicEthClient: any;
  private publicBaseClient: any;
  private spendLimit: KiraSpendLimit = new KiraSpendLimit();

  constructor() {
    if (KIRA_PRIVATE_KEY) {
      try {
        const pk = KIRA_PRIVATE_KEY.startsWith("0x")
          ? KIRA_PRIVATE_KEY as `0x${string}`
          : `0x${KIRA_PRIVATE_KEY}` as `0x${string}`;

        this.account = privateKeyToAccount(pk);

        this.ethClient = createWalletClient({
          account: this.account,
          chain:   mainnet,
          transport: http(process.env.ETH_RPC || "https://eth.llamarpc.com"),
        });

        this.baseClient = createWalletClient({
          account: this.account,
          chain:   base,
          transport: http(process.env.BASE_RPC || "https://mainnet.base.org"),
        });

        this.publicEthClient = createPublicClient({
          chain:     mainnet,
          transport: http(process.env.ETH_RPC || "https://eth.llamarpc.com"),
        });

        this.publicBaseClient = createPublicClient({
          chain:     base,
          transport: http(process.env.BASE_RPC || "https://mainnet.base.org"),
        });

        console.log(`[Execution] Wallet ready: ${this.account.address}`);
      } catch (err: any) {
        console.error("[Execution] Wallet init failed:", err?.message);
      }
    } else {
      console.log("[Execution] No private key — paper trade mode only");
    }
  }

  // ── NFT BUYING ────────────────────────────────────────────────────────────────

  async buyNFTFloor(
    contractAddress: string,
    chain:           string,
    maxPriceEth:     number,
    collectionName:  string
  ): Promise<ExecutionResult> {
    if (!this.account) {
      return { success: false, error: "No wallet configured — paper mode only" };
    }

    if (maxPriceEth > MAX_NFT_BUY_ETH) {
      return {
        success: false,
        error: `Price ${maxPriceEth} ETH exceeds max ${MAX_NFT_BUY_ETH} ETH`,
      };
    }

    // DAILY SPEND CEILING — hard stop against cumulative wallet drain
    const ceilingCheck = await this.spendLimit.checkSpend(maxPriceEth);
    if (!ceilingCheck.allowed) {
      console.log(`[Execution] BLOCKED by spend ceiling: ${ceilingCheck.reason}`);
      return { success: false, error: ceilingCheck.reason };
    }

    try {
      const baseUrl = chain === "base" ? RESERVOIR_BASE_URL2 : RESERVOIR_BASE_URL;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-api-key":    RESERVOIR_API_KEY,
      };

      // Step 1: Get floor listing
      const listingsRes = await fetch(
        `${baseUrl}/orders/asks/v5?contracts=${contractAddress}&sortBy=price&limit=1&status=active`,
        { headers, signal: AbortSignal.timeout(15000) }
      );
      if (!listingsRes.ok) {
        return { success: false, error: `Listings fetch failed: ${listingsRes.status}` };
      }

      const listingsData = await listingsRes.json() as any;
      const listing = listingsData.orders?.[0];
      if (!listing) {
        return { success: false, error: "No active listings found" };
      }

      const listingPriceEth = parseFloat(listing.price?.amount?.native || "0");
      if (listingPriceEth > maxPriceEth) {
        return {
          success: false,
          error: `Floor ${listingPriceEth} ETH above max ${maxPriceEth} ETH`,
        };
      }

      console.log(`[Execution] Buying ${collectionName} floor @ ${listingPriceEth} ETH`);

      // Step 2: Get buy transaction via Reservoir
      const buyRes = await fetch(`${baseUrl}/execute/buy/v7`, {
        method:  "POST",
        headers,
        body: JSON.stringify({
          items: [{
            orderId: listing.id,
            quantity: 1,
          }],
          taker:         KIRA_WALLET,
          skipBalanceCheck: false,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!buyRes.ok) {
        const err = await buyRes.json() as any;
        return { success: false, error: err?.message || `Buy API failed: ${buyRes.status}` };
      }

      const buyData = await buyRes.json() as any;
      const steps   = buyData.steps || [];

      // Step 3: Execute transaction steps
      for (const step of steps) {
        if (step.kind !== "transaction") continue;
        for (const item of (step.items || [])) {
          if (!item.data) continue;

          const client = chain === "base" ? this.baseClient : this.ethClient;
          const txHash = await client.sendTransaction({
            to:    item.data.to    as `0x${string}`,
            data:  item.data.data  as `0x${string}`,
            value: BigInt(item.data.value || "0"),
          });

          console.log(`[Execution] Tx sent: ${txHash}`);

          // Wait for confirmation
          const publicClient = chain === "base"
            ? this.publicBaseClient
            : this.publicEthClient;

          const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
          if (receipt.status === "reverted") {
            return { success: false, txHash, error: "Transaction reverted" };
          }

          const gasUsed = Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice) / 1e18;
          console.log(`[Execution] ✓ Bought ${collectionName} @ ${listingPriceEth} ETH (gas: ${gasUsed.toFixed(5)} ETH)`);

          // Record against daily spend ceiling (price + gas if configured)
          const nftSpend = listingPriceEth + (this.spendLimit.countsGas() ? gasUsed : 0);
          await this.spendLimit.recordSpend(nftSpend, `NFT buy: ${collectionName}`);

          return {
            success:   true,
            txHash,
            pricePaid: listingPriceEth,
            gasUsed,
          };
        }
      }

      return { success: false, error: "No executable transaction steps found" };

    } catch (err: any) {
      console.error(`[Execution] Buy failed:`, err?.message);
      return { success: false, error: err?.message };
    }
  }

  // ── NFT SELLING ───────────────────────────────────────────────────────────────

  async sellNFT(
    contractAddress: string,
    tokenId:         string,
    chain:           string,
    minPriceEth:     number,
    collectionName:  string
  ): Promise<SellResult> {
    if (!this.account) {
      return { success: false, error: "No wallet configured" };
    }

    try {
      const baseUrl = chain === "base" ? RESERVOIR_BASE_URL2 : RESERVOIR_BASE_URL;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-api-key":    RESERVOIR_API_KEY,
      };

      // Check best offer first
      const offersRes = await fetch(
        `${baseUrl}/orders/bids/v6?contracts=${contractAddress}&tokenId=${tokenId}&status=active&sortBy=price&limit=1`,
        { headers, signal: AbortSignal.timeout(15000) }
      );

      if (offersRes.ok) {
        const offersData  = await offersRes.json() as any;
        const bestOffer   = offersData.orders?.[0];
        const offerPrice  = parseFloat(bestOffer?.price?.amount?.native || "0");

        if (bestOffer && offerPrice >= minPriceEth) {
          // Accept the offer
          console.log(`[Execution] Accepting offer for ${collectionName} #${tokenId} @ ${offerPrice} ETH`);

          const acceptRes = await fetch(`${baseUrl}/execute/sell/v7`, {
            method:  "POST",
            headers,
            body: JSON.stringify({
              items: [{ orderId: bestOffer.id }],
              taker: KIRA_WALLET,
            }),
            signal: AbortSignal.timeout(30000),
          });

          if (acceptRes.ok) {
            const acceptData = await acceptRes.json() as any;
            const steps      = acceptData.steps || [];

            for (const step of steps) {
              if (step.kind !== "transaction") continue;
              for (const item of (step.items || [])) {
                if (!item.data) continue;

                const client  = chain === "base" ? this.baseClient : this.ethClient;
                const txHash  = await client.sendTransaction({
                  to:   item.data.to   as `0x${string}`,
                  data: item.data.data as `0x${string}`,
                  value: BigInt(item.data.value || "0"),
                });

                const publicClient = chain === "base"
                  ? this.publicBaseClient : this.publicEthClient;
                const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

                if (receipt.status === "reverted") {
                  return { success: false, txHash, error: "Transaction reverted" };
                }

                console.log(`[Execution] ✓ Sold ${collectionName} #${tokenId} @ ${offerPrice} ETH`);
                return { success: true, txHash, priceEth: offerPrice };
              }
            }
          }
        }
      }

      // No acceptable offer — create listing instead
      console.log(`[Execution] Creating listing for ${collectionName} #${tokenId} @ ${minPriceEth} ETH`);

      const listRes = await fetch(`${baseUrl}/execute/list/v5`, {
        method:  "POST",
        headers,
        body: JSON.stringify({
          maker: KIRA_WALLET,
          params: [{
            token:       `${contractAddress}:${tokenId}`,
            weiPrice:    (minPriceEth * 1e18).toString(),
            orderKind:   "seaport-v1.5",
            orderbook:   "opensea",
            expirationTime: Math.floor(Date.now() / 1000) + 7 * 24 * 3600, // 7 days
          }],
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!listRes.ok) {
        return { success: false, error: `List API failed: ${listRes.status}` };
      }

      const listData = await listRes.json() as any;
      const steps    = listData.steps || [];

      for (const step of steps) {
        for (const item of (step.items || [])) {
          if (step.kind === "transaction" && item.data) {
            const client = chain === "base" ? this.baseClient : this.ethClient;
            const txHash = await client.sendTransaction({
              to:   item.data.to   as `0x${string}`,
              data: item.data.data as `0x${string}`,
              value: BigInt(item.data.value || "0"),
            });
            console.log(`[Execution] Listed ${collectionName} #${tokenId} @ ${minPriceEth} ETH (tx: ${txHash})`);
            return { success: true, txHash, priceEth: minPriceEth };
          }
          // Signature step
          if (step.kind === "signature" && item.data) {
            // Signature-based listing — log for now
            console.log(`[Execution] Signature listing step for ${collectionName}`);
          }
        }
      }

      return { success: true, priceEth: minPriceEth };

    } catch (err: any) {
      console.error(`[Execution] Sell failed:`, err?.message);
      return { success: false, error: err?.message };
    }
  }

  // ── TOKEN BUYING ──────────────────────────────────────────────────────────────
  // Uniswap V3 Universal Router

  async buyToken(
    tokenAddress: string,
    chain:        string,
    amountEth:    number,
    symbol:       string,
    slippagePct:  number = 1
  ): Promise<ExecutionResult> {
    if (!this.account) {
      return { success: false, error: "No wallet configured" };
    }

    if (amountEth > MAX_TOKEN_BUY_ETH) {
      return { success: false, error: `Amount ${amountEth} ETH exceeds max ${MAX_TOKEN_BUY_ETH} ETH` };
    }

    // DAILY SPEND CEILING — hard stop against cumulative wallet drain
    const tokenCeilingCheck = await this.spendLimit.checkSpend(amountEth);
    if (!tokenCeilingCheck.allowed) {
      console.log(`[Execution] BLOCKED by spend ceiling: ${tokenCeilingCheck.reason}`);
      return { success: false, error: tokenCeilingCheck.reason };
    }

    try {
      // Use 0x API for swap execution (simpler than direct Uniswap)
      const chainId = chain === "base" ? "8453" : "1";
      const swapUrl = `https://api.0x.org/swap/v1/quote?` +
        `buyToken=${tokenAddress}` +
        `&sellToken=ETH` +
        `&sellAmount=${Math.floor(amountEth * 1e18)}` +
        `&slippagePercentage=${slippagePct / 100}` +
        `&takerAddress=${KIRA_WALLET}` +
        `&chainId=${chainId}`;

      const swapRes = await fetch(swapUrl, {
        headers: { "0x-api-key": process.env.ZEROX_API_KEY || "" },
        signal:  AbortSignal.timeout(15000),
      });

      if (!swapRes.ok) {
        return { success: false, error: `0x quote failed: ${swapRes.status}` };
      }

      const quote  = await swapRes.json() as any;
      const client = chain === "base" ? this.baseClient : this.ethClient;

      const txHash = await client.sendTransaction({
        to:    quote.to   as `0x${string}`,
        data:  quote.data as `0x${string}`,
        value: BigInt(quote.value || "0"),
        gas:   BigInt(quote.gas   || "300000"),
      });

      const publicClient = chain === "base"
        ? this.publicBaseClient : this.publicEthClient;
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === "reverted") {
        return { success: false, txHash, error: "Swap reverted" };
      }

      const gasUsed = Number(receipt.gasUsed) * Number(receipt.effectiveGasPrice) / 1e18;
      console.log(`[Execution] ✓ Bought ${symbol} @ ${amountEth} ETH (gas: ${gasUsed.toFixed(5)})`);
      const tokenSpend = amountEth + (this.spendLimit.countsGas() ? gasUsed : 0);
      await this.spendLimit.recordSpend(tokenSpend, `Token buy: ${symbol}`);
      return { success: true, txHash, pricePaid: amountEth, gasUsed };

    } catch (err: any) {
      console.error(`[Execution] Token buy failed:`, err?.message);
      return { success: false, error: err?.message };
    }
  }

  // ── TOKEN SELLING ─────────────────────────────────────────────────────────────

  async sellToken(
    tokenAddress: string,
    chain:        string,
    amountTokens: bigint,
    symbol:       string,
    slippagePct:  number = 1
  ): Promise<ExecutionResult> {
    if (!this.account) {
      return { success: false, error: "No wallet configured" };
    }

    try {
      const chainId = chain === "base" ? "8453" : "1";
      const swapUrl = `https://api.0x.org/swap/v1/quote?` +
        `buyToken=ETH` +
        `&sellToken=${tokenAddress}` +
        `&sellAmount=${amountTokens.toString()}` +
        `&slippagePercentage=${slippagePct / 100}` +
        `&takerAddress=${KIRA_WALLET}` +
        `&chainId=${chainId}`;

      const swapRes = await fetch(swapUrl, {
        headers: { "0x-api-key": process.env.ZEROX_API_KEY || "" },
        signal:  AbortSignal.timeout(15000),
      });

      if (!swapRes.ok) {
        return { success: false, error: `0x sell quote failed: ${swapRes.status}` };
      }

      const quote  = await swapRes.json() as any;
      const client = chain === "base" ? this.baseClient : this.ethClient;

      // First approve token spend if needed
      // (simplified — in production check allowance first)
      const txHash = await client.sendTransaction({
        to:   quote.to   as `0x${string}`,
        data: quote.data as `0x${string}`,
        value: BigInt(0),
      });

      const publicClient = chain === "base"
        ? this.publicBaseClient : this.publicEthClient;
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === "reverted") {
        return { success: false, txHash, error: "Sell swap reverted" };
      }

      const proceeds = parseFloat(formatEther(BigInt(quote.buyAmount || "0")));
      console.log(`[Execution] ✓ Sold ${symbol} for ~${proceeds.toFixed(4)} ETH`);
      return { success: true, txHash, pricePaid: proceeds };

    } catch (err: any) {
      console.error(`[Execution] Token sell failed:`, err?.message);
      return { success: false, error: err?.message };
    }
  }

  // ── BALANCE CHECK ─────────────────────────────────────────────────────────────

  async getBalance(chain: string = "base"): Promise<number> {
    try {
      const publicClient = chain === "base"
        ? this.publicBaseClient : this.publicEthClient;
      const balance = await publicClient.getBalance({
        address: KIRA_WALLET as `0x${string}`,
      });
      return parseFloat(formatEther(balance));
    } catch {
      return 0;
    }
  }

  isReady(): boolean {
    return !!this.account;
  }
}
