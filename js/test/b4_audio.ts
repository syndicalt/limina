// B4 — Rust-side fire-and-forget TTS. The load-bearing property: op_audio_speak
// returns IMMEDIATELY (it only queues a command; synthesis runs on a worker
// thread), so a slow voice never freezes the frame. Under LIMINA_AUDIO=null it's
// a clean no-op; live (espeak-ng) it speaks off-thread at the speaker's position.
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("B4 FAIL: " + msg);
}

const mode = ops.op_audio_init();

// Fire-and-forget: the op must return synchronously + fast even though synthesis
// (espeak) takes far longer — proving it runs off the JS thread, not inline.
const t0 = Date.now();
const h1 = ops.op_audio_speak("Hello from limina.", 0, 1, 0, 0.95, 0);
const dt = Date.now() - t0;
assert(typeof h1 === "number", "op_audio_speak returns a handle");
assert(dt < 50, `op_audio_speak must return immediately (fire-and-forget); took ${dt}ms`);
const h2 = ops.op_audio_speak("A second spoken line.", 3, 1, 0, 0.95, 0);
assert(h2 !== h1, "speak handles are distinct");

// audio.speak skill: permissioned (audio.play) + traced.
const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops };
const tracer = new LiminaTracer("ses_b4");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);

const voiceAgent = { agentId: "agt_voice", sessionId: "ses_b4", permissions: resolveProfile("social.actor"), tick: 1, world };
const r = await registry.invoke("audio.speak", { text: "Spoken through the skill.", position: [1, 1, 1] }, voiceAgent);
assert(r.success, "audio.speak should succeed for social.actor");

const mute = { agentId: "agt_mute", sessionId: "ses_b4", permissions: resolveProfile("system.readonly"), tick: 2, world };
const denied = await registry.invoke("audio.speak", { text: "denied", position: [0, 0, 0] }, mute);
assert(!denied.success, "audio.speak must be denied without audio.play");

const trace = tracer.trace("agt_voice");
assert(trace.some((e) => e.type === "audio.spoke"), "audio.spoke event traced");

await ops.op_sleep_ms(mode === 1 ? 1800 : 50); // live: let off-thread synth + playback happen

ops.op_log(`B4 OK: mode=${mode} op_audio_speak fire-and-forget (returned in ${dt}ms); audio.speak permissioned+traced; handles=[${h1},${h2}]`);
