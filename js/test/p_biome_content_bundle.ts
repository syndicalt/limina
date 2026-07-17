import {
  BIOME_CONTENT_BUNDLE_KINDS,
  BIOME_CONTENT_BUNDLE_LICENSES,
  BIOME_CONTENT_BUNDLE_LIMITS,
  BIOME_CONTENT_BUNDLE_SCHEMA,
  BIOME_CONTENT_BUNDLE_STATUSES,
  BiomeContentBundleValidationError,
  biomeContentBundleContentHash,
  deriveBiomeContentBundleClosureHash,
  parseBiomeContentBundle,
  stableStringifyBiomeContentBundle,
} from "../src/world/biome-content-bundle.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_biome_content_bundle FAIL: ${message}`);
}
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof BiomeContentBundleValidationError || error instanceof Error, `${message}: did not throw`);
  assert(pattern.test(error.message), `${message}: ${error.message}`);
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const hash = (digit: string): string => `sha256:${digit.repeat(64)}`;
const cc0 = (sourceUri: string) => ({ licenseSpdx: "CC0-1.0", sourceUri });
const evidence = {
  mechanicalEvidence: { assetId: "evidence/mechanical", contentHash: hash("2") },
  humanVisualEvidence: { assetId: "evidence/human", contentHash: hash("1") },
};

const draft = {
  schema: BIOME_CONTENT_BUNDLE_SCHEMA,
  id: "temperate-forest-production",
  version: "1.2.0",
  status: "accepted",
  runtimePack: { assetId: "runtime/temperate-forest", contentHash: hash("0") },
  entries: [
    { assetId: "evidence/human", contentHash: hash("1"), kind: "human-visual-evidence", byteLength: 8192,
      provenance: cc0("limina://review/project-gorgon-floor") },
    { assetId: "evidence/mechanical", contentHash: hash("2"), kind: "mechanical-evidence", byteLength: 4096,
      provenance: { licenseSpdx: "MIT", sourceUri: "limina://qc/asset-qc-v2" } },
    { assetId: "materials/forest-surface", contentHash: hash("3"), kind: "surface-wrapper", byteLength: 2048,
      provenance: cc0("https://ambientcg.com/view?id=ForestGround001"), acceptance: evidence },
    { assetId: "models/oak-lod0", contentHash: hash("4"), kind: "model-source", byteLength: 2_000_000,
      provenance: { licenseSpdx: "CC-BY-4.0", sourceUri: "https://example.invalid/oak.glb", attribution: {
        author: "Example Artist", title: "Temperate Oak", sourceUrl: "https://example.invalid/oak",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/", modified: true,
      } } },
    { assetId: "population/oak", contentHash: hash("5"), kind: "population-descriptor", byteLength: 1024,
      provenance: cc0("limina://generated/oak-population"), acceptance: evidence },
    { assetId: "recipes/forest-pack", contentHash: hash("7"), kind: "authoring-recipe", byteLength: 3072,
      provenance: { licenseSpdx: "MIT", sourceUri: "limina://pack-factory/forest-v1" } },
    { assetId: "textures/forest-albedo", contentHash: hash("6"), kind: "texture", byteLength: 4_000_000,
      provenance: { licenseSpdx: "Apache-2.0", sourceUri: "limina://generated/forest-albedo" } },
  ],
};
const bundle = { ...draft, closureHash: deriveBiomeContentBundleClosureHash(draft) };
const parsed = parseBiomeContentBundle(bundle) as any;

assert(parsed.schema === BIOME_CONTENT_BUNDLE_SCHEMA && parsed.runtimePack.assetId === draft.runtimePack.assetId,
  "canonical bundle lost its runtime-pack identity");
assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.runtimePack) && Object.isFrozen(parsed.entries)
  && parsed.entries.every((entry: any) => Object.isFrozen(entry) && Object.isFrozen(entry.provenance))
  && Object.isFrozen(parsed.entries[2].acceptance) && Object.isFrozen(parsed.entries[2].acceptance.mechanicalEvidence)
  && Object.isFrozen(parsed.entries[3].provenance.attribution), "canonical output is not deeply frozen");
assert(BIOME_CONTENT_BUNDLE_KINDS.length === 10 && BIOME_CONTENT_BUNDLE_LICENSES.tierA.length === 3
  && BIOME_CONTENT_BUNDLE_LICENSES.tierB.length === 2 && BIOME_CONTENT_BUNDLE_STATUSES.join(",") === "candidate,accepted",
"exported kind, status, or license policy is incomplete");

