import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
export const PRODUCTION_R1_INPUTS = Object.freeze({
  sourceLodGlb: ".limina/c1-functional-package-E9QFYQ/c1-production-lod.glb",
  sourceLodManifest: ".limina/c1-functional-package-E9QFYQ/c1-production-lod.json",
  sourceKtx2Glb: ".limina/c1-functional-package-E9QFYQ/runtime/buildings/functional-hall-house-v4-production.glb",
  sourceKtx2Manifest: ".limina/c1-functional-package-E9QFYQ/c1-production-ktx2.json",
  directory: "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653",
  lodGlb: "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/functional-hall-house-v4-lod.glb",
  lodManifest: "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/lod-manifest.json",
  ktx2Glb: "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/functional-hall-house-v4-production.glb",
  ktx2Manifest: "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/ktx2-manifest.json",
});
const EXPECTED = Object.freeze({ lod: "111b07b7f070d18fb521289c01e9be4b88295b7a4a0970de537491ff798b0fe4", ktx2: "20063648f0c7aa7331b348e66bb714b419e2b8a1fa215045fb775d6c0ee3fb99" });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes, label) => { try { return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)); } catch (error) { throw new Error(`${label} is invalid JSON`, { cause: error }); } };
const exactFile = async (root, path, expected, label) => { const absolute = resolve(root, path), stat = await lstat(absolute); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`); const bytes = await readFile(absolute); if (expected && sha(bytes) !== expected) throw new Error(`${label} exact bytes drifted`); return { absolute, bytes }; };
const portable = (root, path) => relative(root, path).split(sep).join("/");

export async function publishProductionPackageInputs({ repoRoot = ROOT, write = true } = {}) {
  const root = resolve(repoRoot), sourceLod = await exactFile(root, PRODUCTION_R1_INPUTS.sourceLodGlb, EXPECTED.lod, "final LOD GLB"), sourceKtx = await exactFile(root, PRODUCTION_R1_INPUTS.sourceKtx2Glb, EXPECTED.ktx2, "final KTX2 GLB");
  const sourceLodManifest = await exactFile(root, PRODUCTION_R1_INPUTS.sourceLodManifest, undefined, "final LOD manifest"), sourceKtxManifest = await exactFile(root, PRODUCTION_R1_INPUTS.sourceKtx2Manifest, undefined, "final KTX2 manifest");
  const lodManifest = decode(sourceLodManifest.bytes, "final LOD manifest"), ktx2Manifest = decode(sourceKtxManifest.bytes, "final KTX2 manifest");
  if (lodManifest.sha256 !== EXPECTED.lod || lodManifest.outputPath !== PRODUCTION_R1_INPUTS.sourceLodGlb || ktx2Manifest.source?.sha256 !== EXPECTED.lod || ktx2Manifest.output?.sha256 !== EXPECTED.ktx2) throw new Error("final LOD/KTX2 source manifest chain drifted");
  const publishedLod = { ...lodManifest, outputPath: PRODUCTION_R1_INPUTS.lodGlb, publication: { sourcePath: PRODUCTION_R1_INPUTS.sourceLodManifest, sourceSha256: `sha256:${sha(sourceLodManifest.bytes)}`, appendOnly: true } };
  const publishedKtx = { ...ktx2Manifest, source: { ...ktx2Manifest.source, path: PRODUCTION_R1_INPUTS.lodGlb }, output: { ...ktx2Manifest.output, path: PRODUCTION_R1_INPUTS.ktx2Glb }, publication: { sourcePath: PRODUCTION_R1_INPUTS.sourceKtx2Manifest, sourceSha256: `sha256:${sha(sourceKtxManifest.bytes)}`, appendOnly: true } };
  const outputs = [PRODUCTION_R1_INPUTS.lodGlb, PRODUCTION_R1_INPUTS.ktx2Glb, PRODUCTION_R1_INPUTS.lodManifest, PRODUCTION_R1_INPUTS.ktx2Manifest].map((path) => resolve(root, path));
  if (write) {
    for (const path of outputs) try { await lstat(path); throw new Error(`production R1 input already exists: ${portable(root, path)}`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await mkdir(resolve(root, PRODUCTION_R1_INPUTS.directory), { recursive: true, mode: 0o700 });
    await copyFile(sourceLod.absolute, outputs[0], constants.COPYFILE_EXCL); await copyFile(sourceKtx.absolute, outputs[1], constants.COPYFILE_EXCL);
    await writeFile(outputs[2], `${JSON.stringify(publishedLod, null, 2)}\n`, { flag: "wx", mode: 0o600 }); await writeFile(outputs[3], `${JSON.stringify(publishedKtx, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return { lodManifest: publishedLod, ktx2Manifest: publishedKtx, hashes: { lodGlb: `sha256:${EXPECTED.lod}`, ktx2Glb: `sha256:${EXPECTED.ktx2}`, lodManifest: `sha256:${sha(Buffer.from(`${JSON.stringify(publishedLod, null, 2)}\n`))}`, ktx2Manifest: `sha256:${sha(Buffer.from(`${JSON.stringify(publishedKtx, null, 2)}\n`))}` } };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await publishProductionPackageInputs(), null, 2));
