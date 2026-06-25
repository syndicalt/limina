// P3N-S spike (native-spatial go/no-go): prove the native rayon op
// `op_ecs_spatial_query_batch` (crates/limina-ecs) is
//   (1) BIT-IDENTICAL to the JS oracle UniformGridSpatialIndex — same hit set
//       AND same order, including the insertion-order tiebreak on exact
//       distance ties (a deliberate 4-entity identical-position cluster);
//   (2) DETERMINISTIC — identical output across runs (thread-count independent);
//   (3) materially FASTER than the JS grid at the locked density (E=2000, K=200).
//
// Run: limina js/test/p3n_s_spike.ts

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld, Position } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}
function field(v: unknown, k: string): unknown {
  return typeof v === "object" && v !== null && k in v ? (v as Record<string, unknown>)[k] : undefined;
}
const perf = (globalThis as { performance?: { now?: () => number } }).performance;
const hiRes = typeof perf?.now === "function";
const now: () => number = hiRes ? () => perf!.now!() : () => Date.now();

const CELL = 10;
const E = 2000;
const K = 200;
const MAX_HITS = 512;
const AREA = 200;
const RADIUS = 15;
const TIE_N = 4; // entities at an identical position -> guaranteed exact distance tie
const TIE_POS: [number, number, number] = [3, 0, 3];

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const ecs = createEcsWorld();
const world: WorldContext = {
  ecs,
  transforms: createTransformStorage(ecs),
  spatial: new UniformGridSpatialIndex({ cellSize: CELL }),
  entities: new EntityTable(),
  tags: new Map(),
  scene,
  camera,
  ops,
};
ops.op_physics_create_world(0);
const tracer = new LiminaTracer("ses_p3ns");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);
const builder = { agentId: "agt_spike", sessionId: "ses_p3ns", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

let seed = 0x0051a7e5 >>> 0;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
};

const entityStrings: string[] = [];
// TIE_N entities at exactly the same position -> distance-0 ties for a query at TIE_POS.
for (let i = 0; i < TIE_N; i++) {
  const e = field(ok(await registry.invoke("scene.createEntity", { position: TIE_POS }, builder)), "entity");
  assert(typeof e === "string", "tie entity setup failed");
  entityStrings.push(e);
}
for (let i = TIE_N; i < E; i++) {
  const e = field(ok(await registry.invoke("scene.createEntity", { position: [(rnd() - 0.5) * AREA, (rnd() - 0.5) * 2, (rnd() - 0.5) * AREA] }, builder)), "entity");
  assert(typeof e === "string", "entity setup failed");
  entityStrings.push(e);
}

const ids = world.entities.ids();
const orderedEids = new Uint32Array(ids.length);
for (let i = 0; i < ids.length; i++) {
  const entry = world.entities.resolve(ids[i]);
  assert(entry !== undefined, "entity id did not resolve");
  orderedEids[i] = entry.eid;
}

// K queries: q0 at TIE_POS (hits the tie cluster), rest random; every 5th excludes an entity.
const queries = new Float64Array(K * 5);
const excludeStrings: (string | undefined)[] = [];
for (let q = 0; q < K; q++) {
  const nx = q === 0 ? TIE_POS[0] : (rnd() - 0.5) * AREA;
  const ny = q === 0 ? TIE_POS[1] : 0;
  const nz = q === 0 ? TIE_POS[2] : (rnd() - 0.5) * AREA;
  let excludeEid = -1;
  let excludeString: string | undefined;
  if (q % 5 === 1) {
    excludeString = entityStrings[(q * 7) % E];
    excludeEid = world.entities.resolve(excludeString)?.eid ?? -1;
  }
  excludeStrings.push(excludeString);
  queries[q * 5] = nx;
  queries[q * 5 + 1] = ny;
  queries[q * 5 + 2] = nz;
  queries[q * 5 + 3] = RADIUS;
  queries[q * 5 + 4] = excludeEid;
}

const stride = 1 + MAX_HITS;
const out = new Uint32Array(K * stride);
ops.op_ecs_spatial_query_batch(Position.x, Position.y, Position.z, orderedEids, CELL, queries, MAX_HITS, out);

