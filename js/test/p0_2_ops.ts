// P0.2 - op-bridge conventions: fast numeric op, zero-copy buffer round-trip,
// structured error op, and an OpState-resource op.

interface LiminaOps {
  op_log(msg: string): void;
  op_sum(a: number, b: number): number;
  op_buffer_scale(data: Float32Array, factor: number): void;
  op_fail(msg: string): void;
  op_counter_inc(): number;
}

declare const Deno: { core: { ops: LiminaOps } };
const ops = Deno.core.ops;

// Fast numeric op.
const sum = ops.op_sum(40, 2);
if (sum !== 42) throw new Error(`op_sum expected 42, got ${sum}`);

// Zero-copy buffer round-trip: Rust mutates the Float32Array in place.
const buf = new Float32Array([1, 2, 3, 4]);
ops.op_buffer_scale(buf, 2.5);
const expected = [2.5, 5, 7.5, 10];
for (let i = 0; i < buf.length; i++) {
  if (Math.abs(buf[i] - expected[i]) > 1e-6) {
    throw new Error(`buffer[${i}] expected ${expected[i]}, got ${buf[i]}`);
  }
}

// Error op surfaces as a catchable JS exception.
let threw = false;
try {
  ops.op_fail("boom");
} catch (e) {
  threw = true;
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes("boom")) throw new Error(`unexpected error message: ${msg}`);
}
if (!threw) throw new Error("op_fail did not throw");

// OpState resource: a host-owned counter persists across calls.
const c1 = ops.op_counter_inc();
const c2 = ops.op_counter_inc();
if (c1 !== 1 || c2 !== 2) throw new Error(`counter expected 1,2 got ${c1},${c2}`);

ops.op_log("P0.2 OK: fast op, zero-copy buffer, error op, OpState resource");
