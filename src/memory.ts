// memory.ts — KIRA's persistent self-awareness layer
// Three stores that accumulate over time and CANNOT be backdated:
//   1. Identity journal — milestones, lessons, notable moments (permanent)
//   2. Core learnings — important insights that never rotate out (permanent)
//   3. Relationship memory — who engages with KIRA, what resonates (accumulating)
// This is KIRA's tacit-knowledge equivalent: lived experience, time-stamped.

import { kiraRedis }  from "./redis.js";
import { kiraVector } from "./vectormemory.js";

export interface JournalEntry {
  ts:        number;
  type:      "milestone" | "lesson" | "interaction" | "decision" | "reflection";
  text:      string;
  context?:  string;
}

export interface CoreLearning {
  ts:         number;
  insight:    string;
  evidence:   string;
  confidence: number;   // 0-1, grows as reinforced
  reinforced: number;   // times this learning was confirmed
}

export interface Relationship {
  handle:        string;       // X username (no @)
  userId?:       string;
  firstSeen:     number;
  lastSeen:      number;
  interactions:  number;       // total exchanges
  theyEngaged:   number;       // times they replied/liked KIRA
  kiraEngaged:   number;       // times KIRA replied/liked them
  sentiment:     "positive" | "neutral" | "hostile" | "unknown";
  notable:       string[];     // memorable things they said
  isAgent:       boolean;
  isPriority:    boolean;
}

const K = {
  journal:   ()             => `kira:memory:journal`,
  core:      ()             => `kira:memory:core`,
  rel:       (h: string)    => `kira:memory:rel:${h.toLowerCase()}`,
  rels:      ()             => `kira:memory:relationships`,
};

const MAX_JOURNAL = 500;   // keep last 500 journal entries
const MAX_CORE    = 100;   // keep up to 100 core learnings

export class KiraMemory {

  // ── IDENTITY JOURNAL ──────────────────────────────────────────────────────────

  async journal(type: JournalEntry["type"], text: string, context?: string): Promise<void> {
    const entry: JournalEntry = { ts: Date.now(), type, text, context };
    const existing = await kiraRedis.getJson<JournalEntry[]>(K.journal()) || [];
    const updated  = [entry, ...existing].slice(0, MAX_JOURNAL);
    await kiraRedis.setJson(K.journal(), updated);
  }

  async getJournal(limit: number = 20): Promise<JournalEntry[]> {
    const entries = await kiraRedis.getJson<JournalEntry[]>(K.journal()) || [];
    return entries.slice(0, limit);
  }

  // Summary of who KIRA is, drawn from the journal — read at startup
  async getSelfNarrative(): Promise<string> {
    const entries    = await kiraRedis.getJson<JournalEntry[]>(K.journal()) || [];
    if (!entries.length) return "Newly awakened. No history yet.";

    const milestones = entries.filter(e => e.type === "milestone").slice(0, 5);
    const lessons    = entries.filter(e => e.type === "lesson").slice(0, 5);
    const daysActive = entries.length > 0
      ? Math.floor((Date.now() - entries[entries.length - 1].ts) / 86400000)
      : 0;

    const parts: string[] = [`${daysActive} days of accumulated experience, ${entries.length} journal entries.`];
    if (milestones.length) parts.push(`Milestones: ${milestones.map(m => m.text).join("; ")}`);
    if (lessons.length)    parts.push(`Lessons learned: ${lessons.map(l => l.text).join("; ")}`);
    return parts.join(" ");
  }

  // ── CORE LEARNINGS (permanent, reinforced over time) ──────────────────────────

