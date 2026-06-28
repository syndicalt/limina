// Phase 12 — the camera.* skill seam (camera.ts).
//
// Proves the closure-wired camera skills actually DRIVE a real CameraManager (not the old
// never-set ctx.world.cameraManager no-op) and that the manager's update(dt, world) pump
// applies the active rig to the engine camera with DETERMINISTIC, reproducible math:
//
//   - camera.follow / thirdPerson: orbit rig (REUSES ThirdPersonCamera) frames a followed
//     entity — the engine camera lands at the expected orbit position + look-at.
//   - camera.firstPerson: head position + look direction from camera.look (yaw/pitch).
//   - camera.topDown: configurable angle/zoom above the target.
//   - camera.setFOV: applied to the engine camera on the next update.
//   - camera.cut: instant position + look-at.
//   - camera.shake: a dt-driven envelope that DECAYS TO ZERO over its duration.
//   - DETERMINISM: two identical update sequences produce identical camera transforms.
//
// Run: limina js/test/p12_camera.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { ThirdPersonCamera } from "../src/world/third_person_camera.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_camera FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}
const EPS = 1e-5;
function close(a: number, b: number, msg: string): void {
  assert(Math.abs(a - b) <= EPS, `${msg}: expected ${b}, got ${a}`);
}

ops.op_physics_create_world(0);
const PROFILE = resolveProfile("builder.readWrite");

/** A capturing engine-camera stub: records the last position/look-at/fov the manager set. */
interface CaptureCamera {
  px: number; py: number; pz: number;
  lx: number; ly: number; lz: number;
  fov: number; projUpdates: number;
  aspect: number;
  position: { set(x: number, y: number, z: number): void };
  lookAt(x: number, y: number, z: number): void;
  updateProjectionMatrix(): void;
}
function makeCamera(): CaptureCamera {
  const c: CaptureCamera = {
    px: 0, py: 0, pz: 0, lx: 0, ly: 0, lz: 0, fov: 60, projUpdates: 0, aspect: 1,
    position: { set(x, y, z) { c.px = x; c.py = y; c.pz = z; } },
    lookAt(x, y, z) { c.lx = x; c.ly = y; c.lz = z; },
    updateProjectionMatrix() { c.projUpdates++; },
  };
  return c;
}

/** A WorldContext whose camera is a capturing stub and whose entity table is shared so the
 *  rig can resolve a followed entity's transform. */
function makeWorld(worldOps: EngineOps, camera: CaptureCamera): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as unknown as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

const SESSION = "ses_p12_camera";
const AGENT = "agt_camera";
const TARGET_EID = 7;
const TPX = 10, TPY = 2, TPZ = -3; // known target world position
const LOOK_HEIGHT = 1.2;           // CameraManager DEFAULT_LOOK_HEIGHT
const HEAD_HEIGHT = 1.6;

/** Build a core + world with a single followable target entity at (TPX,TPY,TPZ). */
function setup(): { core: CoreSkills; world: WorldContext; camera: CaptureCamera; target: string; call: (tool: string, input: unknown) => Promise<MCPResponse> } {
  const reg = new SkillRegistry(new LiminaTracer(SESSION));
  const core = registerCoreSkills(reg);
  const camera = makeCamera();
  const world = makeWorld(ops, camera);
  const target = world.entities.create({ eid: TARGET_EID });
  world.transforms!.writePosition(TARGET_EID, TPX, TPY, TPZ);
  const base = { agentId: AGENT, sessionId: SESSION, permissions: PROFILE, tick: 0, world };
  const call = (tool: string, input: unknown): Promise<MCPResponse> => reg.invoke(tool, input, base);
  return { core, world, camera, target, call };
}

// ── (0) the manager is exposed on core.camera (closure-owned, not a dead cast) ─────────────
{
  const { core } = setup();
  assert(core.camera !== undefined && core.camera.cameraManager !== undefined, "core.camera must expose cameraManager");
}

