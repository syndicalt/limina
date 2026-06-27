// Phase 8 SAMPLE EXPORT producer. Records a small colorful physics scene on the
// native host (ground + dynamic spheres + boxes, stirred by recorded impulses),
// captures periodic transform keyframes, assembles the portable export, WRITES
// the three files to web/public/worlds/demo/, and reloads them via loadExport to
// confirm the package round-trips.
//
// Run (native, from repo root):
//   ./target/release/limina js/scripts/export-demo.ts
// then relocate the three files from the host's sandboxed `traces/` dir into the
// served world dir (the run wrapper below / the package.json `export:demo` script
// does this):
//   mkdir -p web/public/worlds/demo
//   mv traces/demo.manifest.json   web/public/worlds/demo/manifest.json
//   mv traces/demo.log.jsonl       web/public/worlds/demo/log.jsonl
//   mv traces/demo.keyframes.jsonl web/public/worlds/demo/keyframes.jsonl
//
// The limina host's ONLY file-write capability is op_write_trace, which writes a
// bare filename under <cwd>/traces (no path separators). So the script writes
// there and the wrapper relocates — no foundation change. This is a native-host
// script (Deno globals present); it lives outside js/src so the host-portability
// guard does not scan it.

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld, Position } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { syncAllBodies } from "../src/worldlog/log.ts";
import { KeyframeRecorder } from "../src/worldlog/keyframes.ts";
import { assembleExport, loadExport } from "../src/export/package.ts";

const SEED = 0x115a;
const TICKS = 300;
const INTERVAL = 10;
// Bare trace filenames (op_write_trace forbids path separators); the run wrapper
// relocates these to web/public/worlds/demo/{manifest.json,log.jsonl,keyframes.jsonl}.
const OUT = {
  "manifest.json": "demo.manifest.json",
  "log.jsonl": "demo.log.jsonl",
  "keyframes.jsonl": "demo.keyframes.jsonl",
} as const;

function makeHeadlessWorld(worldOps: typeof ops): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless" };
}

// Warm THREE's lazy init on the DEFAULT rng before the seeded rng is installed
// (mirrors the parity test) so the seeded stream is reproducible.
void new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));
void new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));

const tracer = new LiminaTracer("ses_demo_export");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry);
const recorder = new WorldRecorder("ses_demo_export");
recorder.attach(registry);
recorder.seed(SEED);
const recOps = recorder.wrapOps(ops);
const world = makeHeadlessWorld(recOps);
const keyframeRec = new KeyframeRecorder(INTERVAL);

const base = { agentId: "limina:builder", sessionId: "ses_demo_export", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

recOps.op_physics_create_world(-9.81);
recOps.op_physics_add_ground(0);

// A colorful ring of dynamic bodies, alternating spheres and boxes.
const palette = [0xff8c1a, 0x4ade80, 0x60a5fa, 0xf472b6, 0xfacc15, 0xa78bfa, 0x34d399, 0xfb7185];
const bodies: { id: string; eid: number }[] = [];
const RING = 8;
for (let i = 0; i < RING; i++) {
  const a = (i / RING) * Math.PI * 2;
  const r = 4;
  const sphere = i % 2 === 0;
  const res = await registry.invoke("scene.createEntity", {
    shape: sphere ? "sphere" : "box",
    collider: sphere ? "sphere" : "box",
    size: 1.0,
    color: palette[i % palette.length],
    position: [Math.cos(a) * r, 3 + (i % 3), Math.sin(a) * r],
    dynamic: true, friction: 0.4, restitution: 0.5,
  }, base);
  if (!res.success) throw new Error(`createEntity failed: ${JSON.stringify(res.error)}`);
  const id = (res.result as { entity: string }).entity;
  const entry = world.entities.resolve(id);
  if (entry === undefined) throw new Error("created entity not resolvable");
  bodies.push({ id, eid: entry.eid });
}

keyframeRec.maybeCapture(world, 0);
const GAIN = 0.06, SWIRL = 0.05;
for (let tick = 1; tick <= TICKS; tick++) {
  recorder.tick = tick;
  for (const b of bodies) {
    const px = Position.x[b.eid], pz = Position.z[b.eid];
    await registry.invoke("physics.applyImpulse", { entity: b.id, impulse: [-GAIN * px - SWIRL * pz, 0, -GAIN * pz + SWIRL * px] }, base);
  }
  recOps.op_physics_step();
  syncAllBodies(world);
  keyframeRec.maybeCapture(world, tick);
}
keyframeRec.capture(world, TICKS); // exact end state

const files = assembleExport({
  worldId: "demo",
  meta: recorder.meta(),
  commands: recorder.commands,
  keyframes: keyframeRec.keyframes,
  keyframeInterval: INTERVAL,
  createdAt: new Date().toISOString(),
  // Phase 11: carry the content-addressed bytes of every asset placed this session
  // (empty here — this demo places none) so the package is self-contained.
  assets: core.assets.bundle(),
});

// Confirm it round-trips before writing it to disk.
const check = loadExport(files);
if (check.manifest.ticks !== TICKS) throw new Error(`manifest ticks ${check.manifest.ticks} != ${TICKS}`);
if (check.keyframes[check.keyframes.length - 1].tick !== TICKS) throw new Error("final keyframe not at last tick");

// Write via the host's sandboxed trace-write op, then read back from disk and
// re-validate through loadExport (a true disk round-trip, exactly what a browser
// fetch+loadExport does).
ops.op_write_trace(OUT["manifest.json"], files["manifest.json"]);
ops.op_write_trace(OUT["log.jsonl"], files["log.jsonl"]);
ops.op_write_trace(OUT["keyframes.jsonl"], files["keyframes.jsonl"]);

const onDisk = loadExport({
  "manifest.json": ops.op_read_trace(OUT["manifest.json"]),
  "log.jsonl": ops.op_read_trace(OUT["log.jsonl"]),
  "keyframes.jsonl": ops.op_read_trace(OUT["keyframes.jsonl"]),
});
if (onDisk.manifest.ticks !== TICKS) throw new Error("disk round-trip lost ticks");
if (onDisk.commands.length !== recorder.commands.length) throw new Error("disk round-trip lost commands");

ops.op_log(
  `export-demo OK: wrote traces/{${OUT["manifest.json"]},${OUT["log.jsonl"]},${OUT["keyframes.jsonl"]}} — ` +
  `${recorder.commands.length} commands, ${TICKS} ticks, ${check.keyframes.length} keyframes, ${bodies.length} bodies; ` +
  `disk round-trip via loadExport OK. Relocate to web/public/worlds/demo/.`,
);