  async addCoreLearning(insight: string, evidence: string, confidence: number = 0.5): Promise<void> {
    const existing = await kiraRedis.getJson<CoreLearning[]>(K.core()) || [];

    // If a similar insight exists, reinforce it instead of duplicating
    const similar = existing.find(l =>
      l.insight.toLowerCase().slice(0, 40) === insight.toLowerCase().slice(0, 40)
    );
    if (similar) {
      similar.reinforced++;
      similar.confidence = Math.min(1, similar.confidence + 0.1);
      similar.evidence   = evidence;
      similar.ts         = Date.now();
      await kiraRedis.setJson(K.core(), existing);
      // Refresh the semantic index for this learning (no-op if Vector disabled).
      await kiraVector.upsertText("learnings", this.learningId(similar.insight),
        `${similar.insight}. ${similar.evidence}`,
        { confidence: similar.confidence, reinforced: similar.reinforced });
      return;
    }

    const learning: CoreLearning = { ts: Date.now(), insight, evidence, confidence, reinforced: 1 };
    const updated = [learning, ...existing]
      .sort((a, b) => (b.confidence * b.reinforced) - (a.confidence * a.reinforced))
      .slice(0, MAX_CORE);
    await kiraRedis.setJson(K.core(), updated);
    // Index in Vector for semantic recall (no-op if Vector disabled).
    await kiraVector.upsertText("learnings", this.learningId(insight),
      `${insight}. ${evidence}`, { confidence, reinforced: 1 });
  }

