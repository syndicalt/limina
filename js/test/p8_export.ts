// Phase 8 — export FORMAT + keyframe-driven PHYSICS LOGIC (headless, fast unit
// checks; the full record→playback parity gate is p8_playback_parity.ts).
//   1. assembleExport → serialize → loadExport round-trips (manifest + log + kf).
//   2. keyframe JSONL round-trips; a torn line is rejected loudly.
//   3. KeyframePhysics serves step-to-keyframe transforms (the binary search).
//   4. KeyframePhysics allocates body ids EXACTLY as native (add_ground = no id;
//      add_* monotonic from 0; removed ids tombstone, never reused).

import { ops } from "../src/engine.ts";
import { assembleExport, EXPORT_VERSION, loadExport } from "../src/export/package.ts";
import { parseKeyframes, serializeKeyframes, type Keyframe } from "../src/worldlog/keyframes.ts";
import { KeyframePhysics } from "../src/browser/keyframe-physics.ts";
import type { WorldCommand, WorldLogMeta } from "../src/worldlog/log.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p8_export FAIL: " + msg);
}

// 1. Export package round-trip ------------------------------------------------
const meta: WorldLogMeta = { kind: "meta", logVersion: 1, sessionId: "ses_p8", createdAt: "2026-01-01T00:00:00Z", commands: 0, ticks: 20 };
const commands: WorldCommand[] = [
  { kind: "seed", seq: 0, seed: 42 },
  { kind: "physics", seq: 1, tick: 0, op: "create_world", args: [-9.81] },
  { kind: "physics", seq: 2, tick: 0, op: "add_box", args: [0, 5, 0, 0.5, 0.5, 0.5, 0.4, 0.4] },
  { kind: "physics", seq: 3, tick: 1, op: "step", args: [] },
];
const keyframes: Keyframe[] = [
  { tick: 0, bodies: [{ id: 0, t: [0, 5, 0, 0, 0, 0, 1] }] },
  { tick: 10, bodies: [{ id: 0, t: [0, 3.5, 0, 0, 0, 0, 1] }] },
  { tick: 20, bodies: [{ id: 0, t: [0, 1.25, 0, 0, 0, 0, 1] }] },
];
const files = assembleExport({ worldId: "demo", meta, commands, keyframes, keyframeInterval: 10, createdAt: "2026-01-01T00:00:00Z" });
const loaded = loadExport(files);
assert(loaded.manifest.kind === "limina.export" && loaded.manifest.exportVersion === EXPORT_VERSION, "manifest kind/version wrong");
assert(loaded.manifest.worldId === "demo" && loaded.manifest.keyframeInterval === 10 && loaded.manifest.ticks === 20, "manifest fields lost");
assert(loaded.manifest.commands === commands.length && loaded.manifest.keyframes === keyframes.length, "manifest counts wrong");
assert(loaded.commands.length === commands.length && loaded.commands[2].kind === "physics", "commands not round-tripped");
assert(loaded.keyframes.length === 3 && loaded.keyframes[1].tick === 10 && loaded.keyframes[2].bodies[0].t[1] === 1.25, "keyframes not round-tripped");

// loadExport rejects a non-limina / wrong-version manifest loudly.
let rejected = false;
try { loadExport({ "manifest.json": JSON.stringify({ kind: "nope" }), "log.jsonl": "", "keyframes.jsonl": "" }); } catch { rejected = true; }
assert(rejected, "loadExport accepted a non-limina manifest");

// 2. Keyframe JSONL round-trip + torn-line rejection --------------------------
assert(parseKeyframes(serializeKeyframes(keyframes)).length === 3, "keyframe JSONL round-trip lost lines");
let tornRejected = false;
try { parseKeyframes('{"tick":0,"bodies":[]}\n{"tick":1,"bod'); } catch { tornRejected = true; }
assert(tornRejected, "parseKeyframes silently dropped a torn line");
// malformed body shape (b not length 7) is rejected (no NaN-poisoning downstream).
let badBodyRejected = false;
try { parseKeyframes('{"tick":0,"bodies":[{"id":0,"b":[1,2,3]}]}'); } catch { badBodyRejected = true; }
assert(badBodyRejected, "parseKeyframes accepted a malformed body (b.length != 7)");

