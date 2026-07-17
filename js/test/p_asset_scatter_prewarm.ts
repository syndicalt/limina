import { gltfAssetIdsForCommand } from "../src/browser-entry.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_asset_scatter_prewarm FAIL: ${message}`);
}

const scatter = gltfAssetIdsForCommand({
  kind: "skill",
  tool: "asset.scatter",
  input: {
    regionId: "rgn",
    config: {
      assets: [
        { id: "vegetation/oak-lod0.glb", lods: [{ id: "vegetation/oak-lod1.glb" }, { id: "vegetation/oak-lod2.glb" }] },
        { id: "vegetation/pine-lod0.glb", treeLod: { reducedId: "vegetation/pine-lod1.glb", impostorId: "vegetation/pine-impostor.glb" } },
        { id: "vegetation/fern.glb" },
      ],
    },
  },
} as never);
assert(JSON.stringify(scatter) === JSON.stringify([
  "vegetation/oak-lod0.glb", "vegetation/oak-lod1.glb", "vegetation/oak-lod2.glb",
  "vegetation/pine-lod0.glb", "vegetation/pine-lod1.glb", "vegetation/pine-impostor.glb", "vegetation/fern.glb",
]), "asset.scatter did not expose every base and LOD asset in stable palette order");

const biome = gltfAssetIdsForCommand({
  kind: "skill",
  tool: "world.populateBiome",
  input: {
    regionId: "rgn",
    biomePack: {
      broadleaf: { id: "vegetation/oak-lod0.glb", lods: [{ id: "vegetation/oak-lod1.glb" }] },
      conifer: { id: "vegetation/pine-lod0.glb", treeLod: { reducedId: "vegetation/pine-lod1.glb", impostorId: "vegetation/pine-impostor.glb" } },
      bush: { id: "vegetation/fern.glb" },
    },
  },
} as never);
assert(JSON.stringify(biome) === JSON.stringify([
  "vegetation/oak-lod0.glb", "vegetation/oak-lod1.glb", "vegetation/pine-lod0.glb",
  "vegetation/pine-lod1.glb", "vegetation/pine-impostor.glb", "vegetation/fern.glb",
]), "world.populateBiome did not expose nested scatter assets");

const hostile = gltfAssetIdsForCommand({
  kind: "skill",
  tool: "asset.scatter",
  input: { config: { assets: [null, 7, {}, { id: "" }, { id: "ok.glb", lods: [null, {}, { id: "" }, { id: "ok-lod.glb" }] }] } },
} as never);
assert(JSON.stringify(hostile) === JSON.stringify(["ok.glb", "ok-lod.glb"]),
  "prewarm discovery leaked malformed or empty ids");

const vegetationInline = gltfAssetIdsForCommand({ kind: "skill", tool: "vegetation.scatter", input: {
  assets: [{ id: "trees/oak.glb", treeLod: { reducedId: "trees/oak-lod.glb", reducedDistance: 80,
    impostorId: "trees/oak-impostor.glb", impostorDistance: 280, cullDistance: 1200 } }],
} } as never);
assert(JSON.stringify(vegetationInline) === JSON.stringify(["trees/oak.glb", "trees/oak-lod.glb", "trees/oak-impostor.glb"]),
  "vegetation.scatter inline tree chain was not fully prewarmed");

const vegetationPack = gltfAssetIdsForCommand({ kind: "skill", tool: "vegetation.scatter", input: { species: ["oak"] } } as never, {
  oak: [{ id: "trees/pack-oak.glb", treeLod: { reducedId: "trees/pack-oak-lod.glb", reducedDistance: 80,
    impostorId: "trees/pack-oak-impostor.glb", impostorDistance: 280, cullDistance: 1200 } }],
});
assert(JSON.stringify(vegetationPack) === JSON.stringify(["trees/pack-oak.glb", "trees/pack-oak-lod.glb", "trees/pack-oak-impostor.glb"]),
  "vegetation.scatter pack tree chain was not fully prewarmed");

const functionalBuilding = gltfAssetIdsForCommand({ kind: "skill", tool: "building.placeFunctional", input: { assetId: "buildings/hall.glb" } } as never);
const functionalFurniture = gltfAssetIdsForCommand({ kind: "skill", tool: "furniture.placeFunctional", input: { assetId: "furniture/settle.glb" } } as never);
assert(JSON.stringify(functionalBuilding) === JSON.stringify(["buildings/hall.glb"]), "functional building bytes were not discovered for prewarm");
assert(JSON.stringify(functionalFurniture) === JSON.stringify(["furniture/settle.glb"]), "functional furniture bytes were not discovered for prewarm");

console.log("p_asset_scatter_prewarm OK: asset, biome, functional-building/furniture, and vegetation GLBs are discovered before the render session");