  // Stable id for a learning's vector entry, derived from its insight text so
  // reinforcement updates the same vector rather than creating duplicates.
  private learningId(insight: string): string {
    const slug = insight.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 48);
    return `learn_${slug}`;
  }

  async getCoreLearnings(limit: number = 10): Promise<CoreLearning[]> {
    const learnings = await kiraRedis.getJson<CoreLearning[]>(K.core()) || [];
    return learnings
      .sort((a, b) => (b.confidence * b.reinforced) - (a.confidence * a.reinforced))
      .slice(0, limit);
  }

  // ── #8 RELEVANCE-WEIGHTED RETRIEVAL ───────────────────────────────────────────
  // Surfaces the learnings actually relevant to the CURRENT decision, weighted by
  // proven value — instead of always returning the same global top-N ("dump all
  // memories"). Relevance = term overlap between the decision context and each
  // learning's text; value = confidence × reinforced. The combined score means a
  // moderately-proven learning that's ON-TOPIC can outrank a highly-proven one that's
  // irrelevant to what KIRA is deciding right now. This is the difference between
  // "recall everything" and "recall what matters here".
  //
  // Honest note: this is lexical overlap, not semantic embeddings — it's a real,
  // measurable improvement over global top-N, but it's not deep understanding. A
  // future upgrade could use embeddings; this is the tractable, verifiable version.
  // Honest note: the lexical path below is term-overlap, not deep understanding.
  // When Upstash Vector is configured, we use SEMANTIC retrieval first (match by
  // meaning, e.g. "Fed eased" ↔ "rate cut"), and fall back to the lexical path when
  // Vector is disabled or returns nothing. This is the L2 upgrade the corpus needed.
  async getRelevantLearnings(context: string, limit: number = 6): Promise<CoreLearning[]> {
    const learnings = await kiraRedis.getJson<CoreLearning[]>(K.core()) || [];
    if (learnings.length === 0) return [];

    // ── SEMANTIC PATH (preferred when Vector is enabled) ──
    if (kiraVector.enabled() && context && context.trim()) {
      const matches = await kiraVector.queryText("learnings", context, limit, 0.0);
      if (matches.length > 0) {
        // Map vector ids back to the authoritative Redis learnings.
        const byId = new Map(learnings.map(l => [this.learningId(l.insight), l]));
        const hits = matches.map(m => byId.get(m.id)).filter(Boolean) as CoreLearning[];
        if (hits.length > 0) return hits.slice(0, limit);
      }
      // enabled but no usable hits → fall through to lexical
    }

    // ── LEXICAL FALLBACK (unchanged #8 logic) ──
    // Build a term set from the current decision context (lowercased words >3 chars).
    const ctxTerms = new Set(
      (context || "").toLowerCase().match(/[a-z0-9]{4,}/g) || []
    );
    if (ctxTerms.size === 0) return this.getCoreLearnings(limit); // no context → fall back

    const scored = learnings.map(l => {
      const text  = `${l.insight} ${l.evidence}`.toLowerCase();
      const terms = text.match(/[a-z0-9]{4,}/g) || [];
      let overlap = 0;
      const seen = new Set<string>();
      for (const t of terms) {
        if (ctxTerms.has(t) && !seen.has(t)) { overlap++; seen.add(t); }
      }
      // Relevance 0..1 (capped), value 0..~MAX. Combined so on-topic beats off-topic
      // even at lower proven value, but proven value still matters as a tiebreak/multiplier.
      const relevance = Math.min(1, overlap / 4);          // ~4 shared terms = fully relevant
      const value     = l.confidence * Math.min(l.reinforced, 5) / 5; // 0..1
      // Weight relevance higher than raw value so retrieval is context-driven.
      const score = relevance * 0.7 + value * 0.3;
      return { l, score, relevance };
    });

    // Only return learnings with at least some relevance; if none overlap, fall back
    // to the proven top-N so KIRA isn't left with nothing.
    const relevant = scored.filter(s => s.relevance > 0).sort((a, b) => b.score - a.score);
    if (relevant.length === 0) return this.getCoreLearnings(limit);
    return relevant.slice(0, limit).map(s => s.l);
  }

  // Context string built from relevance-weighted retrieval for a given decision context.
  async getRelevantLearningsForContext(context: string): Promise<string> {
    const learnings = await this.getRelevantLearnings(context, 6);
    if (!learnings.length) return "No relevant learnings for this context.";
    return learnings
      .map(l => `${l.insight} (confidence ${(l.confidence * 100).toFixed(0)}%, seen ${l.reinforced}x)`)
      .join(" | ");
  }


  async getCoreLearningsForContext(): Promise<string> {
    const learnings = await this.getCoreLearnings(6);
    if (!learnings.length) return "No core learnings yet.";
    return learnings
      .map(l => `${l.insight} (confidence ${(l.confidence * 100).toFixed(0)}%, seen ${l.reinforced}x)`)
      .join(" | ");
  }

  // ── RELATIONSHIP MEMORY ───────────────────────────────────────────────────────

  async recordInteraction(
    handle:    string,
    direction: "they_engaged" | "kira_engaged",
    opts:      { userId?: string; notable?: string; isAgent?: boolean; isPriority?: boolean; sentiment?: Relationship["sentiment"] } = {}
  ): Promise<void> {
    if (!handle) return;
    const clean = handle.replace("@", "").toLowerCase();
    let rel = await kiraRedis.getJson<Relationship>(K.rel(clean));

    if (!rel) {
      rel = {
        handle: clean, userId: opts.userId,
        firstSeen: Date.now(), lastSeen: Date.now(),
        interactions: 0, theyEngaged: 0, kiraEngaged: 0,
        sentiment: opts.sentiment || "unknown",
        notable: [], isAgent: opts.isAgent || false, isPriority: opts.isPriority || false,
      };
    }

    rel.interactions++;
    rel.lastSeen = Date.now();
    if (direction === "they_engaged") rel.theyEngaged++;
    else                              rel.kiraEngaged++;
    if (opts.userId)    rel.userId = opts.userId;
    if (opts.isAgent)   rel.isAgent = true;
    if (opts.isPriority) rel.isPriority = true;
    if (opts.sentiment) rel.sentiment = opts.sentiment;
    if (opts.notable) {
      rel.notable = [opts.notable, ...rel.notable].slice(0, 5);
    }

    await kiraRedis.setJson(K.rel(clean), rel);
    await kiraRedis.sadd(K.rels(), clean);
  }

  async getRelationship(handle: string): Promise<Relationship | null> {
    return kiraRedis.getJson<Relationship>(K.rel(handle.replace("@", "").toLowerCase()));
  }

  // Top relationships by mutual engagement — KIRA's closest connections
  async getTopRelationships(limit: number = 5): Promise<Relationship[]> {
    const handles = await kiraRedis.smembers(K.rels());
    const rels    = await Promise.all(handles.map(h => kiraRedis.getJson<Relationship>(K.rel(h))));
    return (rels.filter(Boolean) as Relationship[])
      .sort((a, b) => (b.theyEngaged + b.kiraEngaged) - (a.theyEngaged + a.kiraEngaged))
      .slice(0, limit);
  }

  async getRelationshipsForContext(): Promise<string> {
    const top = await this.getTopRelationships(5);
    if (!top.length) return "No established relationships yet.";
    return top
      .map(r => `@${r.handle} (${r.interactions} interactions${r.isAgent ? ", agent" : ""}${r.sentiment === "hostile" ? ", hostile" : ""})`)
      .join(" | ");
  }
}
