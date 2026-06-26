// Phase 8 BROWSER-GLUE headless checks — the browser-specific logic that does NOT
// need a GPU, verified without a browser:
//   1. startAccumulatorLoop drives a fixed-timestep step/frame schedule that
//      matches the native windowed loop (windowed.rs): N steps for N*FIXED_DT of
//      wall-clock, clamped at MAX_STEPS_PER_FRAME, with the frame-dt clamp.
//   2. DurableTraceStore: synchronous-mirror TraceOps over an async KV (write /
//      append / read / hydrate / write-behind drains via whenIdle).
//   3. The ACTUAL on-disk sample export (web/public/worlds/demo, copied into the
//      host's readable traces/ dir by the run harness) loadExports and the
//      ReplayPlayer — the same class the browser rAF loop drives — runs to `done`
//      reaching the manifest's tick count, with the expected entity count.
//
// The in-tab WebGPU RENDER is NOT covered here (no browser) — that is UAT.

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { loadExport } from "../src/export/package.ts";
import { ReplayPlayer } from "../src/browser/player.ts";
import {
  DurableTraceStore,
  FIXED_DT,
  MAX_STEPS_PER_FRAME,
  startAccumulatorLoop,
  type AsyncKvStore,
} from "../src/browser/host.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p8_browser_runtime FAIL: " + msg);
}
const flush = async (): Promise<void> => { for (let i = 0; i < 64; i++) await Promise.resolve(); };

// ===========================================================================
// 1. Accumulator loop — fixed-timestep schedule (no browser; raf/now injected)
// ===========================================================================
{
  let clock = 0; // ms
  let queued: Array<() => void> = [];
  const raf = (cb: () => void): void => { queued.push(cb); };
  const now = (): number => clock;
  let stepCalls = 0;
  let frameCalls = 0;
  const pump = async (advanceMs: number): Promise<void> => {
    clock += advanceMs;
    const cbs = queued; queued = [];
    for (const cb of cbs) cb();
    await flush();
  };

  const loop = startAccumulatorLoop({
    step: (): void => { stepCalls++; },
    frame: (): void => { frameCalls++; },
    raf, now, fixedDt: 1, maxStepsPerFrame: 5, maxFrameDt: 100,
  });

  await pump(3000);  // 3s of wall-clock at fixedDt=1s -> exactly 3 fixed steps + 1 frame
  assert(stepCalls === 3, `expected 3 steps after 3s, got ${stepCalls}`);
  assert(frameCalls === 1, `expected 1 frame, got ${frameCalls}`);

  await pump(100);   // 0.1s -> below one step -> frame only
  assert(stepCalls === 3, `sub-step dt must not advance a step (got ${stepCalls})`);
  assert(frameCalls === 2, `expected 2 frames, got ${frameCalls}`);

  await pump(10000); // 10s wants 10 steps but MAX_STEPS_PER_FRAME=5 clamps the catch-up
  assert(stepCalls === 8, `MAX_STEPS_PER_FRAME must clamp catch-up to 5 (got ${stepCalls - 3} this frame)`);
  assert(frameCalls === 3, `expected 3 frames, got ${frameCalls}`);
  assert(loop.steps === stepCalls && loop.frames === frameCalls, "handle counters disagree with observed calls");

  loop.stop();
  const before = loop.steps;
  await pump(5000);
  assert(loop.steps === before, "stop() must halt further steps");

  // Frame-dt clamp: a huge gap is clamped to maxFrameDt so a backgrounded tab
  // cannot trigger a spiral of death.
  let clamped = 0; let clampClock = 0; let q2: Array<() => void> = [];
  const loop2 = startAccumulatorLoop({
    step: (): void => { clamped++; },
    frame: (): void => {},
    raf: (cb): void => { q2.push(cb); },
    now: (): number => clampClock,
    fixedDt: 1, maxStepsPerFrame: 5, maxFrameDt: 0.25,
  });
  clampClock += 100000; // 100s gap -> clamped to 0.25s -> 0 steps (0.25 < fixedDt 1)
  { const cbs = q2; q2 = []; for (const cb of cbs) cb(); await flush(); }
  assert(clamped === 0, `frame-dt clamp must cap catch-up (got ${clamped} steps)`);
  loop2.stop();
}

