// ERC-8257 tool discovery and registration

const REGISTRY_CONTRACT = "0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1";
const BASE_RPC          = process.env.BASE_RPC || "https://mainnet.base.org";
const AGENTCHECK_URL    = process.env.AGENTCHECK_URL || "https://agentcheck-bice.vercel.app";

export interface ToolInfo {
  id:        number;
  creator:   string;
  metadataUri: string;
  manifest?: any;
  trustRating?: string;
  composite?: number;
}

export class KiraTools {
  private knownTools: Map<number, ToolInfo> = new Map();
  private lastScan: number = 0;

  async getToolCount(): Promise<number> {
  try {
    const res = await fetch(BASE_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_call",
        params: [{
          to:   REGISTRY_CONTRACT,
          data: "0x0a12f9b1",
        }, "latest"],
        id: 1,
      }),
    });
    const data  = await res.json() as any;
    if (!data.result || data.result === "0x") return 18;
    const count = parseInt(data.result, 16);
    return isNaN(count) ? 18 : count;
  } catch {
    return 18; // fallback to known count
  }
}
  
  async getToolConfig(toolId: number): Promise<ToolInfo | null> {
    try {
      // getToolConfig(uint256) selector
      const selector = "0x09a7e0cf";
      const paddedId = toolId.toString(16).padStart(64, "0");

      const res  = await fetch(BASE_RPC, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          jsonrpc: "2.0",
          method:  "eth_call",
          params:  [{
            to:   REGISTRY_CONTRACT,
            data: `${selector}${paddedId}`,
          }, "latest"],
          id: 1,
        }),
      });
      const data = await res.json() as any;
      if (!data.result || data.result === "0x") return null;

      // Parse the result — first 32 bytes padding, then address (12 bytes padding + 20 bytes)
      const result  = data.result.slice(2);
      const creator = "0x" + result.slice(24, 64);

      return {
        id:          toolId,
        creator:     creator.toLowerCase(),
        metadataUri: `https://registry.8257.ai/tool/${toolId}`,
      };
    } catch {
      return null;
    }
  }

  async scanRegistry(): Promise<ToolInfo[]> {
    const count = await this.getToolCount();
    console.log(`Scanning ERC-8257 registry: ${count} tools`);

    const tools: ToolInfo[] = [];

    for (let i = 1; i <= Math.min(count, 20); i++) {
      if (this.knownTools.has(i)) {
        tools.push(this.knownTools.get(i)!);
        continue;
      }

      const tool = await getToolConfig(i);
      if (tool) {
        // Check creator trust via AgentCheck
        try {
          const trustRes = await fetch(
            `${AGENTCHECK_URL}/api/check?wallet=${tool.creator}`
          );
          const trust    = await trustRes.json() as any;
          tool.trustRating = trust.rating;
          tool.composite   = trust.composite;
        } catch {
          tool.trustRating = "UNKNOWN";
        }

        this.knownTools.set(i, tool);
        tools.push(tool);
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 200));
    }

    this.lastScan = Date.now();
    return tools;

    async function getToolConfig(id: number): Promise<ToolInfo | null> {
      try {
        const selector = "0x09a7e0cf";
        const paddedId = id.toString(16).padStart(64, "0");
        const rpcRes   = await fetch(BASE_RPC, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            jsonrpc: "2.0",
            method:  "eth_call",
            params:  [{ to: REGISTRY_CONTRACT, data: `${selector}${paddedId}` }, "latest"],
            id:      1,
          }),
        });
        const rpcData = await rpcRes.json() as any;
        if (!rpcData.result || rpcData.result === "0x") return null;
        const result  = rpcData.result.slice(2);
        const creator = "0x" + result.slice(24, 64);
        return { id, creator: creator.toLowerCase(), metadataUri: "" };
      } catch {
        return null;
      }
    }
  }

  async getSummary(): Promise<string> {
  const count = await this.getToolCount();
  return `${count} tools on ERC-8257 registry on Base. KIRA operates Tool #7 (Normies Intelligence) and Tool #13 (AgentCheck). AgentCheck predicate deployed at 0x38530729...`;
}

  getKnownTools(): ToolInfo[] {
    return Array.from(this.knownTools.values());
  }

  needsScan(): boolean {
    return Date.now() - this.lastScan > 60 * 60 * 1000; // 1 hour
  }
}
