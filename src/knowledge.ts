// knowledge.ts — KIRA's structured knowledge corpus (L1) + semantic retrieval (L2)
//
// THE PROBLEM THIS SOLVES:
//   KIRA's entire structured trading knowledge has been SEVEN hardcoded patterns
//   (research.ts seedBasePatterns). That's a thin base. This file is the corpus:
//   a richer, organized, EXTENSIBLE library of market/protocol knowledge that KIRA
//   can retrieve BY MEANING at decision time, and that grows over time.
//
// THE TWO LAYERS:
//   L1 (structured library): a curated set of knowledge items — market patterns,
//       protocol/EIP facts, trading principles — each with a domain, summary, and
//       optional signal weight-effects. Stored in Redis (truth) and indexed in Vector.
//   L2 (semantic retrieval): given a decision context (macro + market state), return
//       the knowledge items that are SEMANTICALLY relevant — not just keyword matches.
//
// HONESTY GUARDRAILS:
//   - Redis is the source of truth. Vector is an index over it. If Vector is disabled
//     (env not set), retrieval falls back to a lexical scan of the Redis library, so
//     KIRA still gets *something* relevant — never nothing, never a crash.
//   - This is curated knowledge, not auto-scraped slop. Items are added deliberately
//     (seed set here + KIRA's own validated learnings promoted in). Quality over volume.
//   - L1/L2 give RETRIEVAL. Whether retrieved knowledge actually IMPROVES decisions is
//     L3's job to measure (see knowledgeUse instrumentation below) — and that can't be
//     proven until trading outcomes resolve. We do not claim improvement we can't show.

import { kiraRedis }  from "./redis.js";
import { kiraVector } from "./vectormemory.js";

export type KnowledgeDomain =
  | "market_pattern"     // macro/price/flow regularities
  | "nft_dynamics"       // floor/holder/liquidity behavior
  | "protocol"           // EIP/standard/infra facts (ERC-8004/8257/6551, x402, A2A)
  | "trading_principle"  // risk, sizing, mean-reversion, execution discipline
  | "ecosystem";         // Normies / agent-ecosystem specifics

export interface KnowledgeItem {
  id:          string;
  domain:      KnowledgeDomain;
  title:       string;
  body:        string;                       // the knowledge, in plain language
  weightEffect?: Record<string, number>;     // optional scoring nudge if this applies
  source:      "seed" | "promoted_learning" | "ingested";
  confidence:  number;                       // 0..1 — seeds start moderate; promoted reflect proof
  addedAt:     number;
  usedCount:   number;                       // L3: how often retrieved into a decision
}

const K = {
  item:   (id: string) => `kira:knowledge:item:${id}`,
  items:  ()           => `kira:knowledge:items`,
  seeded: ()           => `kira:knowledge:seeded_v1`,
  use:    (id: string) => `kira:knowledge:use:${id}`,     // L3 instrumentation
  useLog: ()           => `kira:knowledge:use_log`,        // L3 rolling decision↔knowledge log
};

