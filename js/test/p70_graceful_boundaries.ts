// Phase A0 — GRACEFUL BOUNDARIES. One bad / out-of-band command must NEVER wedge the scene or the
// viewport. Layer-1 isolation already works (registry.ts `applyHandler` try/catch → {success:false};
// kernel/authoring.ts `applyAuthorCommands` loops without throwing). This gate proves the TWO
// live-viewport Layer-2 loops now match that contract, plus the editor's reboot quarantine.
//
// Runner: the native limina binary (`./target/release/limina js/test/p70_graceful_boundaries.ts`),
// exactly like p68/p11 — so the assertions exercise the REAL engine surfaces (native `ops`, the real
// SkillRegistry + registerCoreSkills, the shared `applyAuthorCommandsIsolated` the sim-worker
// `loadWorld` and `runLive` authoring loop both call, and the real `createWorkerHandshake` /
// `partitionQuarantined` the browser handshake + editor reboot use). NOT a reimplementation.
//
// Coverage boundary (honest): this is HEADLESS (no GPU / no real Worker). It drives the exact pure
// code paths the live loops delegate to. What it CANNOT cover: the WebGPU/forceWebGL render pipeline
// and a real cross-thread Worker handshake — those are browser-UAT. See the report caveat.

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { AssetRegistry } from "../src/asset-registry.ts";
// THE CODE UNDER TEST — imported from the SAME module the sim-worker, browser-entry, and editor
// viewport use. No copy.
import {
  applyAuthorCommandsIsolated,
  createWorkerHandshake,
  partitionQuarantined,
} from "../src/kernel/apply-isolated.ts";
import type { AuthorCommand } from "../src/kernel/authoring.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p70_graceful_boundaries: " + msg);
}

/** Reject if a promise does not settle within `ms` — turns a HANG (the original handshake bug) into a
 *  clean, falsifiable assertion instead of an infinite process hang. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms (HANG)`)), ms)),
  ]);
}

/** A headless WorldContext over the REAL native ops (mirrors p11_materials.makeWorld). */
function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs,
    transforms: createTransformStorage(ecs),
    spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(),
    tags: new Map(),
    scene,
    camera,
    ops: worldOps,
    mode: "headless",
  };
}

const BUILDER = resolveProfile("builder.readWrite");

// ============================================================================
// 1. ISOLATION — the per-command apply used by loadWorld + runLive continues past a bad command.
//    Several VALID scene.createEntity commands INTERLEAVED with two out-of-band commands:
//      • an UNKNOWN skill name          → registry returns {success:false, not_found}
//      • a physics op that DOES NOT EXIST → applyAuthorCommand throws; the isolator must CONTAIN it.
// ============================================================================
{
  const world = makeWorld(ops);
  const registry = new SkillRegistry(LiminaTracer.ephemeral("ses_p70"));
  registerCoreSkills(registry, { assets: new AssetRegistry(ops) });

  const mkBox = (x: number): AuthorCommand => ({
    kind: "skill",
    tool: "scene.createEntity",
    input: { shape: "box", material: "stone", position: [x, 1, 0] },
  });
  const batch: AuthorCommand[] = [
    mkBox(0),                                                          // 0 valid
    { kind: "skill", tool: "definitely.not.a.real.skill", input: {} }, // 1 BAD: unknown skill name
    mkBox(2),                                                          // 2 valid
    { kind: "physics", op: "op_physics_does_not_exist" as keyof EngineOps, args: [] }, // 3 BAD: throws
    mkBox(4),                                                          // 4 valid
  ];

  let outcome: Awaited<ReturnType<typeof applyAuthorCommandsIsolated>> | undefined;
  let threw = false;
  try {
    outcome = await applyAuthorCommandsIsolated(registry, world, batch, {
      sessionId: "ses_p70",
      defaultAgentId: "author",
      defaultPerms: BUILDER,
      tick: 0,
    });
  } catch {
    threw = true;
  }
  assert(!threw, "applyAuthorCommandsIsolated must NEVER throw, even with a command that throws internally");
  assert(outcome !== undefined, "isolated batch must return a result");

  // Every command has a 1:1 result, in order.
  assert(outcome.results.length === batch.length, `expected ${batch.length} results, got ${outcome.results.length}`);
  // Every VALID command applied.
  assert(outcome.results[0].success, "valid command #0 must apply despite a later bad command");
  assert(outcome.results[2].success, "valid command #2 must apply — it sits BETWEEN the two bad commands");
  assert(outcome.results[4].success, "valid command #4 must apply — the earlier bad commands must not skip it");
  // The bad commands failed — reported, not thrown.
  assert(!outcome.results[1].success, "unknown-skill command #1 must be reported as a failure");
  assert(!outcome.results[3].success, "unknown-physics-op command #3 must be CONTAINED as a failure (it throws)");
  // Structured failures carry the offending indices + labels.
  assert(outcome.failures.length === 2, `expected exactly 2 structured failures, got ${outcome.failures.length}`);
  assert(outcome.failures.map((f) => f.index).join(",") === "1,3", `failures must point at indices 1,3 (got ${outcome.failures.map((f) => f.index).join(",")})`);
  assert(outcome.failures[0].command === "skill:definitely.not.a.real.skill", `failure #0 label wrong: ${outcome.failures[0].command}`);
  assert(outcome.failures[1].command === "physics.op_physics_does_not_exist", `failure #1 label wrong: ${outcome.failures[1].command}`);
  // The world actually gained the 3 valid entities (no valid command was skipped because of a bad one).
  assert(world.entities.ids().length === 3, `expected 3 authored entities (the valid commands), got ${world.entities.ids().length}`);
}

