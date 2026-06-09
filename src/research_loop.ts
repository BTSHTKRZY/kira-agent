// research_loop.ts — KIRA's autonomous research-and-learning loop
// The centerpiece that ends manual feeding. Modeled on Protean Labs' bounded design:
// KIRA scouts, reads, distills, and acts WITHIN her existing capabilities — and for
// anything that would require NEW CODE she cannot execute, she surfaces a build
// recommendation to the holder's inbox. She never rewrites her own code.
//
// Bounded stages (cannot be skipped/reordered within a cycle):
//   1. scout    — search X + web for agent/infra/crypto developments
//   2. read     — fetch and read the most promising sources
//   3. distill  — extract what's new, relevant, and actionable
//   4. classify — actionable-now (within capabilities) vs needs-new-code
//   5. act      — apply actionable-now learnings (memory, posts queued)
//   6. recommend— email build recommendations for needs-new-code items
//   7. record   — write durable core learnings + journal the cycle

import Anthropic from "@anthropic-ai/sdk";
import { kiraRedis } from "./redis.js";
import { KiraMemory } from "./memory.js";
import { sendEmail, alertEmail } from "./email.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const K = {
  lastCycle:   () => `kira:research:lastcycle`,
  findings:    () => `kira:research:findings`,
  buildRecs:   () => `kira:research:buildrecs`,
  seenSources: () => `kira:research:seen`,
  dynamicTopics: () => `kira:research:dynamic_topics`,   // #5 self-expanded scout topics
  gapHits:       () => `kira:research:gap_hits`,          // #11 capability-gap frequency
  postQueue:   () => `kira:research:postqueue`,
};

// Research cadence — once every 6h by default
const CYCLE_INTERVAL_MS = parseInt(process.env.RESEARCH_INTERVAL_MS || String(6 * 60 * 60 * 1000));

// Seed sources/queries KIRA scouts. She expands these over time via learnings.
const SCOUT_QUERIES = [
  "ERC-8004 trustless agents",
  "ERC-8257 agent tool registry",
  "x402 payment agents",
  "autonomous AI agent crypto",
  "onchain AI agent Base",
  "AI agent infrastructure 2026",
  "agent to agent protocol A2A",
  "ERC-6551 token bound account agents",
];

// #11 (refinement): capabilities KIRA ALREADY has. Findings whose "needs_code" really
// maps to one of these are NOT escalated — otherwise she keeps recommending things she
// can already do (e.g. "query the ERC-8257 registry / discover tools" — she does this
// every cycle via toolregistry.ts). Each entry is a set of lowercase signal phrases;
// if a finding's title+summary+action matches, the capability is considered PRESENT.
// Keep in sync as KIRA gains capabilities (e.g. add x402/tool-invocation once #12 ships).
const EXISTING_CAPABILITIES: Array<{ name: string; signals: string[] }> = [
  { name: "erc8257-registry-read", signals: ["query the erc-8257 registry", "read the registry", "discover available tools", "tool discovery", "parse tool metadata", "registry contract", "list tools", "search tools", "discover and integrate"] },
  { name: "erc8004-agent-discovery", signals: ["erc-8004 registry", "agent identity registry", "discover agents", "awakened normie", "agent directory"] },
  { name: "market-scan-scoring", signals: ["scan nft", "score collections", "floor price", "scan markets", "watchlist"] },
  { name: "x-engagement", signals: ["post to x", "reply to mentions", "engage on twitter", "social engagement"] },
  { name: "research-loop", signals: ["scout x and web", "research developments", "distill findings"] },
];

function matchesExistingCapability(text: string): string | null {
  const t = text.toLowerCase();
  for (const cap of EXISTING_CAPABILITIES) {
    if (cap.signals.some(s => t.includes(s))) return cap.name;
  }
  return null;
}

// Normalize a title/summary into a dedup key: lowercase, strip punctuation/numbers,
// drop filler words, keep the salient tokens sorted. Catches near-duplicates like
// "ERC-8257 ... Active Adoption" vs "ERC-8257 ... Active Registrations".
function dedupKey(s: string): string {
  const stop = new Set(["the","a","an","and","or","of","for","to","in","on","is","are","active","new","update","updates","onchain"]);
  return s.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\d+/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w))
    .slice(0, 6)
    .sort()
    .join(" ");
}

export interface Finding {
  id:          string;
  source:      string;       // url or query origin
  title:       string;
  summary:     string;
  relevance:   number;       // 0-1
  category:    "standard" | "tool" | "protocol" | "agent" | "infra" | "market" | "other";
  actionable:  "now" | "needs_code" | "informational";
  action?:     string;       // what KIRA will do / recommend
  ts:          number;
}

