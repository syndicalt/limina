import { BiomeGrassDensitySampler } from "../src/render/biome-grass-density.ts";
import { BIOME_POPULATION_ASSET_SCHEMA } from "../src/world/biome-population-asset.mjs";
import { continuousGrassDensityVariation } from "../src/render/continuous-grass-density-variation.ts";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`p_biome_grass_density FAIL: ${message}`); }
const HASH = `sha256:${"a".repeat(64)}`;
const descriptor = new TextEncoder().encode(JSON.stringify({ schema: BIOME_POPULATION_ASSET_SCHEMA, id: "meadow-grass", version: "1.0.0",
  role: "flora/meadow-grass", backend: "continuous-grass-field", visualPackageId: "limina.grass.interactive-temperate-meadow",
  visualPackageVersion: "1.0.0", densityScale: 0.8, bladeScale: [0.75, 1.25], climate: "summer",
  provenance: { licenseId: "CC0-1.0", sourceUri: "https://example.invalid/grass" } }));
const other = new TextEncoder().encode(JSON.stringify({ schema: BIOME_POPULATION_ASSET_SCHEMA, id: "oak", version: "1.0.0",
  role: "flora/oak", backend: "instanced-asset", assetId: "oak.glb", contentHash: HASH,
  provenance: { licenseId: "CC0-1.0", sourceUri: "https://example.invalid/oak" } }));
const assets = { resolve(id: string) { return { assetId: id, hash: HASH, bytes: id === "roles/meadow-grass.json" ? descriptor : other }; } } as any;
const binding = { assetId: "roles/meadow-grass.json", contentHash: HASH };
let fullSamples = 0, vegetationSamples = 0;
const sample = (x: number) => x < 0 ? null : { vegetationDensity01: x < 5 ? 0.5 : 1,
  vegetation: [{ role: "flora/meadow-grass", binding, weight01: 0.75 }, { role: "flora/oak", binding: { assetId: "ignored", contentHash: HASH }, weight01: 0.25 }] };
const publication = { disposed: false,
  sample(x: number) { fullSamples++; return sample(x); },
  sampleVegetation(x: number) { vegetationSamples++; return sample(x); },
} as any;
const sampler = new BiomeGrassDensitySampler(publication, assets);
assert(sampler.sample(-1, 0) === 0
  && Math.abs(sampler.sample(1, 0) - continuousGrassDensityVariation(0.3, 1, 0)) < 1e-12
  && Math.abs(sampler.sample(8, 0) - continuousGrassDensityVariation(0.6, 8, 0)) < 1e-12,
  "top-four grass contribution did not become the expected continuous density");
const profile = sampler.profile(1, 0); assert(profile?.climate === "summer" && profile.bladeScale[0] === 0.75, "dominant B1 grass style was not resolved");
assert(vegetationSamples === 4 && fullSamples === 0, "grass density bypassed the publication's vegetation-only dense sampling path");
console.log("p_biome_grass_density OK: content-addressed grass roles become a continuous B1 density/style field without spawning grass GLBs");
