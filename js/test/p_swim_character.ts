import { EntityTable, ops, type PhysicsOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import {
  CharacterController,
  MAX_BUOYANCY_GAIN_PER_S2,
  MAX_SWIM_SPEED_MPS,
  MAX_SWIM_VERTICAL_SPEED_MPS,
  MAX_WATER_DRAG_PER_S,
  PLAYER_EYE_OFFSET_M,
  SWIM_ENTER_COLUMN_DEPTH_M,
  SWIM_ENTER_IMMERSION_RATIO,
  SWIM_EXIT_COLUMN_DEPTH_M,
  SWIM_EXIT_IMMERSION_RATIO,
  SWIM_SUBMERGED_EPSILON_M,
  type CharacterWaterContact,
  type CharacterWaterContactProvider,
  type MoveCommand,
} from "../src/world/character.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_swim_character FAIL: ${message}`);
}

function throws(fn: () => unknown, pattern: RegExp, message: string): void {
  let caught: unknown;
  try { fn(); } catch (error) { caught = error; }
  assert(caught instanceof Error && pattern.test(caught.message), `${message}: ${caught instanceof Error ? caught.message : "did not throw"}`);
}

interface FakeBody {
  p: [number, number, number];
  groundOffset: number;
}

class FakeCharacterPhysics {
  private nextId = 1;
  private readonly bodies = new Map<number, FakeBody>();

  constructor(private readonly floorY: number | null = null) {}

  op_physics_add_character(x: number, y: number, z: number, halfHeight: number, radius: number): number {
    const id = this.nextId++;
    this.bodies.set(id, { p: [x, y, z], groundOffset: halfHeight + radius });
    return id;
  }

  op_physics_move_character(id: number, dx: number, dy: number, dz: number, out: Float32Array): void {
    const body = this.body(id);
    let y = body.p[1] + dy;
    let grounded = false;
    if (this.floorY !== null && y <= this.floorY + body.groundOffset) {
      y = this.floorY + body.groundOffset;
      grounded = true;
    }
    out[0] = body.p[0] + dx;
    out[1] = y;
    out[2] = body.p[2] + dz;
    out[3] = grounded ? 1 : 0;
    body.p[0] = out[0];
    body.p[1] = out[1];
    body.p[2] = out[2];
  }

  op_physics_body_pos(id: number, out: Float32Array): void {
    const body = this.body(id);
    out[0] = body.p[0]; out[1] = body.p[1]; out[2] = body.p[2];
  }

  op_physics_remove_body(id: number): void { this.bodies.delete(id); }

  asOps(): PhysicsOps { return this as unknown as PhysicsOps; }

  private body(id: number): FakeBody {
    const body = this.bodies.get(id);
    if (body === undefined) throw new Error(`unknown fake body ${id}`);
    return body;
  }
}

class MutableWater implements CharacterWaterContactProvider {
  readonly contact: CharacterWaterContact = {
    wet: false,
    surfaceLevelM: null,
    columnDepthM: 0,
    bodyId: null,
    kind: null,
  };
  queries = 0;

  query(): CharacterWaterContact {
    this.queries++;
    return this.contact;
  }

  dry(): void {
    this.contact.wet = false;
    this.contact.surfaceLevelM = null;
    this.contact.columnDepthM = 0;
    this.contact.bodyId = null;
    this.contact.kind = null;
  }

  wet(surfaceLevelM: number, columnDepthM: number): void {
    this.contact.wet = true;
    this.contact.surfaceLevelM = surfaceLevelM;
    this.contact.columnDepthM = columnDepthM;
    this.contact.bodyId = "lake-test";
    this.contact.kind = "lake";
  }
}

const DT = 1 / 60;
const HALF_HEIGHT = 0.6;
const RADIUS = 0.3;
const OFFSET = HALF_HEIGHT + RADIUS;
const STILL: MoveCommand = { forward: 0, strafe: 0, yaw: 0, run: false, jump: false };
const JUMP: MoveCommand = { ...STILL, jump: true };