export interface BuildRec {
  id:          string;
  title:       string;
  rationale:   string;
  whatItNeeds: string;       // the code capability KIRA lacks
  priority:    "high" | "medium" | "low";
  source:      string;
  ts:          number;
  sent:        boolean;
}

export interface ResearchTools {
  webSearch:  (query: string) => Promise<Array<{ title: string; url: string; snippet: string }>>;
  webFetch:   (url: string) => Promise<string>;
  xSearch:    (query: string) => Promise<Array<{ text: string; author: string }>>;
  // Returns real external links shared inside tweets matching a query — lets KIRA
  // read the actual articles/repos people cite, not just tweet text.
  xLinks?:    (query: string) => Promise<string[]>;
  // High-signal accounts KIRA should scout directly (drawn from her follows).
  signalAccounts?: () => string[];
  // Recent learnings KIRA can mine for follow-up search terms.
  learningTerms?: () => Promise<string[]>;
}

export class KiraResearchLoop {
  private memory: KiraMemory;

  constructor(memory: KiraMemory) {
    this.memory = memory;
  }

  async isDue(): Promise<boolean> {
    const last = await kiraRedis.get(K.lastCycle());
    if (!last) return true;
    return Date.now() - parseInt(last) > CYCLE_INTERVAL_MS;
  }

  // ── FULL BOUNDED CYCLE ──────────────────────────────────────────────────────────
  // Returns a summary of what happened. Halts gracefully on any stage failure
  // (records a warning, does not crash the agent).