// ── (1) camera.follow → real orbit rig frames the target at the expected position + look-at ──
{
  const { core, world, camera, target, call } = setup();
  const DIST = 8, PITCH = 0.3, YAW = 0; // follow input pitch; yaw defaults 0
  ok(await call("camera.follow", { target, distance: DIST, pitch: PITCH }));
  core.camera.cameraManager.update(1 / 60, world);

  // Expected = the REAL ThirdPersonCamera orbit math (the rig we reuse), computed independently.
  const ref = new ThirdPersonCamera({ distance: DIST, lookHeight: LOOK_HEIGHT });
  ref.yaw = YAW; ref.pitch = PITCH;
  let rpx = 0, rpy = 0, rpz = 0, rlx = 0, rly = 0, rlz = 0;
  ref.update({ position: { set(x, y, z) { rpx = x; rpy = y; rpz = z; } }, lookAt(x, y, z) { rlx = x; rly = y; rlz = z; } }, [TPX, TPY, TPZ]);
  close(camera.px, rpx, "follow camera x"); close(camera.py, rpy, "follow camera y"); close(camera.pz, rpz, "follow camera z");
  close(camera.lx, rlx, "follow lookAt x"); close(camera.ly, rly, "follow lookAt y"); close(camera.lz, rlz, "follow lookAt z");
  // Sanity: a real orbit sits BEHIND (+Z, yaw=0) and ABOVE the target, looking at it.
  assert(camera.pz > TPZ, "orbit camera should sit behind the target (+Z at yaw 0)");
  close(camera.lx, TPX, "look-at should track the target x");
  close(camera.lz, TPZ, "look-at should track the target z");
}

// ── (2) camera.thirdPerson + camera.look → orbit angles drive the rig ──────────────────────
{
  const { core, world, camera, target, call } = setup();
  const DIST = 6, PITCH = 0.2;
  ok(await call("camera.thirdPerson", { target, distance: DIST, pitch: PITCH }));
  const dYaw = 0.4, dPitch = 0.1; // camera.look nudges the orbit angles
  ok(await call("camera.look", { yawDelta: dYaw, pitchDelta: dPitch }));
  core.camera.cameraManager.update(1 / 60, world);

  const ref = new ThirdPersonCamera({ distance: DIST, lookHeight: LOOK_HEIGHT });
  ref.yaw = 0 + dYaw; ref.pitch = PITCH + dPitch;
  let rpx = 0, rpy = 0, rpz = 0;
  ref.update({ position: { set(x, y, z) { rpx = x; rpy = y; rpz = z; } }, lookAt() {} }, [TPX, TPY, TPZ]);
  close(camera.px, rpx, "thirdPerson+look camera x"); close(camera.py, rpy, "thirdPerson+look camera y"); close(camera.pz, rpz, "thirdPerson+look camera z");
}

// ── (3) camera.firstPerson + camera.look → head position + look direction ──────────────────
{
  const { core, world, camera, target, call } = setup();
  ok(await call("camera.firstPerson", { target, headHeight: HEAD_HEIGHT }));
  const yaw = 0.5, pitch = 0.2;
  ok(await call("camera.look", { yawDelta: yaw, pitchDelta: pitch }));
  core.camera.cameraManager.update(1 / 60, world);

  const headY = TPY + HEAD_HEIGHT;
  close(camera.px, TPX, "fp camera x"); close(camera.py, headY, "fp camera y (eye height)"); close(camera.pz, TPZ, "fp camera z");
  const cp = Math.cos(pitch);
  close(camera.lx, TPX + Math.sin(yaw) * cp, "fp look x");
  close(camera.ly, headY + Math.sin(pitch), "fp look y");
  close(camera.lz, TPZ + Math.cos(yaw) * cp, "fp look z");
}

// ── (4) camera.topDown → angled overhead position, looking straight at the target ──────────
{
  const { core, world, camera, target, call } = setup();
  const DIST = 12, ANGLE = 0.6;
  ok(await call("camera.topDown", { target, distance: DIST, angle: ANGLE }));
  core.camera.cameraManager.update(1 / 60, world);
  close(camera.px, TPX, "topDown camera x");
  close(camera.py, TPY + DIST * Math.cos(ANGLE), "topDown camera y");
  close(camera.pz, TPZ + DIST * Math.sin(ANGLE), "topDown camera z");
  close(camera.lx, TPX, "topDown look x"); close(camera.ly, TPY, "topDown look y"); close(camera.lz, TPZ, "topDown look z");
}

