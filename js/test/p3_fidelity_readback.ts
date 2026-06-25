// Phase 3 T4 -- Falsifiable visual-fidelity readback.
//
// Builds the fidelity scene THROUGH SKILLS (demos/fidelity_scene_core.ts),
// renders it windowed, reads the window surface back with raw-WebGPU
// copyTextureToBuffer (the proven path here; three's RT readback hits a WeakMap
// bug), and asserts:
//   (a) a floor pixel inside the cast-shadow region is >= 25% darker than a lit
//       pixel of the SAME floor surface (real shadow mapping), and
//   (b) a pixel on the textured glTF matches the texture's red baseColor and is
//       not flat black/dark (real UV sampling).
// A PPM screenshot of the rendered frame is written to traces/.
//
// Run: limina --window --frames 5 js/test/p3_fidelity_readback.ts

import * as THREE from "../build/three.bundle.mjs";
import { createEngine, ops } from "../src/engine.ts";
import { renderSyncSystem } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { buildFidelityScene } from "../src/demos/fidelity_scene_core.ts";

// Raw-WebGPU surfaces engine.ts types as `unknown`; type them locally for the
// readback path (named consts with reason, never inlined into member access).
interface GpuMappedBuffer {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
}
interface GpuCommandEncoder {
  copyTextureToBuffer(src: object, dst: object, size: object): void;
  finish(): unknown;
}
interface GpuDeviceLike {
  createBuffer(desc: { size: number; usage: number }): GpuMappedBuffer;
  createCommandEncoder(): GpuCommandEncoder;
  queue: { submit(buffers: unknown[]): void };
}
interface GpuTextureLike { width: number; height: number; format: string }
interface GpuCanvasContextLike { getCurrentTexture(): GpuTextureLike }
interface Vec3Like { x: number; y: number; z: number }
interface LocalToWorld { localToWorld(v: Vec3Like): Vec3Like }
declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const engine = await createEngine({ width: 960, height: 640 });
const tracer = new LiminaTracer("ses_p3_fidelity_readback");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);
ops.op_physics_create_world(0);

const world: WorldContext = {
  ecs: engine.world,
  transforms: engine.transforms,
  spatial: engine.spatial,
  entities: engine.entities,
  tags: engine.tags,
  scene: engine.scene,
  camera: engine.camera,
  ops: engine.ops,
  renderer: engine.renderer,
  width: engine.width,
  height: engine.height,
  mode: engine.mode,
};
const base: InvokeBase = {
  agentId: "agt_builder",
  sessionId: "ses_p3_fidelity_readback",
  permissions: resolveProfile("builder.readWrite"),
  tick: 0,
  world,
};

const handles = await buildFidelityScene(registry, base);

function frame(): void {
  renderSyncSystem(engine.world);
  engine.renderer.render(engine.scene, engine.camera);
  ops.op_surface_present(engine.context);
}

// Warm-up + a few driven frames so the shadow-map + textured pipelines compile
// before we read back (the host pumps the event loop between our awaited sleeps).
frame();
for (let i = 0; i < 30; i++) {
  await ops.op_sleep_ms(16);
  frame();
}

// Final render WITHOUT present, then copy the live surface texture to a buffer.
renderSyncSystem(engine.world);
engine.renderer.render(engine.scene, engine.camera);

// engine.device / engine.context are the GPUDevice/GPUCanvasContext three renders
// with; type for the raw readback (engine.ts exposes them as unknown).
const device = engine.device as unknown as GpuDeviceLike;
const context = engine.context as unknown as GpuCanvasContextLike;

