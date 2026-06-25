// P4.0b in-isolate baseline -- run on the REAL engine binary (privileged main V8
// isolate, JIT-class) to measure the cost of a capability call that is NOT
// sandboxed: a direct deno_core op call. This is the no-sandbox floor the
// sandboxed candidates' per-call round-trip is compared against.
//
//   ./target/debug/limina spikes/isolation/baseline.ts
//
// NOTE: the engine binary is a DEBUG build, so this is an UPPER bound on the
// in-isolate op-dispatch cost (a release engine's fast-API op would be lower).
// op_sum is a numeric fast-API op: the cleanest measure of the V8<->Rust op
// crossing floor without string-marshaling or compute noise. (op_sha256 was
// tried but its cost is dominated by unoptimized SHA-256 in the debug build, not
// the boundary, so it is not a useful boundary baseline.)

interface Ops {
  op_log(msg: string): void;
  op_sum(a: number, b: number): number;
}
declare const Deno: { core: { ops: Ops } };
const { op_log, op_sum } = Deno.core.ops;

function bench(label: string, n: number, fn: (i: number) => void): void {
  for (let i = 0; i < 20000; i++) fn(i); // warm up the JIT
  const t0 = Date.now();
  for (let i = 0; i < n; i++) fn(i);
  const dt = Date.now() - t0;
  const perCall = (dt * 1e6) / n; // ns/call
  op_log(`${label}: ${n} calls in ${dt} ms => ${perCall.toFixed(1)} ns/call`);
}

op_log("=== in-isolate baseline (engine main isolate, no sandbox, DEBUG build) ===");

let acc = 0;
bench("op_sum (numeric fast-API op, in-isolate)", 5_000_000, (i) => {
  acc = op_sum(i & 0xffff, 1);
});
op_log(`  (sink acc=${acc})`);
op_log("in-isolate baseline done");
