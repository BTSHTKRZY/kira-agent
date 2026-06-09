// vectormemory.ts — KIRA's semantic memory layer (Upstash Vector via REST)
// Same no-SDK, REST-fetch, fail-soft pattern as redis.ts.
//
// WHY THIS EXISTS (the L2 upgrade):
//   KIRA's existing recall (#8 in memory.ts) is LEXICAL — term overlap. It can't
//   match "Fed eased policy" to a learning about "rate cuts" because they share no
//   words. Semantic retrieval matches by MEANING. This is the real upgrade the
//   knowledge corpus needs: recall what's RELEVANT, not just what shares vocabulary.
//
// DESIGN CHOICES (deliberate, honest):
//   - Upstash Vector with a SERVER-SIDE EMBEDDING MODEL. KIRA sends raw text; Upstash
//     embeds it. No separate embedding API, no extra key, no vendor beyond Upstash
//     (which already holds her Redis). One mental model, one account.
//   - FAIL-SOFT: if the Vector env vars are not set, every method no-ops/returns empty.
//     KIRA then runs EXACTLY as she does today (lexical fallback in memory.ts). This is
//     critical — the corpus must never be able to break the deploy or block a decision.
//   - Redis remains the SOURCE OF TRUTH for KIRA's learnings/patterns. Vector is an
//     INDEX over that truth, used only for retrieval. If Vector and Redis ever diverge,
//     Redis wins. We never store the only copy of anything in Vector.
//
// REST shape (Upstash Vector, embedding-model index):
//   POST {URL}/upsert-data           body: [{ id, data, metadata }]            (server embeds `data`)
//   POST {URL}/query-data            body: { data, topK, includeMetadata }     (server embeds query)
//   POST {URL}/delete                body: { ids: [...] }
//   Namespaces are addressed by path suffix: {URL}/upsert-data/{namespace}
//   Auth: Authorization: Bearer {TOKEN}

const VECTOR_URL   = process.env.KIRA_VECTOR_REST_URL   || "";
const VECTOR_TOKEN = process.env.KIRA_VECTOR_REST_TOKEN || "";

// KIRA is "vector-enabled" only when both are present. Otherwise every op no-ops and
// callers fall back to lexical retrieval — she runs unchanged.
export const VECTOR_ENABLED = Boolean(VECTOR_URL && VECTOR_TOKEN);

// Namespaces partition the single index into isolated subsets.
export type VectorNamespace = "knowledge" | "learnings";

export interface VectorMatch {
  id:       string;
  score:    number;                       // cosine similarity, higher = closer
  metadata: Record<string, any>;
}

function headers(): Record<string, string> {
  return {
    Authorization:  `Bearer ${VECTOR_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function nsPath(base: string, ns?: VectorNamespace): string {
  // Default namespace when none specified.
  return ns ? `${VECTOR_URL}/${base}/${encodeURIComponent(ns)}` : `${VECTOR_URL}/${base}`;
}

export const kiraVector = {

  enabled(): boolean { return VECTOR_ENABLED; },

  // Upsert a single text item; Upstash embeds `data` server-side. Returns false on
  // any failure (logged, never thrown) so a write problem can't crash a cycle.
  async upsertText(
    ns: VectorNamespace,
    id: string,
    data: string,
    metadata: Record<string, any> = {}
  ): Promise<boolean> {
    if (!VECTOR_ENABLED) return false;
    if (!data || !data.trim()) return false;
    try {
      const res = await fetch(nsPath("upsert-data", ns), {
        method:  "POST",
        headers: headers(),
        // Store the raw text in metadata too, so query results can return the text
        // without a second fetch.
        body:    JSON.stringify([{ id, data, metadata: { ...metadata, _text: data.slice(0, 1000) } }]),
        signal:  AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.error(`[Vector] upsert ${ns}/${id} failed: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (err: any) {
      console.error(`[Vector] upsert ${ns}/${id} error:`, err?.message);
      return false;
    }
  },

  // Batch upsert (used to seed the corpus). Chunked to stay well within limits.
  async upsertMany(
    ns: VectorNamespace,
    items: Array<{ id: string; data: string; metadata?: Record<string, any> }>
  ): Promise<number> {
    if (!VECTOR_ENABLED || items.length === 0) return 0;
    let ok = 0;
    const CHUNK = 20;
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK).filter(x => x.data && x.data.trim());
      if (!chunk.length) continue;
      try {
        const res = await fetch(nsPath("upsert-data", ns), {
          method:  "POST",
          headers: headers(),
          body:    JSON.stringify(chunk.map(x => ({
            id: x.id, data: x.data, metadata: { ...(x.metadata || {}), _text: x.data.slice(0, 1000) },
          }))),
          signal:  AbortSignal.timeout(15000),
        });
        if (res.ok) ok += chunk.length;
        else console.error(`[Vector] upsertMany ${ns} chunk failed: HTTP ${res.status}`);
      } catch (err: any) {
        console.error(`[Vector] upsertMany ${ns} error:`, err?.message);
      }
    }
    return ok;
  },

  // Semantic query by text. Returns [] on any failure so callers fall back cleanly.
  async queryText(
    ns: VectorNamespace,
    query: string,
    topK: number = 6,
    minScore: number = 0.0
  ): Promise<VectorMatch[]> {
    if (!VECTOR_ENABLED) return [];
    if (!query || !query.trim()) return [];
    try {
      const res = await fetch(nsPath("query-data", ns), {
        method:  "POST",
        headers: headers(),
        body:    JSON.stringify({ data: query, topK, includeMetadata: true }),
        signal:  AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.error(`[Vector] query ${ns} failed: HTTP ${res.status}`);
        return [];
      }
      const json = await res.json() as any;
      const matches = (json.result || json.matches || []) as any[];
      return matches
        .map(m => ({ id: String(m.id), score: Number(m.score ?? 0), metadata: m.metadata || {} }))
        .filter(m => m.score >= minScore);
    } catch (err: any) {
      console.error(`[Vector] query ${ns} error:`, err?.message);
      return [];
    }
  },

  async deleteIds(ns: VectorNamespace, ids: string[]): Promise<boolean> {
    if (!VECTOR_ENABLED || ids.length === 0) return false;
    try {
      const res = await fetch(nsPath("delete", ns), {
        method:  "POST",
        headers: headers(),
        body:    JSON.stringify({ ids }),
        signal:  AbortSignal.timeout(10000),
      });
      return res.ok;
    } catch (err: any) {
      console.error(`[Vector] delete ${ns} error:`, err?.message);
      return false;
    }
  },

  // Lightweight health check — used at startup to log whether semantic memory is live.
  async health(): Promise<{ enabled: boolean; reachable: boolean }> {
    if (!VECTOR_ENABLED) return { enabled: false, reachable: false };
    try {
      const res = await fetch(`${VECTOR_URL}/info`, {
        headers: headers(), signal: AbortSignal.timeout(8000),
      });
      return { enabled: true, reachable: res.ok };
    } catch {
      return { enabled: true, reachable: false };
    }
  },
};