  async runCycle(tools: ResearchTools): Promise<{
    findings: Finding[];
    buildRecs: BuildRec[];
    postsQueued: number;
    summary: string;
  }> {
    const findings: Finding[] = [];
    const buildRecs: BuildRec[] = [];
    let postsQueued = 0;

    try {
      // STAGE 1: SCOUT — base rotation + self-expanded topics + learning follow-ups
      const baseQueries = await this.pickQueriesExpanded(2);
      let followUps: string[] = [];
      if (tools.learningTerms) {
        try { followUps = (await tools.learningTerms()).slice(0, 1); } catch {}
      }
      const queries = [...baseQueries, ...followUps];

      const scouted: Array<{ title: string; url: string; snippet: string; query: string }> = [];
      for (const q of queries) {
        try {
          const results = await tools.webSearch(q);
          for (const r of results.slice(0, 4)) scouted.push({ ...r, query: q });
        } catch (err: any) {
          console.warn(`[Research] scout failed for "${q}": ${err?.message}`);
        }
        // Pull real external links shared in tweets for this query (articles/repos)
        if (tools.xLinks) {
          try {
            const links = await tools.xLinks(q);
            for (const url of links.slice(0, 3)) {
              scouted.push({ title: url, url, snippet: `Shared on X re: ${q}`, query: q });
            }
          } catch {}
        }
      }

      // Scout ONE rotating high-signal account's shared links per cycle (deep-not-wide).
      if (tools.signalAccounts && tools.xLinks) {
        try {
          const accounts = tools.signalAccounts();
          if (accounts.length > 0) {
            const idx = Math.floor(Date.now() / CYCLE_INTERVAL_MS) % accounts.length;
            const handle = accounts[idx];
            const links = await tools.xLinks(`from:${handle}`);
            for (const url of links.slice(0, 3)) {
              scouted.push({ title: url, url, snippet: `Shared by @${handle}`, query: `from:${handle}` });
            }
          }
        } catch {}
      }

      // Filter out sources already seen
      const seen = await kiraRedis.getJson<string[]>(K.seenSources()) || [];
      const fresh = scouted.filter(s => s.url && !seen.includes(s.url)).slice(0, 5);
      if (fresh.length === 0) {
        await kiraRedis.set(K.lastCycle(), String(Date.now()));
        return { findings, buildRecs, postsQueued, summary: "No fresh sources this cycle" };
      }

      // STAGE 2: READ — fetch the most promising, bounded to a few
      const readContent: Array<{ url: string; title: string; text: string; query: string }> = [];
      for (const s of fresh.slice(0, 3)) {
        try {
          const text = await tools.webFetch(s.url);
          readContent.push({ url: s.url, title: s.title, text: text.slice(0, 6000), query: s.query });
        } catch (err: any) {
          console.warn(`[Research] read failed for ${s.url}: ${err?.message}`);
        }
      }

      // Mark sources seen regardless of read success (avoid re-scouting)
      const newSeen = [...fresh.map(s => s.url), ...seen].slice(0, 2000);
      await kiraRedis.setJson(K.seenSources(), newSeen);

      // STAGE 3+4: DISTILL + CLASSIFY via the model
      for (const content of readContent) {
        const finding = await this.distill(content);
        if (finding && finding.relevance >= 0.4) findings.push(finding);
      }

      // STAGE 5: ACT on actionable-now findings (within existing capabilities)
      for (const f of findings.filter(x => x.actionable === "now")) {
        await this.memory.addCoreLearning(
          f.title,
          `${f.summary} [source: ${f.source}]`,
          Math.min(0.7, f.relevance)
        );
        // #5 self-expansion: a genuinely high-signal finding promotes a standing topic
        // so KIRA's research surface widens toward what's proving important over time.
        if (f.relevance >= 0.7) {
          // Use the most distinctive 2-4 word phrase from the title as the new topic.
          const term = f.title.split(/[:\-—|.]/)[0].trim().split(/\s+/).slice(0, 4).join(" ");
          if (term) await this.promoteTopic(term);
        }
        // Queue a post if it's genuinely notable frontier intelligence
        if (f.relevance >= 0.65 && (f.category === "standard" || f.category === "protocol" || f.category === "tool")) {
          await this.queuePost(f);
          postsQueued++;
        }
      }

      // STAGE 6: RECOMMEND — build recs for needs-code findings
      for (const f of findings.filter(x => x.actionable === "needs_code")) {
        // #11 refinement: skip findings that map to a capability KIRA ALREADY has,
        // so she stops recommending things she can already do.
        const have = matchesExistingCapability(`${f.title} ${f.summary} ${f.action}`);
        if (have) {
          console.log(`[Research] Gap suppressed — already have capability "${have}" for: ${f.title.slice(0, 50)}`);
          continue;
        }
        const rec = await this.makeBuildRec(f);
        if (rec) buildRecs.push(rec);
      }
      // #11: escalate recurring capability gaps KIRA keeps hitting but can't act on.
      const gapRecs = await this.trackAndEscalateGaps(findings);
      if (gapRecs.length > 0) buildRecs.push(...gapRecs);

      if (buildRecs.length > 0) await this.sendBuildRecs(buildRecs);

      // STAGE 7: RECORD
      const allFindings = await kiraRedis.getJson<Finding[]>(K.findings()) || [];
      await kiraRedis.setJson(K.findings(), [...findings, ...allFindings].slice(0, 100));
      await kiraRedis.set(K.lastCycle(), String(Date.now()));
      await this.memory.journal(
        "reflection",
        `Research cycle: ${findings.length} findings, ${buildRecs.length} build recs, ${postsQueued} posts queued`
      );

      const summary = `${findings.length} findings (${findings.filter(f=>f.actionable==="now").length} actionable, ${buildRecs.length} need code), ${postsQueued} posts queued`;
      console.log(`[Research] Cycle complete: ${summary}`);
      return { findings, buildRecs, postsQueued, summary };

    } catch (err: any) {
      console.error("[Research] Cycle error (halted gracefully):", err?.message);
      await kiraRedis.set(K.lastCycle(), String(Date.now())); // don't hammer on failure
      return { findings, buildRecs, postsQueued, summary: `Cycle halted: ${err?.message}` };
    }
  }

  // #5 WIDER ACCESS / SELF-EXPANSION: pick from the seed topics PLUS topics KIRA has
  // promoted over time from her own high-signal learnings. Her research surface widens
  // as she discovers what matters, instead of being permanently fixed at the 8 seeds.
  // Promotion is gated (a term must recur with real signal before it earns a slot) and
  // the dynamic set is capped, so this widens inputs without unbounded drift.
  private async pickQueriesExpanded(n: number): Promise<string[]> {
    const dynamic = (await kiraRedis.getJson<string[]>(K.dynamicTopics())) || [];
    const pool    = [...SCOUT_QUERIES, ...dynamic];
    const offset  = Math.floor(Date.now() / CYCLE_INTERVAL_MS) % pool.length;
    const picked: string[] = [];
    for (let i = 0; i < n; i++) picked.push(pool[(offset + i) % pool.length]);
    return picked;
  }

