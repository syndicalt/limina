// BEACON QUEST — W5 world export. Packages the MAP-PAINTER "Eastern Watch" as a Mode-A export the
// browser plays back + renders (so tools/shoot.mjs can capture it and the site /examples can ship
// it). Unlike the old scene.ts (a flat-ground dressed field of props), this records the PAINTED
// world itself by REPLAYING the exact peek scene (tools/design/peek-scene.mjs — the GPU-verified
// command set: terrain.create {source:"map"} → confined forest/swamp scatter → sea + river ribbons →
// the stamped buildings via asset.place) through the recorder, then keyframes the placed transforms.
// terrain.create's map tiles re-derive from the IR on playback, so the shipped package is
// {IR asset + glbs + command log + keyframes}.
//
// Run from repo root:
//   LIMINA_ASSET_ROOT=games/beacon-quest/assets \
//     ./target/release/limina games/beacon-quest/build/world-export.ts
//   then games/beacon-quest/build.sh games/beacon-quest/build/world-export.ts relocates + bundles.

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
import { WorldMapSchema, type WorldMap } from "../../../js/src/world/worldmap.ts";
// @ts-expect-error — peek-scene.mjs is plain JS (host authoring tool), no .d.ts.
import { buildPeekScene } from "../../../tools/design/peek-scene.mjs";

const MAP_ASSET = "maps/beacon-quest-primary.worldmap.json";
const INTERVAL = 10;

function makeHeadlessWorld(worldOps: typeof ops): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless" };
}

const tracer = new LiminaTracer("ses_beacon_world");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry);
const recorder = new WorldRecorder("ses_beacon_world");
recorder.attach(registry);
const recOps = recorder.wrapOps(ops);
const world = makeHeadlessWorld(recOps);
const keyframeRec = new KeyframeRecorder(INTERVAL);
const base = { agentId: "limina:builder", sessionId: "ses_beacon_world", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

recOps.op_physics_create_world(-9.81);

// The committed WorldMap, and the GPU-verified peek scene built from it — the SAME command set
// the Atlas peek renders, so the export ships exactly the look already read with eyes.
const worldMap: WorldMap = WorldMapSchema.parse(JSON.parse(new TextDecoder().decode(ops.op_read_asset(MAP_ASSET))));
const { scene: peek } = buildPeekScene(worldMap, { project: "beacon-quest", mapFile: "beacon-quest-primary.worldmap.json" }) as { scene: { commands: { kind: string; op?: string; tool?: string; args?: unknown[]; input?: Record<string, unknown> }[] } };

let placed = 0, skills = 0;
for (const cmd of peek.commands) {
  if (cmd.kind === "physics") {
    if (cmd.op === "op_physics_create_world") continue; // already created above
    (recOps as unknown as Record<string, (...a: unknown[]) => unknown>)[cmd.op!](...(cmd.args ?? []));
    continue;
  }
  const res = await registry.invoke(cmd.tool!, cmd.input!, base);
  if (!res.success) { ops.op_log(`world-export: ${cmd.tool} FAILED: ${JSON.stringify(res.error)}`); throw new Error(cmd.tool); }
  skills++;
  if (cmd.tool === "asset.place") placed++;
}

// Keyframe the placed transforms (a few ticks; terrain re-derives on playback so needs no keyframe).
keyframeRec.capture(world, 0);
for (let tick = 1; tick <= 2; tick++) { recorder.tick = tick; recOps.op_physics_step(); keyframeRec.capture(world, tick); }

const files = exportGame(recorder, {
  worldId: "beacon",
  keyframes: keyframeRec.keyframes,
  keyframeInterval: INTERVAL,
  createdAt: "2026-07-07T00:00:00.000Z",
  assets: core.assets.bundle(),
});

const check = loadExport(files); // round-trip: the package parses back clean or this throws.
const written: string[] = [];
for (const [name, content] of Object.entries(files)) { ops.op_write_trace("beacon." + name, content); written.push(name); }

ops.op_log(`beacon world-export OK: replayed the peek scene (${skills} skills incl. ${placed} stamped buildings) → ${recorder.commands.length} commands, ${check.keyframes.length} keyframes, ${Object.keys(core.assets.bundle()).length} assets bundled. Wrote: ${written.join(", ")}.`);