const tex = context.getCurrentTexture();
const W = tex.width;
const H = tex.height;
const format = tex.format;
const bgra = format.startsWith("bgra");
const bytesPerRow = Math.ceil((W * 4) / 256) * 256;
const readBuffer = device.createBuffer({
  size: bytesPerRow * H,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
const encoder = device.createCommandEncoder();
encoder.copyTextureToBuffer(
  { texture: tex },
  { buffer: readBuffer, bytesPerRow },
  { width: W, height: H, depthOrArrayLayers: 1 },
);
device.queue.submit([encoder.finish()]);
await readBuffer.mapAsync(GPUMapMode.READ);
const pixels = new Uint8Array(readBuffer.getMappedRange().slice(0));
readBuffer.unmap();
ops.op_surface_present(engine.context);

interface Sample { r: number; g: number; b: number; a: number; sx: number; sy: number }
function sampleWorld(wx: number, wy: number, wz: number): Sample {
  const ndc = new THREE.Vector3(wx, wy, wz).project(engine.camera);
  const sx = Math.min(Math.max(Math.round((ndc.x * 0.5 + 0.5) * (W - 1)), 0), W - 1);
  const sy = Math.min(Math.max(Math.round((0.5 - ndc.y * 0.5) * (H - 1)), 0), H - 1);
  const o = sy * bytesPerRow + sx * 4;
  const c0 = pixels[o];
  const c1 = pixels[o + 1];
  const c2 = pixels[o + 2];
  const a = pixels[o + 3];
  return bgra ? { r: c2, g: c1, b: c0, a, sx, sy } : { r: c0, g: c1, b: c2, a, sx, sy };
}

const lit = sampleWorld(handles.litPoint[0], handles.litPoint[1], handles.litPoint[2]);
const shadow = sampleWorld(handles.shadowPoint[0], handles.shadowPoint[1], handles.shadowPoint[2]);

// glTF sample: project the live world position of the triangle's interior point.
const texturedMesh = engine.entities.resolve(handles.textured)?.mesh;
assert(texturedMesh !== undefined, "textured glTF entity missing");
const ltw = texturedMesh as unknown as LocalToWorld; // Object3D.localToWorld; outside SceneObject typing
const [lx, ly, lz] = handles.texturedLocalSample;
const worldSample = ltw.localToWorld(new THREE.Vector3(lx, ly, lz));
const tex0 = sampleWorld(worldSample.x, worldSample.y, worldSample.z);

const litLum = lit.r + lit.g + lit.b;
const shadowLum = shadow.r + shadow.g + shadow.b;
const darkerPct = litLum > 0 ? (1 - shadowLum / litLum) * 100 : 0;

ops.op_log(`fidelity: surface ${W}x${H} ${format}`);
ops.op_log(`fidelity: lit floor @(${lit.sx},${lit.sy}) rgb=${lit.r},${lit.g},${lit.b} lum=${litLum}`);
ops.op_log(`fidelity: shadow floor @(${shadow.sx},${shadow.sy}) rgb=${shadow.r},${shadow.g},${shadow.b} lum=${shadowLum}`);
ops.op_log(`fidelity: shadow is ${darkerPct.toFixed(1)}% darker than the lit floor`);
ops.op_log(`fidelity: glTF texel @(${tex0.sx},${tex0.sy}) rgba=${tex0.r},${tex0.g},${tex0.b},${tex0.a}`);

// (sanity) sampling the lit floor and the shadow region must hit the same bright
// gray surface, not the dark scene background (~rgb 11,14,20 -> lum ~45).
assert(litLum > 200, `lit floor too dark (lum ${litLum}); not sampling the lit floor`);
assert(shadowLum > 90, `shadow sample too dark (lum ${shadowLum}); not on the floor surface`);

// (a) Real cast shadow: shadow region materially darker than the same lit floor.
assert(
  shadowLum <= litLum * 0.75,
  `cast shadow not dark enough: shadow lum ${shadowLum} vs lit lum ${litLum} (only ${darkerPct.toFixed(1)}% darker, need >= 25%)`,
);

// (b) Real UV sampling: the glTF surface shows its red baseColor texture, not
// flat black/dark and not the floor/lighting tint.
assert(tex0.a === 255, `glTF texel not opaque (a=${tex0.a})`);
assert(tex0.r >= 80, `glTF texel too dark (r=${tex0.r}); texture not sampling (would be ~black before the fix)`);
assert(
  tex0.r > tex0.g * 2 + 20 && tex0.r > tex0.b * 2 + 20,
  `glTF texel not red-dominant: rgb=${tex0.r},${tex0.g},${tex0.b}`,
);

// Save a screenshot (PPM P3) of the rendered frame as visual evidence.
const ppm: string[] = [`P3\n${W} ${H}\n255`];
for (let y = 0; y < H; y++) {
  let row = "";
  for (let x = 0; x < W; x++) {
    const o = y * bytesPerRow + x * 4;
    const r = bgra ? pixels[o + 2] : pixels[o];
    const g = pixels[o + 1];
    const b = bgra ? pixels[o] : pixels[o + 2];
    row += `${r} ${g} ${b} `;
  }
  ppm.push(row);
}
ops.op_write_trace("fidelity_readback.ppm", ppm.join("\n"));
ops.op_log("fidelity: screenshot written to traces/fidelity_readback.ppm");
ops.op_log("P3 fidelity readback OK: real shadow map + real UV texture sampling verified by pixel readback");