// 2b. BIT-EXACT transforms: -0 / NaN / +-Inf survive the JSONL round-trip
// (decimal JSON would lose them; compareWorldState uses Object.is, so it matters).
const edge: Keyframe[] = [{ tick: 0, bodies: [{ id: 0, t: [-0, NaN, Infinity, -Infinity, 1.5, 0, 1] }] }];
const rt = parseKeyframes(serializeKeyframes(edge))[0].bodies[0].t;
assert(Object.is(rt[0], -0), "-0 not preserved through keyframe serialization");
assert(Object.is(rt[1], NaN), "NaN not preserved through keyframe serialization");
assert(rt[2] === Infinity && rt[3] === -Infinity, "+-Infinity not preserved");
assert(rt[4] === 1.5 && Object.is(rt[5], 0) && rt[6] === 1, "finite components not preserved");

// 2c. loadExport cross-checks manifest counts -> a cleanly-truncated file fails.
let truncRejected = false;
try {
  const f2 = assembleExport({ worldId: "demo", meta, commands, keyframes, keyframeInterval: 10, createdAt: "2026-01-01T00:00:00Z" });
  const kfLines = f2["keyframes.jsonl"].split("\n").filter((l) => l.length > 0);
  f2["keyframes.jsonl"] = kfLines.slice(0, -1).join("\n") + "\n"; // drop the final (whole) line
  loadExport(f2);
} catch { truncRejected = true; }
assert(truncRejected, "loadExport accepted a keyframe count mismatch (silent truncation)");

// 3. KeyframePhysics step-to-keyframe lookup ----------------------------------
// body 0 keyframed at ticks 0,10,20; transform x = the tick/10. Between keyframes
// the transform HOLDS the last keyframe (step-to-keyframe), exact AT keyframes.
const kf: Keyframe[] = [
  { tick: 0, bodies: [{ id: 0, t: [0, 0, 0, 0, 0, 0, 1] }] },
  { tick: 10, bodies: [{ id: 0, t: [1, 0, 0, 0, 0, 0, 1] }] },
  { tick: 20, bodies: [{ id: 0, t: [2, 0, 0, 0, 0, 0, 1] }] },
];
const phys = new KeyframePhysics(kf);
const out = new Float32Array(7);
const xAt = (steps: number): number => {
  const p = new KeyframePhysics(kf);
  p.op_physics_create_world(-9.81);
  for (let i = 0; i < steps; i++) p.op_physics_step();
  const o = new Float32Array(7); p.op_physics_body_transform(0, o); return o[0];
};
assert(xAt(0) === 0, `tick 0 should read keyframe 0 (got ${xAt(0)})`);
assert(xAt(5) === 0, `tick 5 should HOLD keyframe 0 (got ${xAt(5)})`);
assert(xAt(10) === 1, `tick 10 should read keyframe 10 (got ${xAt(10)})`);
assert(xAt(15) === 1, `tick 15 should HOLD keyframe 10 (got ${xAt(15)})`);
assert(xAt(20) === 2, `tick 20 should read keyframe 20 (got ${xAt(20)})`);
assert(xAt(99) === 2, `past the last keyframe should HOLD it (got ${xAt(99)})`);
// body_pos returns only the position triple.
phys.op_physics_create_world(-9.81); for (let i = 0; i < 10; i++) phys.op_physics_step();
phys.op_physics_body_pos(0, out); assert(out[0] === 1 && out[1] === 0 && out[2] === 0, "body_pos wrong");

// 4. Body-id allocation MATCHES native (insert_body monotonic; ground = no id) -
const idp = new KeyframePhysics([]);
idp.op_physics_create_world(-9.81);
idp.op_physics_add_ground(0); // collider only — must NOT consume an id
assert(idp.op_physics_add_box() === 0, "first dynamic body should be id 0 (ground must not consume an id)");
assert(idp.op_physics_add_sphere() === 1, "second body should be id 1");
assert(idp.op_physics_add_static_box() === 2, "third body should be id 2");
idp.op_physics_remove_body(1); // tombstone
assert(idp.op_physics_add_capsule() === 3, "after remove, next id must be 3 (ids never reused)");
idp.op_physics_create_world(-9.81); // reset
assert(idp.op_physics_add_box() === 0, "create_world should reset the id counter");

ops.op_log(`p8_export OK: export round-trips (manifest+log+${loaded.keyframes.length}kf); keyframe JSONL round-trips + rejects torn lines; KeyframePhysics serves step-to-keyframe transforms; body ids match native (ground=no id, monotonic from 0, tombstoned on remove).`);
