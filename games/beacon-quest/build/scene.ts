// BEACON QUEST — scene exporter. Records a dressed quest-hub world (real placed glb props) on the
// native host, captures keyframes, and writes a portable export the browser replays + renders (so the
// agent can shoot it with tools/shoot.mjs and SEE it). First pass: get real models grounded and
// rendering; terrain / atmosphere / NPC / HUD layer on after the render path is proven.
//
// Run from repo root: ./target/release/limina games/beacon-quest/build/scene.ts
//   then relocate traces/beacon.* → games/beacon-quest/web/public/worlds/beacon/ (build.sh does this).

import { EntityTable, ops } from "../../../js/src/engine.ts";
import { createEcsWorld } from "../../../js/src/ecs/world.ts";
import { createTransformStorage } from "../../../js/src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../../../js/src/spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../../../js/src/skills/registry.ts";
import { registerCoreSkills } from "../../../js/src/skills/index.ts";
import { resolveProfile } from "../../../js/src/skills/permissions.ts";
import { LiminaTracer } from "../../../js/src/observability/event.ts";
import { WorldRecorder } from "../../../js/src/worldlog/recorder.ts";
import { KeyframeRecorder } from "../../../js/src/worldlog/keyframes.ts";
import { loadExport } from "../../../js/src/export/package.ts";
import { exportGame } from "../../../js/src/game/publish.ts";
import { beaconField } from "../../../js/src/game/examples/beacon_run_scene.ts";
import { BEACON_XZ, BLIGHT_XZ, BLIGHT_RADIUS } from "../../../js/src/game/examples/beacon_run_game.ts";

const SEED = 0xbea0;
const INTERVAL = 10;
const OUT = {
  "manifest.json": "beacon.manifest.json",
  "log.jsonl": "beacon.log.jsonl",
  "keyframes.jsonl": "beacon.keyframes.jsonl",
} as const;

function makeHeadlessWorld(worldOps: typeof ops): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless" };
}

const tracer = new LiminaTracer("ses_beacon_export");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry);
const recorder = new WorldRecorder("ses_beacon_export");
recorder.attach(registry);
recorder.seed(SEED);
const recOps = recorder.wrapOps(ops);
const world = makeHeadlessWorld(recOps);
const keyframeRec = new KeyframeRecorder(INTERVAL);
const base = { agentId: "limina:builder", sessionId: "ses_beacon_export", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

recOps.op_physics_create_world(-9.81);
recOps.op_physics_add_ground(0);

// A textured PBR ground patch over the dead baseline plane (~50 m moss; its top sits just above 0 so
// the grey plane is hidden under the hub). The atmosphere/fog fades its edge in the far distance.
await registry.invoke("scene.createEntity", { shape: "box", size: 50, material: "grass", pbr: true, position: [0, -24.97, 0], dynamic: false }, base);

// The dressed field comes from the SHARED scene definition — the SAME beaconField() the playable build
// (js/src/demos/beacon_run_window.ts) renders live, placed here around the SAME beacon/blight the sim
// uses. Recording this field is what makes the packaged web release show the scene you actually play.
const field = beaconField({ beaconXZ: BEACON_XZ, blightXZ: BLIGHT_XZ, blightRadius: BLIGHT_RADIUS });

let placed = 0;
for (const pl of field) {
  const res = await registry.invoke(
    "asset.place",
    { assetId: pl.assetId, position: [pl.position[0], pl.surfaceY ?? 0, pl.position[1]], normalizeHeight: pl.height, rotation: [0, pl.rotY ?? 0, 0] },
    base,
  );
  if (res.success) placed++;
  else ops.op_log(`asset.place FAILED ${pl.assetId}: ${JSON.stringify(res.error)}`);
}

// Static scene: capture the placed transforms as keyframes (a couple of ticks is enough).
keyframeRec.capture(world, 0);
for (let tick = 1; tick <= 2; tick++) { recorder.tick = tick; recOps.op_physics_step(); keyframeRec.capture(world, tick); }

const files = exportGame(recorder, {
  worldId: "beacon",
  keyframes: keyframeRec.keyframes,
  keyframeInterval: INTERVAL,
  createdAt: "2026-06-30T00:00:00.000Z",
  assets: core.assets.bundle(),
});

const check = loadExport(files);
// Write EVERY export file (manifest/log/keyframes AND assets.jsonl/tiles.jsonl) — the placed glbs
// live in assets.jsonl; without it the browser 404s and renders nothing.
const written: string[] = [];
for (const [name, content] of Object.entries(files)) {
  ops.op_write_trace("beacon." + name, content);
  written.push(name);
}

ops.op_log(`beacon scene OK: placed ${placed}/${field.length} props, ${recorder.commands.length} commands, ${check.keyframes.length} keyframes, ${Object.keys(core.assets.bundle()).length} assets bundled. Wrote: ${written.join(", ")}.`);
