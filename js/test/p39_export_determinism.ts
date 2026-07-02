import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { exportGame } from "../src/game/publish.ts";
import { ops } from "../src/engine.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p39_export_determinism FAIL: " + message);
}

const recorder = new WorldRecorder("ses_p39_export_determinism");
recorder.seed(0x3939);

const logA = recorder.toJsonl();
await ops.op_sleep_ms(20);
const logB = recorder.toJsonl();
assert(logA === logB, "WorldRecorder.toJsonl must be byte-identical across repeated calls");

const filesA = exportGame(recorder, { worldId: "deterministic-world" });
await ops.op_sleep_ms(20);
const filesB = exportGame(recorder, { worldId: "deterministic-world" });
assert(filesA["log.jsonl"] === filesB["log.jsonl"], "export log.jsonl must be byte-identical across repeated calls");
assert(filesA["manifest.json"] === filesB["manifest.json"], "export manifest default timestamp must be deterministic");
assert(filesA["log.jsonl"].includes('"createdAt":"tick:0"'), "world-log createdAt must derive from deterministic recorder state");
assert(filesA["manifest.json"].includes('"createdAt": "tick:0"'), "manifest createdAt default must derive from deterministic recorder state");

ops.op_log("p39_export_determinism OK: recorder/export defaults are byte-identical across repeated calls");
