import {
  BIOME_POPULATION_ASSET_SCHEMA,
  BIOME_POPULATION_TREE_CAPS,
  BiomePopulationAssetValidationError,
  biomePopulationAssetContentHash,
  parseBiomePopulationAsset,
  stableStringifyBiomePopulationAsset,
} from "../src/world/biome-population-asset.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_biome_population_asset FAIL: ${message}`);
}
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof BiomePopulationAssetValidationError || error instanceof Error, `${message}: did not throw`);
  assert(pattern.test(error.message), `${message}: ${error.message}`);
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const hash = (digit: string): string => `sha256:${digit.repeat(64)}`;
const provenance = { licenseId: "CC0-1.0", sourceUri: "https://example.invalid/source" };

const grass = {
  schema: BIOME_POPULATION_ASSET_SCHEMA,
  id: "meadow-grass-summer",
  version: "1.0.0",
  role: "flora/ground-grass",
  backend: "continuous-grass-field",
  visualPackageId: "limina.grass.interactive-temperate-meadow",
  visualPackageVersion: "1.0.0",
  densityScale: 1.25,
  bladeScale: [0.75, 1.4],
  climate: "summer",
  provenance,
};
const tree = {
  schema: BIOME_POPULATION_ASSET_SCHEMA,
  id: "oak-tree-chain",
  version: "1.0.0",
  role: "flora/canopy-oak",
  backend: "tree-population",
  sourceAssetId: "trees/oak-1.glb",
  sourceContentHash: hash("a"),
  reducedAssetId: "trees/oak-1-lod1.glb",
  reducedContentHash: hash("b"),
  impostorAssetId: "trees/oak-1-impostor.glb",
  impostorContentHash: hash("c"),
  reducedDistance: 45,
  impostorDistance: 120,
  cullDistance: 600,
  hysteresis: 0.15,
  provenance,
};
const instanced = {
  schema: BIOME_POPULATION_ASSET_SCHEMA,
  id: "forest-rocks",
  version: "2.1.0",
  role: "scatter/rock-small",
  backend: "instanced-asset",
  assetId: "rocks/forest-small.glb",
  contentHash: hash("d"),
  provenance,
};

for (const fixture of [grass, tree, instanced]) {
  const parsed = parseBiomePopulationAsset(fixture);
  assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.provenance), `${fixture.backend} output is mutable`);
  assert(/^sha256:[0-9a-f]{64}$/.test(biomePopulationAssetContentHash(fixture)), `${fixture.backend} hash is not canonical`);
}
const parsedGrass = parseBiomePopulationAsset(grass) as any;
assert(Object.isFrozen(parsedGrass.bladeScale), "grass blade scale was not frozen");
assert(parsedGrass.visualPackageId === "limina.grass.interactive-temperate-meadow" && parsedGrass.visualPackageVersion === "1.0.0",
  "grass descriptor lost its exact visual-package identity");
assert(BIOME_POPULATION_TREE_CAPS.species === 12 && BIOME_POPULATION_TREE_CAPS.active === 24_576
  && BIOME_POPULATION_TREE_CAPS.activeAndPending === 30_720,
"exported tree assumptions drifted from the B2 population contract");

const canonical = stableStringifyBiomePopulationAsset(tree);
const address = biomePopulationAssetContentHash(tree);
const reordered = {
  provenance: clone(provenance), hysteresis: tree.hysteresis, cullDistance: tree.cullDistance,
  impostorDistance: tree.impostorDistance, reducedDistance: tree.reducedDistance,
  impostorContentHash: tree.impostorContentHash, impostorAssetId: tree.impostorAssetId,
  reducedContentHash: tree.reducedContentHash, reducedAssetId: tree.reducedAssetId,
  sourceContentHash: tree.sourceContentHash, sourceAssetId: tree.sourceAssetId,
  backend: tree.backend, role: tree.role, version: tree.version, id: tree.id, schema: tree.schema,
};
assert(stableStringifyBiomePopulationAsset(reordered) === canonical
  && biomePopulationAssetContentHash(reordered) === address,
"object insertion order changed canonical bytes or content identity");
const changed = clone(tree) as any;
changed.cullDistance = 601;
assert(biomePopulationAssetContentHash(changed) !== address, "meaningful mutation did not change content identity");

for (const forbidden of ["assetId", "contentHash", "glb", "sourceAssetId"]) {
  const candidate = { ...clone(grass), [forbidden]: forbidden.includes("Hash") ? hash("e") : "grass.glb" };
  rejects(() => parseBiomePopulationAsset(candidate), /unknown field/, `grass accepted forbidden GLB binding field '${forbidden}'`);
}
for (const field of ["visualPackageId", "visualPackageVersion"] as const) {
  const candidate = clone(grass) as any;
  delete candidate[field];
  rejects(() => parseBiomePopulationAsset(candidate), /missing/, `grass accepted missing exact package selector '${field}'`);
}
rejects(() => parseBiomePopulationAsset({ ...clone(grass), visualPackageId: "../fallback" }), /visualPackageId is invalid/,
  "grass accepted an unsafe visual package ID");
