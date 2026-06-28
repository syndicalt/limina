// Phase 12 — the SAVE/LOAD system. Falsifiable, headless, and REAL (the old skill
// was a stub: checkpoints stored {} / [0,0,0], load restored nothing, export wrote a
// literal "trace_data" string with a Date.now() timestamp). This proves the honest
// spine:
//
//   1. checkpoint.create/load — REAL round-trip: capture known transforms + gameState,
//      MUTATE them, load, and assert the world RETURNED bit-identically (compareWorldState).
//      The stub (which restored nothing) fails this.
//   2. save.export → save.import (SNAPSHOT fallback, the current index.ts wiring) into a
//      FRESH world reconstructs the captured state (after the SoA is corrupted — teeth that
//      import actually writes).
//   3. DETERMINISM: two exports at the same tick over the same state are BYTE-IDENTICAL
//      (catches the exportedTick: Date.now() regression); a different tick changes the bytes.
//   4. LOG FACADE (recorder wired): export serializes the durable command stream into a real
//      export package; import loadExport-verifies it + replayCommands into a fresh world,
//      reconstructing the SAME entities by RE-RUNNING the authored skills.
//
// Run: limina js/test/p12_save.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld, spawnRenderable, type Transformable } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { registerSaveSkills } from "../src/skills/save.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { captureWorldState, compareWorldState } from "../src/worldlog/log.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_save FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}

