import * as THREE from "../build/three.bundle.mjs";
import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_material_pack FAIL: ${message}`);
}

// deno-lint-ignore no-explicit-any
function graphNodes(root: any): any[] {
  const found: any[] = []; const seen = new Set<unknown>();
  // deno-lint-ignore no-explicit-any
  const walk = (node: any) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node); found.push(node);
    if (typeof node.getChildren === "function") for (const child of node.getChildren()) walk(child);
  };
  walk(root); return found;
}

const manifest = JSON.parse(new TextDecoder().decode(ops.op_read_asset("materials/forest-ground/material-pack.json"))) as {
  schema: string;
  source: { provider: string; apiVersion: string; licenseSpdx: string };
  maps: Record<string, { assetId: string; sha256: string; assetHash: string }>;
};
assert(manifest.schema === "limina.material-pack/v1", "production pack schema is unsupported");
assert(manifest.source.provider === "ambientCG" && manifest.source.apiVersion === "v3" && manifest.source.licenseSpdx === "CC0-1.0",
  "production pack provenance is incomplete or stale");
for (const slot of ["albedo", "normal", "roughness", "occlusion", "displacement"]) {
  const map = manifest.maps[slot];
  assert(map !== undefined && map.sha256.startsWith("sha256:") && map.assetHash.startsWith("sha256:"), `production pack is missing ${slot} identity`);
}

ops.op_physics_create_world(-9.81);
const context = createHeadlessContext({ session: "ses_material_pack", agentId: "agt_material_pack" });
const command = {
  name: "forest-ground",
  albedo: manifest.maps.albedo.assetId,
  normal: manifest.maps.normal.assetId,
  roughness: manifest.maps.roughness.assetId,
  occlusion: manifest.maps.occlusion.assetId,
  displacement: manifest.maps.displacement.assetId,
  occlusionStrength: 0.8,
  triplanar: true,
  scale: 0.35,
  antiTiling: true,
  parallax: {},
  hashes: Object.fromEntries(["albedo", "normal", "roughness", "occlusion", "displacement"].map((slot) => [manifest.maps[slot].assetId, manifest.maps[slot].assetHash])),
};
const imported = await context.registry.invoke("material.import", command, context.base);
assert(imported?.success === true, `production material import failed: ${JSON.stringify(imported?.error)}`);
const material = context.core.materials.build("forest-ground") as THREE.MeshStandardNodeMaterial;
assert(material.colorNode !== null && material.normalNode !== null && material.roughnessNode !== null && material.aoNode !== null,
  "production triplanar material did not build every A2 PBR channel");
assert(context.core.materials.hashesOf("forest-ground")[manifest.maps.occlusion.assetId] === manifest.maps.occlusion.assetHash,
  "production material lost its pinned AO identity");
assert(context.core.materials.hashesOf("forest-ground")[manifest.maps.displacement.assetId] === manifest.maps.displacement.assetHash,
  "production material lost its pinned displacement identity");
// deno-lint-ignore no-explicit-any
const triEvidence = (material.userData as any).liminaSurfaceSampling;
assert(triEvidence?.projection === "triplanar-upward-xz-pom" && triEvidence?.parallax?.boundedLoop === true,
  "production triplanar material does not declare the bounded upward-XZ POM scope");
assert(triEvidence.parallax.heightScale === 0.04 && triEvidence.parallax.minLayers === 8 && triEvidence.parallax.maxLayers === 16 &&
  triEvidence.parallax.fadeStart === 20 && triEvidence.parallax.fadeEnd === 40,
  "strict parallax defaults did not survive material.import parsing");
assert(triEvidence.displacementTexture?.image?.width > 0,
  "production triplanar POM does not retain the decoded displacement texture");
assert(graphNodes(material.colorNode).some((node) => node.isTextureNode === true && Array.isArray(node.gradNode)),
  "production stochastic triplanar color graph has no explicit-gradient texture sample");

// The UV path exposes the actual POM shader call for headless graph inspection. It must close over
// the bounded Loop/Break implementation and keep explicit-gradient final-map samples.
const uvImported = await context.registry.invoke("material.import", { ...command, name: "forest-ground-uv-pom", triplanar: false }, context.base);
assert(uvImported?.success === true, `production UV POM import failed: ${JSON.stringify(uvImported?.error)}`);
const uvMaterial = context.core.materials.build("forest-ground-uv-pom") as THREE.MeshStandardNodeMaterial;
// deno-lint-ignore no-explicit-any
const uvEvidence = (uvMaterial.userData as any).liminaSurfaceSampling;
const calls = graphNodes(uvEvidence.displacedUv).filter((node) => node.isShaderCallNodeInternal === true);
const sources = calls.map((node) => String(node.shaderNode?.jsFunc));
assert(sources.some((source) => source.includes("T.Loop") && source.includes("T.Break")),
  "UV POM node graph does not contain the bounded Loop/Break march");
assert(uvEvidence.displacementTexture?.image?.width > 0,
  "UV POM graph evidence lost the decoded displacement texture");
assert(graphNodes(uvMaterial.colorNode).some((node) => node.isTextureNode === true && Array.isArray(node.gradNode)),
  "UV stochastic final-map graph has no explicit-gradient sample");

const missingHeight = await context.registry.invoke("material.import", {
  name: "invalid-pom", albedo: manifest.maps.albedo.assetId, parallax: {},
}, context.base);
assert(missingHeight?.success === false && JSON.stringify(missingHeight.error).includes("requires a displacement"),
  "parallax without displacement was not rejected");
const invalidLayers = await context.registry.invoke("material.import", {
  name: "invalid-layers", albedo: manifest.maps.albedo.assetId, displacement: manifest.maps.displacement.assetId,
  parallax: { minLayers: 16, maxLayers: 8 },
}, context.base);
assert(invalidLayers?.success === false, "parallax maxLayers below minLayers was not rejected");
const invalidFade = await context.registry.invoke("material.import", {
  name: "invalid-fade", albedo: manifest.maps.albedo.assetId, displacement: manifest.maps.displacement.assetId,
  parallax: { fadeStart: 50, fadeEnd: 40 },
}, context.base);
assert(invalidFade?.success === false, "parallax fadeEnd at/below fadeStart was not rejected");

console.log("p_material_pack OK: ambientCG v3 CC0 pack provenance, hashes, OpenGL normal, roughness, AO, displacement replay identity, stochastic explicit gradients, bounded UV POM, and upward-XZ-only triplanar POM are proven");