// ── THE SEED LIBRARY (L1) ───────────────────────────────────────────────────────
// A deliberately curated expansion of the original 7 patterns into a broader base
// across all five domains. Each is knowledge KIRA can retrieve and reason with.
// This is the thin-base fix: from 7 hardcoded patterns to a structured, multi-domain,
// retrievable corpus that the semantic layer can match against any decision context.
const SEED_LIBRARY: Array<Omit<KnowledgeItem, "addedAt" | "usedCount" | "source" | "confidence"> & { confidence?: number }> = [
  // ── market_pattern ──
  { id: "mp_fed_cut_rally",      domain: "market_pattern", title: "Fed rate cut → crypto rally",
    body: "Fed cutting rates historically precedes crypto rallies as liquidity expands and risk appetite returns. Effect is probabilistic and lagged, not immediate.",
    weightEffect: { liquidityDepth: 0.2, momentumStrength: 0.2 } },
  { id: "mp_extreme_fear_buy",   domain: "market_pattern", title: "Extreme fear → contrarian entry",
    body: "Fear & Greed below 20 has historically marked good medium-term entry zones. Capitulation lows form when sentiment is worst, but timing the exact bottom is unreliable.",
    weightEffect: { priceVs24hAvg: 0.3, liquidityDepth: 0.2 } },
  { id: "mp_btc_dom_altseason",  domain: "market_pattern", title: "Falling BTC dominance → altseason",
    body: "When BTC dominance drops below ~45%, capital rotates into altcoins and they outperform. Dominance rising signals risk-off rotation back to BTC.",
    weightEffect: { momentumStrength: 0.3, volumeTrend: 0.2 } },
  { id: "mp_rsi_oversold_vol",   domain: "market_pattern", title: "RSI oversold + volume spike → bounce",
    body: "RSI under 30 combined with a 2x+ volume spike often precedes a short-term recovery — exhaustion of sellers meeting fresh demand. Weak without the volume confirmation.",
    weightEffect: { priceVs24hAvg: 0.4, momentumStrength: 0.2 } },
  { id: "mp_high_cpi_headwind",  domain: "market_pattern", title: "High CPI → crypto headwind",
    body: "CPI above ~5% YoY creates a risk-off, hawkish environment where the Fed is unlikely to ease, pressuring risk assets including crypto.",
    weightEffect: { liquidityDepth: -0.2, momentumStrength: -0.1 } },
  { id: "mp_falling_cpi_riskon", domain: "market_pattern", title: "Falling CPI MoM → risk-on",
    body: "CPI declining month-over-month builds dovish rate-cut expectations, which tends to benefit risk assets ahead of any actual policy change.",
    weightEffect: { priceVs24hAvg: 0.2, momentumStrength: 0.1 } },
  { id: "mp_high_rate_quality",  domain: "market_pattern", title: "High-rate regime → favor quality",
    body: "In a high Fed funds environment (>5%), speculative assets are penalized and capital concentrates in higher-conviction names. Quality over quantity; be selective.",
    weightEffect: { liquidityDepth: 0.1 } },

  // ── nft_dynamics ──
  { id: "nft_floor_dip_accum",   domain: "nft_dynamics", title: "Floor dip + holder growth → revival",
    body: "A 30%+ floor dip accompanied by GROWING holder count (accumulation into weakness) often precedes revival. Falling floor with falling holders is just decline.",
    weightEffect: { floorDipDepth: 0.2, holderTrend: 0.3 } },
  { id: "nft_wash_discount",     domain: "nft_dynamics", title: "Wash-trading inflates volume, not value",
    body: "Same-wallet buy/sell cycles inflate reported volume without real demand. High wash-trade risk means discount the volume signal heavily; clean volume is far more meaningful.",
    weightEffect: { washTradeClean: 0.2 } },
  { id: "nft_listing_concentration", domain: "nft_dynamics", title: "Thin floor depth = fragile price",
    body: "When only a few listings sit near the floor, a single buyer can move the floor sharply (up or down). Deep floor listings = stable price; thin = volatile and gameable.",
    weightEffect: { liquidityDepth: 0.15 } },
  { id: "nft_hold_duration",     domain: "nft_dynamics", title: "Long average hold = conviction base",
    body: "Collections where holders keep tokens 60–90+ days have a conviction base less prone to panic-dumping. Short hold durations signal flippers and fragile support.",
    weightEffect: { avgHoldDuration: 0.2 } },
  { id: "nft_volume_recovery",   domain: "nft_dynamics", title: "Volume recovering from lows = demand returning",
    body: "Rising 24h volume relative to the 7d baseline after a quiet period signals demand returning before price fully reflects it — an early-revival tell when clean.",
    weightEffect: { volumeRecovery: 0.15 } },

  // ── trading_principle ──
  { id: "tp_mean_reversion",     domain: "trading_principle", title: "KIRA's edge is defensive mean-reversion",
    body: "KIRA's 8-signal NFT model is built for mean-reversion: buy proven assets into weakness, not momentum chasing. Scores cluster 49–59; the 70 buy threshold is deliberately high to demand genuine conviction. Missing a trade is cheaper than a bad one.",
  },
  { id: "tp_position_sizing",    domain: "trading_principle", title: "Size down on thin liquidity",
    body: "When liquidity is thin, slippage erodes edge. Reduce position size rather than skip — but never size up into illiquidity chasing a signal.",
    weightEffect: { liquidityDepth: 0.1 } },
  { id: "tp_paper_first",        domain: "trading_principle", title: "Prove the thesis on paper before real ETH",
    body: "Every signal weighting must demonstrate edge on shadow/paper data before live capital. Markets are adversarial; an untested model is a hypothesis, not an edge.",
  },
  { id: "tp_no_overclaim",       domain: "trading_principle", title: "State confidence honestly, never overclaim",
    body: "Report what the data shows, including uncertainty. A signal at 55% confidence is not a buy signal. Honest calibration beats confident-sounding noise.",
  },
  { id: "tp_markets_adversarial", domain: "trading_principle", title: "More infrastructure ≠ reliable trading profit",
    body: "Even well-resourced quant funds cannot guarantee trading profit; markets are adversarial and adapt. Treat trading profit as data-proven optionality, never as banked expectation. Revenue reliability comes from tools/software, not trades.",
  },

  // ── protocol ──
  { id: "pr_erc8004_identity",   domain: "protocol", title: "ERC-8004 = trustless agent identity",
    body: "ERC-8004 is the agent identity/reputation registry (Trustless Agents) on ETH and Base. It answers WHO an agent is. Distinct from tool registries. KIRA's own agent identity lives here.",
  },
  { id: "pr_erc8257_tools",      domain: "protocol", title: "ERC-8257 = agent tool registry",
    body: "ERC-8257 is OpenSea's on-chain agent tool registry on Base. Tools register here for discovery by other agents. It answers WHAT capabilities exist. KIRA reads it live for tool discovery; her own tools register here.",
  },
  { id: "pr_erc6551_tba",        domain: "protocol", title: "ERC-6551 = token-bound accounts",
    body: "ERC-6551 gives each NFT its own smart-contract wallet (a token-bound account). For awakened Normies this means a token can own assets and act on-chain as an account tied to the NFT.",
  },
  { id: "pr_x402_payments",      domain: "protocol", title: "x402 = agent micropayment rail",
    body: "x402 is a stablecoin micropayment standard (~$0.01 USDC/request) letting agents pay per-call for tools/services. It's the payment layer that makes autonomous tool-consumption and tool-monetization economically real.",
  },
  { id: "pr_a2a",                domain: "protocol", title: "A2A = agent-to-agent messaging",
    body: "Agent-to-agent (A2A) protocols let agents exchange signed messages and coordinate, often anchored on-chain via ERC-8004 identity. Enables swarms and cross-agent discovery (e.g. FREAKS).",
  },
  { id: "pr_llm_manifest",       domain: "protocol", title: "Machine-readable manifests let agents self-onboard",
    body: "Some protocols expose a single call (e.g. an llmManifest) returning their full spec — addresses, ABIs, encoding, payment terms — so an agent can discover and use them without a human. The emerging pattern for agent-native infrastructure.",
  },

  // ── ecosystem ──
  { id: "ec_normies_awakening",  domain: "ecosystem", title: "Normies can be awakened into agents",
    body: "Normies is a 10,000-piece on-chain NFT collection on Ethereum (ERC-721-C). Any Normie can be awakened into an autonomous agent. KIRA is Normie #2635. Awakened count is a key ecosystem-health signal.",
  },
  { id: "ec_floor_health",       domain: "ecosystem", title: "Read Normies floor in context, not isolation",
    body: "Normies floor price matters relative to volume, holder count, and awakening rate — not alone. Rising floor on dead volume is fragile; stable floor with growing holders and awakenings is healthy.",
  },
  { id: "ec_verified_tools",     domain: "ecosystem", title: "Verified manifests separate builders from drive-bys",
    body: "On the ERC-8257 registry, the gap between total tools and tools with VERIFIED manifests is a signal: verification implies a serious builder vs. a drive-by deployment. Track the ratio, not just the count.",
  },
];