/** Inert transform binding (the render mesh is host-attached; headless stub). */
function inert(): Transformable {
  return { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
}

function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

/** Spawn a body-less ECS entity at a known transform; returns its id + eid. */
function spawn(world: WorldContext, x: number, y: number, z: number): { id: string; eid: number } {
  const eid = spawnRenderable(world.ecs, inert(), x, y, z);
  const id = world.entities.create({ eid });
  return { id, eid };
}

const BUILDER = resolveProfile("builder.readWrite");

// ===========================================================================
// 1. checkpoint.create / checkpoint.load — REAL snapshot/restore round-trip
// ===========================================================================
const reg = new SkillRegistry(new LiminaTracer("ses_p12_save"));
registerCoreSkills(reg); // production wiring: save with NO recorder → snapshot fallback

const W = makeWorld(ops);
const base = { agentId: "agt_p12", sessionId: "ses_p12_save", permissions: BUILDER, tick: 0, world: W };

const a = spawn(W, 1, 2, 3);
const b = spawn(W, 4, 5, 6);
const c = spawn(W, 7, 8, 9);
// Give one entity a non-identity rotation + scale so the restore is exercised in full.
W.transforms!.writeRotation(a.eid, 0, 0.7071, 0, 0.7071);
W.transforms!.writeScale(a.eid, 2, 2, 2);

const before = captureWorldState(W);
assert(before.entities.length === 3, "expected 3 captured entities");

const cpRes = ok(await reg.invoke("checkpoint.create", { name: "cp1", gameState: { score: 100, level: "forest" } }, base));
assert(cpRes.entityCount === 3, "checkpoint.create captured the wrong entity count (stub captured 0?)");

// MUTATE every transform component so a no-op load would be caught.
W.transforms!.writePosition(a.eid, 99, 99, 99);
W.transforms!.writeRotation(a.eid, 0, 0, 0, 1);
W.transforms!.writeScale(a.eid, 5, 5, 5);
W.transforms!.writePosition(b.eid, -1, -1, -1);
W.transforms!.writePosition(c.eid, 0, 0, 0);
const mutated = captureWorldState(W);
assert(!compareWorldState(before, mutated).identical, "mutation did not change the world (test is toothless)");

const loaded = ok(await reg.invoke("checkpoint.load", { name: "cp1" }, base));
const after = captureWorldState(W);
const cmp = compareWorldState(before, after);
assert(cmp.identical, `checkpoint.load did NOT restore the world: ${cmp.detail} (the stub restored nothing)`);
const lgs = loaded.gameState as Record<string, unknown>;
assert(lgs !== undefined && lgs.score === 100 && lgs.level === "forest", "checkpoint.load did not return the stored gameState");

// checkpoint.list reflects the real checkpoint.
const list = ok(await reg.invoke("checkpoint.list", {}, base));
assert((list.checkpoints as { name: string; entityCount: number }[]).some((c2) => c2.name === "cp1" && c2.entityCount === 3),
  "checkpoint.list did not report the real checkpoint");

// ===========================================================================
// 2. save.export → save.import (SNAPSHOT fallback) into a FRESH world
// ===========================================================================
const exp = ok(await reg.invoke("save.export", { name: "slot1", gameState: { score: 100 } }, base));
assert(exp.mode === "snapshot", "no recorder wired → export must use the snapshot fallback");
assert((exp.bytes as number) > 0, "export produced no bytes");

const slot = ok(await reg.invoke("save.slot", { action: "load", name: "slot1" }, base));
const data = slot.data as string;
assert(typeof data === "string" && !data.includes("trace_data"), "export wrote the fake 'trace_data' stub string");

// Capture W's state (numbers copied out), then CORRUPT the shared SoA at those eids so a
// no-op import would be caught — import MUST write the real transforms back.
const wSnap = captureWorldState(W);
for (const e of wSnap.entities) W.transforms!.writePosition(e.eid, -777, -777, -777);

const F = makeWorld(ops);
const baseF = { ...base, world: F };
const imp = ok(await reg.invoke("save.import", { data }, baseF));
assert(imp.mode === "snapshot", "snapshot save must import in snapshot mode");
assert(imp.entities === wSnap.entities.length, `import reconstructed ${imp.entities} entities != ${wSnap.entities.length}`);

const fState = captureWorldState(F);
const cmp2 = compareWorldState(wSnap, fState);
assert(cmp2.identical, `save.import did not reconstruct the world into the fresh world: ${cmp2.detail}`);
const igs = imp.gameState as Record<string, unknown>;
assert(igs !== undefined && igs.score === 100, "save.import did not surface the embedded gameState");

// ===========================================================================
// 3. DETERMINISM — two exports at the same tick over the same state are byte-identical
// ===========================================================================
// Restore W to `before` so its state is stable across the two exports.
ok(await reg.invoke("checkpoint.load", { name: "cp1" }, base));
ok(await reg.invoke("save.export", { name: "d1", gameState: { a: 1 } }, base));
ok(await reg.invoke("save.export", { name: "d2", gameState: { a: 1 } }, base));
const d1 = ok(await reg.invoke("save.slot", { action: "load", name: "d1" }, base)).data as string;
const d2 = ok(await reg.invoke("save.slot", { action: "load", name: "d2" }, base)).data as string;
assert(d1 === d2, "two exports at the same tick over the same state are NOT byte-identical (Date.now regression)");

// A different tick changes the bytes (proves the tick is honestly in the output, not a constant).
const baseT5 = { ...base, tick: 5 };
ok(await reg.invoke("save.export", { name: "d3", gameState: { a: 1 } }, baseT5));
const d3 = ok(await reg.invoke("save.slot", { action: "load", name: "d3" }, base)).data as string;
assert(d3 !== d1, "export bytes did not change with the tick (tick not embedded)");

// ===========================================================================
// 4. LOG FACADE — export the durable command stream; import via replayCommands
// ===========================================================================
ops.op_physics_create_world(-9.81);
const recorder = new WorldRecorder("ses_p12_log");
const logReg = new SkillRegistry(new LiminaTracer("ses_p12_log"));
registerCoreSkills(logReg); // gives scene.createEntity etc.
// Re-register save WITH a recorder + replay factories (overrides core's save by name).
registerSaveSkills(logReg, {
  recorder,
  worldId: "p12save",
  replay: {
    makeWorld: () => makeWorld(ops),
    makeRegistry: (tr) => {
      const r = new SkillRegistry(tr as LiminaTracer);
      registerCoreSkills(r);
      return r;
    },
  },
});
recorder.attach(logReg);
const recOps = recorder.wrapOps(ops);
const logWorld = makeWorld(recOps);
const baseL = { agentId: "agt_log", sessionId: "ses_p12_log", permissions: BUILDER, tick: 0, world: logWorld };

recOps.op_physics_create_world(-9.81); // depth-0 physics op → recorded + replayed
ok(await logReg.invoke("scene.createEntity", { shape: "box", position: [0, 1, 0] }, baseL));
ok(await logReg.invoke("scene.createEntity", { shape: "sphere", position: [2, 1, 0] }, baseL));
const liveCount = logWorld.entities.ids().length;
assert(liveCount === 2, `expected 2 authored entities, got ${liveCount}`);

const expL = ok(await logReg.invoke("save.export", { name: "logslot" }, baseL));
assert(expL.mode === "log", "a recorder-wired export MUST use the log facade");
const dataL = ok(await logReg.invoke("save.slot", { action: "load", name: "logslot" }, baseL)).data as string;
assert(dataL.includes("limina.export") && dataL.includes("log.jsonl"), "log-facade save did not serialize a real export package");

const impL = ok(await logReg.invoke("save.import", { data: dataL }, baseL));
assert(impL.mode === "log", "log save must import in log mode");
assert((impL.commands as number) > 0, "log import surfaced no verified commands");
assert(impL.entities === liveCount, `replay reconstructed ${impL.entities} entities != authored ${liveCount} (the log facade did not re-run the authored skills)`);

ops.op_log(
  `p12_save OK: (1) checkpoint.create/load REAL round-trip — captured 3 entity transforms + gameState, mutated, and compareWorldState confirms a bit-identical restore. ` +
  `(2) save.export(snapshot)→save.import reconstructs the world into a FRESH world (after SoA corruption). ` +
  `(3) deterministic export — two exports at the same tick are byte-identical (Date.now removed; tick embedded). ` +
  `(4) log facade — export serializes the durable command stream into a real package; import loadExport-verifies + replayCommands re-runs the authored skills to reconstruct ${liveCount} entities.`,
);
