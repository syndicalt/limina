// DIRECT-PATH DEMO (M1) — the playable proof of the substrate split. A third-person character
// walks on the lit baseline ground, driven through the direct-path runtime (createWindowedContext
// + GameLoop). The GAMEPLAY LOOP issues ZERO registry.invoke: movement is a CharacterController
// stepped straight off ctx.ops, and the loop owns the pose→sync→skin→present order. Authoring
// (loading the rigged model) still uses a skill — that's setup, not the hot path.
//
// Run: ./target/release/limina --window js/src/demos/direct_path_window.ts
//   CONTROLS: click to capture the mouse — W/S move, A/D turn, mouse look, Shift run.

import { ops } from "../engine.ts";
import { createWindowedContext, GameLoop } from "../game/index.ts";
import { CharacterController } from "../world/character.ts";
import { ThirdPersonCamera } from "../world/third_person_camera.ts";
import { attachCharacterModel } from "../world/character_model.ts";
import { applyTurn } from "../world/heading.ts";

// One factory call replaces the ~11-field WorldContext literal every demo used to hand-copy.
const ctx = await createWindowedContext({ width: 1280, height: 720 });
ctx.ops.op_physics_create_world(-9.81);
ctx.ops.op_physics_add_ground(0);

const HALF = 0.5;
const RADIUS = 0.35;
const player = new CharacterController(ctx.ops, [0, HALF + RADIUS, 0], { halfHeight: HALF, radius: RADIUS });

// Authoring (one-time, off the hot path): load the rigged player model via the skill surface.
const p0 = player.position;
const model = await attachCharacterModel({
  world: ctx.world,
  registry: ctx.registry,
  base: ctx.base,
  animationManager: ctx.core.animation.animationManager,
  position: [p0[0], p0[1] - player.groundOffset, p0[2]],
});

const engine = ctx.engine!;
engine.camera.near = 0.3;
engine.camera.far = 1000;
engine.camera.updateProjectionMatrix();
const camera = new ThirdPersonCamera({ distance: 7, lookHeight: 1.1 });

const TURN_RATE = 2.6;
const LOOK_SENS = 0.0022;
const axes = new Float32Array(4);
const buttons = new Float32Array(2);
const look = new Float32Array(2);
let heading = 0;
let freeYaw = 0;
let freePitch = -0.25;

interface Input { forward: number; yaw: number; run: boolean }

const loop = new GameLoop<Input>(ctx, {
  sampleInput: (dt): Input => {
    ctx.ops.op_input_axes(axes); // [0]=A/D, [2]=S/W
    ctx.ops.op_input_buttons(buttons); // [0]=Space, [1]=Shift
    heading = applyTurn(heading, axes[0], TURN_RATE, dt);
    return { forward: axes[2], yaw: heading + freeYaw, run: buttons[1] === 1 };
  },
  // DIRECT PATH: step the controller + advance physics. No registry.invoke.
  step: (dt, input): void => {
    player.step({ forward: input.forward, strafe: 0, yaw: input.yaw, run: input.run, jump: false }, dt);
    ctx.ops.op_physics_step();
  },
  beforeSync: (): void => {
    ctx.ops.op_input_look(look);
    freeYaw += look[0] * LOOK_SENS;
    freePitch -= look[1] * LOOK_SENS;
    if (freePitch < -1.2) freePitch = -1.2;
    if (freePitch > 0.6) freePitch = 0.6;
    const p = player.position;
    model.setPose([p[0], p[1] - player.groundOffset, p[2]], player.facing);
    model.setLocomotion(Math.abs(axes[2]) > 0.01 ? (buttons[1] === 1 ? "run" : "walk") : "idle", 1 / 60);
    camera.yaw = heading + freeYaw;
    camera.pitch = freePitch;
    camera.update(engine.camera, p);
  },
  synced: [model],
  present: (): void => {
    engine.renderer.render(engine.scene, engine.camera);
    ctx.ops.op_surface_present(engine.context);
  },
  resize: (w, h): void => {
    ctx.ops.op_surface_resize(w, h);
    engine.renderer.setSize(w, h, false);
    engine.camera.aspect = w / h;
    engine.camera.updateProjectionMatrix();
  },
});
loop.start();

ops.op_log(
  "direct-path demo ready: a third-person character on the direct-path runtime (createWindowedContext " +
  "+ GameLoop). Click to capture the mouse — W/S move, A/D turn, mouse look, Shift run. The gameplay " +
  "loop uses ZERO registry.invoke.",
);
