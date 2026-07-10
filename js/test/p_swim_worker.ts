import { SimWorkerController, type AuthorCommand } from "../src/browser/sim-worker.ts";
import {
  SIM_STATUS_BYTES,
  SIM_STATUS_FLAG_IN_WATER,
  SIM_STATUS_FLAG_SUBMERGED,
  SIM_STATUS_FLAG_SWIMMING,
  SIM_STATUS_FLAGS_INDEX,
  SIM_STATUS_GENERATION_INDEX,
  SIM_STATUS_INTS,
  SIM_STATUS_KNOWN_FLAGS,
  SIM_STATUS_LAYOUT_VERSION,
  SIM_STATUS_PLAYER_EID_INDEX,
  SIM_STATUS_TICK_INDEX,
  createSimStatusView,
  initializeSimStatus,
  readSimStatus,
  readSimStatusInto,
  writeSimStatus,
} from "../src/browser/sim-status.ts";
import type { RapierModule } from "../src/browser/wasm-rapier-physics.ts";
import type { CharacterWaterContact } from "../src/world/character.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_swim_worker FAIL: ${message}`);
}

// @ts-ignore -- native test loader needs the explicit package file.
const RAPIER = (await import("../node_modules/@dimforge/rapier3d-compat/rapier.mjs")) as unknown as RapierModule;

function read(controller: SimWorkerController) {
  return readSimStatus(createSimStatusView(controller.buffers.status));
}

async function create(commands: AuthorCommand[] = []): Promise<SimWorkerController> {
  const controller = await SimWorkerController.create({ rapier: RAPIER });
  await controller.loadWorld([
    { kind: "physics", op: "op_physics_create_world", args: [-9.81] },
    ...commands,
  ]);
  return controller;
}

function installContact(controller: SimWorkerController, contact: CharacterWaterContact, counter: { value: number }): void {
  (controller.core.water.contact as unknown as { query(x: number, z: number): CharacterWaterContact }).query = () => {
    counter.value++;
    return contact;
  };
}

assert(SIM_STATUS_LAYOUT_VERSION === 1, "unexpected status layout version");
assert(SIM_STATUS_INTS === 4 && SIM_STATUS_BYTES === 16, "status layout is not the compatible 16-byte buffer");
assert(SIM_STATUS_TICK_INDEX === 0 && SIM_STATUS_FLAGS_INDEX === 1 && SIM_STATUS_PLAYER_EID_INDEX === 2 && SIM_STATUS_GENERATION_INDEX === 3,
  "status slot assignments changed");
assert(SIM_STATUS_FLAG_IN_WATER === 1 && SIM_STATUS_FLAG_SWIMMING === 2 && SIM_STATUS_FLAG_SUBMERGED === 4,
  "water flag bit assignments changed");

