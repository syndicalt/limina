import * as THREE from "../build/three.bundle.mjs";
import { ops } from "../src/engine.ts";
import { BuildingFireRuntime } from "../src/render/building-fire-runtime.ts";
import { createBuildingFireRenderBinding, type BuildingFireRenderContract } from "../src/render/building-fire-render-binding.ts";
import { createBuildingFireDensityTexture } from "../src/render/building-fire-volumetric.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_building_fire_volumetric_binding FAIL: ${message}`);
}

function hashPixels(texture: THREE.DataTexture): number {
  const data = texture.image.data as Uint8Array; let hash = 2166136261;
  for (const byte of data) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const contract = JSON.parse(decoder.decode(ops.op_read_asset(
  "assets/buildings/authoring/functional-hall-house-v4/fire-r2/fire-runtime-contract.json"))) as BuildingFireRenderContract;
const textureA = createBuildingFireDensityTexture(128, 192), textureB = createBuildingFireDensityTexture(128, 192);
assert(hashPixels(textureA) === hashPixels(textureB) && hashPixels(textureA) !== 0
  && textureA.image.data.length === 128 * 192 * 4, "analytic density texture is not exact and deterministic");
textureA.dispose(); textureB.dispose();

const parent = new THREE.Group(), binding = createBuildingFireRenderBinding({ parent, contract });
assert(binding.inventory.flameVolumes === 1 && binding.inventory.flameLayers === 0 && binding.inventory.flameRibbons === 0
  && binding.inventory.flameRepresentation === "three-fire-derived-volume-raymarch/v1"
  && binding.inventory.volumeProxyTriangles === 12 && binding.inventory.fragmentWorkPerCoveredPixel === 96
  && binding.inventory.volumeTextures === 1 && binding.inventory.predictedDrawCalls === 2,
"binding inventory does not prove the bounded volumetric representation and work budget");
const volume = binding.root.getObjectByName("limina:flame/volume-main") as THREE.Mesh | undefined;
assert(volume instanceof THREE.Mesh && volume.geometry.type === "BoxGeometry"
  && volume.material instanceof THREE.MeshBasicNodeMaterial && volume.material.depthTest === true
  && volume.material.depthWrite === false && volume.material.transparent === true
  && volume.material.side === THREE.FrontSide
  && volume.material.userData.liminaRayEntrySurface === "camera-facing-front-face"
  && volume.material.userData.liminaAuthoritativeTimeOnly === true,
"volumetric fire is not a depth-safe authoritative TSL box raymarch");
assert(!binding.root.children.some((child) => child.name.includes("inner-") || child.name.includes("outer-")),
  "superseded ribbon flame meshes leaked into fire r2");

const runtime = new BuildingFireRuntime({ seed: contract.simulation.seed,
  ignitionTicks: contract.simulation.parameters.ignitionTicks,
  extinguishTicks: contract.simulation.parameters.extinguishTicks,
  lightBaseCandela: contract.simulation.parameters.lightBaseCandela,
  lightFlickerCandela: contract.simulation.parameters.lightFlickerCandela,
  lightDistanceM: contract.simulation.parameters.lightDistanceM, binding });
assert(volume.userData.liminaAuthoritativeTimeSeconds === 0 && volume.userData.liminaAuthoritativeEnvelope === 0,
  "volume did not begin at the canonical authoritative off state");
runtime.start(); const sample = runtime.advanceTicks(120);
assert(volume.userData.liminaAuthoritativeTimeSeconds === sample.authoritativeTimeSeconds
  && volume.userData.liminaAuthoritativeEnvelope === sample.envelope && sample.envelope === 1,
"fixed-tick runtime did not drive exact volume time and envelope uniforms");
const snapshot = runtime.snapshot(); runtime.advanceTicks(37); runtime.restore(snapshot);
assert(volume.userData.liminaAuthoritativeTimeSeconds === snapshot.state.tick / 60
  && volume.userData.liminaAuthoritativeEnvelope === 1, "snapshot restore did not replay exact volumetric authority");

const density = (volume.material as THREE.Material & { fragmentNode?: unknown }).fragmentNode;
assert(density !== undefined, "volumetric material lost its TSL fragment graph");
let textureDisposals = 0, volumeGeometryDisposals = 0, volumeMaterialDisposals = 0;
const ownedDensityTexture = volume.material.userData.liminaOwnedDensityTexture as THREE.DataTexture | undefined;
assert(ownedDensityTexture instanceof THREE.DataTexture, "volume did not expose its exact owned density resource for lifecycle evidence");
ownedDensityTexture.addEventListener("dispose", () => { textureDisposals++; });
volume.geometry.addEventListener("dispose", () => { volumeGeometryDisposals++; });
volume.material.addEventListener("dispose", () => { volumeMaterialDisposals++; });
runtime.dispose(); runtime.dispose();
assert(binding.disposed && parent.children.length === 0 && volumeGeometryDisposals === 1 && volumeMaterialDisposals === 1
  && textureDisposals === 1, "volumetric binding lifecycle did not remove and dispose owned render resources exactly once");

console.log("p_building_fire_volumetric_binding OK: deterministic THREE.Fire-derived density, fixed-tick volume authority, depth occlusion, structural budgets, snapshot replay, and idempotent CPU lifecycle are proven");