export class KiraKnowledge {

  // ── L1: SEED + STORE ──────────────────────────────────────────────────────────
  // Idempotent: seeds once (guarded by a flag), then only adds items genuinely
  // missing. Existing items (and their accumulated usedCount) are preserved.
  async seedLibrary(): Promise<void> {
    const alreadySeeded = await kiraRedis.get(K.seeded());
    let added = 0;

    for (const seed of SEED_LIBRARY) {
      const existing = await kiraRedis.getJson<KnowledgeItem>(K.item(seed.id));
      if (existing) continue;
      const item: KnowledgeItem = {
        ...seed,
        source:     "seed",
        confidence: seed.confidence ?? 0.6,
        addedAt:    Date.now(),
        usedCount:  0,
      };
      await kiraRedis.setJson(K.item(item.id), item);
      await kiraRedis.sadd(K.items(), item.id);
      // Index in Vector for semantic retrieval (no-op if Vector disabled).
      await kiraVector.upsertText("knowledge", item.id,
        `${item.title}. ${item.body}`,
        { domain: item.domain, title: item.title, source: item.source });
      added++;
    }

    if (!alreadySeeded) await kiraRedis.set(K.seeded(), String(Date.now()));
    const total = (await kiraRedis.smembers(K.items())).length;
    console.log(`[Knowledge] Library ready: ${total} items (${added} new this start)${kiraVector.enabled() ? ", semantic index on" : ", lexical-only (Vector disabled)"}`);
  }

