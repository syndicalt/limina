// p_navigation_gazetteer — Places Stage 4: the gazetteer (named-place index) + place-based NPC nav.
//
// Run: ./target/release/limina js/test/p_navigation_gazetteer.ts   (exit 0 = pass)
//
// Proves, end to end, that a design-space "Places" tree drives runtime navigation-by-name:
//
//   A. COMPILE EMITS THE GAZETTEER (pure). compileDesignMap({..., placesText}) turns placed places
//      into a `gazetteer` on the WorldMap IR (one entry per PLACED place; an UNPLACED place is
//      hierarchy-only and emits nothing), preserves parentId + area radiusM, and turns a place that
//      names a marker asset into an "asset" anchor (source "places"). It is deterministic
//      (byte-identical across compiles) and the output zod-parses as WorldMap v1. FALSIFIABLE:
//      compiling WITHOUT placesText emits no gazetteer at all; moving a place changes the contentHash.
//   B. gazetteer.load + npc.goToPlace (the skills). gazetteer.load reads the compiled map asset (via
//      the sandboxed op_read_asset — stubbed here the same way p11 stubs the asset source) into the
//      runtime index; npc.goToPlace resolves a place id to its position and walks the entity there
//      THROUGH navmesh.moveTo (real A*), reaching the place with strictly-decreasing remaining
//      distance. FALSIFIABLE: an unknown place id / an unloaded gazetteer returns resolved:false.
//   C. DETERMINISM. Record gazetteer.load + navmesh.build + a fixed goToPlace sequence; replay into a
//      FRESH world/registry and assert the final position is bit-identical.

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld, spawnRenderable, type Transformable } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { compileDesignMap } from "../src/world/design-map-compile.mjs";
import { WorldMapSchema, stableStringifyWorldMap, type WorldMap } from "../src/world/worldmap.ts";
import type { NavmeshManager } from "../src/skills/navmesh.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_navigation_gazetteer FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}
function inert(): Transformable {
  return { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
}
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
type V3 = [number, number, number];
const close2 = (a: V3, gx: number, gz: number, eps = 0.5): boolean => Math.abs(a[0] - gx) < eps && Math.abs(a[2] - gz) < eps;
const sameV = (a: V3, b: V3): boolean => Object.is(a[0], b[0]) && Object.is(a[1], b[1]) && Object.is(a[2], b[2]);

const PERMS = resolveProfile("builder.readWrite");
const MAP_ASSET_ID = "maps/nav-gazetteer.worldmap.json";

// ── The design-vault triplet (inline, no fixture files). A square land outline, a 500m zone, and a
//    Places tree with three PLACED places + one UNPLACED place; the hamlet also names a marker asset.
const MAPS_JSON = JSON.stringify({
  activeMapId: "m1",
  maps: [{
    id: "m1",
    features: [{ type: "area", kind: "outline", id: "land", points: [[-200, -200], [200, -200], [200, 200], [-200, 200]] }],
  }],
});
const WORLD_BIBLE = "---\nkind: world-bible\nzone:\n  size_m: 500\n---\n";
const PLACES_MD = [
  "---",
  "kind: places",
  "places:",
  "  - id: dalimond",
  "    name: Dalimond",
  "    kind: nation",
  "    position: [10, -20]",
  "    binding: point",
  "  - id: grey-field",
  "    name: The Grey Field",
  "    kind: hamlet",
  "    parentId: dalimond",
  "    position: [-40, 60]",
  "    binding: point",
  "    assetId: cottage-authored.glb",
  "  - id: the-caesura",
  "    name: The Caesura",
  "    kind: landmark",
  "    parentId: grey-field",
  "    position: [90, -7]",
  "    binding: area",
  "    radiusM: 120",
  "  - id: watchpost",
  "    name: Watchpost",
  "    kind: landmark",
  "    parentId: grey-field",
  "    note: sited but not yet built",
  "---",
  "",
].join("\n");

// ─────────────────────────── A. COMPILE EMITS THE GAZETTEER ───────────────────────────
const cA = compileDesignMap({ mapsJsonText: MAPS_JSON, worldBibleText: WORLD_BIBLE, placesText: PLACES_MD });
const cB = compileDesignMap({ mapsJsonText: MAPS_JSON, worldBibleText: WORLD_BIBLE, placesText: PLACES_MD });
const worldMap = cA.worldMap as WorldMap;

assert(stableStringifyWorldMap(worldMap) === stableStringifyWorldMap(cB.worldMap as WorldMap), "compile with places must be byte-identical across runs");
const parsed = WorldMapSchema.safeParse(worldMap);
assert(parsed.success, "compiled map with a gazetteer must zod-parse as WorldMap v1: " + JSON.stringify(parsed.success ? "" : parsed.error.issues.slice(0, 3)));

const gaz = worldMap.gazetteer ?? [];
assert(gaz.length === 3, `expected 3 gazetteer entries (placed places), got ${gaz.length}`);
assert(!gaz.some((g) => g.placeId === "watchpost"), "UNPLACED place 'watchpost' must NOT appear in the gazetteer");
const gf = gaz.find((g) => g.placeId === "grey-field")!;
assert(gf !== undefined && gf.name === "The Grey Field" && gf.kind === "hamlet" && gf.parentId === "dalimond", "grey-field gazetteer entry wrong");
assert(gf.position[0] === -40 && gf.position[1] === 60, `grey-field position wrong: ${JSON.stringify(gf.position)}`);
const nation = gaz.find((g) => g.placeId === "dalimond")!;
assert(nation.parentId === null, "a root place must have parentId null in the gazetteer");
const caes = gaz.find((g) => g.placeId === "the-caesura")!;
assert(caes.radiusM === 120, `area place must carry radiusM (got ${caes.radiusM})`);

// A placed place that names a marker asset compiles to an "asset" anchor with source "places".
const placeAnchor = worldMap.anchors.find((a) => a.id === "grey-field");
assert(placeAnchor !== undefined && placeAnchor.kind === "asset" && placeAnchor.assetId === "cottage-authored.glb" && placeAnchor.source === "places",
  "grey-field must compile to a source:'places' asset anchor: " + JSON.stringify(placeAnchor));

// FALSIFIABLE #1: no placesText -> NO gazetteer field at all (pre-Places maps unchanged).
const cNoPlaces = compileDesignMap({ mapsJsonText: MAPS_JSON, worldBibleText: WORLD_BIBLE }).worldMap as WorldMap;
assert(cNoPlaces.gazetteer === undefined, "a compile without placesText must not emit a gazetteer field");
// FALSIFIABLE #2: moving a place changes the content hash (the gazetteer is really hashed).
const moved = compileDesignMap({ mapsJsonText: MAPS_JSON, worldBibleText: WORLD_BIBLE, placesText: PLACES_MD.replace("[-40, 60]", "[-41, 60]") }).worldMap as WorldMap;
assert(moved.provenance.contentHash !== worldMap.provenance.contentHash, "moving a place must change the WorldMap contentHash");

// ─────────────────────────── B. gazetteer.load + npc.goToPlace ───────────────────────────
// Stub op_read_asset to serve the compiled map (p11 pattern) — the skill really reads via the
// sandboxed op; only the asset SOURCE is controlled here.
const worldMapBytes = new TextEncoder().encode(JSON.stringify(worldMap));
function stubOps(base: EngineOps): EngineOps {
  return new Proxy(base, {
    get(t, p, r) {
      if (p === "op_read_asset") {
        return (id: string): Uint8Array => {
          if (id === MAP_ASSET_ID) return worldMapBytes;
          return (Reflect.get(t, p, r) as (i: string) => Uint8Array).call(t, id);
        };
      }
      return Reflect.get(t, p, r);
    },
  }) as EngineOps;
}

const REGION = { minX: -160, minZ: -160, maxX: 160, maxZ: 160 } as const; // covers every place + the start
const START: V3 = [-140, 0, -120];

const reg = new SkillRegistry(new LiminaTracer("ses_p_nav_gaz"));
const core = registerCoreSkills(reg);
const mgr = core.nav.navmeshManager;
const sOps = stubOps(ops);
const world = makeWorld(sOps);
sOps.op_physics_create_world(-9.81);
const base = { agentId: "agt_gaz", sessionId: "ses_p_nav_gaz", permissions: PERMS, tick: 0, world };

// FALSIFIABLE #3: goToPlace BEFORE any load -> gazetteer not loaded -> resolved:false.
ok(await reg.invoke("navmesh.build", { bounds: REGION, cellSize: 4 }, base));
const preEid = spawnRenderable(world.ecs, inert(), START[0], START[1], START[2]);
const preEnt = world.entities.create({ eid: preEid });
const notLoaded = ok(await reg.invoke("npc.goToPlace", { entity: preEnt, placeId: "grey-field", from: START }, base));
assert(notLoaded.ok === false && notLoaded.resolved === false, "goToPlace with an unloaded gazetteer must return resolved:false");

// Load the gazetteer from the (stubbed) map asset.
const loaded = ok(await reg.invoke("gazetteer.load", { mapAssetId: MAP_ASSET_ID }, base));
assert(loaded.ok === true && loaded.count === 3, `gazetteer.load should report 3 placed places, got ${loaded.count}`);

// FALSIFIABLE #4: an unknown place id -> resolved:false (no move).
const unknown = ok(await reg.invoke("npc.goToPlace", { entity: preEnt, placeId: "atlantis", from: START }, base));
assert(unknown.ok === false && unknown.resolved === false, "goToPlace to an unknown place must return resolved:false");

// Walk the entity to grey-field [-40, 60] via repeated goToPlace steps (real navmesh under the hood).
ok(await reg.invoke("navmesh.setSpeed", { entity: preEnt, speed: 8 }, base));
let prevRemaining = Infinity, steps = 0;
let mv: Record<string, unknown> | undefined;
do {
  mv = ok(await reg.invoke("npc.goToPlace", { entity: preEnt, placeId: "grey-field", dt: 0.5, from: START }, base));
  assert(mv.ok === true && mv.resolved === true, "goToPlace to a known, loaded place must resolve + move");
  const remaining = mv.remaining as number;
  if (!(mv.arrived as boolean)) assert(remaining < prevRemaining - 1e-9, `remaining did not decrease: ${remaining} >= ${prevRemaining}`);
  prevRemaining = remaining;
  steps++;
} while (!(mv!.arrived as boolean) && steps < 5000);
assert(mv!.arrived as boolean, "goToPlace never reached grey-field");
assert(steps > 1, "arrived in a single step — not actually walking a path");
const finalPos = mv!.position as V3;
assert(close2(finalPos, -40, 60), `final position ${JSON.stringify(finalPos)} is not at grey-field [-40, _, 60]`);

// ─────────────────────────── C. DETERMINISM — record → replay ───────────────────────────
const STEP_COUNT = 24;
const recorder = new WorldRecorder("ses_p_nav_gaz_rec");
const recReg = new SkillRegistry(new LiminaTracer("ses_p_nav_gaz_rec"));
const recCore = registerCoreSkills(recReg);
const recMgr = recCore.nav.navmeshManager;
recorder.attach(recReg);
const recOps = recorder.wrapOps(stubOps(ops));
const recWorld = makeWorld(recOps);
const recBase = { agentId: "agt_rec", sessionId: "ses_p_nav_gaz_rec", permissions: PERMS, tick: 0, world: recWorld };
recOps.op_physics_create_world(-9.81);
const recEid = spawnRenderable(recWorld.ecs, inert(), START[0], START[1], START[2]);
const recEnt = recWorld.entities.create({ eid: recEid }); // ent_0
assert(recEnt === "ent_0", `expected ent_0, got ${recEnt}`);

ok(await recReg.invoke("navmesh.build", { bounds: REGION, cellSize: 4 }, recBase));
ok(await recReg.invoke("gazetteer.load", { mapAssetId: MAP_ASSET_ID }, recBase));
ok(await recReg.invoke("navmesh.setSpeed", { entity: recEnt, speed: 8 }, recBase));
for (let i = 0; i < STEP_COUNT; i++) {
  ok(await recReg.invoke("npc.goToPlace", { entity: recEnt, placeId: "grey-field", dt: 0.5, from: START }, recBase));
}
const authFinal = recMgr.getAgent(recEnt)!.pos as V3;

let replayMgr: NavmeshManager | undefined;
await replayCommands(recorder.commands, {
  makeWorld: () => {
    const w = makeWorld(stubOps(ops));
    const e = spawnRenderable(w.ecs, inert(), START[0], START[1], START[2]);
    w.entities.create({ eid: e }); // ent_0
    return w;
  },
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayMgr = registerCoreSkills(r).nav.navmeshManager;
    return r;
  },
  tracer: new LiminaTracer("ses_p_nav_gaz_replay"),
});
const replayFinal = replayMgr!.getAgent("ent_0")!.pos as V3;
assert(sameV(authFinal, replayFinal), `replay final ${JSON.stringify(replayFinal)} != authoring ${JSON.stringify(authFinal)} (non-deterministic goToPlace)`);

ops.op_log(
  `p_navigation_gazetteer OK: compileDesignMap emits a deterministic gazetteer (3 placed places, unplaced 'watchpost' omitted; ` +
  `area radiusM + parentId preserved; grey-field -> source:'places' asset anchor) that zod-parses; a places-move changes the contentHash and ` +
  `no placesText emits none; gazetteer.load read 3 entries from the (stubbed) map asset; npc.goToPlace walked the entity to grey-field ` +
  `[-40,60] in ${steps} steps (remaining strictly decreasing) via navmesh.moveTo; unknown-place + unloaded-gazetteer both return resolved:false; ` +
  `record->replay of ${STEP_COUNT} goToPlace steps reproduces the identical final position ${JSON.stringify(replayFinal)}.`,
);
