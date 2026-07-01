// BEACON RUN (playable) — the Stage-5 build, DRESSED. The SAME game logic the functional gate drove
// (buildBeaconRunGame, flat-ground physics) with the content stage on top: a Blight-gradient ground
// (healthy west → corrupt east), a moody haze, and REAL placed props. The BEACON is an unmistakable
// signal bonfire (embers you reach and set roaring), NOT a tower; the blight is a thinning stand of
// dead trees; the field is scattered with rocks, brush, and trees so it reads as a place, not a void.
// The lantern dims the whole scene as it drains.
//
// Run: ./target/release/limina --window js/src/demos/beacon_run_window.ts
//   CONTROLS: click to capture the mouse — W/S move, A/D turn, mouse look, Shift run.
//   Reach the SIGNAL FIRE ahead (−Z) to set it roaring and WIN. Stay off the dead BLIGHT to the
//   right (+X) — it drains your lantern; at zero you LOSE.

import { ops } from "../engine.ts";
import * as THREE from "../../build/three.bundle.mjs";
import { createWindowedContext, GameLoop } from "../game/index.ts";
import { buildBeaconRunGame } from "../game/examples/beacon_run_game.ts";
import { placeContent } from "../game/content.ts";
import { beaconField, BEACON_GROUND } from "../game/examples/beacon_run_scene.ts";
import { ThirdPersonCamera } from "../world/third_person_camera.ts";
import { attachCharacterModel } from "../world/character_model.ts";
import { applyTurn } from "../world/heading.ts";

const ctx = await createWindowedContext({
  width: 1280,
  height: 720,
  session: "ses_beacon_run",
  renderBaseline: { ground: { enabled: false }, atmosphere: { density: 0.0009 } }, // Blight haze
});
const engine = ctx.engine!;

const game = buildBeaconRunGame(ctx); // logic UNCHANGED from the gate
const [bx, bz] = game.beaconXZ; // [0,-12]
const [gx, gz] = game.blightXZ; // [10, 0]

// ── Ground: a Blight gradient (healthy olive at −X → dead grey at +X), vertex-colored (no canvas).
// Params come from the SHARED scene definition so the live render and the export agree on the field. ─
function makeGradientGround(): THREE.Mesh {
  const g = BEACON_GROUND;
  const geo = new THREE.PlaneGeometry(g.size, g.size, g.segments, g.segments);
  geo.rotateX(-Math.PI / 2);
  const healthy = new THREE.Color(g.healthy);
  const blight = new THREE.Color(g.blight);
  const pos = geo.attributes.position;
  const colors: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getX(i) - g.gradientStartX) / g.gradientSpanX));
    const c = healthy.clone().lerp(blight, t);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
}
engine.scene.add(makeGradientGround());

const crust = new THREE.Mesh(
  new THREE.CircleGeometry(game.blightRadius + 0.5, 40),
  new THREE.MeshStandardMaterial({ color: 0x17160e, roughness: 1, metalness: 0 }),
);
crust.rotation.x = -Math.PI / 2;
crust.position.set(gx, 0.03, gz);
engine.scene.add(crust);

// The dressed field comes from the SHARED scene definition (beacon_run_scene.ts) — the SAME field the
// headless exporter records into the packaged web release, so play and ship can't drift apart.
const field = beaconField(game);
await placeContent(ctx, field);

// ── The signal fire on the beacon pile — dim embers until reached, then a roaring blaze. ──────────
const fireMat = new THREE.MeshStandardMaterial({ color: 0x3a1d00, emissive: new THREE.Color(0xff9a2e), emissiveIntensity: 0.45 });
const fire = new THREE.Mesh(new THREE.ConeGeometry(0.95, 3.4, 16), fireMat);
fire.position.set(bx, 2.6, bz);
engine.scene.add(fire);
const fireLight = new THREE.PointLight(0xff9a2e, 0.5, 55, 2);
fireLight.position.set(bx, 2.8, bz);
engine.scene.add(fireLight);

// ── Player model (the sim drives the capsule; this follows). ─────────────────────────────────────
const p0 = game.player.position;
const model = await attachCharacterModel({
  world: ctx.world, registry: ctx.registry, base: ctx.base,
  animationManager: ctx.core.animation.animationManager,
  position: [p0[0], p0[1] - game.player.groundOffset, p0[2]],
});

engine.camera.near = 0.3;
engine.camera.far = 1000;
engine.camera.updateProjectionMatrix();
const camera = new ThirdPersonCamera({ distance: 7, lookHeight: 1.1 });

const axes = new Float32Array(4);
const buttons = new Float32Array(2);
const look = new Float32Array(2);
let heading = 0;
let freeYaw = 0;
let freePitch = -0.2;
let ended = false;

const loop = new GameLoop(ctx, {
  sampleInput: (dt) => {
    ops.op_input_axes(axes);
    ops.op_input_buttons(buttons);
    heading = applyTurn(heading, axes[0], 2.6, dt);
    return { forward: axes[2], strafe: 0, yaw: heading + freeYaw, run: buttons[1] === 1, jump: false, choose: -1 };
  },
  step: (dt, input) => { game.step(input, dt); },
  beforeSync: () => {
    ops.op_input_look(look);
    freeYaw += look[0] * 0.0022;
    freePitch -= look[1] * 0.0022;
    if (freePitch < -1.2) freePitch = -1.2;
    if (freePitch > 0.6) freePitch = 0.6;
    const p = game.player.position;
    model.setPose([p[0], p[1] - game.player.groundOffset, p[2]], game.player.facing);
    model.setLocomotion(Math.abs(axes[2]) > 0.01 ? (buttons[1] === 1 ? "run" : "walk") : "idle", 1 / 60);
    camera.yaw = heading + freeYaw;
    camera.pitch = freePitch;
    camera.update(engine.camera, p);

    // Embers → roaring blaze when lit; the scene dims as the lantern drains (pressure reads visually).
    const blaze = game.lit() ? 1 : 0;
    fire.scale.set(1 + blaze * 0.5, 1 + blaze * 0.9, 1 + blaze * 0.5);
    fireMat.emissiveIntensity = 0.45 + blaze * 2.6;
    fireLight.intensity = 0.5 + blaze * 3.2;
    engine.renderer.toneMappingExposure = 0.4 + 0.7 * (game.lantern() / game.lanternMax());

    if (!ended) {
      const s = game.gameState();
      if (s === "won") { ended = true; ops.op_log("the signal fire roars to life — the watch is warned. YOU WIN."); }
      else if (s === "lost") { ended = true; ops.op_log("the blight drank the last of your lantern. YOU LOSE."); }
    }
  },
  synced: [model],
  present: () => {
    engine.renderer.render(engine.scene, engine.camera);
    ops.op_surface_present(engine.context);
  },
  resize: (w, h) => {
    ops.op_surface_resize(w, h);
    engine.renderer.setSize(w, h, false);
    engine.camera.aspect = w / h;
    engine.camera.updateProjectionMatrix();
  },
});
loop.start();

ops.op_log(
  "BEACON RUN ready: click to capture the mouse — W/S move, A/D turn, mouse look, Shift run. " +
  "Reach the SIGNAL FIRE ahead (−Z) to set it roaring and WIN; stay off the dead BLIGHT to the right " +
  "(+X) — it drains your lantern and the world dims as it runs out.",
);
