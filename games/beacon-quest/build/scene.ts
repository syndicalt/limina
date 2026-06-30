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

// A TIGHT, dense hamlet (NW): dwellings clustered around a well + camp; living pines ring it. A clear
// corridor runs north to the BEACON (a signal-fire pile); the BLIGHT (dead trees) lies east.
const props: Array<[string, number, number, number, number]> = [
  // [assetId, x, z, normalizeHeight, rotY]
  // ── Hamlet (clustered): cottages, a guard tower, the well, tents, the camp. ──
  ["cottage.glb", -6, -4, 4.0, 0.4],
  ["building-medieval-house-1.glb", -10, -1, 4.5, -0.3],
  ["building-medieval-house-3.glb", -9, 5, 4.5, 0.8],
  ["building-medieval-house-2.glb", -14, 2, 4.5, -0.6],
  ["building-guard-tower-1.glb", -13, -7, 7.0, 0.2],
  ["prop-water-well-1.glb", -4, 1, 2.2, 0],
  ["prop-camping-tent-1.glb", -8, 8, 2.2, 0.6],
  ["prop-camping-tent-1.glb", -11, 9, 2.2, -0.4],
  ["prop-campfire-1.glb", -5, 4, 0.8, 0],
  ["prop-barrel-1.glb", -3.5, 5, 0.9, 0.3],
  ["prop-barrel-1.glb", -2.8, 6, 0.9, 1.1],
  ["prop-a-wooden-barrel-2.glb", -6, 2, 0.9, 0.5],
  // ── Living pines + broadleaf ringing the hamlet (west, healthy). ──
  ["vegetation-pine-tree-1.glb", -17, -5, 7.0, 0.2],
  ["vegetation-pine-tree-1.glb", -18, 4, 6.5, 1.1],
  ["vegetation-pine-tree-1.glb", -16, 10, 7.2, 2.0],
  ["vegetation-pine-tree-1.glb", -7, -12, 6.4, 0.7],
  ["vegetation-pine-tree-1.glb", -14, -11, 6.8, 2.4],
  ["vegetation-pine-tree-1.glb", 3, -10, 6.2, 1.5],
  ["vegetation-pine-tree-1.glb", -19, 0, 6.9, 0.4],
  ["broadleaf.glb", -2, -9, 5.0, 0.9],
  ["broadleaf.glb", -12, 12, 5.5, 2.2],
  // ── The BEACON — a signal-fire pile ahead (north, −Z), at the corridor's end. ──
  ["prop-campfire-1.glb", 0, -15, 1.8, 0],
  ["prop-stone-pillar-1.glb", -2.5, -13, 1.6, 0.3],
  // ── The BLIGHT — dead trees east (+X), thinning outward. ──
  ["vegetation-dead-tree-1.glb", 10, -3, 6.5, 0.3],
  ["vegetation-dead-tree-1.glb", 13, 4, 6.0, 1.2],
  ["vegetation-dead-tree-1.glb", 16, -6, 7.0, 2.5],
  ["vegetation-dead-tree-1.glb", 20, 2, 6.2, 0.9],
  ["vegetation-dead-tree-1.glb", 12, -11, 6.6, 1.8],
  ["vegetation-dead-tree-1.glb", 18, 9, 6.4, 0.5],
  ["vegetation-dead-tree-1.glb", 24, -2, 6.8, 2.1],
  // ── Ground clutter: bushes + rocks for density. ──
  ["bush.glb", -3, -6, 1.0, 0], ["bush.glb", 5, 6, 1.1, 1], ["bush.glb", -15, 6, 0.9, 2],
  ["bush.glb", 7, -8, 1.0, 0.5], ["bush.glb", 2, 9, 1.2, 1.5],
  ["rock.glb", 4, 9, 1.0, 0], ["rock.glb", 8, -11, 1.3, 1.0], ["rock.glb", -8, 11, 0.9, 2.1],
  ["rock.glb", 14, -1, 1.2, 0.6], ["rock.glb", -16, -8, 1.1, 1.4],
];

let placed = 0;
for (const [assetId, x, z, height, rotY] of props) {
  const res = await registry.invoke("asset.place", { assetId, position: [x, 0, z], normalizeHeight: height, rotation: [0, rotY, 0] }, base);
  if (res.success) placed++;
  else ops.op_log(`asset.place FAILED ${assetId}: ${JSON.stringify(res.error)}`);
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

ops.op_log(`beacon scene OK: placed ${placed}/${props.length} props, ${recorder.commands.length} commands, ${check.keyframes.length} keyframes, ${Object.keys(core.assets.bundle()).length} assets bundled. Wrote: ${written.join(", ")}.`);
