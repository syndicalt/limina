// Canonical grass-field presentation gate: pluggable visuals, actual blades, canonical placement,
// bounded lifecycle, and zero entity growth. Headless bookkeeping only; no GPU adapter required.

import * as THREE from "../build/three.bundle.mjs";
import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { INTERACTIVE_TEMPERATE_MEADOW_PACKAGE } from "../src/content/grass/interactive-temperate-meadow.ts";
import { RIPARIAN_REED_GRASS_PACKAGE } from "../src/content/grass/riparian-reed.ts";
import { GrassFieldTileMount } from "../src/render/grass-field-render.ts";
import { GrassFieldVisualPackageRegistry } from "../src/render/grass-field-package.ts";
import { buildGrassInstancedMesh } from "../src/render/grass-placement-mesh.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerTerrainEditSkills } from "../src/skills/terrain-edit.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(`p_grass FAIL: ${message}`);
}

// The package is content, not a singleton engine style, and owns its bounded quality budgets.
const packages = new GrassFieldVisualPackageRegistry();
packages.register(INTERACTIVE_TEMPERATE_MEADOW_PACKAGE);
packages.register(RIPARIAN_REED_GRASS_PACKAGE);
assert(packages.get(INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.id) === INTERACTIVE_TEMPERATE_MEADOW_PACKAGE,
  "registered visual package did not round-trip by id");
assert(packages.get(RIPARIAN_REED_GRASS_PACKAGE.id) === RIPARIAN_REED_GRASS_PACKAGE,
  "riparian visual package did not round-trip by id");
assert(INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("cinematic").maxResidentBlades === 525_000,
  "cinematic package profile lost the accepted 525k blade budget");
assert(INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("cinematic").fineRadius === 2
  && INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("cinematic").fineRadius
    === INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("cinematic").radius,
  "cinematic near grass can change representation before its material fade completes");
assert(INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("cinematic").bladesPerInstance[0] === 1
  && INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("cinematic").bladesPerSquareMeter[0] === 260
  && INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("cinematic").bladesPerInstance[1] === 16
  && INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("cinematic").bladesPerSquareMeter[1] === 72,
"interactive meadow lost honest per-instance blade accounting or its explicit near-field density");
const cinematicMid = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("cinematic").additionalContinuousBands?.[0];
assert(cinematicMid?.id === "mid-cluster" && cinematicMid.cellSizeDivisor === 3
  && cinematicMid.radius === 2 && cinematicMid.lod === 1
  && cinematicMid.bladesPerSquareMeter === 72
  && cinematicMid.maxResidentBlades === 540_000 && cinematicMid.fadeIn.start === 8
  && cinematicMid.fadeIn.end === 16 && cinematicMid.fadeOut.start === 18
  && cinematicMid.fadeOut.end === 32 && Math.abs(cinematicMid.projectedAreaPerInstanceM2 - 0.06465) < 1e-9
  && Math.abs(cinematicMid.targetProjectedCoverage - 0.290925) < 1e-9 && cinematicMid.complementsLod === 0,
"interactive meadow lost its package-owned, camera-centered physical mid-field band");
const cinematicProxy = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("cinematic").farSurfaceProxy;
assert(cinematicProxy?.fadeIn.start === 8 && cinematicProxy.fadeIn.end === 20
  && cinematicProxy.coverageEnd >= 1_000,
"interactive meadow lost its horizon-scale density-aware terrain representation");
let duplicateRejected = false;
try { packages.register(INTERACTIVE_TEMPERATE_MEADOW_PACKAGE); } catch { duplicateRejected = true; }
assert(duplicateRejected, "visual package registry silently replaced an existing package");