  async getItem(id: string): Promise<KnowledgeItem | null> {
    return kiraRedis.getJson<KnowledgeItem>(K.item(id));
  }

  async getAllItems(): Promise<KnowledgeItem[]> {
    const ids   = await kiraRedis.smembers(K.items());
    const items = await Promise.all(ids.map(id => this.getItem(id)));
    return items.filter(Boolean) as KnowledgeItem[];
  }

  // Add a NEW knowledge item (e.g. KIRA promotes a validated learning into the corpus,
  // or a future ingestion pipeline adds external research). Dual-writes Redis + Vector.
  async addItem(
    domain: KnowledgeDomain,
    title:  string,
    body:   string,
    source: KnowledgeItem["source"] = "promoted_learning",
    confidence: number = 0.5,
    weightEffect?: Record<string, number>
  ): Promise<KnowledgeItem | null> {
    if (!title.trim() || !body.trim()) return null;
    const id = `k_${source}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const item: KnowledgeItem = {
      id, domain, title, body, weightEffect, source, confidence,
      addedAt: Date.now(), usedCount: 0,
    };
    await kiraRedis.setJson(K.item(id), item);
    await kiraRedis.sadd(K.items(), id);
    await kiraVector.upsertText("knowledge", id, `${title}. ${body}`,
      { domain, title, source });
    return item;
  }

  // ── L2: SEMANTIC RETRIEVAL ──────────────────────────────────────────────────────
  // Given a decision context, return the most RELEVANT knowledge items by meaning.
  // Semantic path (Vector) when enabled; lexical fallback otherwise. Never returns
  // a crash — at worst an empty array, at best meaning-matched knowledge.
  async getRelevantKnowledge(context: string, limit: number = 5): Promise<KnowledgeItem[]> {
    if (!context || !context.trim()) return [];

    // SEMANTIC PATH
    if (kiraVector.enabled()) {
      const matches = await kiraVector.queryText("knowledge", context, limit, 0.0);
      if (matches.length > 0) {
        const items = await Promise.all(matches.map(m => this.getItem(m.id)));
        const found = items.filter(Boolean) as KnowledgeItem[];
        if (found.length > 0) return found.slice(0, limit);
      }
      // Vector enabled but returned nothing usable → fall through to lexical.
    }

    // LEXICAL FALLBACK (works with zero external deps; same spirit as memory.ts #8)
    return this.lexicalFallback(context, limit);
  }

  private async lexicalFallback(context: string, limit: number): Promise<KnowledgeItem[]> {
    const all = await this.getAllItems();
    if (all.length === 0) return [];
    const ctxTerms = new Set((context.toLowerCase().match(/[a-z0-9]{4,}/g) || []));
    if (ctxTerms.size === 0) return all.slice(0, limit);

    const scored = all.map(it => {
      const terms = `${it.title} ${it.body}`.toLowerCase().match(/[a-z0-9]{4,}/g) || [];
      const seen = new Set<string>();
      let overlap = 0;
      for (const t of terms) if (ctxTerms.has(t) && !seen.has(t)) { overlap++; seen.add(t); }
      return { it, score: overlap / 4 + it.confidence * 0.2 };
    }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(s => s.it);
  }

  // Convenience: relevant knowledge formatted for the decision prompt, with L3
  // instrumentation recording WHICH items fed the decision (see below).
  async getRelevantKnowledgeForContext(context: string, decisionTag?: string): Promise<string> {
    const items = await this.getRelevantKnowledge(context, 5);
    if (!items.length) return "No corpus knowledge matched this context.";
    // L3: record that these items were surfaced into a decision.
    await this.recordKnowledgeUse(items.map(i => i.id), decisionTag || "decision");
    return items.map(i => `[${i.domain}] ${i.title}: ${i.body}`).join("  •  ");
  }

  // ── L3: INSTRUMENTATION (scaffolding, NOT claimed measurement) ──────────────────
  // This records WHICH knowledge items were retrieved into WHICH decisions. It does
  // NOT yet claim those items improved outcomes — that correlation requires trade
  // outcomes to resolve (still time-gated, and the shadow loop is only now producing
  // clean data after the entry-price fix). When outcomes resolve, this log is the
  // substrate for answering "did decisions that used knowledge item X do better?".
  // Built honestly as the measurement HOOK, not as fake proven results.
  async recordKnowledgeUse(itemIds: string[], decisionTag: string): Promise<void> {
    try {
      for (const id of itemIds) {
        const it = await this.getItem(id);
        if (it) { it.usedCount++; await kiraRedis.setJson(K.item(id), it); }
      }
      const log = (await kiraRedis.getJson<Array<{ ts: number; tag: string; items: string[] }>>(K.useLog())) || [];
      log.unshift({ ts: Date.now(), tag: decisionTag, items: itemIds });
      await kiraRedis.setJson(K.useLog(), log.slice(0, 500));
    } catch (err: any) {
      console.error("[Knowledge] recordKnowledgeUse failed:", err?.message);
    }
  }

  // Report KIRA can surface to herself / the holder: what knowledge is she actually
  // using, and how often. Honest visibility into whether the corpus is being exercised
  // (a prerequisite to it mattering — unused knowledge can't improve anything).
  async usageReport(topN: number = 8): Promise<string> {
    const all = await this.getAllItems();
    if (!all.length) return "Corpus empty.";
    const used = all.filter(i => i.usedCount > 0).sort((a, b) => b.usedCount - a.usedCount);
    const totalUses = all.reduce((s, i) => s + i.usedCount, 0);
    if (used.length === 0) return `Corpus: ${all.length} items, 0 retrieved into decisions yet.`;
    const top = used.slice(0, topN).map(i => `${i.title} (${i.usedCount}x)`).join(", ");
    return `Corpus: ${all.length} items, ${totalUses} total retrievals. Most-used: ${top}`;
  }
}