// ── (5) camera.setFOV → applied to the engine camera on the next update ────────────────────
{
  const { core, world, camera, target, call } = setup();
  ok(await call("camera.follow", { target, distance: 5, pitch: 0.3 }));
  ok(await call("camera.setFOV", { fov: 90 }));
  assert(camera.fov === 60, "fov must not change until update() applies it");
  core.camera.cameraManager.update(1 / 60, world);
  close(camera.fov, 90, "fov applied on update");
  assert(camera.projUpdates >= 1, "setFOV must call updateProjectionMatrix");
  const before = camera.projUpdates;
  core.camera.cameraManager.update(1 / 60, world);
  assert(camera.projUpdates === before, "fov should not re-apply (no projection churn) when unchanged");
}

// ── (6) camera.cut → instant position + look-at ────────────────────────────────────────────
{
  const { camera, call } = setup();
  ok(await call("camera.cut", { position: [1, 2, 3], target: [4, 5, 6] }));
  close(camera.px, 1, "cut x"); close(camera.py, 2, "cut y"); close(camera.pz, 3, "cut z");
  close(camera.lx, 4, "cut look x"); close(camera.ly, 5, "cut look y"); close(camera.lz, 6, "cut look z");
}

// ── (7) camera.shake → dt-driven envelope that DECAYS TO ZERO over its duration ─────────────
{
  const { core, world, camera, target, call } = setup();
  ok(await call("camera.follow", { target, distance: 8, pitch: 0.3 }));
  // Base (unshaken) orbit position for this rig.
  core.camera.cameraManager.update(1 / 60, world);
  const baseX = camera.px, baseY = camera.py;

  const DUR = 0.3, DT = 1 / 60;
  ok(await call("camera.shake", { amplitude: 0.5, duration: DUR, frequency: 40, fade: true }));
  // Mid-shake: the planar camera offset is non-zero (the shake is live).
  core.camera.cameraManager.update(DT, world);
  const midDx = Math.abs(camera.px - baseX) + Math.abs(camera.py - baseY);
  assert(midDx > EPS, "shake must perturb the camera while active");

  // Pump past the duration; the envelope must clear and the camera return to the base framing.
  for (let t = DT; t <= DUR + DT * 2; t += DT) core.camera.cameraManager.update(DT, world);
  close(camera.px, baseX, "shake decayed to zero (x back to base)");
  close(camera.py, baseY, "shake decayed to zero (y back to base)");
}

// ── (8) DETERMINISM: two identical update sequences produce identical camera transforms ─────
{
  const seq = async (): Promise<string> => {
    const { core, world, camera, target, call } = setup();
    ok(await call("camera.thirdPerson", { target, distance: 7, pitch: 0.25 }));
    ok(await call("camera.shake", { amplitude: 0.4, duration: 0.5, frequency: 33, fade: true }));
    const states: string[] = [];
    for (let i = 0; i < 20; i++) {
      ok(await call("camera.look", { yawDelta: 0.03, pitchDelta: 0.01 }));
      core.camera.cameraManager.update(1 / 60, world);
      states.push(`${camera.px},${camera.py},${camera.pz}|${camera.lx},${camera.ly},${camera.lz}`);
    }
    return states.join(";");
  };
  const a = await seq();
  const b = await seq();
  assert(a === b, "two identical update sequences diverged (camera math is not deterministic)");
}

ops.op_log(
  `p12_camera OK: closure-wired camera skills drive core.camera.cameraManager (no dead ctx.world cast); ` +
  `camera.follow/thirdPerson REUSE the real ThirdPersonCamera orbit rig — engine camera lands at the ` +
  `expected orbit position + look-at; firstPerson head+look, topDown angle/zoom, setFOV (applied on ` +
  `update, no projection churn when unchanged), and cut all produce the expected camera state; ` +
  `camera.shake decays to zero over its dt-driven duration; two identical update sequences are BIT-IDENTICAL.`,
);
