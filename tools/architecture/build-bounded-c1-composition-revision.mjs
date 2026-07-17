import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildingCompositionManifestV2Hash, validateBuildingCompositionManifestV2 } from "../../js/src/assets/building-composition-manifest-v2.mjs";
import { verifyFurnishedC1Composition } from "./verify-furnished-c1-composition.mjs";

export const BOUNDED_C1_EXTRACTION_SCHEMA = "limina.blender-composition-edit-extraction/v1";
export const BOUNDED_C1_BASE = Object.freeze({
  manifestPath: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/composition-manifest.json",
  manifestSha256: "sha256:12b822f1fc688d0b4fed45f8d4bfc1a1c7acf8a781d443c55e2ca2d90f002a3e",
  buildEvidencePath: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/build-evidence.json",
  buildEvidenceSha256: "sha256:7c18144a19ab9b8dadfd274734d24b66b4186ab91df1dfb936cd1502501ffd39",
  blendPath: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/furnished-c1-r3.blend",
  blendSha256: "sha256:5c0fa1aa5e237bf61eaa2e37690122b9b9d5fded8fca8ceb20e979a56eec34c1",
  extractorPath: "tools/blender/extract-building-composition-revision.py",
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HASH = /^sha256:[0-9a-f]{64}$/;
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable = (root, path) => relative(root, path).split(sep).join("/");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value; }
function exactKeys(value, keys, label) { const actual = Object.keys(object(value, label)).sort(), expected = [...keys].sort(); if (!same(actual, expected)) throw new Error(`${label} fields are not the bounded extraction contract`); }
function finite(value, label) { if (!Number.isFinite(value)) throw new Error(`${label} must be finite`); return value; }
function hash(value, label) { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be lowercase sha256`); return value; }
function inside(root, value, label) { if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) throw new Error(`${label} must be repository-relative`); const full = resolve(root, value), rel = relative(root, full); if (rel.startsWith("..") || rel.includes(`..${sep}`)) throw new Error(`${label} escapes repository`); return full; }
async function exactResource(root, record, label) { exactKeys(record, ["path", "sha256"], label); hash(record.sha256, `${label}.sha256`); const full = inside(root, record.path, `${label}.path`), bytes = await readFile(full); if (sha(bytes) !== record.sha256) throw new Error(`${label} exact bytes drifted`); return { full, bytes, path: portable(root, full), sha256: record.sha256 }; }

function expectedProtected(build) {
  const output = object(build.adapterOutput, "base build evidence adapterOutput");
  return {
    handoffSchema: "limina.blender-building-composition-handoff/v2",
    compositionRootId: "composition/functional-hall-house-v4/r3",
    materializedShellFingerprint: output.materializedShellFingerprint,
    materializedShellNodeTableHash: output.materializedShellNodeTableHash,
    materializedShellNodeFingerprint: output.materializedShellNodeFingerprint,
    sourceShellBlendHash: build.sourceValidation?.sourceShellBlendHash ?? output.shellSourceBlend?.sha256,
    sourceCatalogBlendHashes: Object.fromEntries(output.instances.map((entry) => [entry.artifactId, entry.sourceBlendHash]).sort(([a], [b]) => a.localeCompare(b))),
    instances: output.instances,
  };
}

export async function validateBoundedC1Extraction(value, { repoRoot = ROOT } = {}) {
  const root = resolve(repoRoot), extraction = object(value, "bounded C1 extraction");
  exactKeys(extraction, ["schema", "source", "protected", "edits"], "bounded C1 extraction");
  if (extraction.schema !== BOUNDED_C1_EXTRACTION_SCHEMA) throw new Error("unsupported bounded C1 extraction schema");
  exactKeys(extraction.source, ["baseManifest", "baseBuildEvidence", "blend", "extractor"], "bounded C1 extraction source");
  const [manifestFile, buildFile, blendFile, extractorFile] = await Promise.all([
    exactResource(root, extraction.source.baseManifest, "bounded C1 base manifest"),
    exactResource(root, extraction.source.baseBuildEvidence, "bounded C1 base build evidence"),
    exactResource(root, extraction.source.blend, "bounded C1 edited blend"),
    exactResource(root, extraction.source.extractor, "bounded C1 extractor"),
  ]);
  if (manifestFile.path !== BOUNDED_C1_BASE.manifestPath || manifestFile.sha256 !== BOUNDED_C1_BASE.manifestSha256) throw new Error("bounded C1 base manifest is not exact approved r3 authority");
  if (buildFile.path !== BOUNDED_C1_BASE.buildEvidencePath || buildFile.sha256 !== BOUNDED_C1_BASE.buildEvidenceSha256) throw new Error("bounded C1 base build evidence is not exact r3 authority");
  if (extractorFile.path !== BOUNDED_C1_BASE.extractorPath) throw new Error("bounded C1 extraction used an unsupported extractor");
  const manifest = validateBuildingCompositionManifestV2(JSON.parse(manifestFile.bytes.toString("utf8"))), build = JSON.parse(buildFile.bytes.toString("utf8"));
  if (manifest.id !== "composition/functional-hall-house-v4/r3" || manifest.revision !== 3 || manifest.supersedes !== "composition/functional-hall-house-v4/r2") throw new Error("bounded C1 base identity drifted");
  if (extraction.source.baseManifest.canonicalHash !== undefined) throw new Error("bounded C1 source must not carry unsupported fields");
  const expected = expectedProtected(build);
  if (!same(canonical(extraction.protected), canonical(expected))) throw new Error("bounded C1 protected mesh/material/dependency/semantic closure drifted");
  if (!Array.isArray(extraction.edits) || extraction.edits.length !== 7) throw new Error("bounded C1 extraction must contain exactly seven instance roots");
  const baseById = new Map(manifest.instances.map((entry) => [entry.id, entry])), ids = [];
  for (const [index, edit] of extraction.edits.entries()) {
    const label = `bounded C1 edits[${index}]`; exactKeys(edit, ["id", "position", "yawRadians", "scale"], label);
    const prior = baseById.get(edit.id); if (!prior) throw new Error(`${label} does not identify an exact r3 instance`); ids.push(edit.id);
    if (!Array.isArray(edit.position) || edit.position.length !== 3) throw new Error(`${label}.position must be vec3`); edit.position.forEach((entry, axis) => finite(entry, `${label}.position[${axis}]`)); finite(edit.yawRadians, `${label}.yawRadians`);
    if (!same(edit.scale, [1, 1, 1])) throw new Error(`${edit.id} scale edits are forbidden`);
    if (edit.position[1] !== prior.placement.position[1]) throw new Error(`${edit.id} Y edits are forbidden`);
  }
  if (new Set(ids).size !== 7 || !same([...ids].sort(), [...baseById.keys()].sort())) throw new Error("bounded C1 extraction instance inventory drifted");
  return Object.freeze({ extraction, manifest, build, files: { manifestFile, buildFile, blendFile, extractorFile } });
}

export async function buildBoundedC1CompositionRevision({ extractionPath, outputPath, functionalEvidenceOutputPath, repoRoot = ROOT, write = true } = {}) {
  if (!extractionPath) throw new Error("extractionPath is required");
  const root = resolve(repoRoot), extractionFull = inside(root, extractionPath, "extractionPath"), extractionBytes = await readFile(extractionFull), validated = await validateBoundedC1Extraction(JSON.parse(extractionBytes.toString("utf8")), { repoRoot: root });
  const { extraction, manifest: base } = validated, editById = new Map(extraction.edits.map((entry) => [entry.id, entry]));
  const manifest = validateBuildingCompositionManifestV2({
    ...structuredClone(base), id: "composition/functional-hall-house-v4/r4", revision: 4, supersedes: base.id,
    instances: base.instances.map((instance) => ({ ...structuredClone(instance), placement: { ...structuredClone(instance.placement), position: [...editById.get(instance.id).position], yawRadians: editById.get(instance.id).yawRadians, scale: [1, 1, 1] } })),
    metadata: { ...structuredClone(base.metadata), boundedRevision: { schema: BOUNDED_C1_EXTRACTION_SCHEMA, baseManifestPath: BOUNDED_C1_BASE.manifestPath, baseManifestSha256: BOUNDED_C1_BASE.manifestSha256, extractionPath: portable(root, extractionFull), extractionSha256: sha(extractionBytes), editedBlend: extraction.source.blend, allowedFields: ["placement.position[0]", "placement.position[2]", "placement.yawRadians"] } },
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), temp = await mkdtemp(resolve(root, ".tmp-c1-bounded-revision-"));
  try {
    const tempManifest = resolve(temp, "manifest.json"); await writeFile(tempManifest, manifestBytes, { mode: 0o600, flag: "wx" });
    const evidence = await verifyFurnishedC1Composition({ root, manifestPath: portable(root, tempManifest), revisionBaseManifestPath: BOUNDED_C1_BASE.manifestPath });
    if (evidence.verdict !== "pass") throw new Error(`bounded C1 functional verification failed: ${evidence.checks.filter((entry) => !entry.passed).map((entry) => `${entry.id}: ${entry.findings.join("; ")}`).join(" | ")}`);
    if (write) {
      if (!outputPath || !functionalEvidenceOutputPath) throw new Error("outputPath and functionalEvidenceOutputPath are required when writing");
      const output = inside(root, outputPath, "outputPath"), evidenceOutput = inside(root, functionalEvidenceOutputPath, "functionalEvidenceOutputPath"); await Promise.all([mkdir(dirname(output), { recursive: true, mode: 0o700 }), mkdir(dirname(evidenceOutput), { recursive: true, mode: 0o700 })]);
      await writeFile(output, manifestBytes, { mode: 0o600, flag: "wx" }); await writeFile(evidenceOutput, `${JSON.stringify(canonical(evidence))}\n`, { mode: 0o600, flag: "wx" });
    }
    return Object.freeze({ manifest, manifestHash: buildingCompositionManifestV2Hash(manifest), evidence });
  } finally { await rm(temp, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2), at = (flag) => { const index = args.indexOf(flag); if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`); return args[index + 1]; };
  const result = await buildBoundedC1CompositionRevision({ extractionPath: at("--extraction"), outputPath: at("--out"), functionalEvidenceOutputPath: at("--evidence"), write: true });
  console.log(JSON.stringify({ id: result.manifest.id, supersedes: result.manifest.supersedes, manifestHash: result.manifestHash, functionalVerdict: result.evidence.verdict }, null, 2));
}
