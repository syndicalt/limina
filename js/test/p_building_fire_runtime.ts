import {
  BUILDING_FIRE_PARAMETER_LIMITS,
  BUILDING_FIRE_SNAPSHOT_SCHEMA,
  BUILDING_FIRE_TICK_HZ,
  BuildingFireRuntime,
  validateBuildingFireRuntimeSnapshot,
} from "../src/render/building-fire-runtime.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_building_fire_runtime FAIL: ${message}`);
}
function rejects(operation: () => unknown, pattern: RegExp, message: string): void {
  let failure: unknown;
  try { operation(); } catch (error) { failure = error; }
  assert(failure instanceof Error && pattern.test(failure.message), `${message}: ${failure instanceof Error ? failure.message : "did not throw"}`);
}
const json = (value: unknown): string => JSON.stringify(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const applied: string[] = [];
let disposals = 0;
const fire = new BuildingFireRuntime({ seed: 0x12345678, ignitionTicks: 60, extinguishTicks: 90,
  binding: { apply: (value) => applied.push(json(value)), dispose: () => { disposals++; } } });
assert(fire.phase === "off" && fire.tick === 0 && fire.lightSample().intensityCandela === 0,
  "new fire did not begin in a dark off state");
assert(applied.length === 1, "initial off state was not projected to the render binding");
assert(fire.start() && !fire.start() && fire.phase === "igniting", "start was not idempotent while igniting");
const midpoint = fire.advanceTicks(30);
assert(midpoint.phase === "igniting" && midpoint.envelope === 0.5 && midpoint.authoritativeTimeSeconds === 0.5,
  "fixed-tick ignition midpoint drifted");
const burning = fire.advanceTicks(30);
assert(burning.phase === "burning" && burning.envelope === 1 && fire.tick === 60,
  "ignition did not land exactly on the burning boundary");

const intensities = [];
for (let tick = 0; tick < 120; tick++) {
  const value = fire.advanceTicks();
  intensities.push(value.intensityCandela);
  assert(value.intensityCandela >= 0 && value.intensityCandela <= BUILDING_FIRE_PARAMETER_LIMITS.lightMaximumCandela,
    "state-driven light escaped its candela bound");
  assert(value.powerLumens === value.intensityCandela * Math.PI * 4 && value.distanceM >= 1.5 && value.distanceM <= 8
    && value.decay === 2 && value.colorSrgb.every((channel) => channel >= 0 && channel <= 1),
  "light power, range, decay, or color escaped authority");
}
assert(new Set(intensities.map((value) => value.toFixed(6))).size > 20, "burning light lacks bounded temporal flicker");
assert(fire.parameters.lightBaseCandela >= 1 && fire.parameters.lightBaseCandela <= 8
  && fire.parameters.lightFlickerCandela <= fire.parameters.lightBaseCandela * 0.06
  && fire.parameters.lightBaseCandela + fire.parameters.lightFlickerCandela <= 8,
"authored fire-light parameters escaped the locked 1–8 cd / 6% flicker contract");
rejects(() => new BuildingFireRuntime({ lightBaseCandela: 7, lightFlickerCandela: 0.43 }), /6%/,
  "over-amplitude fire-light flicker was accepted");
rejects(() => new BuildingFireRuntime({ lightBaseCandela: 7.8, lightFlickerCandela: 0.4 }), /peak/,
  "fire-light peak above 8 cd was accepted");

const transitions = new BuildingFireRuntime({ seed: 9, ignitionTicks: 100, extinguishTicks: 100 });
transitions.start(); transitions.advanceTicks(37);
const beforeEarlyExtinguish = transitions.lightSample().envelope;
transitions.extinguish();
assert(Math.abs(transitions.lightSample().envelope - beforeEarlyExtinguish) <= 1 / 1_000_000,
  "early extinguish introduced a discontinuous energy jump");
transitions.advanceTicks(19);
const beforeRelight = transitions.lightSample().envelope;
transitions.start();
assert(Math.abs(transitions.lightSample().envelope - beforeRelight) <= 1 / 1_000_000,
  "relight introduced a discontinuous energy jump");
transitions.dispose();

const deterministicActions = (runtime: BuildingFireRuntime): readonly string[] => {
  const output = [json(runtime.lightSample())];
  runtime.start(); output.push(json(runtime.advanceTicks(23)));
  runtime.extinguish(); output.push(json(runtime.advanceTicks(11)));
  runtime.start(); output.push(json(runtime.advanceTicks(97)));
  runtime.extinguish(); output.push(json(runtime.advanceTicks(500)));
  output.push(json(runtime.snapshot()));
  return output;
};
const left = new BuildingFireRuntime({ seed: 77 }), right = new BuildingFireRuntime({ seed: 77 });
assert(json(deterministicActions(left)) === json(deterministicActions(right)),
  "identical fixed-tick commands did not produce byte-identical state and light samples");
left.dispose(); right.dispose();

assert(fire.extinguish() && !fire.extinguish(), "extinguish was not idempotent while fading");
const fadeSnapshot = fire.snapshot(), fadeSample = fire.lightSample();
const restored = new BuildingFireRuntime({ seed: 0x12345678, ignitionTicks: 60, extinguishTicks: 90 });
assert(json(restored.restore(clone(fadeSnapshot))) === json(fadeSample)
  && json(restored.snapshot()) === json(fadeSnapshot), "snapshot restore did not recover exact phase and light state");
assert(restored.advanceTicks(90).phase === "off" && restored.lightSample().intensityCandela === 0,
  "extinguish did not terminate in an exactly dark state");

const valid = validateBuildingFireRuntimeSnapshot(clone(fadeSnapshot));
assert(valid.schema === BUILDING_FIRE_SNAPSHOT_SCHEMA && valid.tickHz === BUILDING_FIRE_TICK_HZ
  && Object.isFrozen(valid) && Object.isFrozen(valid.parameters) && Object.isFrozen(valid.state),
"snapshot validation did not return a deeply immutable authority");
for (const [mutation, pattern] of [
  [(value: any) => { value.schema = "bad"; }, /schema/],
  [(value: any) => { value.tickHz = 30; }, /tickHz/],
  [(value: any) => { value.state.tick = -1; }, /tick/],
  [(value: any) => { value.state.phase = "paused"; }, /phase/],
  [(value: any) => { value.state.phase = "igniting"; value.state.phaseStartedTick = 0; }, /transition boundary/],
  [(value: any) => { value.state.extra = true; }, /unsupported/],
  [(value: any) => { value.parameters.lightBaseCandela = 90; }, /lightBaseCandela|peak/],
] as const) {
  const corrupt: any = clone(fadeSnapshot); mutation(corrupt);
  rejects(() => validateBuildingFireRuntimeSnapshot(corrupt), pattern, "hostile fire snapshot was accepted");
}
const mismatched = new BuildingFireRuntime({ seed: 0x12345678, ignitionTicks: 61, extinguishTicks: 90 });
rejects(() => mismatched.restore(fadeSnapshot), /parameters/, "snapshot crossed a mismatched runtime authority");
mismatched.dispose();

const atomicApplied: string[] = [];
let failApply = false;
const atomic = new BuildingFireRuntime({ binding: { apply(value) { if (failApply) throw new Error("projection failed"); atomicApplied.push(json(value)); }, dispose() {} } });
const beforeFailure = atomic.snapshot(); failApply = true;
rejects(() => atomic.start(), /projection failed/, "binding projection failure was swallowed");
assert(json(atomic.snapshot()) === json(beforeFailure), "failed render projection committed authoritative state");
failApply = false; assert(atomic.start(), "runtime could not retry after an atomic projection failure");
atomic.dispose();

const brokenBinding = { disposed: 0, apply() { throw new Error("initial apply failed"); }, dispose() { this.disposed++; } };
rejects(() => new BuildingFireRuntime({ binding: brokenBinding }), /initial apply failed/,
  "constructor accepted a binding that could not represent the initial state");
assert(brokenBinding.disposed === 1, "failed binding initialization leaked its resource owner");

restored.dispose(); restored.dispose();
fire.dispose(); fire.dispose();
assert(disposals === 1 && fire.disposed, "runtime disposal was not exactly-once and idempotent");
rejects(() => fire.start(), /disposed/, "disposed runtime accepted state mutation");
rejects(() => fire.snapshot(), /disposed/, "disposed runtime exposed stale authoritative state");
assert(applied.length >= 124, "binding did not receive authoritative fixed-tick samples");

let failedDisposals = 0;
const cleanupFailure = new BuildingFireRuntime({ binding: { apply() {}, dispose() { failedDisposals++; throw new Error("dispose failed"); } } });
rejects(() => cleanupFailure.dispose(), /dispose failed/, "binding cleanup failure was swallowed");
cleanupFailure.dispose();
assert(cleanupFailure.disposed && failedDisposals === 1, "failed binding cleanup was retried or left runtime live");

console.log("p_building_fire_runtime OK: fixed-tick start/burn/extinguish, exact snapshot/restore, deterministic bounded lighting, atomic binding projection, and idempotent lifecycle are proven without GPU work");
