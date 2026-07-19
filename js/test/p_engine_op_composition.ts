// Behavioral authority for the live render-side engine-op composition seam.
// The static live-composition supplement proves browser/live-runtime.ts selects this
// shared table; this test proves the selected table preserves the real provider receiver
// and forwards transform output instead of substituting an inert/fabricated operation.

import type { EngineOps } from "../src/engine.ts";
import { composeAuthoringOps } from "../src/browser/live-runtime.ts";
import type { PhysicsEngineOps } from "../src/browser/engine-op-composition.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_engine_op_composition FAIL: ${message}`);
}

const receiverMarker = { id: "real-physics-provider" };
let provider!: PhysicsEngineOps;
let impulseReceiverWasReal = false;
const target = { receiverMarker };
provider = new Proxy(target, {
  get(object, property, receiver) {
    if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
    if (property === "op_physics_take_collision_overflow_count") return undefined;
    if (property === "op_physics_body_transform") {
      return function (this: typeof target, bodyId: number, out: Float32Array): void {
        assert(this === provider, "body-transform lost the real provider receiver");
        assert(this.receiverMarker === receiverMarker, "body-transform receiver state was fabricated");
        const expected = [bodyId + 0.25, 2, 3, 0, 0.5, 0, 1];
        for (let index = 0; index < expected.length; index++) out[index] = expected[index];
      };
    }
    if (property === "op_physics_apply_impulse") {
      return function (this: typeof target): void {
        impulseReceiverWasReal = this === provider && this.receiverMarker === receiverMarker;
      };
    }
    // bindPhysicsEngineOps deliberately touches the complete physics authority at
    // composition time. A callable sentinel keeps this fixture exhaustive without
    // duplicating production's signature table, while the two load-bearing methods
    // above retain observable behavior and receiver state.
    return function (): number { return 0; };
  },
}) as unknown as PhysicsEngineOps;

const assetBytes = new Uint8Array([7, 11, 13]);
const ops: EngineOps = composeAuthoringOps(provider as never, () => assetBytes);
const transform = new Float32Array(7);
ops.op_physics_body_transform(41, transform);
assert(JSON.stringify([...transform]) === JSON.stringify([41.25, 2, 3, 0, 0.5, 0, 1]),
  `real transform output was not forwarded: ${JSON.stringify([...transform])}`);
ops.op_physics_apply_impulse(41, 1, 2, 3);
assert(impulseReceiverWasReal, "another live mutating physics op lost the provider receiver");
assert(ops.op_read_asset("fixture") === assetBytes, "live composition did not retain its explicit non-physics override");

console.log("p_engine_op_composition OK: live authoring forwards real bound physics transforms and provider state");
