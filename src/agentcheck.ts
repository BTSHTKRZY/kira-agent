// AgentCheck integration — KIRA's trust layer

const AGENTCHECK_URL = process.env.AGENTCHECK_URL || "https://agentcheck-bice.vercel.app";
const MIN_RATING     = parseInt(process.env.MIN_AGENTCHECK_RATING || "50");

export interface TrustResult {
  wallet:    string;
  rating:    string;
  composite: number;
  safe:      boolean;
  verdict:   string;
  flags:     string[];
  isAgent:   boolean;
  certified: boolean;
}

export class KiraAgentCheck {
  private cache: Map<string, { result: TrustResult; ts: number }> = new Map();
  private readonly TTL = 5 * 60 * 1000; // 5 minute cache

  async check(wallet: string): Promise<TrustResult> {
    // Check cache
    const cached = this.cache.get(wallet.toLowerCase());
    if (cached && Date.now() - cached.ts < this.TTL) {
      return cached.result;
    }

    try {
      const res  = await fetch(
        `${AGENTCHECK_URL}/api/check?wallet=${wallet}`
      );
      const data = await res.json() as any;

      const result: TrustResult = {
        wallet:    wallet.toLowerCase(),
        rating:    data.rating    || "UNKNOWN",
        composite: data.composite || 0,
        safe:      (data.composite || 0) >= MIN_RATING,
        verdict:   data.verdict   || "Unknown",
        flags:     data.report?.risk_flags || [],
        isAgent:   data.report?.agent_identity?.is_agent || false,
        certified: (data.report?.certifications?.passed || []).length === 3,
      };

      this.cache.set(wallet.toLowerCase(), { result, ts: Date.now() });
      return result;
    } catch {
      return {
        wallet:    wallet.toLowerCase(),
        rating:    "UNKNOWN",
        composite: 0,
        safe:      false,
        verdict:   "Check failed",
        flags:     [],
        isAgent:   false,
        certified: false,
      };
    }
  }

  async checkBatch(wallets: string[]): Promise<TrustResult[]> {
    try {
      const res  = await fetch(`${AGENTCHECK_URL}/api/batch`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ wallets }),
      });
      const data = await res.json() as any;
      return (data.results || []).map((r: any) => ({
        wallet:    r.wallet,
        rating:    r.rating    || "UNKNOWN",
        composite: r.composite || 0,
        safe:      (r.composite || 0) >= MIN_RATING,
        verdict:   r.verdict   || "Unknown",
        flags:     r.flags     || [],
        isAgent:   false,
        certified: false,
      }));
    } catch {
      return [];
    }
  }

  async getStats(): Promise<string> {
    try {
      const res  = await fetch(`${AGENTCHECK_URL}/api/check?wallet=${process.env.KIRA_WALLET}`);
      const data = await res.json() as any;
      return `AgentCheck: ${data.rating} rating for KIRA wallet. Total checks in system accumulating.`;
    } catch {
      return "AgentCheck stats unavailable";
    }
  }

  isSafe(result: TrustResult): boolean {
    return result.safe && !result.flags.includes("sanctioned_entity");
  }

  formatForPost(result: TrustResult): string {
    const flag = result.flags.length > 0 ? ` ⚠ ${result.flags[0]}` : "";
    return `${result.wallet.slice(0, 10)}... → ${result.rating} (${result.composite}/100)${flag}`;
  }
}
