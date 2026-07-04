// P85 — headless ORIENTATION + DEFORM-FOLLOW gate for the BROWSER (WASM Rapier) terrain collider.
//
// Motivation: p84 only grounds on FLAT terrain, which is transpose-invariant, so a heightfield
// axis/transpose bug or a stale-after-deform collider both slip past it. p85 exercises the REAL
// browser WASM path (WasmRapierPhysics — the same code the sim-worker runs) on ASYMMETRIC relief
// that distinguishes X from Z, and after a terrain.deform that reshapes the surface.
//
// What it proves, on the WASM/worker path:
//   (A) ORIENTATION — the heightfield collider's ground height matches the render-mesh formula at
//       every (x,z) on an asymmetric X-ramp (height depends on COL only). A row/col transpose or an
//       X-sign flip would make a corner mismatch. [Locks the col->X, row->Z convention.]
//   (B) GENERATED RELIEF — same collider==mesh check on real seed-6 / amplitude-16 generated terrain
//       (the params the walkable village scene uses), at several asymmetric probe points.
//   (C) DEFORM FOLLOW — after terrain.deform cuts a region DOWN, the collider follows the new mesh
//       surface (does NOT stay at the pre-deform height). This is the ACTUAL sink-through root cause:
//       village.build terraces the terrain via terrain.deform, and a stale collider left the player
//       floating where terrain was cut and sinking through where it was raised.
//   (D) GROUNDED-AFTER-DEFORM — a player dropped onto a freshly-deformed patch RESTS on the new
//       surface (end-to-end: reshaped collider actually carries the character controller).
//
// Run: ./target/release/limina js/test/p85_heightfield_orientation.ts   (exit 0 = pass)

import { SimWorkerController, type AuthorCommand } from "../src/browser/sim-worker.ts";
import type { RapierModule } from "../src/browser/wasm-rapier-physics.ts";
import { WasmRapierPhysics } from "../src/browser/wasm-rapier-physics.ts";
import { ops as nativeOps } from "../src/engine.ts";
import { generateHeightfield } from "../src/world/pipeline/terrain-heightfield.mjs";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p85_heightfield_orientation FAIL: " + msg);
}

// ── bring up REAL rapier-compat (injected; the native loader can't resolve the bare specifier) ──
let RAPIER: RapierModule | null = null;
let initError: string | null = null;
try {
  // @ts-ignore — relative file:// import into node_modules.
  RAPIER = (await import("../node_modules/@dimforge/rapier3d-compat/rapier.mjs")) as unknown as RapierModule;
} catch (e) {
  initError = "import failed: " + String(e);
}
assert(RAPIER !== null, "rapier-compat could not be imported — cannot run the WASM orientation gate. " + (initError ?? ""));
const R = RAPIER as RapierModule;

