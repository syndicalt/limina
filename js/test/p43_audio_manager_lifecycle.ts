// P43 -- AudioManager JS handle lifecycle.
//
// Native playback can finish independently, but the JS manager used to retain
// every fire-and-forget handle forever. Finite sounds must be prunable, while
// looping/ambient sounds stay tracked until an explicit stop/dispose.

import { AudioManager } from "../src/audio/manager.ts";
import { ops } from "../src/engine.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p43_audio_manager_lifecycle: " + message);
}

const original = {
  play: ops.op_audio_play,
  ambient: ops.op_audio_ambient,
  stop: ops.op_audio_stop,
  buffer: ops.op_audio_play_buffer,
  speak: ops.op_audio_speak,
  now: Date.now,
};

let nextNativeId = 10;
const stopped: number[] = [];
Date.now = () => 1000;
ops.op_audio_play = () => nextNativeId++;
ops.op_audio_ambient = () => nextNativeId++;
ops.op_audio_play_buffer = () => nextNativeId++;
ops.op_audio_speak = () => nextNativeId++;
ops.op_audio_stop = (id: number) => { stopped.push(id); };

try {
  const audio = new AudioManager();
  const finite = audio.play(440, 0.25, "sfx", 0.5);
  const ambient = audio.ambient("ambience", 0.3);
  const looping = audio.playBuffer(new Float32Array(48000), 48000, 1, "ambience", 0.4, true);
  const speech = audio.speak("A short spoken line.", [0, 1, 0], 0.8);

  assert(audio.pruneFinished(1249) === 0, "finite sound pruned before its duration elapsed");
  assert(audio.pruneFinished(1251) === 1, "finite sound was not pruned after its duration elapsed");
  assert(audio.stop(finite) === false, "expired finite handle should no longer be stoppable");
  assert(audio.stop(speech) === true, "speech handle should remain stoppable before its conservative expiry");
  assert(stopped.includes(13), "stopping speech should call native stop for its id");

  const speech2 = audio.speak("Hi.", [0, 1, 0], 0.8);
  assert(audio.pruneFinished(3_999) === 0, "speech handle pruned before its minimum conservative expiry");
  assert(audio.pruneFinished(4_001) === 1, "speech handle was not pruned after its conservative expiry");
  assert(audio.stop(speech2) === false, "expired speech handle should no longer be stoppable");

  assert(audio.stop(ambient) === true, "ambient handle should remain live until stopped");
  assert(stopped.includes(11), "stopping ambient should call native stop for its id");

  audio.dispose();
  assert(stopped.includes(12), "dispose should stop remaining looping buffer");
  const stopCount = stopped.length;
  audio.dispose();
  assert(stopped.length === stopCount, "dispose must be idempotent");
  assert(audio.stop(looping) === false, "disposed handle should not remain live");
} finally {
  ops.op_audio_play = original.play;
  ops.op_audio_ambient = original.ambient;
  ops.op_audio_stop = original.stop;
  ops.op_audio_play_buffer = original.buffer;
  ops.op_audio_speak = original.speak;
  Date.now = original.now;
}

ops.op_log("[js] p43_audio_manager_lifecycle OK: finite audio and speech handles prune by duration and dispose stops remaining live sounds");
