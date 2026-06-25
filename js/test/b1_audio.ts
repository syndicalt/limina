// B1 — bus mixer + sound handles + looping ambience. Run under LIMINA_AUDIO=null
// for a deterministic, device-free gate: handle allocation + every op are
// exercised with no device. Live (device) additionally rings the sounds.
import { ops } from "../src/engine.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("B1 FAIL: " + msg);
}

const mode = ops.op_audio_init();

const a = ops.op_audio_play(440, 0.2, 1, 0.8); // one-shot, sfx bus
const b = ops.op_audio_play(660, 0.2, 1, 0.8);
const amb = ops.op_audio_ambient(2, 0.5); // looping bed, ambience bus

assert(typeof a === "number", "play returns a numeric handle");
assert(a !== b && b !== amb && a !== amb, "handles are distinct");
assert(b === a + 1 && amb === b + 1, "handles allocate sequentially (deterministic)");

ops.op_audio_set_bus_volume(0, 0.7); // master down
ops.op_audio_set_bus_volume(2, 0.3); // ambience down
ops.op_audio_stop(a); // stop one
await ops.op_sleep_ms(300); // let the live path ring briefly
ops.op_audio_stop_all(); // stop the rest

ops.op_log(`B1 OK: mode=${mode} handles=[${a},${b},${amb}] play/ambient/setBusVolume/stop/stopAll callable`);