const EPS = 0.05; // 5 cm: raycast hits the triangulated cell interior vs the mesh vertex formula.

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (A) ORIENTATION — synthetic asymmetric X-ramp through the REAL op (WasmRapierPhysics directly).
// Height depends on COL c only: h = c/(n-1) * AMP. Mesh convention (terrain/mesh.ts): col->X,
// row->Z, y = origin.y + heights[r*ncols+c]*scaleY. So the surface RISES along +X, is FLAT along Z.
// A transpose would make it rise along Z instead; an X-sign flip would invert it. We probe corners
// where those errors are unmistakable and compare to the mesh formula.
{
  const phys = await WasmRapierPhysics.create(R, { gravityY: -9.81 });
  const N = 9, SIZE = 32, AMP = 8;
  const origin: [number, number, number] = [0, 0, 0];
  const scale: [number, number, number] = [SIZE, 1, SIZE];
  const heights = new Float32Array(N * N);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) heights[r * N + c] = (c / (N - 1)) * AMP;

  phys.op_physics_add_heightfield(origin[0], origin[1], origin[2], N, N, scale[0], scale[1], scale[2], heights);
  phys.op_physics_step(); // populate the query pipeline

  // mesh ground truth at a vertex (x,z): recover (r,c) and read heights[r*N+c]*scaleY + origin.y.
  const dx = SIZE / (N - 1), dz = SIZE / (N - 1), x0 = origin[0] - SIZE / 2, z0 = origin[2] - SIZE / 2;
  const meshY = (x: number, z: number): number => {
    const c = Math.round((x - x0) / dx), r = Math.round((z - z0) / dz);
    return origin[1] + heights[r * N + c] * scale[1];
  };
  const out = new Float32Array(6);
  const colliderY = (x: number, z: number): number => {
    phys.op_physics_raycast(x, 1000, z, 0, -1, 0, 2000, out);
    return out[0] === 1 ? out[3] : NaN;
  };

  // Corners + a mid-edge. On the X-ramp: low-X => y≈0, high-X => y≈AMP, INDEPENDENT of z.
  const probes: [number, number, string][] = [
    [-16, -16, "minX/minZ"], [16, -16, "maxX/minZ"],
    [-16, 16, "minX/maxZ"], [16, 16, "maxX/maxZ"],
    [8, -12, "midX/lowZ"], [-8, 12, "midX/highZ"],
  ];
  let worst = 0;
  for (const [x, z, label] of probes) {
    const cy = colliderY(x, z), my = meshY(x, z);
    const d = Math.abs(cy - my);
    worst = Math.max(worst, d);
    nativeOps.op_log(`[js]   (A) ${label} (${x},${z}): collider=${Number.isFinite(cy) ? cy.toFixed(3) : "MISS"} mesh=${my.toFixed(3)} d=${d.toFixed(4)}`);
    assert(Number.isFinite(cy), `(A) ramp collider MISS at ${label} (${x},${z}) — heightfield not hit`);
    assert(d < EPS, `(A) collider != mesh at ${label} (${x},${z}): collider=${cy.toFixed(3)} mesh=${my.toFixed(3)} d=${d.toFixed(4)} — X-ramp orientation (transpose/sign) is WRONG`);
  }
  // Explicit axis witness: the two maxX corners must both be HIGH (~AMP) and the two minX corners
  // LOW (~0), regardless of z — a transpose would instead split by z.
  assert(Math.abs(colliderY(16, -16) - AMP) < EPS && Math.abs(colliderY(16, 16) - AMP) < EPS,
    "(A) +X edge is not the high edge — collider axes are transposed vs the mesh");
  assert(Math.abs(colliderY(-16, -16) - 0) < EPS && Math.abs(colliderY(-16, 16) - 0) < EPS,
    "(A) -X edge is not the low edge — collider axes are transposed/flipped vs the mesh");
  nativeOps.op_log(`[js] p85 (A) ORIENTATION OK — X-ramp collider matches mesh (col->X, row->Z), worst d=${worst.toFixed(4)} m`);
  phys.dispose();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared: the real generated-terrain scene params (match the walkable village play scene).
const SIZE = 120, RES = 128, SEED = 6, AMP = 16;
const GEN = { seed: SEED, amplitude: AMP, seaCoverage: 0.2, erosion: { rain: 1.5, thermal: 6 } };