// Every generic grass mesh must ask the injected package for geometry; there is no engine-owned
// single-blade fallback left to silently reappear in grass-field mounts or village lawns.
const lushGeometry = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.createGeometry({ quality: "cinematic", lod: 0, maxBlades: 300_000 });
const repeatGeometry = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.createGeometry({ quality: "cinematic", lod: 0, maxBlades: 300_000 });
const lushPositions = lushGeometry.getAttribute("position") as THREE.BufferAttribute;
assert(lushGeometry.userData.liminaTemperateMeadowBlades === 1
  && lushGeometry.userData.liminaGroundCoverStrategy === "individually-instanced-curved-blade/v3"
  && lushPositions.count === 5 * 3 + 1
  && JSON.stringify([...lushPositions.array]) === JSON.stringify([...repeatGeometry.getAttribute("position").array]),
"interactive meadow stopped publishing its deterministic independently-instanced folded blade");
assert(lushGeometry.getAttribute("uv").count === lushPositions.count
  && lushGeometry.getAttribute("meadowVariation").count === lushPositions.count
  && lushGeometry.boundingBox !== null && lushGeometry.boundingSphere !== null
  && Math.max(lushGeometry.boundingBox.max.x - lushGeometry.boundingBox.min.x,
    lushGeometry.boundingBox.max.z - lushGeometry.boundingBox.min.z) > 0.025,
"interactive meadow lost UVs, variation, bounds, or blade width");
const lushNormal = lushGeometry.getAttribute("normal") as THREE.BufferAttribute;
let hasSideNormal = false;
for (let index = 0; index < lushNormal.count; index++) {
  const nx = lushNormal.getX(index), ny = lushNormal.getY(index), nz = lushNormal.getZ(index);
  assert(Number.isFinite(nx + ny + nz), "package blade contains a non-finite derived normal");
  hasSideNormal ||= Math.abs(nx) > 0.01 || Math.abs(nz) > 0.01;
}
assert(hasSideNormal, "package blade collapsed to fake up normals without folded surface lighting");
const lushProfile = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("cinematic").lod[0];
assert(lushGeometry.boundingBox!.max.y <= lushProfile.maxHeight
  && Math.max(Math.abs(lushGeometry.boundingBox!.min.x), Math.abs(lushGeometry.boundingBox!.max.x),
    Math.abs(lushGeometry.boundingBox!.min.z), Math.abs(lushGeometry.boundingBox!.max.z))
    <= lushProfile.footprintRadius + lushProfile.maxHorizontalDisplacement,
"package-authored culling bounds do not conservatively cover the folded blade");
const lushMaterial = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.createMaterial({
  quality: "cinematic", lod: 0, maxBlades: 9, variant: "summer",
});
assert(lushMaterial.userData.liminaGrassMaterial === "interactive-temperate-meadow/v5",
  "interactive meadow stopped owning its material strategy");
const midMaterial = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.createMaterial({
  quality: "cinematic", lod: 1, maxBlades: 9, variant: "summer", presentationBand: "mid-cluster",
});
assert(midMaterial.alphaHash === true && midMaterial.opacityNode !== null,
  "mid-distance meadow lost its stable alpha-hash crossfade");
const midGeometry = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.createGeometry({
  quality: "cinematic", lod: 1, maxBlades: 16, presentationBand: "mid-cluster",
});
assert(midGeometry.userData.liminaGroundCoverStrategy === "world-varied-folded-physical-cluster/v2"
  && midGeometry.userData.liminaTemperateMeadowBlades === 16
  && midGeometry.getAttribute("position").count === 64 && midGeometry.index?.count === 96,
"mid-distance meadow stopped using its bounded sixteen-blade folded-ribbon physical cluster");
assert(midMaterial.userData.liminaMidClusterGeometry === midGeometry.userData.liminaMidClusterGeometry,
  "mid-distance material and geometry do not share one auditable physical-cluster contract");
