// audio_showcase — a procedural hedgehog dances + SINGS to a procedural dance
// track, showcasing the limina-audio integration end to end:
//   • the music is synthesized in JS (kick/snare/hats/bass/arp) and played as a
//     looping PCM buffer through the native mixer (op_audio_play_buffer);
//   • the hedgehog's bounce/sway/spin + spike-flare are driven by a beat clock
//     derived from the same BPM, so it dances IN TIME;
//   • it SINGS short lyric lines via the pluggable TTS voice (op_audio_speak with
//     an elevated pitch for a sing-song voice), spatialized at its mouth;
//   • the audio listener tracks the orbiting camera, so the singing pans.
//
// Procedural everything (no asset files); voice via espeak-ng. Windowed-only.
//   ./target/release/limina --window js/src/demos/audio_showcase.ts

import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { createMaterial } from "../materials/palette.ts";
import { AudioManager } from "../audio/manager.ts";
import { synthesizeDanceLoop } from "../audio/music.ts";

const now = (): number => (globalThis as { performance?: { now?: () => number } }).performance?.now?.() ?? Date.now();

const BPM = 124;
const BASE_Y = 0.92; // resting height of the hedgehog's center

const engine = await createEngine({ width: 1024, height: 680 });
engine.scene.background = new THREE.Color(0x0a0a18); // dark club

// --- stage: a dark shiny floor + a glowing dance-ring under the hedgehog -------
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(9, 56),
  // Large STATIC stage floor → procedural-PBR palette surface (tactile grain).
  createMaterial("stone", { pbr: true }),
);
floor.rotation.x = -Math.PI / 2;
engine.scene.add(floor);
const ring = new THREE.Mesh(
  new THREE.RingGeometry(1.4, 1.7, 48),
  new THREE.MeshStandardNodeMaterial({ color: 0x000000, emissive: 0x4422aa, roughness: 1 }),
);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.01;
engine.scene.add(ring);

// --- lighting: dim ambient + three orbiting colored disco lamps ----------------
engine.scene.add(new THREE.AmbientLight(0x4456aa, 0.45));
const key = new THREE.DirectionalLight(0xfff0e0, 0.5);
key.position.set(2, 6, 3);
engine.scene.add(key);
interface Disco { light: THREE.PointLight; hue: number; base: number; phase: number; }
const discos: Disco[] = ([
  [0xff3da6, 95], [0x38e1ff, 90], [0xffd24a, 80],
] as [number, number][]).map(([color, base], i) => {
  const light = new THREE.PointLight(color, base, 30, 1.4);
  light.position.set(4, 5, 0);
  engine.scene.add(light);
  return { light, hue: i / 3, base, phase: (i / 3) * Math.PI * 2 };
});

// --- the hedgehog ---------------------------------------------------------------
function buildHedgehog(): { group: THREE.Group; spikes: THREE.InstancedMesh; feet: THREE.Mesh[] } {
  const group = new THREE.Group();
  const tan = 0xc89b6a;
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.72, 28, 20),
    new THREE.MeshStandardNodeMaterial({ color: tan, roughness: 0.85 }),
  );
  body.scale.set(1.0, 0.85, 1.15);
  group.add(body);

  // Spikes: instanced cones over the upper/back hemisphere, clearing a front face
  // patch + the underside (feet). Oriented outward, darker low / lighter on top.
  const N = 150;
  const spikes = new THREE.InstancedMesh(
    new THREE.ConeGeometry(0.07, 0.36, 6),
    new THREE.MeshStandardNodeMaterial({ roughness: 0.6 }),
    N,
  );
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  let k = 0;
  for (let i = 0; i < 400 && k < N; i++) {
    const y = 1 - (i / 399) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * 2.399963; // golden-angle spiral
    dir.set(Math.cos(phi) * r, y, Math.sin(phi) * r);
    if (dir.z > 0.45 && dir.y < 0.45 && dir.y > -0.35) continue; // keep the face clear
    if (dir.y < -0.55) continue; // keep the belly/feet clear
    pos.set(dir.x * 0.7, dir.y * 0.62, dir.z * 0.82);
    q.setFromUnitVectors(up, dir);
    m.compose(pos, q, one);
    spikes.setMatrixAt(k, m);
    c.setHSL(0.07, 0.5, 0.26 + 0.2 * Math.max(0, dir.y));
    spikes.setColorAt(k, c);
    k++;
  }
  spikes.count = k;
  spikes.instanceMatrix.needsUpdate = true;
  if (spikes.instanceColor) spikes.instanceColor.needsUpdate = true;
  group.add(spikes);

  // Face (front, +z): snout + nose + eyes + ears.
  const snout = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.5, 16),
    new THREE.MeshStandardNodeMaterial({ color: tan, roughness: 0.85 }),
  );
  snout.rotation.x = Math.PI / 2;
  snout.position.set(0, -0.05, 0.8);
  group.add(snout);
  const nose = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 12, 10),
    new THREE.MeshStandardNodeMaterial({ color: 0x1a1208, roughness: 0.35 }),
  );
  nose.position.set(0, -0.05, 1.06);
  group.add(nose);
  const eyeMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.3 });
  const pupMat = new THREE.MeshStandardNodeMaterial({ color: 0x0c0a06 });
  const earMat = new THREE.MeshStandardNodeMaterial({ color: tan });
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 12), eyeMat);
    eye.position.set(sx * 0.2, 0.22, 0.62);
    group.add(eye);
    const pup = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), pupMat);
    pup.position.set(sx * 0.21, 0.22, 0.71);
    group.add(pup);
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), earMat);
    ear.scale.set(1, 1, 0.5);
    ear.position.set(sx * 0.34, 0.52, 0.18);
    group.add(ear);
  }
  const feet: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    const foot = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 12, 10),
      new THREE.MeshStandardNodeMaterial({ color: 0x6a4421 }),
    );
    foot.scale.set(1, 0.5, 1.4);
    foot.position.set(sx * 0.28, -0.62, 0.34);
    group.add(foot);
    feet.push(foot);
  }
  return { group, spikes, feet };
}