// Generator mesh ground-truth — the SAME pure generator terrain.create fills the tile from. We probe
// AT GRID VERTICES (where the triangulated mesh height == heights[r*cols+c] exactly, no interpolation
// ambiguity), so any residual delta is a real collider/mesh disagreement, not bilinear-vs-triangle.
const gh = generateHeightfield({ ...GEN, sizeM: SIZE, gridN: RES - 1 }) as { heights: Float32Array; cols: number; rows: number };
const VDX = SIZE / (gh.cols - 1), VDZ = SIZE / (gh.rows - 1), VX0 = -SIZE / 2, VZ0 = -SIZE / 2;
// Triangulated mesh height at (x,z) — matches terrain/mesh.ts winding exactly: v00,v10,v01 / v10,v11,v01
// (diagonal v01→v10). Planar-per-triangle, so at a vertex it equals heights[r*cols+c]. We probe cell
// INTERIORS (off the shared edges where rapier's heightfield raycast is numerically fragile).
function triMeshY(x: number, z: number): number {
  const cols = gh.cols, rows = gh.rows;
  const fx = (x - VX0) / VDX, fz = (z - VZ0) / VDZ;
  const c0 = Math.max(0, Math.min(cols - 2, Math.floor(fx))), r0 = Math.max(0, Math.min(rows - 2, Math.floor(fz)));
  const tx = fx - c0, tz = fz - r0, h = (r: number, c: number) => gh.heights[r * cols + c];
  const y00 = h(r0, c0), y01 = h(r0, c0 + 1), y10 = h(r0 + 1, c0), y11 = h(r0 + 1, c0 + 1);
  return (tx + tz <= 1) ? y00 + tx * (y01 - y00) + tz * (y10 - y00)
                        : y11 + (1 - tx) * (y10 - y11) + (1 - tz) * (y01 - y11);
}
// A cell-interior world point for cell (r,c), nudged to (0.3,0.3) inside the cell (off edges).
function cellProbe(r: number, c: number): { x: number; z: number } {
  return { x: VX0 + (c + 0.3) * VDX, z: VZ0 + (r + 0.3) * VDZ };
}

function baseScene(spawn: [number, number, number]): AuthorCommand[] {
  return [
    { kind: "physics", op: "op_physics_create_world", args: [-9.81] },
    { kind: "skill", tool: "terrain.create", input: { size: SIZE, resolution: RES, generate: GEN } },
    { kind: "skill", tool: "player.spawn", input: { position: spawn } },
  ];
}

async function newCtrl(cmds: AuthorCommand[]) {
  const ctrl = await SimWorkerController.create({ rapier: R });
  (ctrl.world.ops as unknown as { op_read_asset: (id: string) => Uint8Array }).op_read_asset = (id: string) => nativeOps.op_read_asset(id);
  const load = await ctrl.loadWorldIsolated(cmds);
  for (const f of load.failures) throw new Error(`p85 authoring #${f.index} ${f.command} failed: ${f.message}`);
  return { ctrl, load };
}

