// onchainevents.ts — On-chain event detection
// Large transfer detection, new contract deployments, whale movements

import { kiraRedis } from "./redis.js";

export interface OnChainEvent {
  type:        "large_transfer" | "whale_buy" | "new_contract" | "large_nft_sale";
  chain:       string;
  description: string;
  valueEth:    number;
  from:        string;
  to:          string;
  txHash:      string;
  timestamp:   number;
  asset?:      string;
}

const ETHERSCAN_BASE = "https://api.etherscan.io/api";
const BASESCAN_BASE  = "https://api.basescan.org/api";
const ETHERSCAN_KEY  = process.env.ETHERSCAN_API_KEY || "";

const LARGE_TRANSFER_THRESHOLD_ETH = 100; // flag transfers > 100 ETH
const LARGE_NFT_SALE_THRESHOLD_ETH = 10;  // flag NFT sales > 10 ETH

const K = {
  events:    ()           => `kira:events:recent`,
  lastBlock: (chain: str) => `kira:events:lastblock:${chain}`,
};

type str = string;

export class KiraOnChainEvents {

  // ── LARGE ETH TRANSFERS ───────────────────────────────────────────────────────

  async detectLargeTransfers(chain: string = "ethereum"): Promise<OnChainEvent[]> {
    const events: OnChainEvent[] = [];

    try {
      const baseUrl = chain === "base" ? BASESCAN_BASE : ETHERSCAN_BASE;
      const apiKey  = ETHERSCAN_KEY;

      // Get latest block number
      const blockRes = await fetch(
        `${baseUrl}?module=proxy&action=eth_blockNumber${apiKey ? `&apikey=${apiKey}` : ""}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!blockRes.ok) return events;

      const blockData  = await blockRes.json() as any;
      const latestBlock = parseInt(blockData.result, 16);

      // Check last processed block
      const lastBlockKey = K.lastBlock(chain);
      const lastBlockStr = await kiraRedis.get(lastBlockKey);
      const lastBlock    = lastBlockStr ? parseInt(lastBlockStr) : latestBlock - 10;

      if (latestBlock <= lastBlock) return events;

      // Get internal transactions for large ETH moves
      const txRes = await fetch(
        `${baseUrl}?module=account&action=txlist` +
        `&address=0x0000000000000000000000000000000000000000` +
        `&startblock=${lastBlock}&endblock=${latestBlock}` +
        `&sort=desc&page=1&offset=50` +
        (apiKey ? `&apikey=${apiKey}` : ""),
        { signal: AbortSignal.timeout(15000) }
      );

      // Instead get large transfers by checking recent blocks
      // Use eth_getBlockByNumber with full tx list
      const recentBlockRes = await fetch(
        `${baseUrl}?module=proxy&action=eth_getBlockByNumber` +
        `&tag=latest&boolean=true` +
        (apiKey ? `&apikey=${apiKey}` : ""),
        { signal: AbortSignal.timeout(15000) }
      );

      if (!recentBlockRes.ok) return events;

      const recentBlock = await recentBlockRes.json() as any;
      const txs         = recentBlock.result?.transactions || [];

      for (const tx of txs) {
        const valueEth = parseInt(tx.value || "0", 16) / 1e18;
        if (valueEth >= LARGE_TRANSFER_THRESHOLD_ETH) {
          events.push({
            type:        "large_transfer",
            chain,
            description: `Large transfer: ${valueEth.toFixed(1)} ETH`,
            valueEth,
            from:        tx.from || "",
            to:          tx.to   || "",
            txHash:      tx.hash || "",
            timestamp:   Date.now(),
          });
        }
      }

      await kiraRedis.set(lastBlockKey, String(latestBlock));

    } catch (err: any) {
      console.error(`[Events] Large transfer detection failed:`, err?.message);
    }

    return events;
  }

  // ── WHALE WALLET ACTIVITY ─────────────────────────────────────────────────────

  async detectWhaleActivity(
    watchWallets: string[],
    chain:        string = "ethereum"
  ): Promise<OnChainEvent[]> {
    const events: OnChainEvent[] = [];

    try {
      const baseUrl = chain === "base" ? BASESCAN_BASE : ETHERSCAN_BASE;
      const apiKey  = ETHERSCAN_KEY;
      const cutoff  = Math.floor(Date.now() / 1000) - 3600; // last hour

      for (const wallet of watchWallets.slice(0, 5)) {
        try {
          const res = await fetch(
            `${baseUrl}?module=account&action=txlist` +
            `&address=${wallet}&sort=desc&page=1&offset=10` +
            (apiKey ? `&apikey=${apiKey}` : ""),
            { signal: AbortSignal.timeout(10000) }
          );
          if (!res.ok) continue;

          const data = await res.json() as any;
          const txs  = (data.result || []) as any[];

          for (const tx of txs) {
            if (parseInt(tx.timeStamp) < cutoff) continue;
            const valueEth = parseInt(tx.value || "0") / 1e18;
            if (valueEth >= 1) {
              events.push({
                type:        "whale_buy",
                chain,
                description: `Whale activity: ${wallet.slice(0, 8)}... moved ${valueEth.toFixed(2)} ETH`,
                valueEth,
                from:        tx.from || "",
                to:          tx.to   || "",
                txHash:      tx.hash || "",
                timestamp:   parseInt(tx.timeStamp) * 1000,
              });
            }
          }

          await new Promise(r => setTimeout(r, 200));
        } catch {}
      }
    } catch (err: any) {
      console.error("[Events] Whale detection failed:", err?.message);
    }

    return events;
  }

  // ── NEW CONTRACT DEPLOYMENTS ──────────────────────────────────────────────────

  async detectNewContracts(chain: string = "ethereum"): Promise<OnChainEvent[]> {
    const events: OnChainEvent[] = [];

    try {
      // Check for new NFT contract deployments via DexScreener new pairs
      const res = await fetch(
        "https://api.dexscreener.com/latest/dex/search/?q=NFT",
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return events;

      const data  = await res.json() as any;
      const pairs = (data.pairs || []).filter((p: any) => {
        const age = Date.now() - (p.pairCreatedAt || 0);
        return age < 24 * 3600 * 1000; // last 24 hours
      });

      for (const pair of pairs.slice(0, 3)) {
        events.push({
          type:        "new_contract",
          chain:       pair.chainId || chain,
          description: `New token: ${pair.baseToken?.symbol} on ${pair.chainId}`,
          valueEth:    parseFloat(pair.liquidity?.usd || "0") / 2000,
          from:        "",
          to:          pair.pairAddress || "",
          txHash:      "",
          timestamp:   pair.pairCreatedAt || Date.now(),
          asset:       pair.baseToken?.symbol,
        });
      }
    } catch (err: any) {
      console.error("[Events] New contract detection failed:", err?.message);
    }

    return events;
  }

  // ── STORE AND RETRIEVE EVENTS ─────────────────────────────────────────────────

  async storeEvents(events: OnChainEvent[]): Promise<void> {
    if (!events.length) return;
    const existing  = await kiraRedis.getJson<OnChainEvent[]>(K.events()) || [];
    const combined  = [...events, ...existing].slice(0, 50); // keep last 50
    await kiraRedis.setJson(K.events(), combined);
  }

  async getRecentEvents(): Promise<OnChainEvent[]> {
    const result = await kiraRedis.getJson<OnChainEvent[]>(K.events());
    return result ?? [];
  }
  
  // ── HIGH SCORE ALERT ──────────────────────────────────────────────────────────

  formatEventsForContext(events: OnChainEvent[]): string {
    if (!events.length) return "No recent on-chain events";
    return events.slice(0, 5)
      .map(e => `${e.type}: ${e.description} (${e.chain})`)
      .join(" | ");
  }
}
