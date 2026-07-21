import { withFrozenRendererTime } from "../src/render/frozen-render-time.ts";

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(`p_frozen_render_time FAIL: ${message}`);
}

let originalCalls = 0;
const original = function originalUpdate(this: { frameId: number; time: number; deltaTime: number }): void {
  originalCalls++;
  this.frameId++;
  this.time += 1;
  this.deltaTime = 1;
};
const frame = { frameId: 7, time: 2, deltaTime: 1, update: original };
const renderer = { _nodes: { nodeFrame: frame }, info: { frame: 7 } };
let escapedBeginFrame: (() => number) | undefined;
const value = await withFrozenRendererTime(renderer, 3.25, async (beginFrame) => {
  escapedBeginFrame = beginFrame;
  assert(beginFrame() === 8 && renderer.info.frame === 8 && frame.time === 3.25 && frame.deltaTime === 0,
    "first frozen update did not preserve frame semantics");
  await Promise.resolve();
  assert(beginFrame() === 9 && renderer.info.frame === 9 && frame.time === 3.25 && frame.deltaTime === 0,
    "frozen time changed across asynchronous capture work");
  return "captured";
});
assert(value === "captured" && frame.update === original && originalCalls === 0,
  "successful capture did not restore the original NodeFrame update exactly");
let escapedRejected = false;
try { escapedBeginFrame?.(); } catch (error) {
  escapedRejected = error instanceof Error && /escaped its capture scope/.test(error.message);
}
assert(escapedRejected, "frozen frame callback remained usable after capture scope");
frame.update();
assert(originalCalls === 1 && frame.time === 4.25, "restored NodeFrame update is not callable");

let rejected = false;
try {
  await withFrozenRendererTime(renderer, 0, () => { throw new Error("capture failed"); });
} catch (error) {
  rejected = error instanceof Error && error.message === "capture failed";
}
assert(rejected && frame.update === original, "failed capture did not restore the original NodeFrame update");

for (const operation of [
  () => withFrozenRendererTime(renderer, -1, () => undefined),
  () => withFrozenRendererTime({}, 0, () => undefined),
  () => withFrozenRendererTime({ _nodes: { nodeFrame: frame } }, 0, () => undefined),
]) {
  let failedClosed = false;
  try { await operation(); } catch { failedClosed = true; }
  assert(failedClosed, "invalid capture clock contract was accepted");
}

console.log("p_frozen_render_time OK: fixed TSL time, advancing frame identity, async scope, restoration, and fail-closed inputs are proven");
