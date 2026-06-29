// p8_sab_transforms — Phase 8 Mode B, M2: SharedArrayBuffer-backed ECS transforms.
//
// Proves the zero-copy bridge between the sim-worker (writer) and render-main
// thread (reader):
//   1. ROUNDTRIP   — write Position/Rotation/Scale per eid, read back exact.
//   2. ISOMORPHISM — behaves identically to the heap-backed createTransformStorage()
//                    for the same write sequence (compare globals vs SAB views).
//   3. JOIN        — a SECOND storage constructed from the FIRST's `.buffer` sees
//                    writes made through the first (proves shared, not copied).
//   4. LAYOUT      — the 10 SoA channels don't overlap and fit the buffer exactly.
//   5. VALIDATION  — a wrong-sized donor buffer is rejected.
//
// Run: ./target/release/limina js/test/p8_sab_transforms.ts   (exit 0 on pass)

import {
  SharedTransformStorage,
  sharedArrayBufferAvailable,
  TRANSFORM_BUFFER_BYTES,
  TRANSFORM_CHANNELS,
  CHANNEL_BYTES,
} from "../src/browser/sab-transforms.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { Position, Rotation, Scale, MAX_ENTITIES } from "../src/ecs/world.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

// Exact float compare AFTER both sides have been narrowed to Float32 precision.
// The SAB views ARE Float32Array, so any number we read back is already f32; we
// quantize expected values with Math.fround so equality is bit-exact.
function f32(n: number): number {
  return Math.fround(n);
}

// --- Fixtures: a handful of eids spanning the entity range. -----------------
const SAMPLES: Array<{
  eid: number;
  pos: [number, number, number];
  rot: [number, number, number, number];
  scl: [number, number, number];
}> = [
  { eid: 0, pos: [1.5, -2.25, 3.75], rot: [0, 0, 0, 1], scl: [1, 1, 1] },
  { eid: 1, pos: [-10.5, 0.125, 42.0], rot: [0.5, 0.5, 0.5, 0.5], scl: [2, 3, 4] },
  { eid: 7, pos: [100.0, 200.5, -300.25], rot: [-0.5, 0.5, -0.5, 0.5], scl: [0.5, 0.25, 0.125] },
  { eid: 4096, pos: [0.001, -0.001, 0.0], rot: [0, 0.7071, 0, 0.7071], scl: [10, 10, 10] },
  { eid: MAX_ENTITIES - 1, pos: [-1.0, -2.0, -3.0], rot: [0.1, 0.2, 0.3, 0.9273], scl: [1.5, 1.5, 1.5] },
];

// ===========================================================================
// 1. ROUNDTRIP — write through the interface, read back through the views.
// ===========================================================================
const sab = sharedArrayBufferAvailable();
const a = new SharedTransformStorage();

assert(a.shared === sab, "storage.shared must reflect SAB availability");
assert(
  a.buffer.byteLength === TRANSFORM_BUFFER_BYTES,
  "allocated buffer must be exactly the layout size",
);

for (const s of SAMPLES) {
  a.writePosition(s.eid, s.pos[0], s.pos[1], s.pos[2]);
  a.writeRotation(s.eid, s.rot[0], s.rot[1], s.rot[2], s.rot[3]);
  a.writeScale(s.eid, s.scl[0], s.scl[1], s.scl[2]);
}

const outV3 = new Float32Array(3);
const outV4 = new Float32Array(4);
for (const s of SAMPLES) {
  a.readPosition(s.eid, outV3);
  assert(
    outV3[0] === f32(s.pos[0]) && outV3[1] === f32(s.pos[1]) && outV3[2] === f32(s.pos[2]),
    `roundtrip position eid ${s.eid}`,
  );
  a.readRotation(s.eid, outV4);
  assert(
    outV4[0] === f32(s.rot[0]) && outV4[1] === f32(s.rot[1]) &&
      outV4[2] === f32(s.rot[2]) && outV4[3] === f32(s.rot[3]),
    `roundtrip rotation eid ${s.eid}`,
  );
  a.readScale(s.eid, outV3);
  assert(
    outV3[0] === f32(s.scl[0]) && outV3[1] === f32(s.scl[1]) && outV3[2] === f32(s.scl[2]),
    `roundtrip scale eid ${s.eid}`,
  );
  // Direct view access (the renderSyncSystem read path) must agree too.
  assert(a.Position.x[s.eid] === f32(s.pos[0]), `view Position.x eid ${s.eid}`);
  assert(a.Rotation.w[s.eid] === f32(s.rot[3]), `view Rotation.w eid ${s.eid}`);
  assert(a.Scale.z[s.eid] === f32(s.scl[2]), `view Scale.z eid ${s.eid}`);
}

// version is monotonic and advanced once per write (3 writes per sample).
assert(a.version === SAMPLES.length * 3, "version counts every write");

// ===========================================================================
// 2. ISOMORPHISM — identical behavior to the heap-backed createTransformStorage.
// Run the SAME write sequence through both; the SAB views must equal the
// world.ts globals the heap storage mutates, and the version must match.
// ===========================================================================
const heap = createTransformStorage(null);
const sabIso = new SharedTransformStorage();

for (const s of SAMPLES) {
  heap.writePosition(s.eid, s.pos[0], s.pos[1], s.pos[2]);
  heap.writeRotation(s.eid, s.rot[0], s.rot[1], s.rot[2], s.rot[3]);
  heap.writeScale(s.eid, s.scl[0], s.scl[1], s.scl[2]);

  sabIso.writePosition(s.eid, s.pos[0], s.pos[1], s.pos[2]);
  sabIso.writeRotation(s.eid, s.rot[0], s.rot[1], s.rot[2], s.rot[3]);
  sabIso.writeScale(s.eid, s.scl[0], s.scl[1], s.scl[2]);
}

