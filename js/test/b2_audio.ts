// B2 — spatial/positional audio + listener sync. Run under LIMINA_AUDIO=null for
// a deterministic, device-free gate: the limina-owned spatial MATH (ear-derivation
// + max-distance cutoff) is asserted as pure functions, and every spatial op is
// exercised with no device. Live (device) additionally pans the sound.
import { ops } from "../src/engine.ts";
import { deriveEars, distance, maxDistanceGain } from "../src/audio/spatial.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("B2 FAIL: " + msg);
}
function near(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) <= eps;
}

// --- limina-owned spatial math (pure; device-free) ---
const ears = deriveEars([0, 1, 0], [1, 0, 0], 0.1);
assert(near(ears.left[0], -0.1) && near(ears.left[1], 1) && near(ears.left[2], 0), "left ear");
assert(near(ears.right[0], 0.1) && near(ears.right[1], 1) && near(ears.right[2], 0), "right ear");
const ears2 = deriveEars([0, 0, 0], [5, 0, 0], 0.2); // camRight normalized -> true distance
assert(near(ears2.right[0], 0.2) && near(ears2.left[0], -0.2), "ears normalize camRight");

assert(near(distance([0, 0, 0], [3, 4, 0]), 5), "distance");

assert(near(maxDistanceGain(1, 10, 0.8), 0.8), "cutoff: full within range");
assert(near(maxDistanceGain(10, 10, 0.8), 0), "cutoff: zero at maxDist");
const edge = maxDistanceGain(9, 10, 0.8);
assert(edge > 0 && edge < 0.8, "cutoff: ramps near the edge");
assert(near(maxDistanceGain(50, 0, 0.8), 0.8), "cutoff disabled when maxDist<=0");

// --- spatial op plumbing (forced-null exercises handles/commands, no device) ---
const mode = ops.op_audio_init();
const s = ops.op_audio_play_spatial(440, 0.3, 5, 0, 0, 1, 0.9); // emitter to the right
assert(typeof s === "number", "spatial play returns a handle");
ops.op_audio_set_listener(
  ears.left[0], ears.left[1], ears.left[2],
  ears.right[0], ears.right[1], ears.right[2],
);
ops.op_audio_set_emitter(s, 0, 0, 5); // move the emitter in front
ops.op_audio_set_volume(s, maxDistanceGain(distance([0, 1, 0], [0, 0, 5]), 12, 0.9));
await ops.op_sleep_ms(200);
ops.op_audio_stop(s);

ops.op_log(`B2 OK: mode=${mode} spatial handle=${s} ears+cutoff verified; play_spatial/set_emitter/set_listener/set_volume callable`);
