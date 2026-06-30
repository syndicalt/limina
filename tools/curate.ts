// HOST-SIDE CURATION — a footprint-sanity gate over an AssetSource's returned glb bytes, the policy
// layer that rejects asset-SELECTION mistakes a live CC catalog hands back: a "medieval tower" search
// that returns an 18 m-wide CASTLE, a "medieval house" that returns a 22x25 m multi-house CLUSTER. The
// engine-side sources (library-poly / generative) pick a model deterministically by seed-index; they
// have no idea the bytes are the WRONG SHAPE for the request. Curation runs author-side under `bun`
// (gltf-transform reads the glb), measures the asset's raw bounding box, and asks ONE scale-invariant
// question per kind — is this the right SHAPE? If not, the orchestrator re-rolls the seed.
//
// THE SIGNAL: aspect = max(width, depth) / height — scale-invariant (a model's absolute size depends on
// its export units, which we can't trust), so we judge PROPORTION, not meters. A single house is ~1-1.5x
// wider than tall; a flat sprawl / multi-building cluster is many-x wider than tall; a tower is TALLER
// than wide (aspect < 1). The per-kind limits below are the only knobs.
//
// HOST-SIDE ONLY: this is import-injected into tools/asset-fetch.ts. The sandboxed limina engine never
// imports it (gltf-transform + NodeIO are author-side deps, like obj-archive-to-glb.ts).

import { NodeIO, getBounds } from "@gltf-transform/core";
import type { AssetRequest, AssetResult } from "../js/src/asset/types.ts";

export type AssetKind = AssetRequest["kind"]; // "prop" | "building" | "character" | "vegetation" | "model"

// ── Tunable footprint-aspect limits (aspect = max(width, depth) / height) ──────────────────────────────
// An asset PASSES its kind's check when aspect <= the limit. Higher limit = more permissive (allows
// flatter/wider shapes). These are deliberately loose where shape varies a lot (props) and tight where a
// kind has a strong canonical proportion (characters stand tall).
export const ASPECT_LIMITS: Record<AssetKind, number> = {
  // A single house/building is roughly 1-1.5x wider than tall. >2.2 means a flat blob or a multi-house
  // CLUSTER (the 22x25x5 sprawl) rather than one structure.
  building: 2.2,
  // Characters/creatures stand taller than (or about as wide as) they are tall. >1.2 is almost always a
  // mis-pick (a prop, a ragdoll, a flat sheet).
  character: 1.2,
  // Vegetation canopies/bushes can be genuinely broad, so allow a wider spread before rejecting.
  vegetation: 2.5,
  // Props vary wildly (a tall lamp vs. a wide rug), so the prop/model gate is lenient — it only catches
  // truly degenerate flats.
  prop: 3.0,
  model: 3.0,
};

// ── TOWER signal ───────────────────────────────────────────────────────────────────────────────────────
// When the prompt names a tower-like structure, the asset MUST be taller than wide (aspect <= this). This
// is the specific rule that rejects the wide castle returned for "medieval tower". It OVERRIDES (tightens)
// the per-kind limit — a tower is never allowed to be wide just because "building" tolerates 2.2.
export const TOWER_MAX_ASPECT = 0.9;
export const TOWER_KEYWORDS = ["tower", "watchtower", "keep"];

// Default number of seed re-rolls (the original seed plus N-1 successors) the curator will try before
// falling back to the best (lowest-aspect) candidate it saw.
export const DEFAULT_MAX_ATTEMPTS = 6;

/** A bounding extent, in the asset's own units, as [width(x), height(y), depth(z)]. */
export type Dims = [number, number, number];

/** Whether the prompt asks for a tower-like structure (case-insensitive keyword match). */
export function isTowerPrompt(prompt: string): boolean {
  const p = (prompt ?? "").toLowerCase();
  return TOWER_KEYWORDS.some((k) => p.includes(k));
}

/** The scale-invariant footprint aspect: max(width, depth) / height. Guards a zero/near-zero height
 *  (a perfectly flat asset) so it reports a large finite aspect (a clear reject) rather than Infinity. */
export function footprintAspect(dims: Dims): number {
  const [w, h, d] = dims;
  const denom = h > 1e-6 ? h : 1e-6;
  return Math.max(w, d) / denom;
}

/** The effective aspect LIMIT for a (kind, prompt): the per-kind limit, tightened to TOWER_MAX_ASPECT
 *  when the prompt names a tower-like structure (the tighter of the two always wins). */
export function aspectLimit(kind: AssetKind, prompt: string): number {
  const base = ASPECT_LIMITS[kind] ?? ASPECT_LIMITS.model;
  return isTowerPrompt(prompt) ? Math.min(base, TOWER_MAX_ASPECT) : base;
}

/** The verdict of one footprint check. */
export interface CurationVerdict {
  ok: boolean;
  aspect: number;
  limit: number;
  dims: Dims;
}

/** Footprint-sanity check: PASS when aspect <= the effective limit for (kind, prompt). Pure — operates on
 *  bounds alone, so it unit-tests against synthetic dims with no glb. */
