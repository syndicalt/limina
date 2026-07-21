import { ops } from "../src/engine.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p45_recorder_proxy_cache FAIL: " + message);
}

const recorder = new WorldRecorder("ses_p45_recorder_proxy_cache");
const wrapped = recorder.wrapOps(ops);

assert(
  wrapped.op_physics_step === wrapped.op_physics_step,
  "recorded physics op wrapper must be stable across property reads",
);
assert(
  wrapped.op_log === wrapped.op_log,
  "unrecorded bound op wrapper must be stable across property reads",
);

wrapped.op_physics_create_world(-9.81);
assert(recorder.count("physics") === 1, "cached recorded wrapper stopped recording physics ops");

ops.op_log("p45_recorder_proxy_cache OK: WorldRecorder.wrapOps caches recorded and pass-through op wrappers");