const canonical = stableStringifyBiomeContentBundle(bundle);
const address = biomeContentBundleContentHash(bundle);
assert(/^sha256:[0-9a-f]{64}$/.test(address), "bundle content hash is not canonical");
const reordered = {
  entries: draft.entries.map((entry: any) => ({
    ...(entry.acceptance === undefined ? {} : { acceptance: clone(entry.acceptance) }),
    provenance: clone(entry.provenance), byteLength: entry.byteLength, kind: entry.kind,
    contentHash: entry.contentHash, assetId: entry.assetId,
  })),
  runtimePack: { contentHash: draft.runtimePack.contentHash, assetId: draft.runtimePack.assetId },
  version: draft.version, status: draft.status, id: draft.id, schema: draft.schema,
};
const reorderedBundle = { ...reordered, closureHash: deriveBiomeContentBundleClosureHash(reordered) };
assert(reorderedBundle.closureHash === bundle.closureHash
  && stableStringifyBiomeContentBundle(reorderedBundle) === canonical
  && biomeContentBundleContentHash(reorderedBundle) === address,
"object insertion order changed canonical closure or bundle identity");

for (const rejectedLicense of [
  "CC-BY-SA-4.0", "CC-BY-NC-4.0", "CC-BY-ND-4.0", "GPL-3.0-only", "AGPL-3.0-only", "unknown", "LicenseRef-EULA",
]) {
  const hostile = clone(draft) as any;
  hostile.entries[6].provenance.licenseSpdx = rejectedLicense;
  rejects(() => deriveBiomeContentBundleClosureHash(hostile), /not an allowed Tier A or Tier B license/,
    `${rejectedLicense} entered the production closure`);
}
const missingAttribution = clone(draft) as any;
delete missingAttribution.entries[3].provenance.attribution;
rejects(() => deriveBiomeContentBundleClosureHash(missingAttribution), /attribution is required/,
  "CC-BY entry without attribution was accepted");
const incompleteAttribution = clone(draft) as any;
delete incompleteAttribution.entries[3].provenance.attribution.author;
rejects(() => deriveBiomeContentBundleClosureHash(incompleteAttribution), /missing 'author'/,
  "incomplete CC-BY attribution was accepted");
const invalidAttributionUrl = clone(draft) as any;
invalidAttributionUrl.entries[3].provenance.attribution.licenseUrl = "http://example.invalid/license";
rejects(() => deriveBiomeContentBundleClosureHash(invalidAttributionUrl), /licenseUrl.*invalid/,
  "non-HTTPS attribution license URL was accepted");

const missingAcceptance = clone(draft) as any;
delete missingAcceptance.entries[2].acceptance;
rejects(() => deriveBiomeContentBundleClosureHash(missingAcceptance), /acceptance is required/,
  "production surface wrapper without accepted evidence was accepted");
const acceptedWithoutHuman = clone(draft) as any;
delete acceptedWithoutHuman.entries[2].acceptance.humanVisualEvidence;
rejects(() => deriveBiomeContentBundleClosureHash(acceptedWithoutHuman), /humanVisualEvidence is required/,
  "accepted bundle omitted human visual evidence");
const candidate = clone(draft) as any;
candidate.status = "candidate";
for (const entry of candidate.entries) if (entry.acceptance !== undefined) delete entry.acceptance.humanVisualEvidence;
const candidateBundle = { ...candidate, closureHash: deriveBiomeContentBundleClosureHash(candidate) };
assert(parseBiomeContentBundle(candidateBundle).status === "candidate",
  "mechanically evidenced candidate bundle could not enter pre-review compilation");
candidate.entries[2].acceptance.humanVisualEvidence = clone(evidence.humanVisualEvidence);
rejects(() => deriveBiomeContentBundleClosureHash(candidate), /cannot be claimed by a candidate/,
  "candidate bundle falsely claimed human visual acceptance");
const strayAcceptance = clone(draft) as any;
strayAcceptance.entries[6].acceptance = clone(evidence);
rejects(() => deriveBiomeContentBundleClosureHash(strayAcceptance), /only valid on production wrapper/,
  "non-production leaf claimed wrapper acceptance");
const missingEvidence = clone(draft) as any;
missingEvidence.entries[2].acceptance.humanVisualEvidence.assetId = "evidence/missing";
rejects(() => deriveBiomeContentBundleClosureHash(missingEvidence), /does not resolve inside the bundle closure/,
  "external human-review reference escaped the closed bundle");
const wrongEvidenceKind = clone(draft) as any;
wrongEvidenceKind.entries[2].acceptance.mechanicalEvidence = {
  assetId: "evidence/human", contentHash: hash("1"),
};
rejects(() => deriveBiomeContentBundleClosureHash(wrongEvidenceKind), /must resolve to kind 'mechanical-evidence'/,
  "human evidence was substituted for mechanical evidence");
