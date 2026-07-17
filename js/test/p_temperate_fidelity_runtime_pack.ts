import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BIOME_LIBRARY_V1 } from "../src/world/biome-library-v1.mjs";
import { deriveBiomeFieldContentClosure } from "../src/world/biome-field-content-closure.mjs";
import { parseBiomePopulationAsset } from "../src/world/biome-population-asset.mjs";
import { biomeRuntimePackContentHash, parseBiomeRuntimePack } from "../src/world/biome-runtime-pack.mjs";
import { biomeFieldArtifactContentHash } from "../src/world/compiler/biome-field-artifact.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_temperate_fidelity_runtime_pack FAIL: ${message}`);
}

const repo = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const bytes = (assetId: string) => readFile(resolve(repo, "assets", assetId));
const engineHash = (value: Uint8Array): string =>
  `sha256:${createHash("sha256").update(Buffer.from(value).toString("hex")).digest("hex")}`;

const runtimeBytes = await bytes("biomes/temperate-fidelity-runtime-pack.json");
const runtime = parseBiomeRuntimePack(JSON.parse(runtimeBytes.toString()), BIOME_LIBRARY_V1);
assert(runtime.status === "fulfilled", "runtime pack is not structurally fulfilled");
assert(runtime.biomes.map((entry) => entry.biomeId).join(",")
  === "canyon,deep-ocean,grassland,river,temperate-deciduous-forest", "runtime pack does not fulfill the complete locked WorldMap domain");
const grassTurf = runtime.biomes.find((entry) => entry.biomeId === "grassland")!.bindings
  .find((entry) => entry.kind === "surface" && entry.role === "ground/grass-turf");
assert(grassTurf?.assetId === "materials/temperate-grass-turf/material-pack.json"
  && grassTurf.contentHash === "sha256:2317a73ebdba480a3da702e52632dc7d5b8ee73b1cf0fae3485f2065688b2cf6"
  && grassTurf.sourceUri === "https://ambientcg.com/a/Grass001",
  "grass turf is not pinned to the authenticated Grass001 material pack");

let populationBindings = 0;
for (const biome of runtime.biomes) {
  for (const binding of biome.bindings) {
    const boundBytes = await bytes(binding.assetId);
    assert(engineHash(boundBytes) === binding.contentHash,
      `${biome.biomeId}:${binding.kind}:${binding.role} does not pin its exact asset bytes`);
    if (binding.kind === "surface") {
      const materialPack = JSON.parse(boundBytes.toString());
      assert(materialPack.schema === "limina.material-pack/v1", `${binding.role} is not bound to a material pack`);
      for (const map of Object.values(materialPack.maps) as Array<{ assetId: string; assetHash: string }>) {
        assert(engineHash(await bytes(map.assetId)) === map.assetHash, `${binding.role} material map '${map.assetId}' hash drifted`);
      }
      continue;
    }
    populationBindings++;
    const descriptor = parseBiomePopulationAsset(JSON.parse(boundBytes.toString()));
    assert(descriptor.role === binding.role, `${binding.role} descriptor role drifted`);
    if (descriptor.backend === "tree-population") {
      for (const [assetId, contentHash] of [
        [descriptor.sourceAssetId, descriptor.sourceContentHash],
        [descriptor.reducedAssetId, descriptor.reducedContentHash],
        [descriptor.impostorAssetId, descriptor.impostorContentHash],
      ] as const) assert(engineHash(await bytes(assetId)) === contentHash, `${binding.role} tree rung '${assetId}' hash drifted`);
    } else if (descriptor.backend === "instanced-asset") {
      assert(engineHash(await bytes(descriptor.assetId)) === descriptor.contentHash,
        `${binding.role} instanced GLB hash drifted`);
    }
  }
}

assert(populationBindings === 12, `expected twelve exact population bindings, found ${populationBindings}`);
const populationPlan = JSON.parse((await bytes("derived/temperate-fidelity/population-plan.json")).toString());
const groundCover = populationPlan.placements.filter((entry: any) => entry.role === "flora/forest-grass");
const canopy = populationPlan.placements.filter((entry: any) => entry.role === "flora/oak" || entry.role === "flora/ash");
assert(groundCover.length >= 8_000 && groundCover.length > canopy.length * 10,
  `locked population regressed to sparse ground cover (${groundCover.length} grass placements, ${canopy.length} canopy placements)`);
assert(groundCover.some((grass: any) => canopy.some((tree: any) => Math.hypot(grass.x - tree.x, grass.z - tree.z) < 7.5)),
  "locked population lost layered ground cover beneath the canopy");
const deep = runtime.biomes.find((entry) => entry.biomeId === "deep-ocean")!.vegetationRules[0];
const river = runtime.biomes.find((entry) => entry.biomeId === "river")!;
const riverWaterweed = river.vegetationRules.find((entry) => entry.role === "flora/waterweed");
const riverReed = river.vegetationRules.find((entry) => entry.role === "flora/riparian-reed");
assert(deep.density01 === 0 && riverWaterweed?.density01 === 0,
  "submerged populations unexpectedly entered the above-water candidate capture");
assert((riverReed?.density01 ?? 0) > 0, "visible riparian reeds were silently disabled");

const fieldArtifactBytes = new Uint8Array(await bytes("biomes/temperate-fidelity.biome-field.bin"));
const runtimePackContentHash = biomeRuntimePackContentHash(runtime, BIOME_LIBRARY_V1);
const closure = deriveBiomeFieldContentClosure({
  fieldArtifactBytes,
  fieldContentHash: biomeFieldArtifactContentHash(fieldArtifactBytes),
  metadataPack: BIOME_LIBRARY_V1,
  runtimePack: runtime,
  runtimePackContentHash,
});
assert(closure.reachableBiomes.map((entry) => entry.biomeId).join(",")
  === "canyon,deep-ocean,grassland,river,temperate-deciduous-forest", "complete frozen field escaped the runtime pack");

console.log(`p_temperate_fidelity_runtime_pack OK: exact complete-world candidate pack ${runtimePackContentHash} closes frozen field ${closure.closureHash}; ${groundCover.length} ground-cover placements coexist beneath ${canopy.length} canopy placements`);