assert(heap.version === sabIso.version, "isomorphism: versions diverge");
for (const s of SAMPLES) {
  assert(Position.x[s.eid] === sabIso.Position.x[s.eid], `iso Position.x eid ${s.eid}`);
  assert(Position.y[s.eid] === sabIso.Position.y[s.eid], `iso Position.y eid ${s.eid}`);
  assert(Position.z[s.eid] === sabIso.Position.z[s.eid], `iso Position.z eid ${s.eid}`);
  assert(Rotation.x[s.eid] === sabIso.Rotation.x[s.eid], `iso Rotation.x eid ${s.eid}`);
  assert(Rotation.y[s.eid] === sabIso.Rotation.y[s.eid], `iso Rotation.y eid ${s.eid}`);
  assert(Rotation.z[s.eid] === sabIso.Rotation.z[s.eid], `iso Rotation.z eid ${s.eid}`);
  assert(Rotation.w[s.eid] === sabIso.Rotation.w[s.eid], `iso Rotation.w eid ${s.eid}`);
  assert(Scale.x[s.eid] === sabIso.Scale.x[s.eid], `iso Scale.x eid ${s.eid}`);
  assert(Scale.y[s.eid] === sabIso.Scale.y[s.eid], `iso Scale.y eid ${s.eid}`);
  assert(Scale.z[s.eid] === sabIso.Scale.z[s.eid], `iso Scale.z eid ${s.eid}`);
}

// ===========================================================================
// 3. JOIN — second storage over the FIRST's buffer sees the first's writes.
// This simulates the render-main thread receiving the sim-worker's SAB and
// reading transforms WITHOUT a copy. (When SAB is unavailable in-binary this
// runs over a plain ArrayBuffer, proving the layout/join logic; the real
// cross-THREAD sharing guarantee is then browser-UAT.)
// ===========================================================================
const writer = new SharedTransformStorage();
const reader = new SharedTransformStorage({ buffer: writer.buffer });

assert(reader.buffer === writer.buffer, "join must alias the SAME buffer object");
assert(reader.shared === writer.shared, "join must inherit shared-ness");

// Writes through `writer` must be visible through `reader` (no copy).
writer.writePosition(123, 9.0, 8.0, 7.0);
writer.writeRotation(123, 0.0, 0.0, 0.0, 1.0);
writer.writeScale(123, 5.0, 6.0, 7.0);

reader.readPosition(123, outV3);
assert(outV3[0] === 9 && outV3[1] === 8 && outV3[2] === 7, "join: position not shared");
reader.readScale(123, outV3);
assert(outV3[0] === 5 && outV3[1] === 6 && outV3[2] === 7, "join: scale not shared");
assert(reader.Rotation.w[123] === 1, "join: rotation view not shared");

// And the reverse direction — writing through `reader` is seen by `writer`
// (a single shared block, symmetric).
reader.writePosition(123, -1.0, -2.0, -3.0);
assert(
  writer.Position.x[123] === -1 && writer.Position.y[123] === -2 && writer.Position.z[123] === -3,
  "join: reverse write not shared",
);

// ===========================================================================
// 4. LAYOUT — the 10 channels are non-overlapping, contiguous, and fit exactly.
// ===========================================================================
assert(
  TRANSFORM_BUFFER_BYTES === TRANSFORM_CHANNELS * CHANNEL_BYTES,
  "buffer size = channels x channel bytes",
);
assert(CHANNEL_BYTES === MAX_ENTITIES * 4, "channel bytes = MAX_ENTITIES x 4");

// Collect every channel view's [byteOffset, byteOffset+byteLength) extent and
// assert pairwise non-overlap + total coverage of the buffer.
const layout = new SharedTransformStorage();
const channels = [
  layout.Position.x, layout.Position.y, layout.Position.z,
  layout.Rotation.x, layout.Rotation.y, layout.Rotation.z, layout.Rotation.w,
  layout.Scale.x, layout.Scale.y, layout.Scale.z,
];
assert(channels.length === TRANSFORM_CHANNELS, "channel count");
const ranges = channels
  .map((v) => [v.byteOffset, v.byteOffset + v.byteLength] as [number, number])
  .sort((p, q) => p[0] - q[0]);
let cursor = 0;
for (const [start, end] of ranges) {
  assert(start === cursor, `channel must be contiguous (gap/overlap at ${start}, expected ${cursor})`);
  assert(end <= TRANSFORM_BUFFER_BYTES, "channel must fit within buffer");
  cursor = end;
}
assert(cursor === TRANSFORM_BUFFER_BYTES, "channels must fill the buffer exactly");

// ===========================================================================
// 5. VALIDATION — joining a wrong-sized buffer throws.
// ===========================================================================
let threw = false;
try {
  // 64 bytes is nowhere near the expected layout size.
  new SharedTransformStorage({ buffer: new ArrayBuffer(64) });
} catch (_e) {
  threw = true;
}
assert(threw, "wrong-sized donor buffer must be rejected");

const backing = sab ? "SharedArrayBuffer" : "ArrayBuffer (fallback; cross-thread SAB sharing is browser-UAT)";
console.log(
  `p8_sab_transforms OK: backing=${backing}; ` +
    `layout=${TRANSFORM_CHANNELS}ch x ${MAX_ENTITIES}ent x 4B = ${TRANSFORM_BUFFER_BYTES}B; ` +
    `roundtrip+isomorphism+join+layout+validation all pass.`,
);
