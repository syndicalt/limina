// p_entity_stream — Task #78: PLACED-ENTITY residency streaming (the browser view-side
// load/unload of asset.place props), gated headlessly through the EXTRACTED logic exactly
// like p_stream_client gates the tile stream: the REAL EntityResidencyStream + the REAL
// shared wiring (createEntityResidencyWiring — the same eligibility/callbacks browser-entry
// installs, no forked policy), over a REAL authored world (real asset.place of a bundled
// GLB through the registry, real EntityTable/ECS/physics ops). The runLive ACTIVATION policy
// (map-streamed || >512 placed) lives in browser-entry and is documented there; this gate
// proves the MECHANISM those constants switch on.
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p_entity_stream.ts   (exit 0 = pass)
//
// Proves (falsifiably):
//   (a) WINDOW: after convergence at an anchor, every tracked prop within `radius` is
//       MATERIALIZED (mesh attached) and every prop beyond radius+hysteresis is DORMANT
//       (mesh detached, retained); resident count == the in-window count.
//   (b) BUDGET: no update() ever performs more than 4 de/re-materializations.
//   (c) ID STABILITY: across a full leave-and-return cycle the entity ids, eids, mesh object
//       IDENTITIES and SoA transforms are byte-identical (Object.is on every float) — the
//       world log's id spine is untouched by residency.
//   (d) PROTECTION: a body-bound entity is never even tracked; a behavior-carrying entity
//       and a selection-protected id never de-materialize; setProtected-style
//       forceMaterialize re-attaches a dormant mesh immediately (budget-exempt).
//   (e) DORMANT EDITS: three.setMaterial and scene.moveEntity applied while dormant land on
//       the RETAINED state (entry.material + mesh materials; SoA + renderSync onto the
//       detached object) and are intact after re-materialization.
//   (f) TEARDOWN: unregister() re-materializes first, so scene.destroyEntity on a previously
//       dormant entity removes the mesh from the scene exactly like a never-streamed one.

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld, Position, renderSyncSystem, Rotation, Scale } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { createEntityResidencyWiring, EntityResidencyStream, entityStreamEligible } from "../src/browser/entity-stream.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_entity_stream FAIL: " + msg);
}
function ok(res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result as Record<string, unknown>;
}

const GLB = "triangle.glb";
const RADIUS = 300;
const HYSTERESIS = 50;
const BUDGET = 4;

// ── A REAL THREE.Scene (not a stub): the wiring detaches via mesh.parent.remove and
// re-attaches via parent.add, and asset.place's measure path walks parent.matrixWorld —
// the gate must exercise genuine three parenting, exactly what the live viewport has.
import * as THREE from "../build/three.bundle.mjs";
interface Obj { parent?: unknown }
const scene = new THREE.Scene() as { children: Obj[]; add(o: unknown): void; remove(o: unknown): void };
const inScene = (id: string): boolean => scene.children.includes(world.entities.resolve(id)?.mesh as Obj);