// Pure seqlock contract: initialization, coherent writes, immutable reads, unknown-bit masking,
// thousands of generations, and bounded failure when a writer remains odd.
{
  const buffer = new SharedArrayBuffer(SIM_STATUS_BYTES);
  const view = createSimStatusView(buffer);
  initializeSimStatus(view);
  const initial = readSimStatus(view);
  assert(initial !== null && initial.tick === 0 && initial.playerEid === -1 && initial.flags === 0 && initial.generation === 0,
    "initial status was not no-player/tick-zero");
  assert(Object.isFrozen(initial), "reader snapshot is mutable");
  const scratch = { tick: -1, flags: -1, playerEid: -1, generation: -1, inWater: false, swimming: false, submerged: false };
  assert(readSimStatusInto(view, scratch) && scratch.tick === 0 && scratch.playerEid === -1,
    "allocation-free reader did not populate its caller-owned target");

  for (let attempt = 1; attempt <= 1_000; attempt++) {
    const oddGeneration = attempt * 2 - 1;
    Atomics.store(view, SIM_STATUS_GENERATION_INDEX, oddGeneration);
    Atomics.store(view, SIM_STATUS_TICK_INDEX, attempt);
    Atomics.store(view, SIM_STATUS_FLAGS_INDEX, SIM_STATUS_KNOWN_FLAGS);
    assert(readSimStatus(view, 2) === null, `reader accepted torn odd write ${attempt}`);
    Atomics.store(view, SIM_STATUS_PLAYER_EID_INDEX, attempt % 7);
    Atomics.store(view, SIM_STATUS_GENERATION_INDEX, oddGeneration + 1);
    const completed = readSimStatus(view, 2);
    assert(completed !== null && completed.tick === attempt && completed.playerEid === attempt % 7 && completed.submerged,
      `reader rejected completed torn-write fixture ${attempt}`);
  }

  for (let tick = 1; tick <= 5_000; tick++) {
    const flags = tick % 3 === 0 ? SIM_STATUS_FLAG_IN_WATER | SIM_STATUS_FLAG_SWIMMING : 0;
    writeSimStatus(view, { tick, flags, playerEid: tick % 11 });
    const snapshot = readSimStatus(view, 2);
    assert(snapshot !== null && snapshot.tick === tick && snapshot.flags === flags && snapshot.playerEid === tick % 11,
      `coherent read failed at torture tick ${tick}`);
    assert((snapshot.generation & 1) === 0, `reader returned odd generation ${snapshot.generation}`);
  }

  const stableGeneration = Atomics.load(view, SIM_STATUS_GENERATION_INDEX);
  Atomics.store(view, SIM_STATUS_GENERATION_INDEX, stableGeneration + 1);
  assert(readSimStatus(view, 3) === null, "bounded reader did not exhaust on a permanently odd generation");

  Atomics.store(view, SIM_STATUS_FLAGS_INDEX, SIM_STATUS_FLAG_IN_WATER | (1 << 20));
  Atomics.store(view, SIM_STATUS_GENERATION_INDEX, stableGeneration + 2);
  const unknown = readSimStatus(view);
  assert(unknown !== null && unknown.flags === SIM_STATUS_FLAG_IN_WATER && unknown.inWater && !unknown.swimming && !unknown.submerged,
    "reader exposed or misclassified unknown future flag bits");
  assert((unknown.flags & ~SIM_STATUS_KNOWN_FLAGS) === 0, "snapshot retained unknown flags");
}

// No player: every completed tick publishes no-player without changing the legacy slot-0 meaning.
{
  const controller = await create();
  const before = read(controller);
  assert(before !== null && before.tick === 0 && before.playerEid === -1 && before.flags === 0, "pre-tick no-player status invalid");
  controller.tick();
  const after = read(controller);
  assert(after !== null && after.tick === 1 && after.playerEid === -1 && after.flags === 0, "completed no-player tick did not clear status");
  const legacyTickView = new Int32Array(controller.buffers.status, 0, 1);
  assert(Atomics.load(legacyTickView, 0) === 1 && controller.ticks === 1, "legacy slot-0 tick reader changed");
  controller.dispose();
}

