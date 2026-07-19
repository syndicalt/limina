import { FixedStepAccumulator, installSimWorker } from "../src/browser/sim-worker.ts";
import { shouldRenderLiveFrame } from "../src/browser/live-runtime.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p8_sim_worker_pause FAIL: " + message);
}

const messages: Array<Record<string, unknown>> = [];
const scope = {
  onmessage: null as ((event: { data: unknown }) => void) | null,
  postMessage(message: unknown): void { messages.push(message as Record<string, unknown>); },
};
let shellClockMs = 0;
installSimWorker(scope, { nowMs: () => { shellClockMs += 100; return shellClockMs; } });

// Deterministic scheduler contract: elapsed time is accumulated, catch-up is
// bounded, excess debt is reported, and resume/reset carries no paused debt.
const accumulator = new FixedStepAccumulator(10, 5, 250);
accumulator.reset(0);
let advance = accumulator.advance(50);
assert(advance.steps === 0 && advance.droppedSteps === 0, "sub-step elapsed time was not retained");
advance = accumulator.advance(350);
assert(advance.steps === 2 && advance.droppedSteps === 1, "250ms clamp did not bound catch-up and account discarded debt");
advance = accumulator.advance(2_350);
assert(advance.steps === 2 && advance.droppedSteps === 18, "long stall debt was silently lost or over-stepped");
accumulator.reset(5_000);
advance = accumulator.advance(5_100);
assert(advance.steps === 1 && advance.droppedSteps === 0, "reset carried paused elapsed debt into resume");
advance = accumulator.advance(5_050);
assert(advance.steps === 0 && advance.droppedSteps === 0, "regressing clock fabricated fixed-step debt");
advance = accumulator.advance(5_200);
assert(advance.steps === 1 && advance.droppedSteps === 0, "regressing clock made later elapsed time count twice");

let renderSpy = 0;
if (shouldRenderLiveFrame(true)) renderSpy++;
assert(renderSpy === 0, "suspended view gate must suppress hidden runtime frame work");
if (shouldRenderLiveFrame(false)) renderSpy++;
assert(renderSpy === 1, "resumed view gate must allow frame work again");

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`p8_sim_worker_pause FAIL: timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

scope.onmessage?.({ data: { type: "pause", requestId: 1 } });
await waitFor(() => messages.some((message) => message.type === "controlRejected" && message.requestId === 1), "pre-init rejection");
assert(!messages.some((message) => message.type === "paused" && message.requestId === 1), "pre-init pause must not claim success");

scope.onmessage?.({ data: {
  type: "init",
  commands: [{ kind: "physics", op: "op_physics_create_world", args: [-9.81] }],
  hz: 240,
} });
await waitFor(() => messages.some((message) => message.type === "ready"), "ready");
const ready = messages.find((message) => message.type === "ready")!;
const status = new Int32Array(ready.status as SharedArrayBuffer | ArrayBuffer, 0, 5);
await waitFor(() => Atomics.load(status, 0) >= 3, "initial ticks");
assert(Atomics.load(status, 4) > 0, "worker shell did not publish dropped debt from its bounded catch-up loop");

scope.onmessage?.({ data: { type: "pause", requestId: 11 } });
await waitFor(() => messages.some((message) => message.type === "paused" && message.requestId === 11), "pause acknowledgement");
const pausedAt = Atomics.load(status, 0);
const pausedGeneration = Atomics.load(status, 3);
scope.onmessage?.({ data: { type: "step" } });
scope.onmessage?.({ data: { type: "step" } });
await new Promise((resolve) => setTimeout(resolve, 40));
assert(Atomics.load(status, 0) === pausedAt, "acknowledged pause must halt timer and injected deterministic ticks");
assert(Atomics.load(status, 3) === pausedGeneration, "paused worker fabricated a status generation without a completed tick");

scope.onmessage?.({ data: { type: "pause", requestId: 12 } });
await waitFor(() => messages.some((message) => message.type === "paused" && message.requestId === 12), "repeated pause acknowledgement");
assert(Atomics.load(status, 0) === pausedAt, "repeated pause must be idempotent");

scope.onmessage?.({ data: { type: "resume", requestId: 13 } });
await waitFor(() => messages.some((message) => message.type === "resumed" && message.requestId === 13), "resume acknowledgement");
await waitFor(() => Atomics.load(status, 0) > pausedAt, "resumed ticks");
scope.onmessage?.({ data: { type: "resume", requestId: 14 } });
await waitFor(() => messages.some((message) => message.type === "resumed" && message.requestId === 14), "repeated resume acknowledgement");
const beforeFinalPause = Atomics.load(status, 0);
scope.onmessage?.({ data: { type: "pause", requestId: 15 } });
await waitFor(() => messages.some((message) => message.type === "paused" && message.requestId === 15), "final pause acknowledgement");
scope.onmessage?.({ data: { type: "stop" } });
await new Promise((resolve) => setTimeout(resolve, 30));
assert(Atomics.load(status, 0) >= beforeFinalPause, "stop during control must leave a valid final tick");
const stoppedAt = Atomics.load(status, 0);
await new Promise((resolve) => setTimeout(resolve, 30));
assert(Atomics.load(status, 0) === stoppedAt, "stop must prevent every later tick");
scope.onmessage?.({ data: { type: "resume", requestId: 16 } });
await waitFor(() => messages.some((message) => message.type === "controlRejected" && message.requestId === 16), "post-stop rejection");
assert(!messages.some((message) => message.type === "resumed" && message.requestId === 16), "post-stop resume must not claim success");
assert(!messages.some((message) => message.type === "tick"), "worker flooded the message channel with redundant tick acknowledgements");

console.log(`p8_sim_worker_pause OK: worker held tick ${pausedAt} across timer/manual-step pause, resumed, and stopped at ${stoppedAt}`);