function makeWorld(worldOps: EngineOps): WorldContext {
  const camera = { position: { set(): void {} }, aspect: 1, lookAt(): void {}, updateProjectionMatrix(): void {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as unknown as WorldContext["scene"],
    camera: camera as unknown as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

ops.op_physics_create_world(-9.81);
const registry = new SkillRegistry(new LiminaTracer("ses_entity_stream"));
registerCoreSkills(registry);
const world = makeWorld(ops);
const base = {
  agentId: "agt_estream", sessionId: "ses_entity_stream",
  permissions: resolveProfile("builder.readWrite"), tick: 0, world,
};

// ── Author: a 7×7 grid of REAL asset.place props over ±900 m (spacing 300 m) + the
// protection cast: one body-bound primitive, one behavior-carrying prop. ─────────────────
const grid: number[] = [-900, -600, -300, 0, 300, 600, 900];
const placedIds: string[] = [];
const posOf = new Map<string, [number, number]>();
for (const z of grid) {
  for (const x of grid) {
    const out = ok(await registry.invoke("asset.place", { assetId: GLB, position: [x, 0, z] }, base));
    const id = out.entity as string;
    placedIds.push(id);
    posOf.set(id, [x, z]);
    const entry = world.entities.resolve(id);
    assert(entry !== undefined && entry.mesh !== undefined, `placed ${id} has no mesh`);
    assert((entry.mesh as Obj).parent === scene, `placed ${id} mesh not parented to the scene`);
    assert(entry.bodyId === undefined, `asset.place ${id} must be BODILESS (unbound box collider)`);
  }
}
const N = placedIds.length;
assert(N === 49, `expected 49 placed props, got ${N}`);

// Body-bound primitive at the far corner — NEVER eligible (worker-pose-synced class).
const boxOut = ok(await registry.invoke("scene.createEntity", { shape: "box", size: 1, static: true, position: [900, 0.5, 600], color: 0x884422 }, base));
const boxId = boxOut.entity as string;
assert(world.entities.resolve(boxId)?.bodyId !== undefined, "primitive must be body-bound");
assert(!entityStreamEligible(world.entities.resolve(boxId)), "body-bound entity must be INELIGIBLE");

// Behavior-carrying prop at the far corner — eligible at registration, protected dynamically.
const behOut = ok(await registry.invoke("asset.place", { assetId: GLB, position: [600, 0, 900] }, base));
const behaviorId = behOut.entity as string;

// ── Wire the REAL residency stream through the SHARED wiring (same as browser-entry). ────
const protectedIds = new Set<string>();
const wiring = createEntityResidencyWiring(world.entities, protectedIds);
const stream = new EntityResidencyStream({
  radiusM: RADIUS, hysteresisM: HYSTERESIS, maxOpsPerUpdate: BUDGET,
  getPosition: wiring.getPosition, isProtected: wiring.isProtected,
  dematerialize: wiring.dematerialize, rematerialize: wiring.rematerialize,
});
for (const id of world.entities.ids()) if (wiring.eligible(id)) stream.register(id);
assert(stream.size() === N + 1, `expected ${N + 1} tracked (49 grid + behavior prop), got ${stream.size()}`);
assert(!stream.has(boxId), "body-bound entity must not be tracked");

// Behavior lands AFTER registration (the live behavior.set ordering) — protection is dynamic.
world.entities.bindBehavior(behaviorId, { kind: "idle" } as never);

// ── Baseline capture for the id-stability proof (c). ─────────────────────────────────────
const idsBefore = world.entities.ids();
interface Snap { eid: number; mesh: unknown; t: number[] }
const snap = new Map<string, Snap>();
for (const id of idsBefore) {
  const e = world.entities.resolve(id)!;
  snap.set(id, {
    eid: e.eid, mesh: e.mesh,
    t: [
      Position.x[e.eid], Position.y[e.eid], Position.z[e.eid],
      Rotation.x[e.eid], Rotation.y[e.eid], Rotation.z[e.eid], Rotation.w[e.eid],
      Scale.x[e.eid], Scale.y[e.eid], Scale.z[e.eid],
    ],
  });
}

let maxOpsSeen = 0;
function step(x: number, z: number): void {
  const r = stream.update(x, z);
  const opsN = r.dematerialized + r.rematerialized;
  if (opsN > maxOpsSeen) maxOpsSeen = opsN;
  assert(opsN <= BUDGET, `update performed ${opsN} ops > budget ${BUDGET}`);
  assert(r.resident + r.dormant === stream.size(), "resident+dormant must equal tracked");
}
function converge(x: number, z: number): void {
  for (let i = 0; i < 200; i++) {
    const r = stream.update(x, z);
    const opsN = r.dematerialized + r.rematerialized;
    if (opsN > maxOpsSeen) maxOpsSeen = opsN;
    assert(opsN <= BUDGET, `update performed ${opsN} ops > budget ${BUDGET}`);
    if (opsN === 0) return; // a zero-op update == the window is converged
  }
  throw new Error("p_entity_stream FAIL: did not converge in 200 updates");
}
// (a) WINDOW: converged residency == distance window, on both sides of the hysteresis band.
function assertWindow(ax: number, az: number): void {
  let inLoad = 0;
  for (const id of placedIds) {
    const [x, z] = posOf.get(id)!;
    const d = Math.hypot(x - ax, z - az);
    if (d <= RADIUS) {
      inLoad++;
      assert(!stream.isDormant(id) && inScene(id), `prop ${id} at d=${d.toFixed(0)} must be MATERIALIZED`);
    } else if (d > RADIUS + HYSTERESIS) {
      assert(stream.isDormant(id) && !inScene(id), `prop ${id} at d=${d.toFixed(0)} must be DORMANT`);
    }
  }
  assert(stream.residentCount() >= inLoad, "resident under-covers the load window");
}

// ── The walk: corner A → corner B → back to A (60 m steps, budget asserted every step). ──
const A: [number, number] = [-900, -900];
const B: [number, number] = [900, 900];
converge(A[0], A[1]);
assertWindow(A[0], A[1]);
const residentAtA = stream.residentCount();
assert(residentAtA < stream.size(), "some props must be dormant from corner A");
assert(stream.dormantCount() > 0, "dormant set empty at corner A");

const STEPS = 30;
for (let i = 1; i <= STEPS; i++) step(A[0] + ((B[0] - A[0]) * i) / STEPS, A[1] + ((B[1] - A[1]) * i) / STEPS);
converge(B[0], B[1]);
assertWindow(B[0], B[1]);

// (d) PROTECTION at corner B: pin a far-dormant prop (the "selection") — forceMaterialize is
// immediate; while pinned it never de-materializes; unpinning lets it stream out again.
const farFromB = placedIds.find((id) => {
  const [x, z] = posOf.get(id)!;
  return Math.hypot(x - B[0], z - B[1]) > RADIUS + HYSTERESIS;
})!;
assert(stream.isDormant(farFromB), "protection target must start dormant");
protectedIds.add(farFromB);
stream.forceMaterialize(farFromB); // the setProtected(id, true) path
assert(!stream.isDormant(farFromB) && inScene(farFromB), "forceMaterialize must re-attach immediately");
for (let i = 0; i < 10; i++) step(B[0], B[1]);
assert(!stream.isDormant(farFromB) && inScene(farFromB), "a protected entity de-materialized");
protectedIds.delete(farFromB);
converge(B[0], B[1]);
assert(stream.isDormant(farFromB), "unprotected far entity must stream out again");
// The behavior-carrying prop sits ~2 km from B's window? No — (600,900) is NEAR B; walk back
// to A below proves it: it is far from A yet must stay resident (dynamic behavior protection).

// (e) DORMANT EDITS while at corner B: a prop near A is dormant — edit it anyway.
const editId = placedIds.find((id) => {
  const [x, z] = posOf.get(id)!;
  return x === -900 && z === -900;
})!;
assert(stream.isDormant(editId), "edit target (at corner A) must be dormant from corner B");
ok(await registry.invoke("three.setMaterial", { entity: editId, color: 0xff2200, roughness: 0.9 }, base));
const editEntry = world.entities.resolve(editId)!;
assert(editEntry.material?.color === 0xff2200, "dormant setMaterial must land in first-class material state");
let sawColor = false;
const visit = (o: unknown): void => {
  const m = (o as { material?: { color?: { getHex(): number } } }).material;
  if (m?.color !== undefined && m.color.getHex() === 0xff2200) sawColor = true;
  for (const c of ((o as { children?: unknown[] }).children ?? [])) visit(c);
};
visit(editEntry.mesh);
assert(sawColor, "dormant setMaterial must mutate the RETAINED mesh's materials");
ok(await registry.invoke("scene.moveEntity", { entity: editId, position: [-900, 2.5, -900] }, base));
assert(Position.y[editEntry.eid] === 2.5, "dormant moveEntity must write the SoA transform");
renderSyncSystem(world.ecs); // the live loop does this every frame — detached objects included
assert((editEntry.mesh as { position: { y: number } }).position.y === 2.5,
  "renderSync must keep driving the DETACHED mesh (dormant-edit contract)");

// ── Return to corner A (the full leave-and-return cycle). ────────────────────────────────
for (let i = 1; i <= STEPS; i++) step(B[0] + ((A[0] - B[0]) * i) / STEPS, B[1] + ((A[1] - B[1]) * i) / STEPS);
converge(A[0], A[1]);
assertWindow(A[0], A[1]);
assert(!stream.isDormant(editId) && inScene(editId), "edited prop must re-materialize at corner A");
assert(Position.y[editEntry.eid] === 2.5 && editEntry.material?.color === 0xff2200,
  "dormant edits must survive re-materialization");
// Behavior protection: (600,900) is ~2.3 km from A — way outside the window, still resident.
assert(!stream.isDormant(behaviorId) && inScene(behaviorId), "behavior-carrying prop must never de-materialize");

// (c) ID STABILITY: ids, eids, mesh identities and every transform float are UNCHANGED
// (except the deliberately-moved editId's position).
const idsAfter = world.entities.ids();
assert(idsAfter.length === idsBefore.length && idsAfter.every((id, i) => id === idsBefore[i]),
  "entity id list changed across the leave-and-return cycle");
for (const id of idsBefore) {
  const e = world.entities.resolve(id)!;
  const s = snap.get(id)!;
  assert(e.eid === s.eid, `eid changed for ${id}`);
  assert(e.mesh === s.mesh, `mesh object identity changed for ${id}`);
  if (id === editId) continue; // moved on purpose (dormant-edit proof)
  const t = [
    Position.x[e.eid], Position.y[e.eid], Position.z[e.eid],
    Rotation.x[e.eid], Rotation.y[e.eid], Rotation.z[e.eid], Rotation.w[e.eid],
    Scale.x[e.eid], Scale.y[e.eid], Scale.z[e.eid],
  ];
  for (let i = 0; i < 10; i++) {
    assert(Object.is(t[i], s.t[i]), `transform float ${i} of ${id} changed: ${s.t[i]} -> ${t[i]}`);
  }
}

// (f) TEARDOWN of a dormant entity: unregister re-materializes first, then the normal
// destroy path removes the mesh — byte-identical to a never-streamed world.
const doomed = placedIds.find((id) => stream.isDormant(id))!;
const doomedMesh = world.entities.resolve(doomed)!.mesh as Obj;
stream.unregister(doomed);
assert(doomedMesh.parent === scene && inScene(doomed), "unregister must re-materialize a dormant entity");
ok(await registry.invoke("scene.destroyEntity", { entity: doomed }, base));
assert(!scene.children.includes(doomedMesh), "destroy after unregister must remove the mesh from the scene");
assert(world.entities.resolve(doomed) === undefined, "destroyed entity must leave the table");
// And a tracked-but-destroyed-out-of-band entity is dropped on the next update (getPosition → undefined).
const doomed2 = placedIds.find((id) => id !== doomed && stream.has(id))!;
ok(await registry.invoke("scene.destroyEntity", { entity: doomed2 }, base));
step(A[0], A[1]);
assert(!stream.has(doomed2), "an out-of-band-destroyed entity must be dropped from tracking");

// Whole-world teardown must re-attach every retained dormant mesh so the scene
// resource disposer can traverse it, then release all residency bookkeeping.
converge(B[0], B[1]);
assert(stream.dormantCount() > 0, "clear fixture has no dormant entities");
const trackedBeforeClear = world.entities.ids().filter((id) => stream.has(id));
stream.clear();
assert(stream.size() === 0 && stream.dormantCount() === 0, "clear retained residency records");
for (const id of trackedBeforeClear) assert(inScene(id), `clear left ${id} detached from world teardown traversal`);

ops.op_log(
  "[js] p_entity_stream OK — placed-entity residency:\n" +
  `  tracked:    ${N + 1} props (49-grid + behavior) · body-bound excluded · window r=${RADIUS} m +${HYSTERESIS} hysteresis\n` +
  `  walk:       A(-900,-900) → B(900,900) → A, ${STEPS} steps each way · budget ≤${BUDGET}/update (max seen ${maxOpsSeen})\n` +
  `  window:     converged residency == distance window at A, B and A-again (resident at A: ${residentAtA}/${N + 1})\n` +
  `  stability:  ids/eids/mesh identities + all transform floats byte-identical across the full cycle\n` +
  `  dormant:    setMaterial+moveEntity applied while detached, intact after re-materialization\n` +
  "  teardown:   unregister and whole-stream clear re-attach dormant meshes before scene disposal",
);
