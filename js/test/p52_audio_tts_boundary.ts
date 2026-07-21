// Native audio TTS boundary hardening: speech text must be bounded before it can
// queue unbounded TTS worker/process work.

import { ops } from "../src/engine.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p52_audio_tts_boundary FAIL: " + message);
}

function throws(label: string, fn: () => unknown, needle: string): void {
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.toLowerCase().includes(needle), `${label}: wrong error '${msg}', expected '${needle}'`);
    return;
  }
  throw new Error(`p52_audio_tts_boundary FAIL: ${label}: expected throw`);
}

ops.op_audio_init();

throws("oversize TTS text", () => ops.op_audio_speak("x".repeat(1001), 0, 1, 0, 1, 0), "text");
throws("non-finite TTS position", () => ops.op_audio_speak("short", 0, Number.NaN, 0, 1, 0), "finite");

const handle = ops.op_audio_speak("short bounded line", 0, 1, 0, 1, 0);
assert(typeof handle === "number", "bounded TTS text should return a handle");

ops.op_log("[js] p52_audio_tts_boundary OK: TTS text and position are bounded before queueing");
