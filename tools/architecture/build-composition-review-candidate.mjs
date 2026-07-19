import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import {
  validateBuildingCompositionReviewAuthority,
  verifyBuildingCompositionReviewClosure,
} from "../../js/src/render/building-composition-review-scene.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

const ROOT = resolve(import.meta.dirname, "../.."),
  sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  hashObject = (value) => sha(Buffer.from(JSON.stringify(value))),
  portable = (path) => {
    const value = relative(ROOT, path).split(sep).join("/");
    if (!value || value === ".." || value.startsWith("../") || isAbsolute(value))
      throw new Error(`C1 candidate path escapes repository: ${path}`);
    return value;
  },
  exact = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export async function buildCompositionReviewCandidate({ authorityPath, capturePath, outputPath, write = true } = {}) {
  if (!authorityPath || !capturePath || !outputPath)
    throw new Error("authorityPath, capturePath, and outputPath are required");
  const authorityAbsolute = resolve(ROOT, authorityPath),
    captureAbsolute = resolve(ROOT, capturePath),
    outputAbsolute = resolve(ROOT, outputPath),
    [authorityBytes, captureBytes] = await Promise.all([readFile(authorityAbsolute), readFile(captureAbsolute)]),
    authority = validateBuildingCompositionReviewAuthority(JSON.parse(authorityBytes)),
    capture = JSON.parse(captureBytes),
    paths = new Set([
      authority.manifest.path,
      authority.functionalEvidence.path,
      authority.integratedSource.evidence.path,
      authority.integratedSource.blend.path,
      authority.integratedSource.glb.path,
    ]),
    manifest = JSON.parse(await readFile(resolve(ROOT, authority.manifest.path)));
  for (const dependency of [
    manifest.dependencies.shell,
    manifest.dependencies.materialPalette,
    manifest.dependencies.interiorPlan,
  ]) {
    paths.add(dependency.artifact.artifactPath);
    paths.add(dependency.approvalDecision.path);
  }
  for (const entry of manifest.dependencies.catalog) {
    paths.add(entry.artifact.artifactPath);
    paths.add(entry.approvalDecision.path);
    for (const key of ["designContract", "buildEvidence", "functionalEvidence", "sourceBlend", "runtimeGlb"])
      paths.add(entry[key].path);
  }
  for (const entry of [
    manifest.dependencies.shell.sourceBlend,
    manifest.dependencies.shell.runtimeGlb,
    manifest.dependencies.materialPalette.materialsLock,
    manifest.dependencies.materialPalette.runtimeGlb,
    manifest.dependencies.interiorPlan.plan,
  ])
    paths.add(entry.path);
  const byteMap = new Map(
    await Promise.all([...paths].map(async (path) => [path, new Uint8Array(await readFile(resolve(ROOT, path)))])),
  );
  const closure = verifyBuildingCompositionReviewClosure(authority, (path) => {
    const bytes = byteMap.get(path);
    if (!bytes) throw new Error(`C1 candidate closure lacks ${path}`);
    return bytes;
  });
  if (
    capture.schema !== "limina.building-composition-native-review-set/v1" ||
    capture.backend !== "native-webgpu" ||
    capture.captureClass !== "production-engine" ||
    capture.timingPolicy?.gpuTimestampMode !== "disabled" ||
    capture.timingPolicy?.timestampQueriesEnabled !== false ||
    !exact(capture.manifest, authority.manifest) ||
    !exact(capture.functionalEvidence, authority.functionalEvidence) ||
    !exact(capture.integratedSource, authority.integratedSource) ||
    capture.guardEvidence?.schema !== "limina.nvidia-xid-guard/v1" ||
    capture.guardEvidence.preflight?.xidObserved !== false ||
    capture.guardEvidence.live?.xidObserved !== false ||
    capture.guardEvidence.postflight?.xidObserved !== false
  )
    throw new Error("C1 candidate requires exact guarded native-engine capture authority");
  if (
    !Array.isArray(capture.outputs) ||
    capture.outputs.length !== authority.evidenceViews.length ||
    capture.outputs.some(
      (output, index) =>
        output.id !== authority.evidenceViews[index].id ||
        output.width < authority.presentation.minimumResolution[0] ||
        output.height < authority.presentation.minimumResolution[1] ||
        typeof output.pngSha256 !== "string",
    )
  )
    throw new Error("C1 candidate capture evidence set is incomplete");
  const approved = [];
  for (const reference of [
    manifest.dependencies.shell.artifact,
    manifest.dependencies.materialPalette.artifact,
    manifest.dependencies.interiorPlan.artifact,
    ...manifest.dependencies.catalog.map((entry) => entry.artifact),
  ]) {
    const bytes = byteMap.get(reference.artifactPath),
      artifact = validateBuildingStageArtifact(JSON.parse(new TextDecoder().decode(bytes)));
    if (
      artifact.status !== "approved" ||
      artifact.artifactId !== reference.artifactId ||
      sha(bytes) !== reference.artifactSha256
    )
      throw new Error(`C1 dependency approval drifted: ${reference.artifactId}`);
    if (!approved.some((entry) => entry.artifactId === artifact.artifactId)) approved.push(artifact);
  }
  const inputs = approved.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      facets: artifact.facets,
    })),
    instances = closure.manifest.instances,
    facets = [
      {
        scope: "instance-set",
        hash: hashObject(instances.map(({ id, role, catalogArtifactId }) => ({ id, role, catalogArtifactId }))),
      },
      { scope: "resolved-transforms", hash: hashObject(instances.map(({ id, placement }) => ({ id, placement }))) },
      {
        scope: "interaction-bindings",
        hash: hashObject(instances.map(({ id, bindings, constraints }) => ({ id, bindings, constraints }))),
      },
      {
        scope: "runtime-bindings",
        hash: hashObject(
          manifest.dependencies.catalog.map((entry) => ({ artifact: entry.artifact, runtimeGlb: entry.runtimeGlb })),
        ),
      },
      {
        scope: "material-bindings",
        hash: hashObject({
          artifact: manifest.dependencies.materialPalette.artifact,
          runtimeGlb: manifest.dependencies.materialPalette.runtimeGlb,
        }),
      },
      {
        scope: "runtime-closure",
        hash: hashObject({
          manifest: authority.manifest,
          functionalEvidence: authority.functionalEvidence,
          integratedSource: authority.integratedSource,
        }),
      },
    ],
    candidate = validateBuildingStageArtifact({
      schema: "limina.building-stage-artifact/v1",
      artifactId: authority.manifest.id,
      kind: "composition",
      revision: authority.manifest.revision,
      status: "candidate",
      contractHash: authority.manifest.canonicalHash,
      contentHash: authority.integratedSource.glb.sha256,
      facets,
      inputs,
      evidence: capture.outputs.map((output) => ({
        evidenceId: `${authority.manifest.id}/${output.id}`,
        kind: "production-engine-png",
        contentHash: output.pngSha256,
        width: output.width,
        height: output.height,
      })),
      ...(authority.manifest.revision > 1
        ? { supersedes: `composition/functional-hall-house-v4/r${authority.manifest.revision - 1}` }
        : {}),
      metadata: {
        gate: "C1-composition",
        humanDecision: "pending",
        fireExcluded: true,
        lodClosure: "not-claimed",
        authority: {
          path: portable(authorityAbsolute),
          sha256: sha(authorityBytes),
          contentHash: portableAssetContentHash(authorityBytes),
        },
        capture: {
          path: portable(captureAbsolute),
          sha256: sha(captureBytes),
          contentHash: portableAssetContentHash(captureBytes),
          backend: capture.backend,
        },
        functionalEvidence: authority.functionalEvidence,
        integratedSource: authority.integratedSource,
      },
    });
  if (write) {
    await mkdir(dirname(outputAbsolute), { recursive: true, mode: 0o700 });
    await writeFile(outputAbsolute, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  return Object.freeze({ candidate, outputPath: outputAbsolute });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2),
    at = (flag) => {
      const index = args.indexOf(flag);
      if (index < 0 || !args[index + 1])
        throw new Error(
          "usage: bun tools/architecture/build-composition-review-candidate.mjs --authority <json> --capture <json> --out <json>",
        );
      return args[index + 1];
    };
  const result = await buildCompositionReviewCandidate({
    authorityPath: at("--authority"),
    capturePath: at("--capture"),
    outputPath: at("--out"),
  });
  console.log(
    JSON.stringify(
      { artifactId: result.candidate.artifactId, status: result.candidate.status, evidence: result.candidate.evidence },
      null,
      2,
    ),
  );
}
