import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import type { WorldContext } from "../src/skills/registry.ts";
import { CharacterController, type CharacterWaterContact, type CharacterWaterContactProvider, type MoveCommand } from "../src/world/character.ts";
import { installSeededRandom } from "../src/worldlog/log.ts";
import {
  SNAPSHOT_VERSION,
  captureWorldSnapshot,
  parseSnapshot,
  restoreSnapshot,
  serializeSnapshot,
} from "../src/worldlog/snapshot.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_swim_snapshot FAIL: ${message}`);
}

function makeWorld(): WorldContext {
  const ecs = createEcsWorld();
  return {
    ecs,
    transforms: createTransformStorage(ecs),
    spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(),
    tags: new Map(),
    scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} },
    ops,
    mode: "headless",
  };
}

class MutableWater implements CharacterWaterContactProvider {
  readonly contact: CharacterWaterContact = {
    wet: true,
    surfaceLevelM: 1.5,
    columnDepthM: 20,
    bodyId: "snapshot-lake",
    kind: "lake",
  };
  queries = 0;
  query(): CharacterWaterContact { this.queries++; return this.contact; }
}

const DT = 1 / 60;
const STILL: MoveCommand = { forward: 0, strafe: 0, yaw: 0, run: false, jump: false };
const CONTINUATION_STEPS = 30;

function continueSwimming(controller: CharacterController): number[] {
  const trajectory: number[] = [];
  for (let tick = 0; tick < CONTINUATION_STEPS; tick++) {
    controller.step(STILL, DT);
    ops.op_physics_step();
    const p = controller.position;
    const state = controller.serializeState();
    trajectory.push(p[0], p[1], p[2], state.vy, state.grounded ? 1 : 0, state.swimming ? 1 : 0);
  }
  return trajectory;
}

function assertExact(a: readonly number[], b: readonly number[], label: string): void {
  assert(a.length === b.length, `${label}: length differs`);
  for (let i = 0; i < a.length; i++) {
    assert(Object.is(a[i], b[i]), `${label}: index ${i} differs (${a[i]} vs ${b[i]})`);
  }
}

installSeededRandom(0x5a1f00d);
ops.op_physics_create_world(-9.81);
const world = makeWorld();
const water = new MutableWater();
const controller = new CharacterController(ops, [0, 0, 0], {
  halfHeight: 0.6,
  radius: 0.3,
  waterContact: water,
});
ops.op_physics_step();

// Enter swimming, then move the contact to the hysteresis-only band: a restored
// `swimming:true` remains swimming, while a corrupted/default-false state cannot enter.
for (let tick = 0; tick < 8; tick++) {
  controller.step(STILL, DT);
  ops.op_physics_step();
}
assert(controller.isSwimming, "setup did not enter swimming");
const centerAtSnapshot = controller.position[1];
const groundOffset = controller.groundOffset;
water.contact.surfaceLevelM = centerAtSnapshot - groundOffset + 0.42 * (2 * groundOffset);

const snapshot = captureWorldSnapshot(world, {
  sessionId: "ses_swim_snapshot",
  tick: 8,
  snapshotSeq: 0,
  characters: [controller],
});
assert(snapshot.snapshotVersion === SNAPSHOT_VERSION && SNAPSHOT_VERSION === 3, "swimming changed the snapshot schema version");
assert(snapshot.characters.length === 1 && snapshot.characters[0].swimming, "snapshot did not capture swim hysteresis state");
assert(Object.keys(snapshot.characters[0]).sort().join(",") === "bodyId,grounded,heading,swimming,vy",
  "snapshot persisted derived water contact/submersion data");
const snapshotJson = serializeSnapshot(snapshot);

const reference = continueSwimming(controller);

const parsed = parseSnapshot(snapshotJson);
const queriesBeforeRestore = water.queries;
restoreSnapshot(world, parsed, [controller]);
assert(controller.isSwimming, "restore lost captured swim mode");
assert(controller.waterState.surfaceLevelM === null && !controller.isSubmerged,
  "restore retained derived contact/submersion instead of clearing it");
controller.step(STILL, DT);
ops.op_physics_step();
assert(water.queries === queriesBeforeRestore + 1 && controller.waterState.surfaceLevelM === water.contact.surfaceLevelM,
  "first restored fixed step did not re-derive contact exactly once");

// Restore a second time before the full comparison because the re-derivation assertion advanced one step.
restoreSnapshot(world, parsed, [controller]);
const restored = continueSwimming(controller);
assertExact(reference, restored, "mid-swim continuation");

// Falsify load-bearing state: in the 0.42 hysteresis band, false cannot enter at the 0.50 threshold.
const corrupt = parseSnapshot(snapshotJson);
corrupt.characters[0].swimming = false;
restoreSnapshot(world, corrupt, [controller]);
const corrupted = continueSwimming(controller);
let diverged = false;
for (let i = 0; i < reference.length; i++) {
  if (!Object.is(reference[i], corrupted[i])) { diverged = true; break; }
}
assert(diverged, "corrupting swimming did not alter hysteresis-band continuation");

// Old schema-v3 documents omitted this additive field. They must still parse as dry.
const oldV3 = JSON.parse(snapshotJson) as { snapshotVersion: number; characters: Array<Record<string, unknown>> };
delete oldV3.characters[0].swimming;
const parsedOldV3 = parseSnapshot(JSON.stringify(oldV3));
assert(parsedOldV3.snapshotVersion === 3 && parsedOldV3.characters[0].swimming === false,
  "legacy schema-v3 snapshot did not default swimming to false");
restoreSnapshot(world, parsedOldV3, [controller]);
assert(!controller.isSwimming, "legacy schema-v3 restore did not resume in dry mode");

ops.op_log("[js] p_swim_snapshot OK: schema-v3 additive swimming state; legacy-v3 default false; derived contact reset/re-query; bit-identical mid-swim restore; corrupted hysteresis state diverges.");
