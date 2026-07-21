import {
  BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE,
  BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
  BiomeContentClosureArtifactCancelledError,
  decodeBiomeContentClosureArtifact,
  encodeBiomeContentClosureArtifact,
} from "../src/world/compiler/biome-content-closure-artifact.mjs";
import { BIOME_CONTENT_BUNDLE_SCHEMA, deriveBiomeContentBundleClosureHash } from "../src/world/biome-content-bundle.mjs";

function assert(value: boolean, message: string): asserts value { if (!value) throw new Error(`p_biome_content_closure_artifact FAIL: ${message}`); }
function rejects(run: () => unknown, match: RegExp, message: string): void {
  let error: unknown; try { run(); } catch (caught) { error = caught; }
  assert(error instanceof Error && match.test(`${error.name}: ${error.message}`), `${message}: ${String(error)}`);
}
const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
const draft = {
  schema: BIOME_CONTENT_BUNDLE_SCHEMA, id: "test-biome-content", version: "1.0.0", status: "accepted",
  runtimePack: { assetId: "biomes/runtime.json", contentHash: hash("a") },
  entries: [
    { assetId: "evidence/human.json", contentHash: hash("1"), kind: "human-visual-evidence", byteLength: 10,
      provenance: { licenseSpdx: "CC0-1.0", sourceUri: "limina://human-review/pending" } },
    { assetId: "evidence/mechanical.json", contentHash: hash("2"), kind: "mechanical-evidence", byteLength: 10,
      provenance: { licenseSpdx: "MIT", sourceUri: "limina://qc/content" } },
    { assetId: "population/oak.json", contentHash: hash("3"), kind: "population-descriptor", byteLength: 20,
      provenance: { licenseSpdx: "CC0-1.0", sourceUri: "limina://population/oak" }, acceptance: {
        mechanicalEvidence: { assetId: "evidence/mechanical.json", contentHash: hash("2") },
        humanVisualEvidence: { assetId: "evidence/human.json", contentHash: hash("1") },
      } },
  ],
};
const bundle = { ...draft, closureHash: deriveBiomeContentBundleClosureHash(draft) };
const bytes = encodeBiomeContentClosureArtifact(bundle);
const decoded = decodeBiomeContentClosureArtifact(bytes);
assert(decoded.bundle.closureHash === bundle.closureHash && decoded.metadata.artifactType === BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE
  && decoded.metadata.mediaType === BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE, "canonical closure did not round-trip");
assert(bytes.every((value, index) => value === encodeBiomeContentClosureArtifact(decoded.bundle)[index]), "re-encode drifted");
rejects(() => decodeBiomeContentClosureArtifact(new Uint8Array(bytes.buffer, 1, bytes.length - 1)), /owned complete/, "sliced storage was accepted");
const reordered = encoderHack(bytes, (value: any) => ({ ...value, entries: [...value.entries].reverse() }));
rejects(() => decodeBiomeContentClosureArtifact(reordered), /strictly assetId-sorted|not canonical/, "unordered closure was accepted");
const tampered = bytes.slice(); tampered[tampered.length - 3] ^= 1;
rejects(() => decodeBiomeContentClosureArtifact(tampered), /invalid|canonical|JSON/, "tampered closure was accepted");
rejects(() => decodeBiomeContentClosureArtifact(Uint8Array.from([...bytes, 0])), /canonical JSON line|JSON/, "trailing bytes were accepted");
rejects(() => encodeBiomeContentClosureArtifact(bundle, { shouldCancel: () => true }), /cancelled/, "cancelled encode continued");
assert(new BiomeContentClosureArtifactCancelledError().name === "BiomeContentClosureArtifactCancelledError", "cancel error identity drifted");

function encoderHack(source: Uint8Array, mutate: (value: any) => any): Uint8Array {
  const value = JSON.parse(new TextDecoder().decode(source));
  return new TextEncoder().encode(`${JSON.stringify(mutate(value))}\n`);
}
console.log(`p_biome_content_closure_artifact OK: ${bytes.length}B canonical authorization closure ${decoded.metadata.contentHash}`);