const mismatchedEvidenceHash = clone(draft) as any;
mismatchedEvidenceHash.entries[4].acceptance.mechanicalEvidence.contentHash = hash("f");
rejects(() => deriveBiomeContentBundleClosureHash(mismatchedEvidenceHash), /contentHash does not match/,
  "stale evidence identity was accepted");

const unordered = clone(draft) as any;
[unordered.entries[0], unordered.entries[1]] = [unordered.entries[1], unordered.entries[0]];
rejects(() => deriveBiomeContentBundleClosureHash(unordered), /strictly assetId-sorted and unique/,
  "unordered closure entries were accepted");
const duplicate = clone(draft) as any;
duplicate.entries[1].assetId = duplicate.entries[0].assetId;
rejects(() => deriveBiomeContentBundleClosureHash(duplicate), /strictly assetId-sorted and unique/,
  "duplicate closure asset ID was accepted");
const rootCollision = clone(draft) as any;
rootCollision.runtimePack.assetId = rootCollision.entries[0].assetId;
rejects(() => deriveBiomeContentBundleClosureHash(rootCollision), /must not collide/,
  "runtime-pack identity collided with a closure leaf");
for (const unsafe of ["/absolute", "textures//albedo", "textures/../secret", "textures/./albedo", "textures\\albedo"]) {
  const traversal = clone(draft) as any;
  traversal.entries[6].assetId = unsafe;
  rejects(() => deriveBiomeContentBundleClosureHash(traversal), /invalid|unsafe path segment/,
    `unsafe asset ID '${unsafe}' entered the closure`);
}

const mutatedHash = clone(bundle) as any;
mutatedHash.entries[6].contentHash = hash("e");
rejects(() => parseBiomeContentBundle(mutatedHash), /closureHash does not match/,
  "leaf hash mutation survived closure verification");
const mutatedBytes = clone(bundle) as any;
mutatedBytes.entries[6].byteLength++;
rejects(() => parseBiomeContentBundle(mutatedBytes), /closureHash does not match/,
  "leaf byte mutation survived closure verification");
const negativeZero = clone(draft) as any;
negativeZero.entries[6].byteLength = -0;
rejects(() => deriveBiomeContentBundleClosureHash(negativeZero), /canonical integer/,
  "negative-zero byte length was accepted");
const oversizedEntry = clone(draft) as any;
oversizedEntry.entries[6].byteLength = BIOME_CONTENT_BUNDLE_LIMITS.entryBytes + 1;
rejects(() => deriveBiomeContentBundleClosureHash(oversizedEntry), /no greater than/,
  "oversized entry payload was accepted");

let accessorCalls = 0;
const accessorEntry = clone(draft) as any;
Object.defineProperty(accessorEntry.entries[6], "contentHash", {
  enumerable: true, get() { accessorCalls++; return hash("6"); },
});
rejects(() => deriveBiomeContentBundleClosureHash(accessorEntry), /enumerable data field/,
  "accessor-backed leaf was accepted");
assert(accessorCalls === 0, "leaf validation executed an accessor");
const symbolEntry = clone(draft) as any;
symbolEntry.entries[6][Symbol("hostile")] = true;
rejects(() => deriveBiomeContentBundleClosureHash(symbolEntry), /symbol fields/,
  "symbol-backed leaf field was accepted");
const sparse = clone(draft) as any;
delete sparse.entries[1];
rejects(() => deriveBiomeContentBundleClosureHash(sparse), /dense, field-free/,
  "sparse entry array was accepted");
const tooMany = clone(draft) as any;
tooMany.entries = Array.from({ length: BIOME_CONTENT_BUNDLE_LIMITS.entries + 1 }, () => draft.entries[6]);
rejects(() => deriveBiomeContentBundleClosureHash(tooMany), /at most 4096/,
  "entry-count cap was not enforced before traversal");
const tooManyBytes = clone(draft) as any;
tooManyBytes.entries = Array.from({ length: 17 }, (_, index) => ({
  assetId: `textures/huge-${index.toString().padStart(2, "0")}`,
  contentHash: hash((index % 10).toString()), kind: "texture",
  byteLength: BIOME_CONTENT_BUNDLE_LIMITS.entryBytes, provenance: cc0("limina://generated/huge"),
}));
rejects(() => deriveBiomeContentBundleClosureHash(tooManyBytes), /entry bytes exceed/,
  "aggregate payload-byte cap was not enforced");

console.log(`p_biome_content_bundle OK: ${parsed.entries.length} strict closure leaves, Tier A/B provenance, closed dual acceptance evidence, ${bundle.closureHash}, ${address}`);