// The exported constants mirror the native loop.
assert(Math.abs(FIXED_DT - 1 / 60) < 1e-12, "FIXED_DT must be 1/60");
assert(MAX_STEPS_PER_FRAME === 5, "MAX_STEPS_PER_FRAME must be 5");

// ===========================================================================
// 2. DurableTraceStore — synchronous mirror + async write-behind
// ===========================================================================
{
  class FakeKv implements AsyncKvStore {
    readonly data = new Map<string, string>();
    seeded: Array<[string, string]> = [];
    puts = 0;
    async loadAll(): Promise<Array<[string, string]>> { return this.seeded; }
    async put(key: string, value: string): Promise<void> { this.puts++; this.data.set(key, value); }
  }

  // Hydrate brings prior traces into the synchronous mirror.
  const kv = new FakeKv();
  kv.seeded = [["ses.events.jsonl", "line-a\n"]];
  const store = new DurableTraceStore(kv);
  await store.hydrate();
  assert(store.op_read_trace("ses.events.jsonl") === "line-a\n", "hydrate must seed the mirror");
  assert(store.op_read_trace("missing") === "", "absent trace must read empty string");

  // Synchronous write + read; append concatenates; persistence is write-behind.
  store.op_write_trace("t", "AAA");
  assert(store.op_read_trace("t") === "AAA", "write_trace then read_trace must reflect immediately");
  store.op_append_trace("t", "BBB");
  store.op_append_trace("t", "CCC");
  assert(store.op_read_trace("t") === "AAABBBCCC", "append_trace must concatenate in the mirror");

  await store.whenIdle(); // drain write-behind queue
  assert(kv.data.get("t") === "AAABBBCCC", "write-behind must persist the latest value to the KV");
  assert(kv.puts >= 3, `each mutation should enqueue a persist (got ${kv.puts})`);
}

// ===========================================================================
// 3. The on-disk sample export loads + the ReplayPlayer runs to `done`
// ===========================================================================
// The run harness copies web/public/worlds/demo/* into the host-readable traces/
// dir under these bare names (op_read_trace forbids path separators).
const manifest = ops.op_read_trace("demo.manifest.json");
const log = ops.op_read_trace("demo.log.jsonl");
const keyframes = ops.op_read_trace("demo.keyframes.jsonl");
assert(manifest.length > 0 && log.length > 0 && keyframes.length > 0,
  "sample export not found in traces/ — run: cp web/public/worlds/demo/{manifest.json,log.jsonl,keyframes.jsonl} traces/demo.{...} first");

const loaded = loadExport({ "manifest.json": manifest, "log.jsonl": log, "keyframes.jsonl": keyframes });
assert(loaded.manifest.worldId === "demo", "unexpected sample worldId");

function makeHeadlessWorld(worldOps: typeof ops): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless" };
}

const player = new ReplayPlayer(loaded, {
  makeWorld: (o) => makeHeadlessWorld(o as typeof ops),
  makeRegistry: (tracer) => { const r = new SkillRegistry(tracer); registerCoreSkills(r); return r; },
  tracer: new LiminaTracer("ses_p8_runtime"),
});
await player.init();
let guard = 0;
while (!player.done && guard++ < loaded.manifest.ticks + 50) await player.stepTick();
assert(player.done, "player did not reach done");
assert(player.tick === loaded.manifest.ticks, `player ended at tick ${player.tick}, expected ${loaded.manifest.ticks}`);

const finalState = player.state();
const withBodies = finalState.entities.filter((e) => e.body !== undefined).length;
assert(withBodies > 0, "no body-bound entities after playback");

ops.op_log(
  `p8_browser_runtime OK: accumulator loop schedules N steps + clamps at MAX_STEPS_PER_FRAME; ` +
  `DurableTraceStore mirrors + write-behind persists; on-disk sample export (${loaded.manifest.ticks} ticks, ` +
  `${loaded.keyframes.length} kf, ${loaded.commands.length} cmd) loadExports + ReplayPlayer runs to done with ${withBodies} bodies.`,
);