function surfaceForImmersion(centerY: number, ratio: number): number {
  return centerY - OFFSET + ratio * 2 * OFFSET;
}

function sameControllerState(a: CharacterController, b: CharacterController, label: string): void {
  const ap = a.position;
  const bp = b.position;
  for (let axis = 0; axis < 3; axis++) {
    assert(Object.is(ap[axis], bp[axis]), `${label}: position axis ${axis} differs (${ap[axis]} vs ${bp[axis]})`);
  }
  const as = a.serializeState();
  const bs = b.serializeState();
  assert(Object.is(as.vy, bs.vy) && as.grounded === bs.grounded && Object.is(as.heading, bs.heading) && as.swimming === bs.swimming,
    `${label}: serialized states differ`);
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

// Constructor-level validation protects direct callers; the player schema protects skill callers.
for (const [name, value] of [
  ["swimSpeed", 0],
  ["swimSpeed", MAX_SWIM_SPEED_MPS + 1],
  ["buoyancyGain", Number.NaN],
  ["buoyancyGain", MAX_BUOYANCY_GAIN_PER_S2 + 1],
  ["waterDrag", Infinity],
  ["waterDrag", MAX_WATER_DRAG_PER_S + 1],
  ["maxSwimVerticalSpeed", -1],
  ["maxSwimVerticalSpeed", MAX_SWIM_VERTICAL_SPEED_MPS + 1],
] as const) {
  throws(() => new CharacterController(new FakeCharacterPhysics().asOps(), [0, 0, 0], { [name]: value }), /finite and in/, `${name} accepted ${value}`);
}

// A configured provider returning dry must remain bit-identical to the no-provider legacy path.
{
  const physicsA = new FakeCharacterPhysics(0);
  const physicsB = new FakeCharacterPhysics(0);
  const dry = new MutableWater();
  const legacy = new CharacterController(physicsA.asOps(), [0, OFFSET, 0], { halfHeight: HALF_HEIGHT, radius: RADIUS });
  const injected = new CharacterController(physicsB.asOps(), [0, OFFSET, 0], { halfHeight: HALF_HEIGHT, radius: RADIUS, waterContact: dry });
  for (let tick = 0; tick < 360; tick++) {
    const command: MoveCommand = {
      forward: tick % 17 < 11 ? 1 : -0.25,
      strafe: tick % 23 < 7 ? 0.8 : -0.4,
      yaw: (tick % 31) * 0.07,
      run: tick % 5 === 0,
      jump: tick === 20 || tick === 180,
    };
    legacy.step(command, DT);
    injected.step(command, DT);
    sameControllerState(legacy, injected, `dry compatibility tick ${tick}`);
  }
  assert(dry.queries === 360, `dry provider queried ${dry.queries} times instead of once per step`);
}

// Named enter/exit boundaries are inclusive, with a lower exit hysteresis band.
{
  const water = new MutableWater();
  const controller = new CharacterController(new FakeCharacterPhysics().asOps(), [0, 0, 0], {
    halfHeight: HALF_HEIGHT, radius: RADIUS, waterContact: water,
  });
  water.wet(surfaceForImmersion(controller.position[1], SWIM_ENTER_IMMERSION_RATIO), SWIM_ENTER_COLUMN_DEPTH_M);
  controller.step(STILL, DT);
  assert(controller.isSwimming && !controller.isGrounded, "exact enter thresholds did not enter swimming");

  water.wet(surfaceForImmersion(controller.position[1], SWIM_EXIT_IMMERSION_RATIO), SWIM_EXIT_COLUMN_DEPTH_M);
  controller.step(STILL, DT);
  assert(controller.isSwimming, "exact exit thresholds did not retain swimming");

  water.wet(surfaceForImmersion(controller.position[1], SWIM_EXIT_IMMERSION_RATIO - 1e-6), SWIM_EXIT_COLUMN_DEPTH_M);
  controller.step(STILL, DT);
  assert(!controller.isSwimming && controller.waterState.mode === "wading", "crossing the lower immersion exit threshold did not leave swimming");

  water.wet(surfaceForImmersion(controller.position[1], SWIM_ENTER_IMMERSION_RATIO), SWIM_ENTER_COLUMN_DEPTH_M);
  controller.step(STILL, DT);
  assert(controller.isSwimming, "controller did not re-enter at the exact enter thresholds");
  water.wet(surfaceForImmersion(controller.position[1], 0.9), SWIM_EXIT_COLUMN_DEPTH_M - 1e-6);
  controller.step(STILL, DT);
  assert(!controller.isSwimming && controller.waterState.mode === "wading", "crossing the lower depth exit threshold did not leave swimming");
}

// Shallow water remains wading and preserves the legacy ground-motion path.
{
  const dry = new MutableWater();
  const shallow = new MutableWater();
  shallow.wet(surfaceForImmersion(OFFSET, 0.9), SWIM_ENTER_COLUMN_DEPTH_M - 1e-6);
  const dryController = new CharacterController(new FakeCharacterPhysics(0).asOps(), [0, OFFSET, 0], { halfHeight: HALF_HEIGHT, radius: RADIUS, waterContact: dry });
  const wader = new CharacterController(new FakeCharacterPhysics(0).asOps(), [0, OFFSET, 0], { halfHeight: HALF_HEIGHT, radius: RADIUS, waterContact: shallow });
  const command: MoveCommand = { forward: 1, strafe: 0.5, yaw: 0.3, run: true, jump: false };
  dryController.step(command, DT);
  wader.step(command, DT);
  sameControllerState(dryController, wader, "shallow wading legacy motion");
  assert(wader.waterState.mode === "wading", "shallow water was not observable as wading");
}

// Stable water must query once per fixed step and must not chatter over a long idle run.
{
  const water = new MutableWater();
  water.wet(1, 20);
  const controller = new CharacterController(new FakeCharacterPhysics().asOps(), [0, 0, 0], {
    halfHeight: HALF_HEIGHT, radius: RADIUS, waterContact: water,
  });
  for (let tick = 0; tick < 1_000; tick++) {
    controller.step(STILL, DT);
    assert(controller.isSwimming, `stable water exited swimming at tick ${tick}`);
    assert(Math.abs(controller.serializeState().vy) <= 4, `vertical speed escaped clamp at tick ${tick}`);
  }
  assert(water.queries === 1_000, `contact queried ${water.queries} times for 1000 steps`);
  assert(Math.abs(controller.position[1] - (1 - HALF_HEIGHT)) < 1e-4, `idle buoyancy did not converge to float target: y=${controller.position[1]}`);
}

// Diagonal input is normalized to swimSpeed, and Shift/run cannot change swim motion.
{
  const waterA = new MutableWater(); waterA.wet(1, 20);
  const waterB = new MutableWater(); waterB.wet(1, 20);
  const walk = new CharacterController(new FakeCharacterPhysics().asOps(), [0, 0, 0], { halfHeight: HALF_HEIGHT, radius: RADIUS, waterContact: waterA, swimSpeed: 3 });
  const sprint = new CharacterController(new FakeCharacterPhysics().asOps(), [0, 0, 0], { halfHeight: HALF_HEIGHT, radius: RADIUS, waterContact: waterB, swimSpeed: 3 });
  const command = { forward: 1, strafe: 1, yaw: 0.27, jump: false };
  walk.step({ ...command, run: false }, DT);
  sprint.step({ ...command, run: true }, DT);
  sameControllerState(walk, sprint, "swim sprint suppression");
  const distance = Math.sqrt(walk.position[0] ** 2 + walk.position[2] ** 2);
  assert(Math.abs(distance - 3 * DT) < 1e-7, `diagonal swim speed exceeded cap: ${distance / DT} m/s`);
}

// Zero input still floats, while Space supplies a bounded upward surface acceleration.
{
  const idleWater = new MutableWater(); idleWater.wet(1, 20);
  const jumpWater = new MutableWater(); jumpWater.wet(1, 20);
  const idle = new CharacterController(new FakeCharacterPhysics().asOps(), [0, -1, 0], { halfHeight: HALF_HEIGHT, radius: RADIUS, waterContact: idleWater });
  const surfacing = new CharacterController(new FakeCharacterPhysics().asOps(), [0, -1, 0], { halfHeight: HALF_HEIGHT, radius: RADIUS, waterContact: jumpWater });
  for (let tick = 0; tick < 120; tick++) {
    idle.step(STILL, DT);
    surfacing.step(JUMP, DT);
  }
  assert(idle.position[1] > -0.5, `zero-input swimmer did not float: y=${idle.position[1]}`);
  assert(surfacing.position[1] > idle.position[1] + 0.2, "Space did not accelerate the swimmer upward");
  assert(Math.abs(surfacing.serializeState().vy) <= 4, "Space escaped the vertical speed clamp");
}

// Entering at terminal fall speed clamps immediately; leaving water resumes gravity for either vy sign.
{
  const water = new MutableWater();
  const controller = new CharacterController(new FakeCharacterPhysics().asOps(), [0, 20, 0], {
    halfHeight: HALF_HEIGHT, radius: RADIUS, waterContact: water, maxSwimVerticalSpeed: 3,
  });
  for (let tick = 0; tick < 180; tick++) controller.step(STILL, DT);
  assert(Object.is(controller.serializeState().vy, -40), `dry fall did not reach terminal velocity: ${controller.serializeState().vy}`);
  water.wet(surfaceForImmersion(controller.position[1], 1), 20);
  controller.step(STILL, DT);
  assert(controller.isSwimming && Math.abs(controller.serializeState().vy) <= 3, "water entry did not bound inherited terminal velocity");

  for (const initialVy of [-2, 2]) {
    controller.restoreState({ vy: initialVy, grounded: false, heading: 0, swimming: true });
    water.dry();
    controller.step(STILL, DT);
    assert(!controller.isSwimming, `dry transition retained swimming for vy=${initialVy}`);
    assert(Object.is(controller.serializeState().vy, initialVy - 22 * DT), `gravity did not resume exactly for vy=${initialVy}`);
    assert(Math.abs(controller.serializeState().vy) <= 40, `shore exit produced unbounded vy=${controller.serializeState().vy}`);
  }
}

// Submersion uses the shared eye offset and epsilon, including the exact boundary.
{
  const waterA = new MutableWater(); waterA.wet(1, 20);
  const submergedY = 1 - SWIM_SUBMERGED_EPSILON_M - PLAYER_EYE_OFFSET_M - 0.1;
  const submerged = new CharacterController(new FakeCharacterPhysics().asOps(), [0, submergedY, 0], { halfHeight: HALF_HEIGHT, radius: RADIUS, waterContact: waterA });
  submerged.step(STILL, DT);
  assert(submerged.isSubmerged, "eye below the surface epsilon was not submerged");

  const waterB = new MutableWater(); waterB.wet(1, 20);
  const boundaryY = 1 - SWIM_SUBMERGED_EPSILON_M - PLAYER_EYE_OFFSET_M;
  const boundary = new CharacterController(new FakeCharacterPhysics().asOps(), [0, boundaryY, 0], { halfHeight: HALF_HEIGHT, radius: RADIUS, waterContact: waterB, buoyancyGain: Number.MIN_VALUE });
  boundary.step(STILL, Number.MIN_VALUE);
  assert(!boundary.isSubmerged, "exact eye epsilon boundary was classified submerged");
}

// Invalid provider values fail loudly instead of poisoning deterministic state with NaN.
{
  const bad = new MutableWater(); bad.wet(Number.NaN, 1);
  const controller = new CharacterController(new FakeCharacterPhysics().asOps(), [0, 0, 0], { waterContact: bad });
  throws(() => controller.step(STILL, DT), /invalid finite depth\/surface/, "NaN water surface was accepted");
  bad.wet(1, -1);
  throws(() => controller.step(STILL, DT), /invalid finite depth\/surface/, "negative water depth was accepted");
}

// Two independent controllers under the same scripted contact/input stream stay byte-identical.
{
  const waterA = new MutableWater(); waterA.wet(1.5, 12);
  const waterB = new MutableWater(); waterB.wet(1.5, 12);
  const a = new CharacterController(new FakeCharacterPhysics().asOps(), [0, 0, 0], { waterContact: waterA });
  const b = new CharacterController(new FakeCharacterPhysics().asOps(), [0, 0, 0], { waterContact: waterB });
  for (let tick = 0; tick < 600; tick++) {
    const command: MoveCommand = {
      forward: ((tick * 17) % 21 - 10) / 10,
      strafe: ((tick * 13) % 19 - 9) / 9,
      yaw: (tick % 37) * 0.11,
      run: tick % 2 === 0,
      jump: tick % 43 < 5,
    };
    a.step(command, DT);
    b.step(command, DT);
    sameControllerState(a, b, `determinism tick ${tick}`);
    assert(a.isSubmerged === b.isSubmerged && a.waterState.mode === b.waterState.mode, `water state diverged at tick ${tick}`);
  }
}

// The production CoreSkills composition injects its shared provider into player.spawn;
// skill schemas reject bad tunables and movement outputs expose the water state.
{
  ops.op_physics_create_world(-9.81);
  const registry = new SkillRegistry(new LiminaTracer("ses_swim_player_contract"));
  const core = registerCoreSkills(registry);
  let coreQueries = 0;
  (core.water.contact as unknown as { query(x: number, z: number): CharacterWaterContact }).query = () => {
    coreQueries++;
    return { wet: true, surfaceLevelM: 1.5, columnDepthM: 20, bodyId: "core-lake", kind: "lake" };
  };
  const context = {
    agentId: "agt_swim",
    sessionId: "ses_swim_player_contract",
    permissions: resolveProfile("builder.readWrite"),
    tick: 0,
    world: makeWorld(),
  };
  const invalid = await registry.invoke("player.spawn", { position: [0, 0, 0], swimSpeed: 0 }, context);
  assert(!invalid.success, "player.spawn schema accepted zero swimSpeed");
  const excessive = await registry.invoke("player.spawn", { position: [0, 0, 0], buoyancyGain: MAX_BUOYANCY_GAIN_PER_S2 + 1 }, context);
  assert(!excessive.success, "player.spawn schema accepted excessive buoyancyGain");

  const spawned = await registry.invoke("player.spawn", { position: [0, 0, 0] }, context);
  assert(spawned.success, `core player.spawn failed: ${spawned.success ? "" : spawned.error?.message}`);
  const spawnResult = spawned.result as Record<string, unknown>;
  assert(spawnResult.swimming === false && spawnResult.waterMode === "dry", "spawn output did not expose initial water state");
  const entity = spawnResult.entity as string;

  const moved = await registry.invoke("player.move", { entity, forward: 1, strafe: 1, run: true }, context);
  assert(moved.success, `core player.move failed: ${moved.success ? "" : moved.error?.message}`);
  const moveResult = moved.result as Record<string, unknown>;
  assert(moveResult.swimming === true && moveResult.submerged === true && moveResult.waterMode === "swimming" && moveResult.grounded === false,
    `player.move water output was incomplete: ${JSON.stringify(moveResult)}`);
  assert(coreQueries === 1, `CoreSkills provider queried ${coreQueries} times for one player.move`);

  const jumped = await registry.invoke("player.jump", { entity }, context);
  assert(jumped.success, `core player.jump failed: ${jumped.success ? "" : jumped.error?.message}`);
  const jumpResult = jumped.result as Record<string, unknown>;
  assert(jumpResult.jumped === false && jumpResult.swimming === true && jumpResult.waterMode === "swimming",
    "player.jump reported a ground jump or hid swim state while surfacing");
  assert(coreQueries === 2, `CoreSkills provider queried ${coreQueries} times for two fixed steps`);
}

ops.op_log("[js] p_swim_character OK: legacy dry/wading parity; deterministic enter/exit hysteresis; one query/step; stable buoyancy; sprint suppression; bounded surface/shore transitions; eye submersion; validation; twin-run determinism.");