rejects(() => parseBiomePopulationAsset({ ...clone(grass), visualPackageVersion: "latest" }), /visualPackageVersion is invalid/,
  "grass accepted a floating visual package version");
for (const climate of ["spring", "SUMMER", "", null]) {
  rejects(() => parseBiomePopulationAsset({ ...clone(grass), climate }), /climate is unsupported/,
    `grass accepted unsupported climate '${climate}'`);
}
const reversedBlade = clone(grass) as any;
reversedBlade.bladeScale = [1.4, 0.75];
rejects(() => parseBiomePopulationAsset(reversedBlade), /sorted/, "reversed blade scale was accepted");
const sparseBlade = clone(grass) as any;
delete sparseBlade.bladeScale[0];
rejects(() => parseBiomePopulationAsset(sparseBlade), /dense/, "sparse blade scale was accepted");
const decoratedBlade = clone(grass) as any;
decoratedBlade.bladeScale.note = true;
rejects(() => parseBiomePopulationAsset(decoratedBlade), /field-free/, "decorated blade scale was accepted");

for (const [field, value] of [
  ["densityScale", NaN], ["densityScale", Infinity], ["densityScale", -0],
  ["reducedDistance", 0], ["impostorDistance", -0], ["cullDistance", Infinity], ["hysteresis", -0],
] as const) {
  const candidate: any = field === "densityScale" ? clone(grass) : clone(tree);
  candidate[field] = value;
  rejects(() => parseBiomePopulationAsset(candidate), /finite canonical number/,
    `${field} accepted noncanonical numeric value`);
}
for (const distances of [[120, 120, 600], [121, 120, 600], [45, 600, 600], [45, 601, 600]]) {
  const candidate = { ...clone(tree), reducedDistance: distances[0], impostorDistance: distances[1], cullDistance: distances[2] };
  rejects(() => parseBiomePopulationAsset(candidate), /strictly increasing/, `tree accepted distances ${distances.join(",")}`);
}
for (const hysteresis of [-0.01, 0.5, 1]) {
  rejects(() => parseBiomePopulationAsset({ ...clone(tree), hysteresis }), /finite canonical number/,
    `tree accepted hysteresis ${hysteresis}`);
}
const duplicateAsset = clone(tree) as any;
duplicateAsset.reducedAssetId = duplicateAsset.sourceAssetId;
rejects(() => parseBiomePopulationAsset(duplicateAsset), /asset IDs must be distinct/, "tree accepted duplicate rung asset IDs");

for (const field of ["sourceContentHash", "reducedContentHash", "impostorContentHash"]) {
  const candidate = clone(tree) as any;
  candidate[field] = field === "sourceContentHash" ? "sha256:nope" : `sha256:${"A".repeat(64)}`;
  rejects(() => parseBiomePopulationAsset(candidate), new RegExp(`${field}.*invalid`), `${field} accepted malformed hash`);
}
const instancedExtra = { ...clone(instanced), reducedAssetId: "rocks/lod.glb" };
rejects(() => parseBiomePopulationAsset(instancedExtra), /unknown field/, "instanced backend accepted a second asset");

for (const fixture of [grass, tree, instanced]) {
  for (const field of ["licenseId", "sourceUri"]) {
    const candidate = clone(fixture) as any;
    delete candidate.provenance[field];
    rejects(() => parseBiomePopulationAsset(candidate), /missing/, `${fixture.backend} accepted missing provenance ${field}`);
  }
}
const unknownTop = { ...clone(tree), surprise: true };
rejects(() => parseBiomePopulationAsset(unknownTop), /unknown field/, "unknown top-level field was accepted");
const unknownProvenance = clone(tree) as any;
unknownProvenance.provenance.author = "someone";
rejects(() => parseBiomePopulationAsset(unknownProvenance), /unknown field/, "unknown provenance field was accepted");
rejects(() => parseBiomePopulationAsset({ ...clone(tree), backend: "mesh" }), /backend is unsupported/,
  "unknown backend was accepted");
rejects(() => parseBiomePopulationAsset({ ...clone(tree), schema: "limina.biome-population-asset/v2" }), /schema must be/,
  "unknown schema was accepted");

const getter: any = clone(instanced);
Object.defineProperty(getter, "assetId", { enumerable: true, get() { throw new Error("getter executed"); } });
rejects(() => parseBiomePopulationAsset(getter), /enumerable data field/, "accessor field was accepted or executed");
const inherited = Object.assign(Object.create({ surprise: true }), clone(instanced));
rejects(() => parseBiomePopulationAsset(inherited), /plain object/, "non-plain inherited object was accepted");
const symbol = clone(instanced) as any;
symbol[Symbol("surprise")] = true;
rejects(() => parseBiomePopulationAsset(symbol), /symbol fields/, "symbol field was accepted");

console.log(`p_biome_population_asset OK: three strict pure-data backends, hostile validation, ${address}`);
