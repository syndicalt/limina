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

// A role bound to weighted archetype VARIANTS must prewarm EVERY variant — including each
// variant's lods/treeLod chain (the seeded pick decides per instance, so all can mount).
const biomeVariants = gltfAssetIdsForCommand({
  kind: "skill",
  tool: "world.populateBiome",
  input: {
    regionId: "rgn",
    biomePack: {
      conifer: { variants: [
        { id: "vegetation/pine-1.glb", weight: 3 },
        { id: "vegetation/pine-2.glb", lods: [{ id: "vegetation/pine-2-lod1.glb" }] },
        { id: "vegetation/spruce-1.glb", treeLod: { reducedId: "vegetation/spruce-1-lod.glb", impostorId: "vegetation/spruce-1-impostor.glb" } },
      ] },
      boulder: { id: "vegetation/rock.glb" },
    },
  },
} as never);
assert(JSON.stringify(biomeVariants) === JSON.stringify([
  "vegetation/pine-1.glb", "vegetation/pine-2.glb", "vegetation/pine-2-lod1.glb",
  "vegetation/spruce-1.glb", "vegetation/spruce-1-lod.glb", "vegetation/spruce-1-impostor.glb",
  "vegetation/rock.glb",
]), "world.populateBiome did not expose every archetype variant (and its LOD chain) for prewarm");

// Hostile variants shapes must not leak malformed ids or throw.
const biomeHostileVariants = gltfAssetIdsForCommand({
  kind: "skill",
  tool: "world.populateBiome",
  input: { biomePack: { conifer: { variants: [null, 7, {}, { id: "" }, { id: "ok-variant.glb" }] }, bush: { variants: "nope" } } },
} as never);
assert(JSON.stringify(biomeHostileVariants) === JSON.stringify(["ok-variant.glb"]),
  "variants prewarm discovery leaked malformed or empty ids");

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
