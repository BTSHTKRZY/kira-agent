// Documentation reader — KIRA reads and remembers relevant docs

export interface DocEntry {
  url:       string;
  title:     string;
  summary:   string;
  fetchedAt: number;
}

export class KiraDocs {
  private docCache: Map<string, DocEntry> = new Map();

  // Key documentation sources KIRA should know
  private readonly CORE_DOCS = [
    {
      url:   "https://www.8257.ai/build",
      title: "ERC-8257 Build Documentation",
    },
    {
      url:   "https://www.8257.ai/build#composability",
      title: "ERC-8257 Predicate Composability",
    },
    {
      url:   "https://agentcheck-bice.vercel.app/api/methodology",
      title: "AgentCheck Methodology",
    },
  ];

  async fetchDoc(url: string): Promise<string> {
    try {
      const res  = await fetch(url, {
        headers: { "User-Agent": "KIRA-Agent/2.0 (Normie #2635)" },
        signal:  AbortSignal.timeout(10000),
      });
      const text = await res.text();
      // Strip HTML tags for cleaner text
      const clean = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 3000);
      return clean;
    } catch {
      return "";
    }
  }

  async readAndCache(url: string, title: string): Promise<DocEntry | null> {
    // Check cache — docs valid for 24 hours
    const cached = this.docCache.get(url);
    if (cached && Date.now() - cached.fetchedAt < 24 * 60 * 60 * 1000) {
      return cached;
    }

    const content = await this.fetchDoc(url);
    if (!content) return null;

    const entry: DocEntry = {
      url,
      title,
      summary:   content.slice(0, 1000),
      fetchedAt: Date.now(),
    };

    this.docCache.set(url, entry);
    console.log(`✓ Read: ${title}`);
    return entry;
  }

  async readCoreDocs(): Promise<string> {
    const summaries: string[] = [];

    for (const doc of this.CORE_DOCS) {
      const entry = await this.readAndCache(doc.url, doc.title);
      if (entry) {
        summaries.push(`[${entry.title}]: ${entry.summary.slice(0, 300)}`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    return summaries.join("\n\n");
  }

  async readArbitraryUrl(url: string): Promise<string> {
    const content = await this.fetchDoc(url);
    return content.slice(0, 2000);
  }

  async readEIP(eipNumber: number): Promise<string> {
    const url     = `https://eips.ethereum.org/EIPS/eip-${eipNumber}`;
    const content = await this.fetchDoc(url);
    console.log(`✓ Read EIP-${eipNumber}`);
    return content.slice(0, 2000);
  }

  getCachedDocs(): DocEntry[] {
    return Array.from(this.docCache.values());
  }
}
