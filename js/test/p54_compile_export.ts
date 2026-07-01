// P54 -- GDS world-slice COMPILE -> runnable export bundle (headless, deterministic).
//
// compileWorldToExport authors a GDS `world` slice into a recorder-backed world and assembles the
// portable 5-file export the browser plays back. This proves the "Compile" verb end to end for the
// static-designed-world case: the bundle loadExport-round-trips, and REPLAYING its command stream
// into a FRESH engine reproduces the designed world BIT-IDENTICALLY (compareWorldState) -- i.e. the
// bundle is genuinely runnable, not just well-formed. The browser "Run" tier (packRelease +
// engine-browser-gate, chromium) sits on top of this and is gated separately.
//
// Run: limina js/test/p54_compile_export.ts   (exit 0 = pass)

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { validateGDS } from "../src/game/gds.ts";
import { compileWorldToExport } from "../src/game/world-compile.ts";
import { loadExport } from "../src/export/package.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { compareWorldState } from "../src/worldlog/log.ts";

// Warm THREE's rng before any seeded run: this process both RECORDS (compile) and REPLAYS in-process,
// so first-mesh lazy-init must not consume the seeded rng on the record pass only.
void new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));
void new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));

let pass = 0;
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p54_compile_export: " + msg);
  pass++;
}
function makeWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: ops as EngineOps, mode: "headless",
  };
}

// A props-only world slice (scene.createEntity + residual transform + material) so the compiled world
// has NO physics bodies — the bit-identity check is over pure, fully-deterministic ECS transforms.
const spec = validateGDS({
  id: "p54_world",
  pitch: "test world-slice compile+export",
  loopSentence: "move · reach · avoid · score · fall · retry",
  controls: { scheme: "keyboard-mouse", intents: [{ name: "move-forward", binding: "KeyW" }] },
  winCondition: "reach the goal",
  loseCondition: "fall",
  artDirection: "grounded stylized",
  targetPlatforms: ["web"],
  scopeTier: "prototype",
  optIn: "record+export",
  entities: [
    { id: "player", name: "Warden", role: "player" },
    { id: "prop_rock", name: "Rock", role: "prop" },
    { id: "prop_crate", name: "Crate", role: "prop" },
  ],
  content: [],
  world: {
    placements: [
      { id: "pa", entity: "prop_rock", transform: { position: [4, 0, 4], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] }, material: { roughness: 0.5 } },
      { id: "pb", entity: "prop_crate", transform: { position: [-3, 0, 2], scale: [1.5, 1.5, 1.5] } },
    ],
  },
  dod: [{
    id: "d1", statement: "moving forward reaches the goal", kind: "state-transition",
    drives: { steps: [{ forward: 1, repeat: 10 }], assert: [{ check: "gameState", value: "won" }] },
  }],
});
assert(spec.ok && spec.data !== undefined, `spec must validate: ${JSON.stringify(spec.issues)}`);

// ---- compile the world slice into an export bundle ---------------------------------------------
const compiled = await compileWorldToExport(spec.data!, { worldId: "p54", seed: 0x54 });
ops.op_log(`p54: placed=${compiled.result.placed} commands=${compiled.commandCount} failures=${JSON.stringify(compiled.result.failures)}`);
assert(compiled.result.placed === 2, `both props must place (got ${compiled.result.placed})`);
assert(compiled.result.failures.length === 0, `no compile failures (got ${JSON.stringify(compiled.result.failures)})`);

// ---- A. the bundle is a well-formed export that round-trips through loadExport ------------------
const loaded = loadExport(compiled.files); // throws on a bad/torn bundle — reaching here = valid
assert(loaded.commands.length === compiled.commandCount, `A: loadExport preserves the command count (${loaded.commands.length} vs ${compiled.commandCount})`);
assert(loaded.manifest.worldId === "p54", "A: manifest carries the world id");

// ---- B. RUNNABLE: replaying the bundle into a FRESH engine reproduces the world bit-identically --
const replay = await replayCommands(loaded.commands, {
  makeRegistry: (t) => { const r = new SkillRegistry(t); registerCoreSkills(r); return r; },
  makeWorld,
});
const cmp = compareWorldState(compiled.recordedState, replay.state);
assert(cmp.identical, `B: replay of the compiled bundle must reproduce the world BIT-IDENTICALLY (${cmp.comparisons} fields: ${cmp.detail ?? "?"})`);
assert(replay.state.entities.length === 2, `B: the replayed world has both props (got ${replay.state.entities.length})`);

ops.op_log(
  `p54_compile_export OK: ${pass} assertions -- a GDS world slice compiles to a portable export ` +
    `bundle that loadExport round-trips (${loaded.commands.length} commands) and replays BIT-IDENTICALLY ` +
    `into a fresh engine (${cmp.comparisons} fields, ${replay.state.entities.length} entities).`,
);
