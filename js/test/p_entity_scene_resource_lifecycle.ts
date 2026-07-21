import * as THREE from "../build/three.bundle.mjs";
import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { disposeEntitySceneResources } from "../src/render/entity-scene-resources.ts";
import { teardownEntity } from "../src/skills/entity-teardown.ts";
import type { WorldContext } from "../src/skills/registry.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_entity_scene_resource_lifecycle FAIL: ${message}`);
}

const root = new THREE.Group();
const ownedGeometry = new THREE.BufferGeometry();
const ownedTexture = new THREE.Texture();
const ownedMaterial = new THREE.MeshStandardMaterial({ map: ownedTexture });
const sharedGeometry = new THREE.BufferGeometry();
const sharedTexture = new THREE.Texture();
const sharedMaterial = new THREE.MeshStandardMaterial({ map: sharedTexture });
sharedGeometry.userData.liminaLifetime = "host";
sharedTexture.userData.liminaLifetime = "host";
sharedMaterial.userData.liminaLifetime = "host";

root.add(
  new THREE.Mesh(ownedGeometry, [ownedMaterial, ownedMaterial]),
  new THREE.Mesh(sharedGeometry, sharedMaterial),
);

let ownedGeometryDisposals = 0;
let ownedTextureDisposals = 0;
let ownedMaterialDisposals = 0;
let sharedGeometryDisposals = 0;
let sharedTextureDisposals = 0;
let sharedMaterialDisposals = 0;
ownedGeometry.dispose = () => { ownedGeometryDisposals += 1; };
ownedTexture.dispose = () => { ownedTextureDisposals += 1; };
ownedMaterial.dispose = () => { ownedMaterialDisposals += 1; };
sharedGeometry.dispose = () => { sharedGeometryDisposals += 1; };
sharedTexture.dispose = () => { sharedTextureDisposals += 1; };
sharedMaterial.dispose = () => { sharedMaterialDisposals += 1; };

disposeEntitySceneResources(root);
assert(ownedGeometryDisposals === 1, `owned geometry disposed ${ownedGeometryDisposals} times`);
assert(ownedTextureDisposals === 1, `owned texture disposed ${ownedTextureDisposals} times`);
assert(ownedMaterialDisposals === 1, `owned material disposed ${ownedMaterialDisposals} times`);
assert(sharedGeometryDisposals === 0, "host-owned geometry was disposed");
assert(sharedTextureDisposals === 0, "host-owned texture was disposed");
assert(sharedMaterialDisposals === 0, "host-owned material was disposed");

// One broken disposer cannot prevent the rest of the subtree from being released.
const faultyRoot = new THREE.Group();
const faultyGeometry = new THREE.BufferGeometry();
const faultyMaterial = new THREE.MeshStandardMaterial();
faultyRoot.add(new THREE.Mesh(faultyGeometry, faultyMaterial));
let faultyGeometryAttempts = 0;
let faultyMaterialAttempts = 0;
faultyMaterial.dispose = () => { faultyMaterialAttempts += 1; throw new Error("injected material failure"); };
faultyGeometry.dispose = () => { faultyGeometryAttempts += 1; throw new Error("injected geometry failure"); };
let failure: unknown;
try { disposeEntitySceneResources(faultyRoot); } catch (error) { failure = error; }
assert(failure instanceof AggregateError, "resource failures were not aggregated");
assert(faultyMaterialAttempts === 1 && faultyGeometryAttempts === 1, "a disposal failure aborted remaining cleanup");

// Canonical entity teardown keeps progressing when scene detachment fails.
ops.op_physics_create_world(-9.81);
const throwingScene = {
  add() {},
  remove() { throw new Error("injected scene removal failure"); },
  position: { set() {}, x: 0, y: 0, z: 0 },
  background: null,
} as unknown as WorldContext["scene"];
const context = createHeadlessContext({
  scene: throwingScene,
  session: "ses_entity_resource_lifecycle",
  agentId: "agt_entity_resource_lifecycle",
});
const created = await context.registry.invoke(
  "scene.createEntity",
  { shape: "box", size: 1, position: [0, 0, 0] },
  context.base,
);
assert(created?.success === true, "failed to create canonical teardown fixture");
const entity = (created.result as { entity: string }).entity;
const entry = context.world.entities.resolve(entity);
assert(entry?.mesh !== undefined, "canonical teardown fixture has no scene object");
const entityMesh = entry.mesh as unknown as { geometry: { dispose(): void }; material: { dispose(): void } };
let entityGeometryDisposals = 0;
let entityMaterialDisposals = 0;
let runtimeDisposals = 0;
if (entry !== undefined) entry.runtimeDispose = () => { runtimeDisposals += 1; throw new Error("injected runtime-disposer failure"); };
entityMesh.geometry.dispose = () => { entityGeometryDisposals += 1; };
entityMesh.material.dispose = () => { entityMaterialDisposals += 1; };
let teardownFailure: unknown;
try { teardownEntity(context.world, entity); } catch (error) { teardownFailure = error; }
assert(teardownFailure instanceof AggregateError, "canonical teardown did not surface the injected detach failure");
assert(context.world.entities.resolve(entity) === undefined, "detach failure left the entity-table identity live");
assert(entityGeometryDisposals === 1 && entityMaterialDisposals === 1, "detach failure aborted owned-resource cleanup");
assert(runtimeDisposals === 1, "canonical teardown did not invoke the runtime-only disposer exactly once");

console.log("p_entity_scene_resource_lifecycle OK: entity-owned geometry/material/texture disposal is exact, host cache resources survive, runtime-only disposal runs exactly once, and failures aggregate only after complete cleanup");
