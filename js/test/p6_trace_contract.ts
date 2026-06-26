// P6 -- Seam 3 TRACE CONTRACT (durable-log I/O behind a typed sink + the
// commands-NOT-bytes invariant), headless.
//
// Records a tiny real session (seed + raw physics ops + skill invocations +
// steps), STREAMS it to disk through the DurableWorldLog sink (which now depends
// only on the narrowed `TraceOps` surface), reads the persisted artifact back,
// and asserts the Seam 3 invariant DIRECTLY:
//   (a) the persisted trace is line-delimited JSON -- exactly one `meta` line and
//       one command object per remaining line (and the canonical one-shot
//       serialization leads with the `meta` header);
//   (b) it carries the recorded INPUTS -- the seed command (seq 0) plus the
//       recorded skill and physics commands;
//   (c) it is TEXT / JSONL -- a UTF-8 string with no binary/control bytes and no
//       opaque "bytes" blob on any line (commands, not bytes);
//   (d) parseWorldLog replays it into a FRESH engine bit-identically.
// The assertions parse real fields; any violation throws (non-zero exit).

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld, Position } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { LiminaTracer, type Tracer } from "../src/observability/event.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayWorldLog } from "../src/worldlog/replay.ts";
import { captureWorldState, compareWorldState, parseWorldLog, syncAllBodies } from "../src/worldlog/log.ts";
import { DurableWorldLog } from "../src/worldlog/durable.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p6_trace_contract: " + message);
}

const SEED = 0x5ea3c047;
const TICKS = 40;
const SESSION = "ses_p6_contract";
const LOG_NAME = "p6_trace_contract.jsonl";

function makeHeadlessWorld(worldOps: typeof ops): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless",
  };
}

function makeRegistry(tracer: Tracer): SkillRegistry {
  const registry = new SkillRegistry(tracer);
  registerCoreSkills(registry);
  return registry;
}

// ---- RECORD a tiny session and STREAM it through the durable sink ----------
// Warm THREE on the default RNG before the seeded one is installed, so record and
// replay share an identical seeded draw stream (same convention as the p4 tests).
void new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));
void new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));

const recTracer = new LiminaTracer(SESSION);
const registry = makeRegistry(recTracer);

const recorder = new WorldRecorder(SESSION);
recorder.attach(registry); // hook the invoke choke point
recorder.seed(SEED); // record + install the deterministic PRNG (seq 0)
const recOps = recorder.wrapOps(ops); // record raw physics ops issued outside skills
const world = makeHeadlessWorld(recOps);

const durable = new DurableWorldLog(recorder, LOG_NAME);
durable.open();
assert(ops.op_read_trace(LOG_NAME).length === 0, "open() did not truncate the segment");

const builderBase = {
  agentId: "limina:builder", sessionId: SESSION,
  permissions: resolveProfile("builder.readWrite"), tick: 0, world,
};

// Raw physics bootstrap -> recorded as `physics` commands (non-skill path).
recOps.op_physics_create_world(-9.81);
recOps.op_physics_add_ground(0);

// A skill invocation -> recorded as a `skill` command (the choke point).
const created = await registry.invoke("scene.createEntity", {
  shape: "sphere", collider: "sphere", size: 1.0, color: 0x3366cc,
  position: [0, 4, 0], dynamic: true, friction: 0.3, restitution: 0.5,
}, builderBase);
assert(created.success === true, "scene.createEntity failed");
const createdResult = created.result;
assert(createdResult !== null && typeof createdResult === "object" && "entity" in createdResult, "createEntity result missing entity");
const ballId = createdResult.entity;
assert(typeof ballId === "string", "entity id not a string");
const ballEid = world.entities.resolve(ballId)!.eid;

// Per-tick: a recorded skill impulse + a recorded raw step, streamed each tick.
for (let tick = 1; tick <= TICKS; tick++) {
  recorder.tick = tick;
  const px = Position.x[ballEid];
  const pz = Position.z[ballEid];
  await registry.invoke("physics.applyImpulse", {
    entity: ballId, impulse: [-0.05 * px, 0, -0.05 * pz],
  }, builderBase);
  recOps.op_physics_step();
  syncAllBodies(world);
  durable.flush(); // segment append (commands-as-they-occur)
}

const recordedState = captureWorldState(world);
const closed = durable.close(); // final flush + meta trailer
const commandCount = recorder.commands.length;
assert(closed.commands === commandCount, "durable close command count mismatch");
assert(durable.pending === 0, "commands remained unflushed after close()");

// ---- The persisted artifact: read it back from disk ------------------------
const diskLog = ops.op_read_trace(LOG_NAME);

