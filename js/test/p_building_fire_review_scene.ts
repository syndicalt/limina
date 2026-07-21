import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import type { WorldContext } from "../src/skills/registry.ts";
import { mountBuildingFireReview } from "../src/render/building-fire-review-scene.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_building_fire_review_scene FAIL: ${message}`);
}

const worldOps: EngineOps = ops;
const authority = JSON.parse(new TextDecoder().decode(worldOps.op_read_asset(
  "assets/buildings/authoring/functional-hall-house-v4/fire-r1/fire-review-authority-r3.json")));
const ecs = createEcsWorld(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(55, 16 / 9, .05, 100);
const world = { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
  entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless", simWorker: false } as unknown as WorldContext;
worldOps.op_physics_create_world(0);

const mount = await mountBuildingFireReview(world, authority);
assert(mount.authority.schema === "limina.building-fire-review-authority/v1"
  && mount.trace.packageId === "fire/functional-hall-house-v4/v1" && mount.trace.timestampQueriesEnabled === false,
  "mount trace does not bind the exact verified V1 authority");
assert(mount.composition.inventory.instances === 7 && mount.inventory.fuelPlacedAtIdentity
  && mount.inventory.fuelMaterialsDarkNonEmissive && mount.inventory.fuelMaterialOverrides > 0,
  "approved C1 context, identity fuel, or material override inventory drifted");
const fuelRoot = world.entities.resolve(mount.fuelEntity)?.mesh as THREE.Object3D | undefined;
assert(fuelRoot !== undefined && fuelRoot.position.equals(new THREE.Vector3())
  && fuelRoot.rotation.x === 0 && fuelRoot.rotation.y === 0 && fuelRoot.rotation.z === 0
  && fuelRoot.scale.equals(new THREE.Vector3(1, 1, 1)), "fuel did not remain at identity");
let darkEmbers = 0; fuelRoot.traverse((object) => {
  if (!(object instanceof THREE.Mesh)) return; const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) if (material.userData.liminaRuntimeMaterialOverride === "hearth-embers-dark-non-emissive/v1") {
    const value = material as THREE.MeshStandardMaterial; assert(value.emissiveIntensity === 0 && value.emissive.equals(new THREE.Color(0, 0, 0)),
      "fuel hearth-embers override is still emissive"); darkEmbers++;
  }
});
assert(darkEmbers > 0, "fuel GLB did not receive the attested dark coal substrate override");
assert(mount.runtime.tick === 0 && mount.runtime.phase === "off" && mount.binding.light.intensity === 0,
  "review mount did not begin at canonical off tick zero");
const initial = mount.snapshot(); assert(mount.start(), "start command was not accepted");
const ignition = mount.advanceTicks(45); assert(ignition.tick === 45 && ignition.phase === "igniting" && ignition.envelope > 0,
  "deterministic ignition advance drifted");
const replay = mount.restore(initial); assert(replay.tick === 0 && replay.phase === "off" && replay.envelope === 0,
  "snapshot restore did not return to canonical off state");
mount.setDynamicFireVisible(false); assert(!mount.binding.visible && !mount.binding.light.visible,
  "paired dynamic-fire visibility left the light visible");
mount.setDynamicFireVisible(true); assert(mount.binding.visible && !mount.binding.light.visible,
  "restored off-state dynamic pair incorrectly lit the context");
await mount.dispose(); await mount.dispose();
assert(mount.disposed && world.entities.ids().length === 0 && scene.children.length === 0,
  "idempotent review disposal leaked engine entities or direct scene resources");
let rejected = false; try { mount.advanceTicks(1); } catch { rejected = true; }
assert(rejected, "disposed review mount accepted deterministic state mutation");

console.log("p_building_fire_review_scene OK: exact V1+C1 closure, engine asset.place identity fuel, dark substrate override, deterministic controls, paired visibility, and idempotent CPU lifecycle are proven");
