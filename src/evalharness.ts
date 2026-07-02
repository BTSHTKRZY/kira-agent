// evalharness.ts — KIRA GOLDEN REGRESSION HARNESS
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// Across the June 2026 build sessions, KIRA repeatedly hit the SAME CLASS of bug:
// a single bad/dead asset or a malformed LLM response jamming an entire pipeline,
// and behavioral guards (loop-breaker, displacement gates, Arc-3 sample gate) that
// must fire under precise conditions. Each was found in PRODUCTION, by reading logs,
// after wasting cycles (and would have cost real USDC post-#12). This harness encodes
// each as a GOLDEN: a named scenario asserting the correct behavior, so the bug can
// never silently regress.
//
// DESIGN: focused, but built to GROW. Every future bug becomes a new golden — copy a
// scenario, fill in the invariant. As KIRA gains surface area (#12 money-touching:
// spend-cap-must-halt, kill-switch-must-work), we add goldens here AS we build those
// paths. This is the seed of the full test framework, grown from real failures rather
// than speculative coverage.
//
// RUN:  npx tsx evalharness.ts   (or: node --import tsx evalharness.ts)
// CI:   exits non-zero if any golden fails — wire into the deploy gate before #12.
//
// SCOPE NOTE: this tests PURE LOGIC (the decision predicates and gates), reimplemented
// here as testable units that MIRROR the production logic in index.ts / convictioncalls.ts.
// It deliberately does NOT boot Redis/viem/Anthropic — those are integration concerns.
// When a golden and production drift, that's the signal to reconcile them (the harness
// is the spec; if production differs, one of them is wrong — investigate).
// ─────────────────────────────────────────────────────────────────────────────