const { group: hog, spikes, feet } = buildHedgehog();
hog.position.y = BASE_Y;
engine.scene.add(hog);

// --- audio: synthesize + loop the dance track; set up the singing voice ---------
const loop = synthesizeDanceLoop(BPM, 2);
const audio = new AudioManager();
ops.op_audio_init();
audio.setBusVolume("master", 0.9);
const musicStart = now();
audio.playBuffer(loop.pcm, loop.sampleRate, 1, "ambience", 0.75, true); // looping music bed

const LYRICS = [
  "Spiky and dancing!",
  "Roll with me now!",
  "La la la, feel the beat!",
  "Bounce, bounce, bounce!",
  "Prickles in the light!",
  "Dance all night with me!",
];
let lastSungBeat = -1;

// --- per-frame: beat clock -> dance + sing + disco + camera + listener ----------
let lastT = 0;
function render(): void {
  const t = now();
  const dt = lastT !== 0 ? t - lastT : 16.7;
  lastT = t;

  const beats = ((t - musicStart) / 1000) * (BPM / 60);
  const beatIndex = Math.floor(beats);
  const frac = beats - beatIndex; // 0..1 within the current beat
  const air = frac < 0.62 ? Math.sin(Math.PI * (frac / 0.62)) : 0; // hop arc over 62% of the beat
  const grounded = frac >= 0.62 || air < 0.06;
  const pulse = Math.exp(-frac * 3.5); // a flash that decays from each beat onset

  // Bounce + squash + sway + spin.
  hog.position.y = BASE_Y + air * 0.42;
  const sq = grounded ? 0.16 * (1 - Math.min(1, frac < 0.62 ? 1 : (frac - 0.62) / 0.3)) : 0.04;
  hog.scale.set(1 + sq, 1 - sq * 1.3, 1 + sq);
  hog.rotation.z = Math.sin(beats * Math.PI) * 0.13; // side-to-side sway, one wag per beat
  hog.rotation.y += dt * 0.0011; // gentle continuous spin
  spikes.scale.setScalar(1 + air * 0.22); // spikes flare on the hop
  feet[0].position.y = -0.62 + (beatIndex % 2 === 0 ? air * 0.12 : 0);
  feet[1].position.y = -0.62 + (beatIndex % 2 === 1 ? air * 0.12 : 0);

  // Sing a lyric line every 4 beats (short lines fit before the next), pitched up.
  if (beatIndex !== lastSungBeat && beatIndex % 4 === 0) {
    lastSungBeat = beatIndex;
    const line = LYRICS[Math.floor(beatIndex / 4) % LYRICS.length];
    audio.speak(line, [hog.position.x, hog.position.y + 0.3, hog.position.z + 0.7], 1.0, 78);
  }

  // Disco lamps: orbit + pulse + slow hue cycle on the beat.
  for (const d of discos) {
    d.phase += dt * 0.0013;
    d.light.position.set(Math.cos(d.phase) * 4.2, 4.5 + Math.sin(d.phase * 1.7) * 1.2, Math.sin(d.phase) * 4.2);
    d.light.intensity = d.base * (0.45 + 0.55 * pulse);
    d.hue = (d.hue + dt * 0.00004) % 1;
    d.light.color.setHSL(d.hue, 0.85, 0.6);
  }
  (ring.material as { emissiveIntensity?: number }).emissiveIntensity = 0.6 + pulse * 1.4;

  // Orbiting camera + audio listener follows it (so the singing pans).
  const camA = (t - musicStart) * 0.00017;
  const cx = Math.cos(camA) * 4.8;
  const cz = Math.sin(camA) * 4.8;
  engine.camera.position.set(cx, 2.5 + Math.sin(beats * Math.PI) * 0.12, cz);
  engine.camera.lookAt(0, 1.05, 0);
  audio.syncListener([cx, engine.camera.position.y, cz], [cz, 0, -cx]); // right = (-fwd.z,0,fwd.x), fwd=(-cx,_,-cz)

  engine.renderer.render(engine.scene, engine.camera);
  ops.op_surface_present(engine.context);
}

// Warm-up frame (compile pipelines, avoid a blank first frame), then run.
engine.camera.position.set(4.8, 2.5, 0);
engine.camera.lookAt(0, 1.05, 0);
engine.renderer.render(engine.scene, engine.camera);
ops.op_surface_present(engine.context);
ops.op_set_frame_callback(render);

ops.op_log(`audio_showcase ready: a hedgehog dancing + singing to a ${BPM} BPM procedural track (music bed + pitched TTS, both through limina-audio)`);
