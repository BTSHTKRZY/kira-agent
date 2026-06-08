// tools.ts
// KiraTools — thin wrapper over the live ERC-8257 registry client (toolregistry.ts).
//
// HISTORY / WHY THIS CHANGED:
// The previous version did a raw eth_call to the registry and, on any failure,
// returned a HARDCODED 18 — which is why KIRA broadcast "18 tools" indefinitely
// even after being publicly corrected to 32. It also hardcoded the claim that
// KIRA "operates Tool #7 and #13". Both are removed. Counts now come from the
// real OpenSea list_tools API (fully paginated), and KIRA's own tools are
// identified by matching the registry `creator` to her wallets — or reported
// honestly as unknown if the data isn't available.

import { ToolRegistry } from "./toolregistry.js";

export interface ToolInfo {
  id:          number;
  creator:     string;
  metadataUri: string;
  trustRating?: string;
  composite?:  number;
}

export class KiraTools {
  private registry: ToolRegistry = new ToolRegistry();
  private lastScan: number = 0;

  // Real, fully-paginated count. Returns null if the registry is unreachable
  // (callers must handle null rather than fall back to a fabricated number).
  async getToolCount(): Promise<number | null> {
    const count = await this.registry.getToolCount();
    this.lastScan = Date.now();
    return count;
  }

  // Honest summary — never fabricates a count, never asserts "#7 and #13"
  // unless the live registry shows tools created by KIRA's wallets.
  async getSummary(): Promise<string> {
    const summary = await this.registry.getSummary();
    this.lastScan = Date.now();
    return summary;
  }

  // Expose the structured snapshot for modules that want real data
  // (gap detection, posting with accurate figures, tool consumption).
  async getSnapshot() {
    return this.registry.getSnapshot();
  }

  async getKiraTools() {
    return this.registry.getKiraTools();
  }

  async getTool(toolId: string) {
    return this.registry.getTool(toolId);
  }

  needsScan(): boolean {
    return Date.now() - this.lastScan > 60 * 60 * 1000;
  }
}