const midVariation = midGeometry.userData.liminaMidClusterGeometry as any;
assert(midVariation.schema === "limina.grass-mid-physical-cluster/v1"
  && midVariation.variationDomain === "world-root-xz" && midVariation.variantFamilies >= 32
  && midVariation.bladeYawJitterRad > 0 && midVariation.bladeOffsetRadiusM > 0
  && midVariation.bladeLeanMaxM > 0 && midVariation.foldedLightingSurface === true,
"mid-distance physical blades lost world-root variation, folded lighting, or deformation");
lushGeometry.dispose();
repeatGeometry.dispose();
lushMaterial.dispose();
midMaterial.dispose();
midGeometry.dispose();
const reedGeometry = RIPARIAN_REED_GRASS_PACKAGE.createGeometry({ quality: "cinematic", lod: 0, maxBlades: 9 });
assert(reedGeometry.userData.liminaRiparianReedBlades === 9
  && reedGeometry.boundingBox !== null && reedGeometry.boundingBox.max.y > 1.2,
"riparian package collapsed to short generic lawn grass");
reedGeometry.dispose();
const injectedMesh = buildGrassInstancedMesh([
  { assetId: "__grass__", x: 0, y: 0, z: 0, yaw: 0, scale: 1 },
  { assetId: "__grass__", x: 1, y: 0, z: 1, yaw: 1, scale: 0.9 },
], {
  maxBlades: 10,
}, { visualPackage: INTERACTIVE_TEMPERATE_MEADOW_PACKAGE, quality: "balanced", lod: 0, variant: "summer" });
assert(injectedMesh !== null && injectedMesh.geometry.userData.liminaTemperateMeadowBlades === 1,
  "generic grass mesh did not preserve the injected package's independent-blade identity");
injectedMesh.geometry.dispose();
(injectedMesh.material as { dispose(): void }).dispose();
injectedMesh.dispose();

type SceneStub = { children: Set<unknown>; add(value: unknown): void; remove(value: unknown): void };
const scene: SceneStub = { children: new Set(), add(value) { this.children.add(value); }, remove(value) { this.children.delete(value); } };
const n = 33;
const tile: TerrainTile = {
  nrows: n, ncols: n, origin: [24, 0, 24], scale: [48, 1, 48],
  heights: new Float32Array(n * n), paintMat: new Uint8Array(n * n).fill(2), paintW: new Float32Array(n * n).fill(1),
};
const mount = new GrassFieldTileMount(scene, tile, () => ({ seed: 42, spacing: 0.75, elevationMin: -1 }),
  INTERACTIVE_TEMPERATE_MEADOW_PACKAGE, "cinematic", 0);
assert(mount.bladeCount() > 1_000 && mount.chunkCount() === 1 && scene.children.size === 1,
  "canonical tile mount did not publish one dense instanced field");
const mesh = mount.chunkMeshes()[0];
assert(mesh.frustumCulled && mesh.name === "limina:grass-field-tile", "field mount lost bounded culling or canonical identity");
tile.paintW!.fill(0);
mount.refreshAll();
assert(mount.bladeCount() === 0 && mount.chunkCount() === 0 && scene.children.size === 0,
  "paint removal did not retire the field atomically");
mount.dispose();
assert(scene.children.size === 0, "field disposal retained a scene mount");

// Paint-driven render state remains scene-direct and adds no ECS entities in authoritative mode.
const ecs = createEcsWorld();
const stub = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const context: WorldContext = {
  ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
  entities: new EntityTable(), tags: new Map(), scene: stub, camera, ops, mode: "headless",
};
const registry = new SkillRegistry(new LiminaTracer("ses_p_grass"));
registerTerrainEditSkills(registry, new Map());
const permissions = resolveProfile("builder.readWrite");
const at = (tick: number) => ({ agentId: "a", sessionId: "ses_p_grass", permissions, tick, world: context });
const created = await registry.invoke("terrain.create", { size: 100, resolution: 33 }, at(1));
assert(created.success, `terrain.create failed before the zero-entity-growth assertion (${created.success ? "unknown" : created.error.message})`);
const painted = await registry.invoke("terrain.paint", { center: [0, 0], radius: 30, strength: 1, material: "grass" }, at(2));
assert(painted.success, `terrain.paint failed before the zero-entity-growth assertion (${painted.success ? "unknown" : painted.error.message})`);
const paintedEntityCount = [...context.entities.ids()].length;
assert(paintedEntityCount === 1, `painted grass added entities beyond its terrain layer (${paintedEntityCount})`);

ops.op_log("[js] p_grass OK: grass visuals are package-selected; cinematic declares 525k modeled blades at 260 near/72 middle-distance blades/m2; visual acceptance remains human-reviewed; canonical tile mounts refresh/dispose atomically; paint-driven grass adds zero ECS entities.");