export function checkFootprint(kind: AssetKind, prompt: string, dims: Dims): CurationVerdict {
  const aspect = footprintAspect(dims);
  const limit = aspectLimit(kind, prompt);
  return { ok: aspect <= limit, aspect, limit, dims };
}

/** Measure a glb's raw bounding box (gltf-transform: load the binary into a Document, take the default
 *  scene's bounds) and return [width, height, depth] in the asset's own units. */
export async function boundsOfGlb(bytes: Uint8Array): Promise<Dims> {
  const io = new NodeIO();
  const doc = await io.readBinary(bytes);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) return [0, 0, 0];
  const { min, max } = getBounds(scene);
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

/** A short, human-readable id for a resolved asset (for the curate log): the provenance URL if present
 *  (e.g. a Poly Pizza model page), else the source name. */
function assetIdOf(result: AssetResult): string {
  return result.meta.sourceUrl ?? result.meta.source ?? "?";
}

/** The re-roll loop. Resolves seed = baseSeed, baseSeed+1, … up to maxAttempts; measures each candidate's
 *  bounds and runs the footprint check; returns the FIRST that passes. If none pass, returns the best
 *  (lowest-aspect) candidate seen. The cache key already folds in seed, so the curated seed is what gets
 *  cached → re-rolls are deterministic on replay.
 *
 *  Generic over the resolve callback's return shape (asset-fetch carries cached/source alongside result);
 *  the only requirement is a `.result` with glb bytes. */
export async function curateResolve<T extends { result: AssetResult }>(opts: {
  kind: AssetKind;
  prompt: string;
  baseSeed: number;
  maxAttempts?: number;
  resolve: (seed: number) => Promise<T>;
  log?: (msg: string) => void;
}): Promise<{ chosen: T; seed: number; verdict: CurationVerdict }> {
  const { kind, prompt, baseSeed, resolve } = opts;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const log = opts.log ?? ((m: string) => console.error(`[asset-fetch] ${m}`));

  let best: { chosen: T; seed: number; verdict: CurationVerdict } | undefined;

  for (let i = 0; i < maxAttempts; i++) {
    const seed = baseSeed + i;
    const chosen = await resolve(seed);
    const dims = await boundsOfGlb(chosen.result.bytes);
    const verdict = checkFootprint(kind, prompt, dims);

    if (verdict.ok) return { chosen, seed, verdict };

    if (!best || verdict.aspect < best.verdict.aspect) best = { chosen, seed, verdict };
    const nextSeed = baseSeed + i + 1;
    log(
      `curate: rejected ${assetIdOf(chosen.result)} (${kind}) ` +
        `aspect=${verdict.aspect.toFixed(2)} > ${verdict.limit.toFixed(2)} — re-rolling seed ${nextSeed}`,
    );
  }

  // Nothing passed — fall back to the closest-to-spec candidate (lowest aspect) and say so plainly.
  log(
    `curate: no in-spec asset for "${prompt}" in ${maxAttempts} tries — using best (aspect=${best!.verdict.aspect.toFixed(2)})`,
  );
  return best!;
}

// ── selftest CLI:  bun run tools/curate.ts --selftest ───────────────────────────────────────────────────
// Unit the (pure) footprint rules against synthetic bounds [width, height, depth]. No glb / no network.
if (import.meta.main && process.argv.includes("--selftest")) {
  interface Case {
    name: string;
    kind: AssetKind;
    prompt: string;
    dims: Dims;
    expectOk: boolean;
  }
  const cases: Case[] = [
    // A 22x25 m footprint, only 5 m tall: a flat multi-house CLUSTER — building rejects it.
    { name: "22x25x5 multi-house cluster", kind: "building", prompt: "medieval house", dims: [22, 5, 25], expectOk: false },
    // A 6x6 m footprint, 5 m tall: a single house — building passes.
    { name: "6x5x6 single house", kind: "building", prompt: "medieval house", dims: [6, 5, 6], expectOk: true },
    // An 18x17 m footprint, 12 m tall, asked for as a "tower": a wide CASTLE — tower rule rejects it.
    { name: "18x12x17 castle (tower prompt)", kind: "building", prompt: "medieval tower", dims: [18, 12, 17], expectOk: false },
    // A 4x4 m footprint, 10 m tall: a slender TOWER — passes the tower rule.
    { name: "4x10x4 slender tower", kind: "building", prompt: "medieval watchtower", dims: [4, 10, 4], expectOk: true },
  ];

  let failures = 0;
  for (const c of cases) {
    const v = checkFootprint(c.kind, c.prompt, c.dims);
    const pass = v.ok === c.expectOk;
    if (!pass) failures++;
    console.log(
      `${pass ? "ok  " : "FAIL"}  ${c.name}: aspect=${v.aspect.toFixed(2)} limit=${v.limit.toFixed(2)} ` +
        `ok=${v.ok} (expected ok=${c.expectOk})`,
    );
  }
  if (failures === 0) {
    console.log("PASS — curate footprint rules");
  } else {
    console.error(`FAIL — ${failures} curate case(s) wrong`);
    process.exit(1);
  }
}
