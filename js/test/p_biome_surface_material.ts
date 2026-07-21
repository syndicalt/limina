import * as THREE from "../build/three.bundle.mjs";
import { buildBiomeSurfaceMaterial } from "../src/terrain/biome-surface-material.ts";
import { SURFACE_COMPOSITE_POLICY_VERSION, SURFACE_COMPOSITE_TILE_SCHEMA } from "../src/world/surface-composite-tile.mjs";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`p_biome_surface_material FAIL: ${message}`); }
const bytes = (r: number, g: number, b: number) => new Uint8Array(Array.from({ length: 64 }, (_, index) => [r, g, b, 255][index % 4]));
const artifact = { schema: SURFACE_COMPOSITE_TILE_SCHEMA, source: { biomeFieldHash: "field", biomePackHash: "pack", terrainChunkHash: "terrain", policyVersion: SURFACE_COMPOSITE_POLICY_VERSION },
  coord: { tx: -1, tz: 2, lod: 0 }, placement: { sizeM: 48 }, resolution: { interior: 2, gutter: 1, total: 4 },
  maps: { albedo: { data: bytes(80, 120, 60) }, normal: { data: bytes(128, 128, 255) },
    orm: { data: bytes(230, 190, 0), channels: "ao-roughness-metalness-grass-density" } },
  diagnostics: { runtimeTextureSamples: 3 } };
const first = buildBiomeSurfaceMaterial(artifact), second = buildBiomeSurfaceMaterial({ ...artifact, coord: { tx: 3, tz: 4, lod: 0 } });
assert(first.textures.length === 3 && first.textures[0].colorSpace === THREE.SRGBColorSpace
  && first.textures[1].colorSpace === THREE.NoColorSpace && first.textures[2].colorSpace === THREE.NoColorSpace,
"three-map ownership or color-space discipline failed");
const meta = first.material.userData.liminaBiomeSurface as any;
assert(meta.textureSamples === 3 && meta.oneGraph && meta.featureLocalUv && meta.shorelineMaskChannel === "albedo.a"
  && meta.grassDensityChannel === "orm.a" && meta.grassSurfacePresentation === "cpu-composited-density-turf/v1",
  "material did not lock the one-graph/three-sample shoreline and far-grass contract");
function graphShape(root: any): string[] {
  const seen = new Set<any>(), result: string[] = [];
  const visit = (node: any) => { if (!node || typeof node !== "object" || seen.has(node)) return; seen.add(node);
    if (node.isNode) result.push(node.constructor?.name ?? "Node");
    if (typeof node.getChildren === "function") for (const child of node.getChildren()) visit(child);
  };
  for (const node of [root.colorNode, root.normalNode, root.aoNode, root.roughnessNode, root.metalnessNode]) visit(node);
  return result.sort();
}
assert(JSON.stringify(graphShape(first.material)) === JSON.stringify(graphShape(second.material)), "tile texture identity changed material graph topology");
const textureNodes = new Set<any>();
for (const root of [first.material.colorNode, first.material.normalNode, first.material.aoNode, first.material.roughnessNode, first.material.metalnessNode]) {
  const seen = new Set<any>(); const visit = (node: any) => { if (!node || typeof node !== "object" || seen.has(node)) return; seen.add(node);
    if (node.isTextureNode) textureNodes.add(node.value); if (typeof node.getChildren === "function") for (const child of node.getChildren()) visit(child); }; visit(root);
}
assert(textureNodes.size === 3, `material graph references ${textureNodes.size} textures instead of exactly three`);
let materialDisposals = 0, textureDisposals = 0;
first.material.addEventListener("dispose", () => materialDisposals++); for (const owned of first.textures) owned.addEventListener("dispose", () => textureDisposals++);
first.dispose(); first.dispose(); second.dispose();
assert(materialDisposals === 1 && textureDisposals === 3, "owned surface resources were not disposed exactly once");
console.log("p_biome_surface_material OK: one pure-TSL MeshStandard graph samples exactly albedo/normal/ORM with feature-local UVs and exact ownership");