// (c) TEXT / JSONL -- a string of UTF-8 text, no binary/control bytes. A bytes
//     blob would not be a `string`, and would carry NUL/control bytes.
assert(typeof diskLog === "string", "persisted trace must be a STRING (text), not a binary buffer");
assert(diskLog.length > 0, "persisted trace is empty");
for (let i = 0; i < diskLog.length; i++) {
  const c = diskLog.charCodeAt(i);
  // Allow newline (0x0a), tab (0x09), and any printable char; reject other control bytes.
  assert(c === 0x0a || c === 0x09 || c >= 0x20, `non-text byte 0x${c.toString(16)} at offset ${i} -- trace is not text/JSONL`);
}

// (a) Every non-empty line is one JSON OBJECT; exactly one `meta` line, every
//     other line a command with a numeric `seq` and a known discriminator. And
//     no line carries an opaque bytes/blob field (commands, not bytes -- (c)).
const lines = diskLog.split("\n").filter((l) => l.length > 0);
assert(lines.length >= 2, `expected >= 2 JSONL lines (meta + commands), got ${lines.length}`);
let metaLines = 0;
const BYTES_FIELDS = ["bytes", "buffer", "blob", "snapshot", "state", "binary", "raw"];
for (let i = 0; i < lines.length; i++) {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(lines[i]) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`p6_trace_contract: line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  assert(obj !== null && typeof obj === "object" && !Array.isArray(obj), `line ${i + 1} is not a JSON object`);
  assert(typeof obj.kind === "string", `line ${i + 1} has no string \`kind\` discriminator`);
  for (const f of BYTES_FIELDS) {
    assert(!(f in obj), `line ${i + 1} carries a raw-bytes field "${f}" -- violates the commands-not-bytes invariant`);
  }
  if (obj.kind === "meta") {
    metaLines++;
  } else {
    assert(["seed", "physics", "skill"].includes(obj.kind), `line ${i + 1} has unknown command kind "${String(obj.kind)}"`);
    assert(typeof obj.seq === "number", `command line ${i + 1} missing numeric \`seq\``);
  }
}
assert(metaLines === 1, `expected exactly one meta line, found ${metaLines}`);

// The canonical one-shot serialization LEADS with the meta header line (the
// documented "Line 1 is a meta header" format). parseWorldLog tolerates the
// durable trailer position, but the header convention is asserted here.
const oneShotFirst = recorder.toJsonl().split("\n")[0];
assert((JSON.parse(oneShotFirst) as { kind?: string }).kind === "meta", "canonical serialization must lead with a meta header line");

// (b) The trace carries the recorded INPUTS: seed (seq 0) + skill + physics.
const parsed = parseWorldLog(diskLog);
assert(parsed.meta !== undefined, "closed durable trace has no meta header");
assert(parsed.meta.logVersion >= 1, "meta logVersion missing");
assert(parsed.meta.commands === commandCount, `meta commands ${parsed.meta.commands} != ${commandCount}`);

const seeds = parsed.commands.filter((c) => c.kind === "seed");
assert(seeds.length === 1, `expected exactly one seed command, got ${seeds.length}`);
assert(seeds[0].seq === 0, "seed command is not first (seq 0)");
assert(seeds[0].kind === "seed" && seeds[0].seed === (SEED >>> 0), "seed command does not carry the recorded seed");

const physics = parsed.commands.filter((c) => c.kind === "physics");
assert(physics.some((c) => c.kind === "physics" && c.op === "create_world"), "missing recorded physics create_world command");
assert(physics.some((c) => c.kind === "physics" && c.op === "step"), "missing recorded physics step command");

const skills = parsed.commands.filter((c) => c.kind === "skill");
assert(skills.some((c) => c.kind === "skill" && c.tool === "scene.createEntity"), "missing recorded scene.createEntity skill command");
assert(skills.some((c) => c.kind === "skill" && c.tool === "physics.applyImpulse"), "missing recorded physics.applyImpulse skill command");

// (d) parseWorldLog replays it into a FRESH engine, bit-identical to the run.
const replayResult = await replayWorldLog(diskLog, {
  makeWorld: () => makeHeadlessWorld(ops),
  makeRegistry,
  tracer: new LiminaTracer(SESSION + "_replay"),
});
const cmp = compareWorldState(recordedState, replayResult.state);
assert(cmp.identical, `replay from the persisted trace diverged (${cmp.comparisons} fields): ${cmp.detail ?? "?"}`);
assert(replayResult.commands === commandCount, `replay command count ${replayResult.commands} != ${commandCount}`);

ops.op_log(
  `p6_trace_contract OK: durable trace is text/JSONL (${lines.length} lines, ${commandCount} commands: ` +
    `${seeds.length} seed, ${physics.length} physics, ${skills.length} skill) -- one meta header, no raw-bytes field; ` +
    `carries seed(seq0)+skill+physics inputs; parseWorldLog replay BIT-IDENTICAL ` +
    `(${cmp.comparisons} fields, ${replayResult.state.entities.length} live entities)`,
);
