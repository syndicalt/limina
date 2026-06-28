// Phase 12 — worldstate.* / audio.* extension skills: real config state + REPLAY PARITY.
//
// worldstate.ts was BROKEN two ways (both pinned here, falsifiably):
//   1. CLOSURE: the cut-1 skills read `(ctx.world as any).worldStateManager` / `.bgmManager`
//      / `.reverbManager` — a seam that was never set, so EVERY call was a silent no-op
//      (setSpawn stored nothing; getSpawn always returned the origin). The fix closes the
//      skills over the managers created in registerWorldAudioExtensionSkills. Falsifiable:
//      a setSpawn→getSpawn round-trip would fail (always [0,0,0]) under the no-op cut.
//   2. DETERMINISM: audio.playSFX returned + traced `sfx_${name}_${Date.now()}` — a wall
//      clock. The returned/traced handle would differ on every run and BREAK replay parity.
//      The fix derives the handle from ctx.tick + a monotone closure sequence. Falsifiable:
//      the replay-equivalence assert below recomputes the handles and demands bit-identity,
//      which Date.now() cannot satisfy.
//
// Run: limina js/test/p12_worldstate.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_worldstate FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}

function makeWorld(worldOps: EngineOps): WorldContext {
  const stub = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: stub as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

/** Wrap a registry's invoke to collect EVERY audio.playSFX handle (in order). */
function captureSFX(registry: SkillRegistry): string[] {
  const handles: string[] = [];
  const inner = registry.invoke.bind(registry);
  registry.invoke = (n, i, b) => inner(n, i, b).then((rr) => {
    if (n === "audio.playSFX" && rr.success) handles.push((rr.result as { handle: string }).handle);
    return rr;
  });
  return handles;
}

const PERMS = resolveProfile("builder.readWrite");
const SES = "ses_p12_ws_rec";
// Fixed ticks per command so the SFX handles (tick-derived) are pinned + reproducible.
const T = { time: 1, weather: 2, scale: 3, spawn: 4, getspawn: 5, sfx: 6, reverb: 7 };

// ── AUTHORING (recorded) ─────────────────────────────────────────────────────────────────
const recorder = new WorldRecorder(SES);
const recReg = new SkillRegistry(new LiminaTracer(SES));
const core: CoreSkills = registerCoreSkills(recReg);
recorder.attach(recReg);
const authHandles = captureSFX(recReg);
const recWorld = makeWorld(ops);

// Managers come from the core wiring — NOT a ctx.world seam (the cut-1 bug).
const worldMgr = core.worldstate.worldStateManager;
const bgmMgr = core.worldstate.bgmManager;
const reverbMgr = core.worldstate.reverbManager;
assert(worldMgr !== undefined && bgmMgr !== undefined && reverbMgr !== undefined,
  "core.worldstate did not expose the worldState/bgm/reverb managers");

const base = (tick: number) => ({ agentId: "agt_rec", sessionId: SES, permissions: PERMS, tick, world: recWorld });

// Default spawn is a sensible origin BEFORE any setSpawn (control for the round-trip).
const spawn0 = ok(await recReg.invoke("world.getSpawn", {}, base(0)));
assert(JSON.stringify(spawn0.position) === JSON.stringify([0, 0, 0]), "default spawn is not the origin");

// Real config state: setTime / setWeather / setTimeScale store + read back via the manager.
ok(await recReg.invoke("world.setTime", { time: 6.5 }, base(T.time)));
ok(await recReg.invoke("world.setWeather", { weather: "rain", intensity: 0.7 }, base(T.weather)));
ok(await recReg.invoke("world.setTimeScale", { scale: 2 }, base(T.scale)));
assert(worldMgr.getState().timeOfDay === 6.5, "setTime did not store the time (no-op closure bug)");
assert(worldMgr.getState().weather === "rain" && worldMgr.getState().weatherIntensity === 0.7, "setWeather did not store");
assert(worldMgr.getState().timeScale === 2, "setTimeScale did not store the (config-only) scale");

// setSpawn → getSpawn round-trip (the falsifiable proof the closure is wired).
ok(await recReg.invoke("world.setSpawn", { position: [3, 4, 5] }, base(T.spawn)));
const spawnBack = ok(await recReg.invoke("world.getSpawn", {}, base(T.getspawn)));
assert(JSON.stringify(spawnBack.position) === JSON.stringify([3, 4, 5]),
  `setSpawn→getSpawn round-trip failed (got ${JSON.stringify(spawnBack.position)}) — the manager seam is a no-op`);

// audio.playSFX twice at the SAME tick + name: handles must be DETERMINISTIC and DISTINCT.
const sfxA = ok(await recReg.invoke("audio.playSFX", { name: "footstep" }, base(T.sfx)));
const sfxB = ok(await recReg.invoke("audio.playSFX", { name: "footstep" }, base(T.sfx)));
const hA = sfxA.handle as string, hB = sfxB.handle as string;
assert(typeof hA === "string" && hA.length > 0, "playSFX returned no handle");
assert(hA !== hB, `two playSFX handles must be DISTINCT (got ${hA} == ${hB}) — the sequence counter is not advancing`);
assert(!/\d{13}/.test(hA), `playSFX handle looks wall-clock-derived (${hA}) — Date.now() determinism regression`);
assert(authHandles.length === 2 && authHandles[0] === hA && authHandles[1] === hB, "captured SFX handles disagree with returns");

// audio.setReverb stores a zone (deterministic id) the backend consumes.
const rev = ok(await recReg.invoke("audio.setReverb", { position: [0, 0, 0], radius: 10, decay: 2 }, base(T.reverb)));
assert(typeof rev.zoneId === "string" && rev.zoneId.length > 0, "setReverb returned no zoneId");
assert(reverbMgr.getZoneAt([1, 0, 0]) !== undefined, "setReverb did not store the zone in the manager");

// Snapshot the authored state for the replay-equivalence comparison.
const authState = JSON.stringify(worldMgr.getState());
const authSnap = { state: authState, handles: [hA, hB] };

// ── REPLAY-EQUIVALENCE: replay the recorded stream into a FRESH core, demand BIT-IDENTITY ──
let replayCore: CoreSkills | undefined;
let replayHandles: string[] = [];
await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayCore = registerCoreSkills(r);
    replayHandles = captureSFX(r);
    return r;
  },
  tracer: new LiminaTracer("ses_p12_ws_replay"),
});
assert(replayCore !== undefined, "replay did not construct a core");
const replayMgrState = JSON.stringify(replayCore.worldstate.worldStateManager.getState());

assert(replayHandles.length === 2, `replay re-ran ${replayHandles.length} playSFX (expected 2) — the stream did not re-drive it`);
assert(replayHandles[0] === authSnap.handles[0] && replayHandles[1] === authSnap.handles[1],
  `replay recomputed DIFFERENT SFX handles (${JSON.stringify(replayHandles)} != ${JSON.stringify(authSnap.handles)}) — Date.now() regression`);
assert(replayMgrState === authSnap.state,
  `replay worldState diverged from authoring:\n  auth=${authSnap.state}\n  replay=${replayMgrState}`);

ops.op_log(
  `p12_worldstate OK: skills closed over the managers (setSpawn→getSpawn round-trips [3,4,5], not the no-op origin); ` +
  `time/weather/timeScale stored as real config (timeScale recorded-only, NOT wired into the sim loop); ` +
  `audio.* schedule via the managers + emit; playSFX handles are tick-derived + monotone (${authSnap.handles.join(", ")}) — ` +
  `DISTINCT at the same tick, NO Date.now(); replay recomputes the SAME handles + identical worldState bit-for-bit.`,
);