// Production worker composition: dry -> wading -> swimming -> submerged, with publication
// occurring after movement and transform sync at the same completed tick.
{
  const controller = await create([
    { kind: "skill", tool: "player.spawn", input: { position: [0, 0, 0] } },
  ]);
  const entity = controller.core.player.controllers.ids()[0];
  const tableEntry = controller.entities.resolve(entity);
  const player = controller.core.player.controllers.get(entity)?.controller;
  assert(tableEntry !== undefined && player !== undefined, "spawned worker player did not resolve");
  const contact: CharacterWaterContact = { wet: false, surfaceLevelM: null, columnDepthM: 0, bodyId: null, kind: null };
  const queries = { value: 0 };
  installContact(controller, contact, queries);

  controller.tick();
  let snapshot = read(controller);
  assert(snapshot !== null && snapshot.playerEid === tableEntry.eid && snapshot.flags === 0 && !snapshot.inWater,
    "dry player status incorrect");

  contact.wet = true;
  contact.surfaceLevelM = player.position[1];
  contact.columnDepthM = 0.5;
  contact.bodyId = "worker-lake";
  contact.kind = "lake";
  controller.tick();
  snapshot = read(controller);
  assert(snapshot !== null && snapshot.inWater && !snapshot.swimming && !snapshot.submerged && snapshot.flags === SIM_STATUS_FLAG_IN_WATER,
    "wading status bits incorrect");

  contact.surfaceLevelM = player.position[1];
  contact.columnDepthM = 20;
  controller.tick();
  snapshot = read(controller);
  assert(snapshot !== null && snapshot.inWater && snapshot.swimming && !snapshot.submerged,
    "swimming/non-submerged status bits incorrect");

  contact.surfaceLevelM = player.position[1] + 1;
  controller.tick();
  snapshot = read(controller);
  assert(snapshot !== null && snapshot.inWater && snapshot.swimming && snapshot.submerged,
    "submerged status bits incorrect");
  assert(snapshot.flags === (SIM_STATUS_FLAG_IN_WATER | SIM_STATUS_FLAG_SWIMMING | SIM_STATUS_FLAG_SUBMERGED),
    "submerged raw mask incorrect");
  assert(snapshot.tick === controller.ticks && snapshot.tick === 4, "status tick does not match completed worker tick");
  assert(Object.is(controller.transforms.Position.x[tableEntry.eid], player.position[0])
    && Object.is(controller.transforms.Position.y[tableEntry.eid], player.position[1])
    && Object.is(controller.transforms.Position.z[tableEntry.eid], player.position[2]),
  "status was not published alongside the synchronized player transform");
  assert(queries.value === 4, `worker queried contact ${queries.value} times for four fixed ticks`);

  await controller.loadWorld([{ kind: "skill", tool: "scene.destroyEntity", input: { entity } }]);
  controller.tick();
  snapshot = read(controller);
  assert(snapshot !== null && snapshot.tick === 5 && snapshot.playerEid === -1 && snapshot.flags === 0,
    "despawned player left stale status or was still driven");
  controller.dispose();
}

// Multiple controllers use the lowest LIVE eid, independent of registry order; destroying it
// deterministically promotes the next eid even though the controller registry retains a stale entry.
{
  const controller = await create([
    { kind: "skill", tool: "player.spawn", input: { position: [0, 1, 0] } },
    { kind: "skill", tool: "player.spawn", input: { position: [2, 1, 0] } },
  ]);
  const ids = controller.core.player.controllers.ids();
  const resolved = ids.map((id) => ({ id, eid: controller.entities.resolve(id)?.eid ?? Number.MAX_SAFE_INTEGER })).sort((a, b) => a.eid - b.eid);
  controller.tick();
  assert(read(controller)?.playerEid === resolved[0].eid, "worker did not select the lowest live player eid");
  await controller.loadWorld([{ kind: "skill", tool: "scene.destroyEntity", input: { entity: resolved[0].id } }]);
  controller.tick();
  assert(read(controller)?.playerEid === resolved[1].eid, "worker did not promote the next live player after despawn");
  controller.dispose();
}

// Status buffers are controller-owned: advancing one worker cannot mutate another worker's state.
{
  const a = await create();
  const b = await create();
  assert(a.buffers.status !== b.buffers.status, "two workers shared one status buffer");
  a.tick();
  a.tick();
  b.tick();
  assert(read(a)?.tick === 2 && read(b)?.tick === 1, "worker status buffers were not isolated");
  a.dispose();
  b.dispose();
}

console.log("p_swim_worker OK: 16-byte v1 status layout; bounded seqlock; legacy tick slot; water modes; post-sync tick coherence; deterministic live-player selection/despawn; isolated worker buffers.");