// (1) Bit-identical to the JS oracle, per query.
let totalHits = 0;
for (let q = 0; q < K; q++) {
  const near: [number, number, number] = [queries[q * 5], queries[q * 5 + 1], queries[q * 5 + 2]];
  const res = world.spatial!.query(world, { near, radius: RADIUS, sortBy: "distance", excludeEntity: excludeStrings[q] });
  const jsEids = res.entities.map((row) => row.eid);
  const count = out[q * stride];
  assert(count <= MAX_HITS, `query ${q}: count ${count} exceeded MAX_HITS ${MAX_HITS}`);
  assert(count === jsEids.length, `query ${q}: native count ${count} != JS ${jsEids.length}`);
  for (let i = 0; i < count; i++) {
    assert(out[q * stride + 1 + i] === jsEids[i], `query ${q} hit ${i}: native eid ${out[q * stride + 1 + i]} != JS ${jsEids[i]}`);
  }
  totalHits += count;
}

// Confirm q0 really exercised the exact-distance tiebreak: the TIE_N identical-position
// entities are all present at distance 0 and lead the result in insertion order.
const q0 = world.spatial!.query(world, { near: TIE_POS, radius: RADIUS, sortBy: "distance" });
const tieEids = entityStrings.slice(0, TIE_N).map((s) => world.entities.resolve(s)!.eid);
const q0Lead = q0.entities.slice(0, TIE_N).map((row) => row.eid);
assert(q0.entities.slice(0, TIE_N).every((row) => row.distance === 0), "tie cluster not at distance 0");
assert(q0Lead.join(",") === tieEids.join(","), `tie order: oracle lead ${q0Lead.join(",")} != insertion ${tieEids.join(",")}`);
assert(Array.from(out.subarray(1, 1 + TIE_N)).join(",") === tieEids.join(","), "native did not match the insertion-order tiebreak");
ops.op_log(`P3N-S BIT-IDENTICAL OK: ${K} queries, ${totalHits} total hits, native == JS oracle incl. the ${TIE_N}-way distance-0 tie (insertion-order tiebreak matched)`);

// (2) Deterministic: a second run is byte-identical.
const out2 = new Uint32Array(K * stride);
ops.op_ecs_spatial_query_batch(Position.x, Position.y, Position.z, orderedEids, CELL, queries, MAX_HITS, out2);
for (let i = 0; i < out.length; i++) assert(out[i] === out2[i], `determinism: out[${i}] ${out[i]} != ${out2[i]}`);
ops.op_log("P3N-S DETERMINISTIC OK: identical output across two runs");

// (3) Native (build + K queries, one call) vs JS oracle (rebuild + K queries).
// Aggregate over many iterations so the ~1 ms timer granularity averages out.
const ITERS = 300;
const nt0 = now();
for (let it = 0; it < ITERS; it++) {
  ops.op_ecs_spatial_query_batch(Position.x, Position.y, Position.z, orderedEids, CELL, queries, MAX_HITS, out);
}
const nativeMean = (now() - nt0) / ITERS;
const jt0 = now();
for (let it = 0; it < ITERS; it++) {
  world.spatial!.invalidate(); // force the per-tick rebuild perception pays
  for (let q = 0; q < K; q++) {
    const near: [number, number, number] = [queries[q * 5], queries[q * 5 + 1], queries[q * 5 + 2]];
    world.spatial!.query(world, { near, radius: RADIUS, sortBy: "distance", excludeEntity: excludeStrings[q] });
  }
}
const jsMean = (now() - jt0) / ITERS;
const ratio = jsMean / Math.max(1e-9, nativeMean);
ops.op_log(`P3N-S BENCH native build+query ${nativeMean.toFixed(3)}ms/iter vs JS ${jsMean.toFixed(3)}ms/iter = ${ratio.toFixed(2)}x faster (E=${E}, K=${K}, ${ITERS} iters, timer ${hiRes ? "performance.now()" : "Date.now()"})`);
assert(nativeMean < jsMean, `native (${nativeMean.toFixed(3)}ms) not faster than JS (${jsMean.toFixed(3)}ms)`);

ops.op_log(`P3N-S SPIKE GO: bit-identical + deterministic + ${ratio.toFixed(2)}x faster`);
