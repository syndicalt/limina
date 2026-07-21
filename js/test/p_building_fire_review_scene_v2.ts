import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import type { WorldContext } from "../src/skills/registry.ts";
import { mountBuildingFireReview } from "../src/render/building-fire-review-scene.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_building_fire_review_scene_v2 FAIL: ${message}`);
}

const worldOps: EngineOps = ops;
const authority = JSON.parse(new TextDecoder().decode(worldOps.op_read_asset(
  "assets/buildings/authoring/functional-hall-house-v4/fire-r4/fire-review-authority-r7.json")));
const ecs = createEcsWorld(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(55, 16 / 9, .05, 100);
const world = { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
  entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless", simWorker: false } as unknown as WorldContext;
worldOps.op_physics_create_world(0);

const mount = await mountBuildingFireReview(world, authority);
assert(mount.authority.schema === "limina.building-fire-review-authority/v4"
  && mount.trace.packageId === "fire/functional-hall-house-v4/v4" && mount.trace.timestampQueriesEnabled === false,
"mount trace does not bind the exact volumetric V1 authority");
assert(mount.composition.inventory.instances === 7 && mount.inventory.fuelPlacedAtIdentity
  && mount.inventory.fuelMaterialsDarkNonEmissive && mount.inventory.fire.flameVolumes === 1
  && mount.inventory.fire.flameLayers === 0 && mount.inventory.fire.flameRibbons === 0
  && mount.inventory.fire.flameRepresentation === "three-fire-derived-volume-raymarch/v1"
  && mount.inventory.fire.fragmentWorkPerCoveredPixel === 96,
"approved C1 context, identity fuel, or volumetric binding inventory drifted");
const volume = mount.binding.root.getObjectByName("limina:flame/volume-main") as THREE.Mesh | undefined;
assert(volume instanceof THREE.Mesh && volume.material instanceof THREE.MeshBasicNodeMaterial
  && volume.material.depthTest && !volume.material.depthWrite, "review mount lost the depth-safe volumetric TSL fire");
const initial = mount.snapshot(); assert(mount.start(), "volumetric fire start command was not accepted");
const burn = mount.advanceTicks(120); assert(burn.phase === "burning" && burn.envelope === 1
  && volume.userData.liminaAuthoritativeTimeSeconds === 2 && volume.userData.liminaAuthoritativeEnvelope === 1,
"review runtime did not drive exact volumetric burn state");
mount.restore(initial); assert(volume.userData.liminaAuthoritativeTimeSeconds === 0
  && volume.userData.liminaAuthoritativeEnvelope === 0, "review snapshot did not restore volumetric off state");
mount.setDynamicFireVisible(false); assert(!mount.binding.visible && !mount.binding.light.visible,
"paired volumetric baseline did not hide geometry and light together");
mount.setDynamicFireVisible(true); assert(mount.binding.visible && !mount.binding.light.visible,
"restored off-state volumetric candidate incorrectly lit the context");
await mount.dispose(); await mount.dispose();
assert(mount.disposed && world.entities.ids().length === 0 && scene.children.length === 0,
"idempotent volumetric review disposal leaked engine entities or render resources");

console.log("p_building_fire_review_scene_v2 OK: exact fire-r4+C1 closure, engine fuel placement, deterministic volumetric controls, paired visibility, and idempotent CPU lifecycle are proven");