// ── tiny test runner ─────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0;
const FAILURES: string[] = [];
function golden(name: string, fn: () => void) {
  try { fn(); PASS++; console.log(`  ✓ ${name}`); }
  catch (e: any) { FAIL++; FAILURES.push(name); console.log(`  ✗ ${name}\n      ${e?.message || e}`); }
}
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }
function eq<T>(a: T, b: T, msg: string) { if (a !== b) throw new Error(`${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// ═════════════════════════════════════════════════════════════════════════════
// GOLDEN SET 1 — UNPRICEABLE ASSET MUST NOT JAM A PIPELINE
// The "SHROOM" bug (call-creation) and the throw-abort bug (resolution): one dead
// asset must never block processing of the others.
// ═════════════════════════════════════════════════════════════════════════════

type Cand = { name: string; score: number; priceable: boolean };

// Mirrors the FIXED call-creation selection: walk ranked, skip unpriceable (drop them),
// return the first priceable candidate that clears the floor. Returns the chosen name +
// the list of dropped names.
function selectCallCandidate(ranked: Cand[], floor: number): { chosen: string | null; dropped: string[] } {
  const dropped: string[] = [];
  for (const c of ranked) {
    if (c.score < floor) break;            // rest below floor
    if (!c.priceable) { dropped.push(c.name); continue; }  // skip + drop, DON'T return/fail
    return { chosen: c.name, dropped };
  }
  return { chosen: null, dropped };
}

function runUnpriceableGoldens() {
  console.log("\nGOLDEN SET 1 — unpriceable asset must not jam pipeline");

  golden("dead asset at top of watchlist is skipped, not fatal (SHROOM bug)", () => {
    const ranked = [
      { name: "SHROOM", score: 70, priceable: false },  // the jammer
      { name: "GOAT",   score: 68, priceable: true },
    ];
    const r = selectCallCandidate(ranked, 45);
    eq(r.chosen, "GOAT", "must skip SHROOM and choose next priceable");
    assert(r.dropped.includes("SHROOM"), "SHROOM must be dropped from watchlist");
  });

  golden("multiple consecutive dead assets all skipped", () => {
    const ranked = [
      { name: "DEAD1", score: 70, priceable: false },
      { name: "DEAD2", score: 69, priceable: false },
      { name: "DEAD3", score: 67, priceable: false },
      { name: "REAL",  score: 66, priceable: true },
    ];
    const r = selectCallCandidate(ranked, 45);
    eq(r.chosen, "REAL", "must walk past all dead assets");
    eq(r.dropped.length, 3, "all three dead assets dropped");
  });

  golden("all-unpriceable watchlist abstains cleanly (no crash, no jam)", () => {
    const ranked = [
      { name: "DEAD1", score: 70, priceable: false },
      { name: "DEAD2", score: 60, priceable: false },
    ];
    const r = selectCallCandidate(ranked, 45);
    eq(r.chosen, null, "no priceable candidate → abstain (null), not throw");
    eq(r.dropped.length, 2, "both dropped");
  });

  // Resolution-path mirror: one throwing lookup must NOT abort the batch.
  golden("one throwing price lookup must not abort resolution batch (throw-abort bug)", () => {
    const book = ["A", "B", "THROWS", "C"];
    const lookup = (a: string): number => { if (a === "THROWS") throw new Error("fetch timeout"); return 100; };
    let resolved = 0;
    for (const a of book) {
      let price: number | null = null;
      try { price = lookup(a); } catch { price = null; }  // guarded — null, not abort
      if (price !== null) resolved++;
    }
    eq(resolved, 3, "the 3 priceable calls must still resolve despite one throwing");
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// GOLDEN SET 2 — MALFORMED LLM JSON MUST BE PARSED/REPAIRED, NOT CRASH
// The "Unparseable decision → 15-min sleep" bug. Mirrors the FIXED extractJson.
// ═════════════════════════════════════════════════════════════════════════════

function extractJson<T>(raw: string): T | null {
  if (!raw) return null;
  let s = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(s) as T; } catch {}
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
    else {
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)) as T; } catch { return null; } } }
    }
  }
  if (depth > 0) {  // truncation repair
    let repaired = s.slice(start);
    if (inStr) repaired += '"';
    repaired = repaired.replace(/[,:]\s*$/, "");
    repaired += "}".repeat(depth);
    try { return JSON.parse(repaired) as T; } catch {}
  }
  return null;
}

function runJsonGoldens() {
  console.log("\nGOLDEN SET 2 — malformed LLM JSON must parse/repair, not crash");

  golden("clean JSON parses", () => {
    const r = extractJson<any>('{"action":"observe","content":"x"}');
    eq(r?.action, "observe", "clean parse");
  });
  golden("JSON wrapped in prose + code fences parses", () => {
    const r = extractJson<any>('Sure! ```json\n{"action":"make_call","content":"y"}\n``` done');
    eq(r?.action, "make_call", "must strip fences and prose");
  });
  golden("TRUNCATED JSON is repaired, not dropped to sleep (Unparseable bug)", () => {
    // LLM cut off mid-string — the exact failure that caused 15-min sleeps.
    const r = extractJson<any>('{"action":"make_call","content":"long thesis that got cut o');
    assert(r !== null, "truncated object must be repaired to a usable decision, not null");
    eq(r?.action, "make_call", "repaired object retains the action");
  });
  golden("truncated with trailing comma repaired", () => {
    const r = extractJson<any>('{"action":"scan_markets","reasoning":"because",');
    assert(r !== null, "trailing-comma truncation repaired");
    eq(r?.action, "scan_markets", "action recovered");
  });
  golden("genuinely empty input returns null (no false positive)", () => {
    eq(extractJson<any>(""), null, "empty → null");
    eq(extractJson<any>("no json here at all"), null, "no-brace → null");
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// GOLDEN SET 3 — make_call LOOP-BREAKER
// At capacity, KIRA must NOT re-choose make_call every cycle (the 15-in-18 loop).
// ═════════════════════════════════════════════════════════════════════════════

// Mirrors the decision override: a model-chosen make_call while capped (and no
// displacement) must be redirected to a productive action, never left to loop.
function loopBreaker(action: string, atCapacity: boolean, displaced: boolean, researchDue: boolean, scanStaleMin: number): string {
  if (action !== "make_call") return action;
  if (!atCapacity) return action;          // can call — proceed
  if (displaced) return action;            // a slot was freed — proceed
  if (researchDue) return "research_now";
  if (scanStaleMin >= 90) return "scan_markets";
  return "observe";
}

function runLoopBreakerGoldens() {
  console.log("\nGOLDEN SET 3 — make_call loop-breaker");

  golden("at capacity, no displacement → redirect (NOT make_call)", () => {
    const a = loopBreaker("make_call", true, false, false, 10);
    assert(a !== "make_call", "must not re-attempt a capped call");
    eq(a, "observe", "with nothing else due → observe");
  });
  golden("at capacity but research due → research_now", () => {
    eq(loopBreaker("make_call", true, false, true, 10), "research_now", "redirect to due research");
  });
  golden("at capacity, scan stale → scan_markets", () => {
    eq(loopBreaker("make_call", true, false, false, 120), "scan_markets", "redirect to stale scan");
  });
  golden("displacement freed a slot → make_call PROCEEDS", () => {
    eq(loopBreaker("make_call", true, true, false, 10), "make_call", "displaced slot lets call through");
  });
  golden("under capacity → make_call proceeds normally", () => {
    eq(loopBreaker("make_call", false, false, false, 10), "make_call", "not capped → call");
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// GOLDEN SET 4 — DISPLACEMENT GATES (opportunity-cost reallocation)
// Displacement must be STRICT: high-conviction + score margin + eligibility + daily cap.
// ═════════════════════════════════════════════════════════════════════════════

type OpenCall = { name: string; conviction: "high" | "medium" | "low"; score: number; pnl: number | null; ageMs: number };
const HIGH_REQ = true, MARGIN = 10, MIN_HOLD = 24 * 3600 * 1000, MAX_DAY = 1, FLAT = 2;
function convRank(c: OpenCall) { return c.conviction === "high" ? 2 : c.conviction === "medium" ? 1 : 0; }

function tryDisplace(
  cand: { score: number; conviction: "high" | "medium" | "low" },
  book: OpenCall[], dayLogCount: number, maxOpen: number
): string {
  if (HIGH_REQ && cand.conviction !== "high") return "blocked:conviction";
  if (dayLogCount >= MAX_DAY) return "blocked:daily_limit";
  if (book.length < maxOpen) return "no_displace_needed";
  const eligible = book.filter(c => c.ageMs >= MIN_HOLD || (c.pnl !== null && c.pnl < 0));
  if (eligible.length === 0) return "blocked:all_protected";
  eligible.sort((a, b) => { const cr = convRank(a) - convRank(b); return cr !== 0 ? cr : (a.pnl ?? 0) - (b.pnl ?? 0); });
  const weakest = eligible[0];
  if (cand.score < weakest.score + MARGIN) return "blocked:margin";
  return `displaced:${weakest.name}`;
}

function runDisplacementGoldens() {
  console.log("\nGOLDEN SET 4 — displacement gates");
  const young = 1 * 3600 * 1000, old = 30 * 3600 * 1000;
  const fullBook: OpenCall[] = [
    { name: "A", conviction: "high",   score: 70, pnl: 8,  ageMs: young }, // young+winning → protected
    { name: "B", conviction: "medium", score: 62, pnl: -5, ageMs: young }, // young but losing → eligible
    { name: "C", conviction: "high",   score: 72, pnl: 10, ageMs: old },
    { name: "D", conviction: "medium", score: 60, pnl: 3,  ageMs: old },
    { name: "E", conviction: "high",   score: 75, pnl: 20, ageMs: old },
    { name: "F", conviction: "high",   score: 71, pnl: 1,  ageMs: old },
    { name: "G", conviction: "high",   score: 73, pnl: 15, ageMs: old },
    { name: "H", conviction: "high",   score: 74, pnl: 18, ageMs: old },
  ];

  golden("dominant high-conviction setup displaces weakest eligible (medium loser)", () => {
    const r = tryDisplace({ score: 80, conviction: "high" }, fullBook, 0, 8);
    eq(r, "displaced:B", "weakest eligible = B (medium, losing)");
  });
  golden("medium-conviction new call CANNOT displace (gate 1)", () => {
    eq(tryDisplace({ score: 90, conviction: "medium" }, fullBook, 0, 8), "blocked:conviction", "only high earns a slot");
  });
  golden("insufficient score margin blocks displacement (gate 2)", () => {
    // weakest eligible is D(60)/B(62); 66 < 60+10 → blocked
    eq(tryDisplace({ score: 66, conviction: "high" }, fullBook, 0, 8), "blocked:margin", "must clear weakest+10");
  });
  golden("young + winning calls are protected (gate 3 anti-churn)", () => {
    const allYoungWin = fullBook.map(c => ({ ...c, ageMs: young, pnl: 10 }));
    eq(tryDisplace({ score: 99, conviction: "high" }, allYoungWin, 0, 8), "blocked:all_protected", "patient theses protected");
  });
  golden("daily displacement limit enforced (anti-churn backstop)", () => {
    eq(tryDisplace({ score: 99, conviction: "high" }, fullBook, 1, 8), "blocked:daily_limit", "max 1/day");
  });
  golden("under capacity → no displacement needed", () => {
    eq(tryDisplace({ score: 99, conviction: "high" }, fullBook.slice(0, 5), 0, 8), "no_displace_needed", "slots free");
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// GOLDEN SET 5 — ARC 3 SOURCE LEARNING SAMPLE GATE
// Below the sample gate, source weights MUST stay neutral (no thrash on small N).
// ═════════════════════════════════════════════════════════════════════════════

const MIN_RESOLVED = 8, MIN_W = 0.5, MAX_W = 1.5, LR = 0.15, NEUTRAL = 1.0;
function arc3Weight(prevWeight: number, n: number, avgYield: number, overallAvg: number): { weight: number; active: boolean } {
  if (n < MIN_RESOLVED) return { weight: prevWeight === undefined ? NEUTRAL : prevWeight, active: false };  // GATE
  const edge = avgYield - overallAvg;
  const target = Math.max(MIN_W, Math.min(MAX_W, NEUTRAL + (edge / 10) * (MAX_W - NEUTRAL)));
  const nw = prevWeight + (target - prevWeight) * LR;
  return { weight: Math.max(MIN_W, Math.min(MAX_W, nw)), active: true };
}

function runArc3Goldens() {
  console.log("\nGOLDEN SET 5 — Arc 3 sample gate (item-level belief learning)");

  golden("below gate (n<8): belief weight stays neutral, inactive (no thrash)", () => {
    const r = arc3Weight(1.0, 5, -20, -5);
    eq(r.weight, 1.0, "must not move below sample gate");
    eq(r.active, false, "inactive below gate");
  });
  golden("at/above gate: belief weight moves SLOWLY toward yield-implied target", () => {
    const r = arc3Weight(1.0, 10, -20, -5); // underperforming belief
    assert(r.weight < 1.0, "underperformer moves down");
    assert(r.weight > 0.85, "but only ONE slow step, not a violent swing");
    eq(r.active, true, "active above gate");
  });
  golden("a belief BEATING baseline gets up-weighted", () => {
    const r = arc3Weight(1.0, 12, 15, 2); // belief avg +15 vs base +2 → should rise
    assert(r.weight > 1.0, "outperforming belief up-weighted");
  });
  golden("weights never exceed [0.5, 1.5] bounds even after many updates", () => {
    let w = 1.0;
    for (let i = 0; i < 100; i++) w = arc3Weight(w, 20, -50, 0).weight; // relentless underperform
    assert(w >= MIN_W, "floor respected (never fully killed)");
    let w2 = 1.0;
    for (let i = 0; i < 100; i++) w2 = arc3Weight(w2, 20, 50, 0).weight; // relentless outperform
    assert(w2 <= MAX_W, "ceiling respected (never dominates)");
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// GOLDEN SET 6 — CONVICTION-CALL RESOLUTION TRIGGERS
// A call must resolve on the FIRST trigger: target / stop / horizon / max-age.
// ═════════════════════════════════════════════════════════════════════════════

function resolveReason(pnl: number | null, ageMs: number, horizonMs: number, maxAgeMs: number, target: number, stop: number): string | null {
  if (pnl === null) return ageMs >= maxAgeMs ? "unpriceable_forced" : null;
  if (pnl >= target) return "target_hit";
  if (pnl <= stop) return "stop_hit";
  if (ageMs >= maxAgeMs) return "max_age_forced";
  if (ageMs >= horizonMs) return "horizon";
  return null; // still open
}

function runResolutionGoldens() {
  console.log("\nGOLDEN SET 6 — resolution triggers");
  const H = 4 * 86400000, MAX = 10 * 86400000, T = 20, S = -15;

  golden("hits target → target_hit", () => eq(resolveReason(22, 1 * 86400000, H, MAX, T, S), "target_hit", "above target"));
  golden("hits stop → stop_hit", () => eq(resolveReason(-18, 1 * 86400000, H, MAX, T, S), "stop_hit", "below stop"));
  golden("past horizon, mid-range → horizon", () => eq(resolveReason(5, 5 * 86400000, H, MAX, T, S), "horizon", "soft horizon"));
  golden("unpriceable past max-age → force-closed (deadlock fix)", () => eq(resolveReason(null, 11 * 86400000, H, MAX, T, S), "unpriceable_forced", "dead asset force-closed"));
  golden("unpriceable but YOUNG → stays open (don't force prematurely)", () => eq(resolveReason(null, 1 * 86400000, H, MAX, T, S), null, "young unpriceable holds"));
  golden("young, mid-range → stays open", () => eq(resolveReason(5, 1 * 86400000, H, MAX, T, S), null, "no trigger yet"));
}

// ═════════════════════════════════════════════════════════════════════════════
// EXTENSION POINT — #12 MONEY-TOUCHING GOLDENS (add as we build them)
//   golden("spend ceiling hard-halts at limit", ...)
//   golden("kill-switch disables all paid calls instantly", ...)
//   golden("per-call maxAmount cap enforced on paidFetch", ...)
//   golden("a paid-call loop cannot exceed per-hour spend cap", ...)
//   golden("NFT/gated tools NEVER auto-called (inbox approval only)", ...)
// These are the goldens that make #12 safe. Build them WITH the #12 paths.
// ═════════════════════════════════════════════════════════════════════════════

// ── run all ──────────────────────────────────────────────────────────────────
console.log("═══ KIRA GOLDEN REGRESSION HARNESS ═══");
runUnpriceableGoldens();
runJsonGoldens();
runLoopBreakerGoldens();
runDisplacementGoldens();
runArc3Goldens();
runResolutionGoldens();
console.log(`\n═══ RESULT: ${PASS} passed, ${FAIL} failed ═══`);
if (FAIL > 0) { console.log(`FAILED: ${FAILURES.join(", ")}`); process.exit(1); }
else console.log("All goldens pass — the regression net holds.");
