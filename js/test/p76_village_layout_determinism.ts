// P76 — planVillage (the shared, pure settlement layout brain behind BOTH the preview's
// buildVillage and the engine's village.build skill) is DETERMINISTIC and terrain-aware.
//
// The engine skill records only the direction/steering/seed request and recomputes the
// building transforms on replay, so those transforms MUST be a pure, reproducible function
// of (terrain, steering, footprint radii). This gate falsifies that: it plans the same
// settlement twice over an analytic knoll and asserts byte-identical placements + center,
// checks the settlement is terrain-aware (focal on the high ground, buildings spread, not
// stacked), and proves a different brief re-rolls the layout (so it is not a constant).

import { ops } from "../src/engine.ts";
import { planVillage } from "../src/world/pipeline/village-layout.mjs";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p76_village_layout_determinism: " + msg);
}

// A deterministic analytic terrain (a gaussian knoll centred at the origin) — no native
// ops, so the layout math is exercised in isolation. Matches the sampler contract:
// { heightAt, slopeAt, halfSize, seaLevel, amplitude }.
function makeSampler() {
  const amp = 18, sigma = 34, half = 60;
  const heightAt = (x: number, z: number): number => amp * Math.exp(-(x * x + z * z) / (2 * sigma * sigma));
  const e = 1;
  const slopeAt = (x: number, z: number): number => {
    const hx = heightAt(x + e, z) - heightAt(x - e, z);
    const hz = heightAt(x, z + e) - heightAt(x, z - e);
    return Math.hypot(hx, hz) / (2 * e);
  };
  return { heightAt, slopeAt, halfSize: half, seaLevel: -2, amplitude: amp };
}

const direction = { palette: { stone: "#9b9890", timber: "#5c4632" }, mood: "weathered, lived-in" };
const steering = {
  buildings: [
    { role: "keep", style: "nordic castle", count: 1 },
    { role: "church", style: "romanesque", count: 1 },
    { role: "cottage", style: "wattle-and-daub", count: 6 },
    { role: "barn", style: "timber", count: 1 },
  ],
  layout: { focal: "keep on the high knoll", density: "loose" },
};
// Footprint radii in the expansion order (keep, church, 6× cottage, barn) — the same
// 0.5·hypot(boundsX,boundsZ) the skill derives from each GLB's card boundsM.
const radii = [8.96, 10.6, 5.13, 5.13, 5.13, 5.13, 5.13, 5.13, 10.18];

// deno-lint-ignore no-explicit-any
const a = (planVillage as any)(makeSampler(), direction, steering, radii);
// deno-lint-ignore no-explicit-any
const b = (planVillage as any)(makeSampler(), direction, steering, radii);

// 1. It plans every building.
assert(a.placements.length === 9, `expected 9 placements, got ${a.placements.length}`);
assert(a.placements[0].role === "keep", `focal (placements[0]) must be the keep, got ${a.placements[0].role}`);

// 2. Terrain-aware: the focal sits on the high ground near the knoll summit (origin), and the
//    buildings are SPREAD (never stacked at one point).
assert(Math.hypot(a.placements[0].x, a.placements[0].z) < 20, "focal keep must sit on the high knoll near the summit");
let minD = Infinity;
for (let i = 0; i < a.placements.length; i++) {
  for (let j = i + 1; j < a.placements.length; j++) {
    const p = a.placements[i], q = a.placements[j];
    minD = Math.min(minD, Math.hypot(p.x - q.x, p.z - q.z));
  }
}
assert(minD > 6, `buildings must be spread, min pairwise distance ${minD.toFixed(2)}`);

// 3. Determinism: same {terrain, direction, steering, radii} → byte-identical placements + center.
assert(a.placements.length === b.placements.length, "replay placement count diverged");
let identical = true, firstDiff = -1;
for (let i = 0; i < a.placements.length; i++) {
  const pa = a.placements[i], pb = b.placements[i];
  if (pa.role !== pb.role || pa.style !== pb.style || pa.index !== pb.index || pa.x !== pb.x || pa.z !== pb.z || pa.yaw !== pb.yaw) {
    identical = false; firstDiff = i; break;
  }
}
assert(identical, `planVillage must be deterministic — placement ${firstDiff} diverged on replay`);
assert(a.center.x === b.center.x && a.center.z === b.center.z, "center diverged on replay");

// 4. Not a constant: a different brief (tighter density) re-rolls the layout.
const steering2 = { ...steering, layout: { focal: "keep on the high knoll", density: "tight" } };
// deno-lint-ignore no-explicit-any
const c = (planVillage as any)(makeSampler(), direction, steering2, radii);
let anyDiff = false;
for (let i = 0; i < a.placements.length; i++) {
  if (a.placements[i].x !== c.placements[i].x || a.placements[i].z !== c.placements[i].z) { anyDiff = true; break; }
}
assert(anyDiff, "a different density brief must change the layout (else it is a constant, not a plan)");

ops.op_log(`[js] p76_village_layout_determinism OK: planVillage is deterministic (byte-identical placements + center on replay) and terrain-aware (focal keep on the knoll, 9 buildings spread, min gap ${minD.toFixed(1)}m); a different density brief re-rolls the spacing.`);
