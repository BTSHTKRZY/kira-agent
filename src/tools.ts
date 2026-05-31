const REGISTRY_CONTRACT = "0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1";
const BASE_RPC          = process.env.BASE_RPC || "https://mainnet.base.org";
const AGENTCHECK_URL    = process.env.AGENTCHECK_URL || "https://agentcheck-bice.vercel.app";

export interface ToolInfo {
  id:          number;
  creator:     string;
  metadataUri: string;
  trustRating?: string;
  composite?:  number;
}

export class KiraTools {
  private lastScan: number = 0;

  async getToolCount(): Promise<number> {
    try {
      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(BASE_RPC, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          jsonrpc: "2.0",
          method:  "eth_call",
          params:  [{ to: REGISTRY_CONTRACT, data: "0x0a12f9b1" }, "latest"],
          id:      1,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data  = await res.json() as any;
      const count = parseInt(data.result, 16);
      return isNaN(count) ? 18 : count;
    } catch {
      return 18;
    }
  }

  async getSummary(): Promise<string> {
    try {
      const count = await this.getToolCount();
      this.lastScan = Date.now();
      return `${count} tools on ERC-8257 registry on Base. KIRA operates Tool #7 (Normies Intelligence) and Tool #13 (AgentCheck). Certification predicate live at 0x38530729...`;
    } catch {
      this.lastScan = Date.now();
      return "18 tools on ERC-8257 registry. KIRA operates Tool #7 and Tool #13.";
    }
  }

  needsScan(): boolean {
    return Date.now() - this.lastScan > 60 * 60 * 1000;
  }
}