const GROUND_OFFSET = 0.9; // player radius 0.3 + halfHeight 0.6 (matches p84)

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (B) GENERATED RELIEF orientation — collider matches the generator mesh at asymmetric probes.
{
  const { ctrl } = await newCtrl(baseScene([0, 60, 0]));
  ctrl.tick(); // populate the query pipeline
  const out = new Float32Array(6);
  // Asymmetric cell indices (r,c): each distinct in r and c so a transpose (which would put errors of
  // many METRES on this amp-16 relief) is unmistakable vs sub-decimetre triangulation noise.
  const rc: [number, number][] = [[10, 20], [115, 25], [30, 100], [64, 64], [20, 110], [100, 15], [50, 90]];
  let worst = 0;
  for (const [r, c] of rc) {
    const p = cellProbe(r, c);
    ctrl.world.ops.op_physics_raycast(p.x, 1000, p.z, 0, -1, 0, 2000, out);
    const cy = out[0] === 1 ? out[3] : NaN, my = triMeshY(p.x, p.z), d = Math.abs(cy - my);
    worst = Math.max(worst, d);
    nativeOps.op_log(`[js]   (B) cell(r=${r},c=${c}) world(${p.x.toFixed(2)},${p.z.toFixed(2)}): collider=${Number.isFinite(cy) ? cy.toFixed(3) : "MISS"} mesh=${my.toFixed(3)} d=${d.toFixed(4)}`);
    assert(Number.isFinite(cy), `(B) generated collider MISS at cell (r=${r},c=${c}) world(${p.x.toFixed(2)},${p.z.toFixed(2)})`);
    assert(d < EPS, `(B) generated collider != mesh at cell (r=${r},c=${c}): collider=${cy.toFixed(3)} mesh=${my.toFixed(3)} d=${d.toFixed(4)}`);
  }
  nativeOps.op_log(`[js] p85 (B) GENERATED RELIEF OK — collider matches seed-${SEED}/amp-${AMP} mesh at ${rc.length} cells, worst d=${worst.toFixed(4)} m`);
  ctrl.dispose();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (C) DEFORM FOLLOW — the sink-through root-cause regression. Cut a region DOWN with terrain.deform
// (flatten) and assert the collider follows the new mesh surface instead of staying at its old
// pre-deform height. Without the deform collider-rebuild this FAILS (collider stays high).
{
  const { ctrl } = await newCtrl(baseScene([0, 60, 0]));
  ctrl.tick();
  const out = new Float32Array(6);
  const colliderY = (x: number, z: number): number => { ctrl.world.ops.op_physics_raycast(x, 1000, z, 0, -1, 0, 2000, out); return out[0] === 1 ? out[3] : NaN; };
  const CX = 12, CZ = -8;
  const before = colliderY(CX, CZ);
  const target = before - 7; // cut 7 m down (relative to origin.y=0)
  const res = await ctrl.registry.invoke("terrain.deform", { center: [CX, CZ], radius: 16, delta: target, mode: "flatten", falloff: "constant" },
    { agentId: "p85", sessionId: "p85", permissions: new Set(["scene.write"]), tick: 0, world: ctrl.world });
  assert((res as { success: boolean }).success, "(C) terrain.deform invocation failed");
  ctrl.tick();
  const after = colliderY(CX, CZ);
  nativeOps.op_log(`[js]   (C) center (${CX},${CZ}): colliderBefore=${before.toFixed(3)} target=${target.toFixed(3)} colliderAfter=${after.toFixed(3)}`);
  assert(Number.isFinite(after), "(C) collider MISS after deform — heightfield was removed but not re-added");
  assert(Math.abs(after - target) < EPS,
    `(C) collider did NOT follow the deform: after=${after.toFixed(3)} expected≈${target.toFixed(3)} (before=${before.toFixed(3)}). STALE collider ⇒ player sinks through / floats over deformed terrain (village.build terraces).`);
  nativeOps.op_log(`[js] p85 (C) DEFORM FOLLOW OK — collider dropped ${(before - after).toFixed(2)} m to track the reshaped mesh (root-cause regression locked)`);
  ctrl.dispose();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (D) GROUNDED-AFTER-DEFORM — end-to-end: deform the ground under the spawn, then drop the player
// and confirm it RESTS on the NEW surface (not the pre-deform height, and not falling through).
{
  const CX = 6, CZ = 4;
  const { ctrl, load } = await newCtrl(baseScene([CX, 60, CZ]));
  const playerEntity = (load.results[2] as { entity: string }).entity;
  const eid = ctrl.entities.resolve(playerEntity)!.eid;
  const target = -3; // flatten the spawn patch to y=-3 (well below the natural surface here)
  const res = await ctrl.registry.invoke("terrain.deform", { center: [CX, CZ], radius: 18, delta: target, mode: "flatten", falloff: "constant" },
    { agentId: "p85", sessionId: "p85", permissions: new Set(["scene.write"]), tick: 0, world: ctrl.world });
  assert((res as { success: boolean }).success, "(D) terrain.deform invocation failed");
  for (let i = 0; i < 200; i++) ctrl.tick(); // drop + settle
  const py = ctrl.transforms.Position.y[eid];
  const foot = py - GROUND_OFFSET;
  nativeOps.op_log(`[js]   (D) player foot=${foot.toFixed(3)} deformed-surface=${target.toFixed(3)}`);
  assert(Number.isFinite(py), `(D) player Y not finite: ${py}`);
  assert(Math.abs(foot - target) < 0.2,
    `(D) player did not rest on the DEFORMED surface: foot=${foot.toFixed(3)} expected≈${target.toFixed(3)} (rested on stale collider or fell through)`);
  nativeOps.op_log(`[js] p85 (D) GROUNDED-AFTER-DEFORM OK — player rests on the reshaped ground at foot=${foot.toFixed(2)} (target ${target})`);
  ctrl.dispose();
}

nativeOps.op_log(
  "[js] p85_heightfield_orientation OK — WASM heightfield collider is mesh-aligned (col->X, row->Z), " +
  "matches generated relief, and now FOLLOWS terrain.deform so the player grounds on the reshaped surface " +
  "(the village-terrace sink-through is fixed).",
);