// ============================================================================
// 2. HANDSHAKE — settles on {type:"error"} (the old bug HUNG forever), and on {type:"ready"}, and on
//    a hard fail(). A tick ack does NOT settle it.
// ============================================================================
{
  const hs = createWorkerHandshake<{ type: string }>();
  assert(hs.offer({ type: "tick", tick: 1 }) === false, "a tick ack must NOT settle the handshake");
  assert(hs.offer({ type: "error", phase: "init", message: "unknown asset id blight-gradient-99" }) === true, "an {type:error} message must settle the handshake");
  const r = await withTimeout(hs.promise, 1000, "handshake on {type:error}");
  assert(r.ok === false, "handshake must resolve ok:false on a worker {type:error} (NOT hang)");
  assert(!r.ok && r.error.includes("unknown asset id blight-gradient-99"), `handshake error must carry the worker message, got: ${!r.ok ? r.error : "<ok>"}`);
  assert(!r.ok && r.error.includes("init"), "handshake error must carry the phase");

  // Ready path still works.
  const hs2 = createWorkerHandshake<{ type: string; buffer: number }>();
  assert(hs2.offer({ type: "ready", buffer: 1, inputBuffer: 2, status: 3 }) === true, "a {type:ready} message must settle the handshake");
  const r2 = await withTimeout(hs2.promise, 1000, "handshake on {type:ready}");
  assert(r2.ok === true, "handshake must resolve ok:true on {type:ready}");
  assert(r2.ok && r2.ready.buffer === 1, "handshake must carry the ready payload through");

  // Hard fail (worker.onerror / spawn failure) also settles.
  const hs3 = createWorkerHandshake();
  hs3.fail("sim worker error: boom");
  const r3 = await withTimeout(hs3.promise, 1000, "handshake on fail()");
  assert(r3.ok === false && r3.error.includes("boom"), "fail() must settle the handshake with the reason");

  // Idempotent: only the first settle wins.
  const hs4 = createWorkerHandshake<{ type: string }>();
  hs4.offer({ type: "error", phase: "init", message: "first" });
  hs4.offer({ type: "ready" });
  const r4 = await withTimeout(hs4.promise, 1000, "handshake idempotency");
  assert(r4.ok === false && r4.error.includes("first"), "only the FIRST settle may win (idempotent)");
}

// ============================================================================
// 3. QUARANTINE — the editor reboot skip logic drops a KNOWN-BAD command on the second authoring pass.
//    (Unit-tests the SAME partitionQuarantined viewport.js imports from the runtime bundle.)
// ============================================================================
{
  const good0: AuthorCommand = { kind: "skill", tool: "scene.createEntity", input: { shape: "box", position: [0, 1, 0] } };
  const bad: AuthorCommand = { kind: "skill", tool: "asset.place", input: { assetId: "does-not-exist" } };
  const good2: AuthorCommand = { kind: "skill", tool: "scene.createEntity", input: { shape: "box", position: [2, 1, 0] } };
  const authorCmds: AuthorCommand[] = [good0, bad, good2];

  // First pass: nothing quarantined — everything is replayed.
  const pass1 = partitionQuarantined(authorCmds, new Set<number>());
  assert(pass1.kept.length === 3, "first pass must replay all 3 commands");
  assert(pass1.keptIndex.join(",") === "0,1,2", "first-pass keptIndex must be identity");

  // runLive reports a failure at kept-index 1 → map back to its authorCmds index and quarantine it.
  const failedKeptIndex = 1;
  const quarantined = new Set<number>([pass1.keptIndex[failedKeptIndex]]);
  assert(quarantined.has(1), "the bad command's original index (1) must be quarantined");

  // Second pass: the known-bad command is SKIPPED.
  const pass2 = partitionQuarantined(authorCmds, quarantined);
  assert(pass2.kept.length === 2, "second pass must skip the quarantined command");
  assert(!pass2.kept.includes(bad), "the known-bad command must NOT be replayed on the second pass");
  assert(pass2.kept[0] === good0 && pass2.kept[1] === good2, "the two good commands must remain, in order");
  assert(pass2.keptIndex.join(",") === "0,2", "second-pass keptIndex must map the kept commands back to their original indices (0,2)");
}

ops.op_log(
  "[js] p70_graceful_boundaries OK: (1) the shared isolated applier used by sim-worker loadWorld + runLive applies every VALID command and CONTAINS both an unknown skill and a throwing physics op as structured failures (never throws; 3/3 entities authored); (2) createWorkerHandshake settles on {type:error} (no hang), on {type:ready}, and on fail() — idempotently; (3) partitionQuarantined skips a known-bad command on the second authoring pass, mapping kept commands back to their original indices.",
);
