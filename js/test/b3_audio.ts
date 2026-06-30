// B3 — audio.* skills: permissioned + traced. Run under LIMINA_AUDIO=null for a
// deterministic, device-free gate: skills are driven through the registry, a
// privileged profile succeeds + is traced, and an unprivileged profile is DENIED.
import { ops } from "../src/engine.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { createHeadlessContext } from "../src/game/index.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("B3 FAIL: " + msg);
}
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

const ctx = createHeadlessContext({ session: "ses_b3" });
const registry = ctx.registry;
const world = ctx.world;
const tracer = ctx.registry.tracer;

const mode = ops.op_audio_init(); // forced LIMINA_AUDIO=null in the gate

// Privileged agent (builder.readWrite has audio.play): every audio.* succeeds.
const dj = { agentId: "agt_dj", sessionId: "ses_b3", permissions: resolveProfile("builder.readWrite"), tick: 1, world };
const r1 = await registry.invoke("audio.play", { freq: 440, secs: 0.2 }, dj);
assert(r1.success, "audio.play should succeed for builder.readWrite");
const handle = field(r1.result, "handle");
assert(typeof handle === "string", "audio.play returns a string handle");

assert((await registry.invoke("audio.ambient", { volume: 0.4 }, dj)).success, "audio.ambient should succeed");
assert((await registry.invoke("audio.playAt", { freq: 330, secs: 0.2, position: [3, 0, 0], maxDistance: 12 }, dj)).success, "audio.playAt should succeed");
assert((await registry.invoke("audio.setBusVolume", { bus: "ambience", volume: 0.3 }, dj)).success, "audio.setBusVolume should succeed");
const rStop = await registry.invoke("audio.stop", { handle }, dj);
assert(rStop.success && field(rStop.result, "ok") === true, "audio.stop succeeds for a live handle");

// Unprivileged agent (player.limited lacks audio.play): DENIED, zero effect.
const npc = { agentId: "agt_npc", sessionId: "ses_b3", permissions: resolveProfile("player.limited"), tick: 2, world };
const denied = await registry.invoke("audio.play", { freq: 440, secs: 0.2 }, npc);
assert(!denied.success, "audio.play MUST be denied for player.limited");

// Invalid input is rejected (no negative duration).
const bad = await registry.invoke("audio.play", { freq: 440, secs: -1 }, dj);
assert(!bad.success, "audio.play MUST reject invalid input (negative secs)");

// Trace: audio.play produced a skill.executed + an audio.played event under agt_dj.
const trace = tracer.trace("agt_dj");
assert(trace.some((e) => e.type === "skill.executed"), "skill.executed traced for audio.*");
assert(trace.some((e) => e.type === "audio.played"), "audio.played event traced");

ops.op_log(`B3 OK: mode=${mode} audio.* permissioned (builder ok / player.limited denied) + input-validated + traced; handle=${handle}`);
