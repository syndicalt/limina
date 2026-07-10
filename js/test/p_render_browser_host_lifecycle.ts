import * as THREE from "../build/three.bundle.mjs";
import { disposeRenderWorldScene, RENDER_RESOURCE_HOST_LIFETIME } from "../src/render/browser-host.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_render_browser_host_lifecycle FAIL: ${message}`);
}

const scene = new THREE.Scene();
const ownedGeometry = new THREE.BoxGeometry();
const ownedTexture = new THREE.Texture();
const ownedMaterial = new THREE.MeshStandardMaterial({ map: ownedTexture });
const hostedGeometry = new THREE.BoxGeometry();
const hostedTexture = new THREE.Texture();
const hostedMaterial = new THREE.MeshStandardMaterial({ map: hostedTexture });
hostedGeometry.userData.liminaLifetime = RENDER_RESOURCE_HOST_LIFETIME;
hostedMaterial.userData.liminaLifetime = RENDER_RESOURCE_HOST_LIFETIME;
hostedTexture.userData.liminaLifetime = RENDER_RESOURCE_HOST_LIFETIME;
const ownedMesh = new THREE.Mesh(ownedGeometry, ownedMaterial);
const duplicateMesh = new THREE.Mesh(ownedGeometry, ownedMaterial);
const hostedMesh = new THREE.Mesh(hostedGeometry, hostedMaterial);
const ownedLight = new THREE.PointLight();
scene.add(ownedMesh, duplicateMesh, hostedMesh, ownedLight);
const backgroundTexture = new THREE.Texture();
const overrideMaterial = new THREE.MeshStandardMaterial();
scene.background = backgroundTexture;
scene.overrideMaterial = overrideMaterial;

const counts = { geometry: 0, material: 0, texture: 0, background: 0, override: 0, light: 0, hosted: 0, errors: 0 };
ownedGeometry.dispose = () => { counts.geometry++; throw new Error("injected geometry failure"); };
ownedMaterial.dispose = () => { counts.material++; };
ownedTexture.dispose = () => { counts.texture++; };
hostedGeometry.dispose = () => { counts.hosted++; };
hostedMaterial.dispose = () => { counts.hosted++; };
hostedTexture.dispose = () => { counts.hosted++; };
backgroundTexture.dispose = () => { counts.background++; };
overrideMaterial.dispose = () => { counts.override++; };
ownedLight.dispose = () => { counts.light++; };
disposeRenderWorldScene(scene, () => { counts.errors++; });
assert(counts.geometry === 1 && counts.material === 1 && counts.texture === 1, "per-world resources were not identity-deduped and disposed once");
assert(counts.background === 1 && counts.override === 1, "scene-level background or override material escaped disposal");
assert(counts.light === 1, "authored light or shadow resources escaped world disposal");
assert(counts.hosted === 0, "host-lifetime cache resources were disposed with one world");
assert(counts.errors === 1, "cleanup failure was hidden or aborted later cleanup");
assert(scene.children.length === 0, "disposed world scene retained children");

console.log("p_render_browser_host_lifecycle OK: world geometry/material/texture/light resources dispose once while host cache resources survive");
