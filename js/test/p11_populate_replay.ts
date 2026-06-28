// Phase 11 — REPLAY PARITY for the new default-render skills.
//
// The auto-surface (world.generateRegion `surface`) is RENDER-ONLY, and world.populateBiome
// orchestrates NESTED asset.scatter calls. This test pins the determinism/replay invariants
// the two skills MUST honour:
//
//   1. NO DOUBLE-RECORD: world.populateBiome records as ONE top-level command; the nested
//      asset.scatter calls it drives are NOT separately recorded (the recorder's depth
//      counter — re-invoking populateBiome on replay reproduces them). Falsifiable: if the
//      nested scatter were recorded, the command stream would carry asset.scatter commands.
//   2. RECOMPUTE IDENTICAL: replaying the recorded stream (generateRegion + populateBiome)
//      into a FRESH world/registry recomputes the SAME scatter placements, bit-for-bit.
//   3. RENDER-ONLY: the auto-surface mesh is render-only — generating WITH it (render:true,
//      default) vs WITHOUT it (render:false) yields the IDENTICAL populateBiome placements.
//
// Run: limina js/test/p11_populate_replay.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { TILE_SIZE } from "../src/terrain/procedural.ts";
import type { AssetInstance } from "../src/terrain/asset-scatter.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_populate_replay FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}
const sameInstances = (a: AssetInstance[], b: AssetInstance[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].assetId !== b[i].assetId) return false;
    for (const k of ["x", "y", "z", "yaw", "scale"] as (keyof AssetInstance)[]) {
      if (!Object.is(a[i][k], b[i][k])) return false;
    }
  }
  return true;
};

function makeWorld(worldOps: EngineOps): WorldContext {
  const stub = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: stub as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

/** Wrap a registry's invoke to collect EVERY asset.scatter's placements (in order). */
function captureScatter(registry: SkillRegistry): AssetInstance[] {
  const placements: AssetInstance[] = [];
  const inner = registry.invoke.bind(registry);
  registry.invoke = (n, i, b) => inner(n, i, b).then((rr) => {
    if (n === "asset.scatter" && rr.success) {
      placements.push(...((rr.result as { placements: AssetInstance[] }).placements));
    }
    return rr;
  });
  return placements;
}

const SEED = 1234;
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 } as const;
const HALF_EXTENT = (Math.min(BOUNDS.maxTx - BOUNDS.minTx, BOUNDS.maxTz - BOUNDS.minTz) + 1) * TILE_SIZE / 2;
const SHAPE = {
  amp: 4.5, erode: 1,
  islandCx: ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE,
  islandCz: ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE,
  islandRadius: HALF_EXTENT * 0.40, islandFalloff: HALF_EXTENT * 0.62,
};
const WATER_MARGIN = 2.5;

// ── AUTHORING (recorded): generateRegion (auto-surface, default render) + populateBiome ──
const recorder = new WorldRecorder("ses_p11_populate_rec");
const recReg = new SkillRegistry(new LiminaTracer("ses_p11_populate_rec"));
registerCoreSkills(recReg);
recorder.attach(recReg);                 // record top-level invokes (depth 0)
const authPlacements = captureScatter(recReg); // capture nested asset.scatter placements
const recOps = recorder.wrapOps(ops);
const recWorld = makeWorld(recOps);
const base = { agentId: "agt_rec", sessionId: "ses_p11_populate_rec", permissions: resolveProfile("builder.readWrite"), tick: 0, world: recWorld };

recOps.op_physics_create_world(-9.81);    // depth-0 physics op → recorded + replayed
const gen = ok(await recReg.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: "mountains", hints: SHAPE }, base));
const regionId = gen.regionId as string;
const relief = gen.relief as { minY: number; maxY: number };
const seaLevel = relief.minY + 0.18 * (relief.maxY - relief.minY);
const pop = ok(await recReg.invoke("world.populateBiome", { regionId, waterLevel: seaLevel, waterMargin: WATER_MARGIN }, base));
assert((pop.instances as number) > 0, "authoring populateBiome placed nothing");
assert(authPlacements.length === (pop.instances as number), `captured ${authPlacements.length} placements != reported ${pop.instances} (a layer's scatter was missed)`);

// ── 1. NO DOUBLE-RECORD: the stream carries the two top-level skills, NOT asset.scatter ──
const tools = recorder.commands.filter((c): c is { kind: "skill"; tool: string } => c.kind === "skill").map((c) => c.tool);
assert(tools.includes("world.generateRegion"), "generateRegion not recorded");
assert(tools.includes("world.populateBiome"), "populateBiome not recorded");
assert(!tools.includes("asset.scatter"), `nested asset.scatter was DOUBLE-RECORDED (${tools.filter((t) => t === "asset.scatter").length}×) — replay would scatter twice`);

// ── 2. RECOMPUTE IDENTICAL: replay the stream into a fresh world/registry ─────────────────
let replayPlacements: AssetInstance[] = [];
await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    registerCoreSkills(r);
    replayPlacements = captureScatter(r);
    return r;
  },
  tracer: new LiminaTracer("ses_p11_populate_replay"),
});
assert(replayPlacements.length > 0, "replay re-ran no asset.scatter (populateBiome did not re-drive it)");
assert(sameInstances(replayPlacements, authPlacements), "replay recomputed DIFFERENT placements than authoring (not bit-identical)");

// ── 3. RENDER-ONLY: render:false yields the IDENTICAL populateBiome placements ────────────
ops.op_physics_create_world(-9.81);
const reg2 = new SkillRegistry(new LiminaTracer("ses_p11_populate_norender"));
registerCoreSkills(reg2);
const noRenderPlacements = captureScatter(reg2);
const world2 = makeWorld(ops);
const base2 = { agentId: "agt_nr", sessionId: "ses_p11_populate_norender", permissions: resolveProfile("builder.readWrite"), tick: 0, world: world2 };
const gen2 = ok(await reg2.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: "mountains", hints: SHAPE, render: false }, base2));
assert((gen2.meshes as number) === 0, "render:false still built meshes");
ok(await reg2.invoke("world.populateBiome", { regionId: gen2.regionId as string, waterLevel: seaLevel, waterMargin: WATER_MARGIN }, base2));
assert(sameInstances(noRenderPlacements, authPlacements), "render:false changed the populateBiome placements — the auto-surface is NOT render-only");

ops.op_log(
  `p11_populate_replay OK: world.populateBiome records as ONE top-level command (nested asset.scatter NOT double-recorded); ` +
  `replay recomputes ${replayPlacements.length} placements bit-identical to authoring; ` +
  `auto-surface is render-only (render:false → identical ${noRenderPlacements.length} placements). ` +
  `Determinism/replay preserved for generateRegion(auto-surface) + populateBiome.`,
);