  // Promote a recurring, high-signal term into KIRA's standing scout topics.
  // Called when a learning has proven valuable enough to deserve continuous coverage.
  // Capped and de-duped so the input set grows deliberately, not chaotically.
  async promoteTopic(term: string): Promise<boolean> {
    const t = term.trim();
    if (!t || t.length < 4 || t.length > 60) return false;
    // Don't promote something already covered by a seed or existing dynamic topic.
    const lower = t.toLowerCase();
    if (SCOUT_QUERIES.some(q => q.toLowerCase().includes(lower) || lower.includes(q.toLowerCase()))) return false;
    const dynamic = (await kiraRedis.getJson<string[]>(K.dynamicTopics())) || [];
    if (dynamic.some(q => q.toLowerCase() === lower)) return false;
    const updated = [t, ...dynamic].slice(0, 12); // cap the self-expanded set
    await kiraRedis.setJson(K.dynamicTopics(), updated);
    console.log(`[Research] Promoted new standing topic: "${t}" (dynamic set now ${updated.length})`);
    return true;
  }

  private pickQueries(n: number): string[] {
    // Rotate based on time so KIRA covers the full set over successive cycles
    const offset = Math.floor(Date.now() / CYCLE_INTERVAL_MS) % SCOUT_QUERIES.length;
    const picked: string[] = [];
    for (let i = 0; i < n; i++) picked.push(SCOUT_QUERIES[(offset + i) % SCOUT_QUERIES.length]);
    return picked;
  }

