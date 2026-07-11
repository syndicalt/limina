// Performance-budgeted near-field fidelity district.
//
// Run:
//   ./target/release/limina --window --frames 1020 js/src/demos/fidelity_district_window.ts
//
// This is the fixed visual/performance baseline for the HermesWorld-HD-class fidelity work. It
// uses only tracked assets and ordinary agent-facing skills. The first version is expected to expose
// missing GPU timing and content-system gaps; upgrades must improve this scene without bypassing it.

import { ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { createWindowedContext } from "../game/index.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints } from "../terrain/terrain-types.ts";
import { surveyRegionRelief } from "../terrain/biome-content.ts";
import { MATERIALS } from "../materials/palette.ts";
import {
  FIDELITY_CAMERA_ROUTE,
  FIDELITY_VISUAL_FLAGS,
  FidelityBenchmarkRecorder,
  fidelityCameraPose,
} from "../render/fidelity-benchmark.ts";

const SEED = 0x5e7;
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 3, maxTz: 3 } as const;
const SHAPE = { amp: 1.15, erode: 1 };
const HINTS = { ...terrainTypeHints("forest", BOUNDS), ...SHAPE };
const WARMUP_FRAMES = 120;
const SAMPLE_FRAMES = FIDELITY_CAMERA_ROUTE.reduce((sum, keyframe) => sum + keyframe.durationFrames, 0);

const ctx = await createWindowedContext({
  width: 1920,
  height: 1080,
  renderBaseline: {
    ground: { enabled: false },
    atmosphere: { height: { enabled: true, density: 0.0007 } },
  },
  session: "ses_fidelity_district",
  agentId: "agt_fidelity_district",
});
const engine = ctx.engine!;
const registry = ctx.registry;
const core = ctx.core;
const base = ctx.base;
ops.op_physics_create_world(-9.81);

const relief = surveyRegionRelief(core.terrain.source, SEED, BOUNDS, HINTS);
const waterLevel = relief.minY + (relief.maxY - relief.minY) * 0.16;
const generated = await registry.invoke("world.generateRegion", {
  seed: SEED,
  bounds: BOUNDS,
  lod: 0,
  type: "forest",
  hints: SHAPE,
  surface: {
    mode: "pbr",
    roughness: 0.94,
    seaLevel: waterLevel,
    minY: relief.minY,
    maxY: relief.maxY,
    waterline: { wetBand: 1.5, foam: 0.45 },
  },
}, base);
if (!generated.success) throw new Error(`fidelity district terrain failed: ${JSON.stringify(generated.error)}`);
const regionId = (generated.result as { regionId: string }).regionId;

const span = (BOUNDS.maxTx - BOUNDS.minTx + 1) * TILE_SIZE;
const centerX = ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE;
const centerZ = ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE;
const surface = (x: number, z: number): number => core.terrain.source.sampleHeight(SEED, x, z, 0, HINTS);
const centerY = surface(centerX, centerZ);

const water = await registry.invoke("world.addWater", {
  level: waterLevel,
  color: MATERIALS.water.color,
  size: span * 1.5,
  region: { seed: SEED, type: "forest", bounds: BOUNDS, hints: SHAPE },
}, base);
if (!water.success) throw new Error(`fidelity district water failed: ${JSON.stringify(water.error)}`);

const biome = await registry.invoke("world.populateBiome", {
  regionId,
  type: "forest",
  waterLevel,
  waterMargin: 1.5,
}, base);
if (!biome.success) throw new Error(`fidelity district biome failed: ${JSON.stringify(biome.error)}`);
const biomeInstances = (biome.result as { instances: number }).instances;

let visualFlags = biomeInstances < 16 ? FIDELITY_VISUAL_FLAGS.missingRequiredContent : 0;
async function place(assetId: string, dx: number, dz: number, height: number, yaw = 0): Promise<void> {
  const x = centerX + dx, z = centerZ + dz;
  const result = await registry.invoke("asset.place", {
    assetId,
    position: [x, surface(x, z), z],
    rotation: [0, yaw, 0],
    normalizeHeight: height,
    ground: true,
  }, base);
  if (!result.success) {
    visualFlags |= FIDELITY_VISUAL_FLAGS.missingRequiredContent;
    ops.op_log(`fidelity district asset failed ${assetId}: ${JSON.stringify(result.error)}`);
  }
}

await place("tudor-cottage.glb", 0, 0, 10.8, -0.25);
await place("prop-campfire-1.glb", -8, 7, 1.4);
await place("a-basic-wooden-bridge.glb", -20, -19, 2.0, Math.PI * 0.35);
for (const [dx, dz, yaw] of [[-11, 9, 0.1], [-8, 11, 0.1], [9, 10, -0.15], [12, 8, -0.15]] as const) {
  await place("prop-fence-section.glb", dx, dz, 1.25, yaw);
}

engine.camera.near = 0.2;
engine.camera.far = span * 8;
engine.camera.updateProjectionMatrix();

const recorder = new FidelityBenchmarkRecorder("balanced", SAMPLE_FRAMES, true);
let frame = 0;
let lastFrameAt: number | undefined;
let reportWritten = false;

function render(): void {
  const now = performance.now();
  const frameMs = lastFrameAt === undefined ? 0 : now - lastFrameAt;
  lastFrameAt = now;
  const routeFrame = Math.max(0, frame - WARMUP_FRAMES);
  const pose = fidelityCameraPose(routeFrame, [centerX, centerY, centerZ]);
  engine.camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
  engine.camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
  renderSyncSystem(engine.world);

  const submittedAt = performance.now();
  engine.renderer.info.reset();
  engine.renderer.render(engine.scene, engine.camera);
  const submitMs = performance.now() - submittedAt;
  const presentStartedAt = performance.now();
  ops.op_surface_present(engine.context);
  const presentMs = performance.now() - presentStartedAt;

  if (frame >= WARMUP_FRAMES && recorder.size < recorder.capacity) {
    const info = engine.renderer.info as unknown as {
      render?: { drawCalls?: number; triangles?: number };
      memory?: { total?: number };
    };
    recorder.record({
      frameMs,
      submitMs,
      presentMs,
      gpuMs: null,
      drawCalls: Math.max(0, Math.floor(info.render?.drawCalls ?? 0)),
      triangles: Math.max(0, Math.floor(info.render?.triangles ?? 0)),
      gpuResourceBytes: Math.max(0, Math.floor(info.memory?.total ?? 0)),
      streamingMs: 0,
      visualFlags,
    });
  }
  if (!reportWritten && recorder.size === recorder.capacity) {
    reportWritten = true;
    const report = recorder.report();
    const artifact = Object.freeze({ ...report, adapter: engine.gpuAdapter });
    ops.op_write_trace("fidelity-district-report.json", `${JSON.stringify(artifact, null, 2)}\n`);
    ops.op_log(`fidelity district benchmark: ${JSON.stringify(artifact)}`);
  }
  frame++;
}

function onResize(width: number, height: number): void {
  ops.op_surface_resize(width, height);
  engine.renderer.setSize(width, height, false);
  engine.camera.aspect = width / height;
  engine.camera.updateProjectionMatrix();
}

render();
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log(`fidelity district ready: ${span}m forest, ${biomeInstances} biome instances, tracked PBR cottage/bridge/fence/campfire, ${WARMUP_FRAMES} warm-up + ${SAMPLE_FRAMES} measured frames at 1920x1080; GPU timing unavailable; adapter ${JSON.stringify(engine.gpuAdapter)}.`);
