// GDS DESIGN GATE — scores a real game's content (not a hand-fed list). It reads a GDS's `content[]`,
// keeps items with a RESOLVED asset, groups them by `tier` (defaults to `kind`), and runs the
// silhouette gate WITHIN each tier (sameness only matters among siblings — two trees should differ;
// a tree and a barrel needn't). Aggregates to one verdict. The functional GateReport is DoD-shaped;
// this is the parallel per-entity DesignReport {pass, score, failures[], tiers[]}.

import { renderMasks, silhouetteVerdict, THRESHOLDS } from "./silhouette-gate.mjs";

/** Group a GDS's resolved content items into silhouette tiers. */
export function gdsTiers(gds) {
  const byTier = new Map();
  for (const c of (gds.content ?? [])) {
    if (!c.asset) continue; // unsourced items can't be rendered yet — skipped
    const tier = c.tier ?? c.kind;
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier).push({ label: c.id, asset: c.asset });
  }
  return [...byTier.entries()].map(([tier, entries]) => ({ tier, entries }));
}

/** Render + score each tier (>=2 resolved assets) and aggregate. PASS iff every tier passes. */
export async function runGdsDesignGate(gds, opts = {}) {
  const tiers = gdsTiers(gds).filter((t) => t.entries.length >= 2);
  if (!tiers.length) {
    return { pass: true, score: 1, failures: [{ gate: "coverage", detail: "no tier has >=2 resolved assets to compare — design gate inert (nothing sourced yet)" }], tiers: [] };
  }
  const results = [];
  let allPass = true, minScore = 1;
  for (const t of tiers) {
    const v = silhouetteVerdict(await renderMasks(t.entries, opts), opts.thresholds ?? THRESHOLDS);
    results.push({ tier: t.tier, pass: v.pass, score: v.score, failures: v.failures, stats: v.stats });
    if (!v.pass) allPass = false;
    if (v.score < minScore) minScore = v.score;
  }
  const failures = results.flatMap((r) => r.failures.map((f) => ({ tier: r.tier, ...f })));
  return { pass: allPass, score: Number(minScore.toFixed(3)), failures, tiers: results.map((r) => ({ tier: r.tier, pass: r.pass, score: r.score, ...r.stats })) };
}