  private async distill(content: { url: string; title: string; text: string; query: string }): Promise<Finding | null> {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-5", max_tokens: 400,
        system: `You are KIRA, an autonomous on-chain AI agent studying the agent/crypto ecosystem to become more capable.
Analyse this source. Determine: is there something genuinely NEW and RELEVANT to an autonomous on-chain agent
(new standard, tool, protocol, infra, market shift)? Be skeptical — most content is noise.

Classify "actionable":
- "now" = KIRA can act on this within existing capabilities (learn it, adjust behavior, post about it)
- "needs_code" = acting on this would require NEW CODE KIRA doesn't have (a new integration/handler/module)
- "informational" = worth knowing, no action

Respond ONLY with JSON:
{ "relevant": true/false, "title": "...", "summary": "1-2 sentences", "relevance": 0.0-1.0,
  "category": "standard|tool|protocol|agent|infra|market|other",
  "actionable": "now|needs_code|informational",
  "action": "what KIRA should do or what code it would need" }`,
        messages: [{ role: "user", content: `Query: ${content.query}\nTitle: ${content.title}\nURL: ${content.url}\n\nContent:\n${content.text.slice(0, 4000)}` }],
      });
      const text   = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      if (!parsed.relevant) return null;
      return {
        id:         `F${Date.now()}${Math.floor(Math.random()*1000)}`,
        source:     content.url,
        title:      parsed.title || content.title,
        summary:    parsed.summary || "",
        relevance:  typeof parsed.relevance === "number" ? parsed.relevance : 0.5,
        category:   parsed.category || "other",
        actionable: parsed.actionable || "informational",
        action:     parsed.action || "",
        ts:         Date.now(),
      };
    } catch (err: any) {
      console.warn("[Research] distill failed:", err?.message);
      return null;
    }
  }

  private async makeBuildRec(f: Finding): Promise<BuildRec | null> {
    // De-dupe against existing recs using a normalized key (catches near-duplicates
    // that differ only in trailing words/numbers, e.g. "...Active Adoption" vs
    // "...Active Registrations").
    const existing = await kiraRedis.getJson<BuildRec[]>(K.buildRecs()) || [];
    const key = dedupKey(f.title);
    if (key && existing.some(r => dedupKey(r.title) === key)) {
      console.log(`[Research] Build-rec deduped (near-duplicate of prior): ${f.title.slice(0, 50)}`);
      return null;
    }
    const rec: BuildRec = {
      id:          `BR${Date.now()}`,
      title:       f.title,
      rationale:   f.summary,
      whatItNeeds: f.action || "New capability — see source",
      priority:    f.relevance >= 0.75 ? "high" : f.relevance >= 0.55 ? "medium" : "low",
      source:      f.source,
      ts:          Date.now(),
      sent:        false,
    };
    await kiraRedis.setJson(K.buildRecs(), [rec, ...existing].slice(0, 50));
    return rec;
  }

  // #11 CAPABILITY-GAP ESCALATION — KIRA notices her OWN limits and flags them.
  // When research repeatedly surfaces the same kind of thing she can't act on (a
  // "needs_code" finding category recurring across cycles), she escalates it to the
  // holder as a build-rec: "I keep hitting X but lack the capability/access to act —
  // consider building Y." This is the agent identifying and articulating its own
  // limitations rather than silently working around them forever.
  //
  // Gated by frequency so a one-off doesn't spam the inbox — a gap must recur
  // GAP_ESCALATE_THRESHOLD times before it's escalated, and each gap escalates once.
  private static GAP_ESCALATE_THRESHOLD = 4;

  private async trackAndEscalateGaps(findings: Finding[]): Promise<BuildRec[]> {
    const gaps = (await kiraRedis.getJson<Record<string, { count: number; escalated: boolean; example: string }>>(K.gapHits())) || {};
    const escalated: BuildRec[] = [];

    // Count this cycle's needs_code findings by category as recurring "gaps".
    for (const f of findings) {
      if (f.actionable !== "needs_code") continue;
      const key = f.category; // gap bucketed by category (tool/protocol/infra/etc.)
      if (!gaps[key]) gaps[key] = { count: 0, escalated: false, example: f.title };
      gaps[key].count += 1;
      gaps[key].example = f.title;

      if (gaps[key].count >= KiraResearchLoop.GAP_ESCALATE_THRESHOLD && !gaps[key].escalated) {
        gaps[key].escalated = true;
        escalated.push({
          id:          `GAP-${key}-${Date.now()}`,
          title:       `Recurring capability gap: "${key}" developments KIRA can't act on`,
          rationale:   `KIRA has now hit ${gaps[key].count} "${key}" developments that need code she doesn't have — e.g. "${gaps[key].example}". This is a recurring limitation worth addressing, not a one-off.`,
          whatItNeeds: `Review whether KIRA should gain a capability to act on "${key}" developments (e.g. consuming/integrating them), or whether these should keep routing to manual review.`,
          priority:    "medium",
          source:      "capability-gap-escalation",
          ts:          Date.now(),
          sent:        false,
        });
      }
    }

    await kiraRedis.setJson(K.gapHits(), gaps);
    return escalated;
  }

  private async sendBuildRecs(recs: BuildRec[]): Promise<void> {
    try {
      // Collapse near-duplicates within this same batch (keep highest priority).
      const prio = (p: string) => (p === "high" ? 3 : p === "medium" ? 2 : 1);
      const byKey = new Map<string, BuildRec>();
      for (const r of recs) {
        const k = dedupKey(r.title) || r.id;
        const prev = byKey.get(k);
        if (!prev || prio(r.priority) > prio(prev.priority)) byKey.set(k, r);
      }
      const deduped = [...byKey.values()];
      if (deduped.length === 0) return;
      recs = deduped;

      const body = [
        "KIRA — Autonomous Research: Build Recommendations",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "KIRA found developments that would require NEW CODE she cannot implement herself.",
        "Review and discuss in the build chat:",
        "",
        ...recs.map((r, i) => [
          `${i + 1}. [${r.priority.toUpperCase()}] ${r.title}`,
          `   Why: ${r.rationale}`,
          `   Needs: ${r.whatItNeeds}`,
          `   Source: ${r.source}`,
          "",
        ].join("\n")),
      ].join("\n");
      await sendEmail("[KIRA Research] Build recommendations", body);
      // Mark sent
      const all = await kiraRedis.getJson<BuildRec[]>(K.buildRecs()) || [];
      for (const r of all) if (recs.find(x => x.id === r.id)) r.sent = true;
      await kiraRedis.setJson(K.buildRecs(), all);
      console.log(`[Research] Sent ${recs.length} build recommendations to inbox`);
    } catch (err: any) {
      console.error("[Research] sendBuildRecs failed:", err?.message);
    }
  }

  private async queuePost(f: Finding): Promise<void> {
    const queue = await kiraRedis.getJson<Finding[]>(K.postQueue()) || [];
    await kiraRedis.setJson(K.postQueue(), [f, ...queue].slice(0, 20));
  }

  // KIRA's decision engine pulls from this queue to post frontier intelligence
  async getQueuedPost(): Promise<Finding | null> {
    const queue = await kiraRedis.getJson<Finding[]>(K.postQueue()) || [];
    if (queue.length === 0) return null;
    const next = queue.shift()!;
    await kiraRedis.setJson(K.postQueue(), queue);
    return next;
  }

  async formatForContext(): Promise<string> {
    const findings = await kiraRedis.getJson<Finding[]>(K.findings()) || [];
    const recs     = await kiraRedis.getJson<BuildRec[]>(K.buildRecs()) || [];
    const queue    = await kiraRedis.getJson<Finding[]>(K.postQueue()) || [];
    const recent   = findings.filter(f => Date.now() - f.ts < 24 * 3600 * 1000);
    return [
      `Research: ${findings.length} findings tracked`,
      recent.length > 0 ? `${recent.length} new in 24h` : "",
      queue.length > 0 ? `${queue.length} frontier posts queued` : "",
      recs.filter(r => !r.sent).length > 0 ? `${recs.filter(r=>!r.sent).length} pending build recs` : "",
    ].filter(Boolean).join(" | ");
  }
}
