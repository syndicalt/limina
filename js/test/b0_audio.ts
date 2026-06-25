// B0 — audio backend smoke. Proves the rodio/cpal stack opens, the dedicated
// audio thread + command channel work, and the backend-selection paths are clean:
//   LIMINA_AUDIO=null  -> mode 0, silent, clean exit (device-independent test).
//   live (device)      -> mode 1, audible blips.
import { ops } from "../src/engine.ts";

const mode = ops.op_audio_init();
ops.op_log(`B0 audio init: mode=${mode} (1=live, 0=null)`);

// Two short synthesized blips on the sfx bus (no-op under Null) — C5 then E5.
ops.op_audio_play(523.25, 0.18, 1, 0.8);
ops.op_audio_play(659.25, 0.18, 1, 0.8);
await ops.op_sleep_ms(500); // let them ring before the process exits

ops.op_log(`B0 OK: audio ops callable, clean exit (mode=${mode})`);
