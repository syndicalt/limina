import * as THREE from "../build/three.bundle.mjs";
import { buildTreeFoliageMaterial } from "../src/render/tree-foliage-material.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_tree_foliage_material FAIL: ${message}`);
}
function rejects(operation: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown; try { operation(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${String(error)}`);
}

const albedo = new THREE.Texture(), normal = new THREE.Texture(), roughness = new THREE.Texture(), alpha = new THREE.Texture();
for (const texture of [albedo, normal, roughness, alpha]) texture.colorSpace = THREE.LinearSRGBColorSpace;
const source = new THREE.MeshStandardMaterial({ color: 0x7cab52, roughness: 0.78, metalness: 0.02, map: albedo,
  normalMap: normal, roughnessMap: roughness, alphaMap: alpha, alphaTest: 0.2, transparent: true, opacity: 0.92 });
source.name = "oak-leaves"; source.userData = { liminaLifetime: "host", provenance: "fixture" };
const foliage = buildTreeFoliageMaterial(source, { alphaCutoff: 0.48, sssStrength: 0.3, sunDirection: { x: 1, y: 2, z: 3 } });
assert(foliage.isMeshStandardNodeMaterial && foliage.map === albedo && foliage.normalMap === normal && foliage.roughnessMap === roughness && foliage.alphaMap === alpha,
  "foliage conversion dropped a host-owned PBR texture");
assert(albedo.colorSpace === THREE.SRGBColorSpace && normal.colorSpace === THREE.NoColorSpace && roughness.colorSpace === THREE.NoColorSpace && alpha.colorSpace === THREE.NoColorSpace,
  "foliage texture color-space discipline is wrong");
assert(foliage.side === THREE.DoubleSide && foliage.alphaTest === 0.48 && !foliage.transparent && foliage.depthWrite,
  "foliage did not enforce double-sided alpha-cutout rendering");
assert(foliage.color.getHex() === source.color.getHex() && foliage.roughness === source.roughness && foliage.metalness === source.metalness,
  "foliage conversion changed the base PBR factors");
assert(foliage.emissiveNode !== null && foliage.userData.liminaTreeFoliage.graph === "pure-tsl-backscatter/1",
  "foliage backscatter TSL graph/evidence is missing");
assert(foliage.userData.liminaLifetime === undefined && foliage.userData.provenance === "fixture", "new material inherited host ownership or lost provenance");

const nodeSource = new THREE.MeshStandardNodeMaterial({ color: 0x448833 });
const customColor = THREE.TSL.vec3(0.1, 0.6, 0.2), customNormal = THREE.TSL.vec3(0, 0, 1);
nodeSource.colorNode = customColor; nodeSource.normalNode = customNormal;
const nodeFoliage = buildTreeFoliageMaterial(nodeSource);
assert(nodeFoliage.colorNode === customColor && nodeFoliage.normalNode === customNormal, "foliage conversion dropped an existing node-material surface graph");
assert(nodeFoliage.emissiveNode !== null, "node-material foliage has no combined backscatter graph");

rejects(() => buildTreeFoliageMaterial(new THREE.MeshBasicMaterial() as never), /MeshStandardMaterial/, "non-PBR foliage source was accepted");
rejects(() => buildTreeFoliageMaterial(source, { alphaCutoff: 1 }), /alphaCutoff/, "invalid alpha cutoff was accepted");
rejects(() => buildTreeFoliageMaterial(source, { sunDirection: { x: 0, y: 0, z: 0 } }), /sunDirection/, "zero sun direction was accepted");

let materialDisposals = 0, textureDisposals = 0;
foliage.addEventListener("dispose", () => { materialDisposals++; }); albedo.addEventListener("dispose", () => { textureDisposals++; });
foliage.dispose();
assert(materialDisposals === 1 && textureDisposals === 0, "world-owned foliage disposal released a host-owned atlas texture");

console.log("p_tree_foliage_material OK: glTF PBR channels survive, alpha cutout/color spaces are enforced, pure-TSL backscatter composes with existing node graphs, ownership remains exact, and invalid inputs fail closed");
