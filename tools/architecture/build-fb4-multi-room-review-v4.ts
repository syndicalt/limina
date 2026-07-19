import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FB4_V4_SEMANTIC_VIEW_MAPPING,
  validateMultiRoomReviewAuthority,
  verifyMultiRoomReviewV3Closure,
  verifyMultiRoomReviewV4Closure,
  type MultiRoomReviewAuthority,
} from "../../js/src/render/building-multi-room-review-scene.ts";
import { verifyBuildingSemanticEvidence } from "../../js/src/render/building-semantic-evidence.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const raw = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable = (path: string) => relative(ROOT, path).split(sep).join("/");
const serialize = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
const parse = (bytes: Uint8Array) => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
const read = async (path: string) => {
  const bytes = new Uint8Array(await readFile(resolve(ROOT, path)));
  return {
    path,
    bytes,
    sha256: raw(bytes),
    contentHash: portableAssetContentHash(bytes),
    bytesLength: bytes.byteLength,
  };
};
const ref = (entry: Awaited<ReturnType<typeof read>>) =>
  Object.freeze({ path: entry.path, sha256: entry.sha256, contentHash: entry.contentHash, bytes: entry.bytesLength });

export interface Fb4V4ReviewBuildInput {
  /** Historical V3 authority supplies the validated site envelope, environment, placement, and articulation proxy. */
  readonly baseV3AuthorityPath: string;
  /** Exact passing semantic evidence produced from a non-test source policy. */
  readonly semanticEvidencePath: string;
  /** Recomputed CPU site evidence for the V4 camera set; the V3 site evidence is never rewritten. */
  readonly v4SiteReviewEvidencePath: string;
  /** Explicit new append-only output directory. */
  readonly outputDirectory: string;
}

export async function buildFb4MultiRoomReviewV4(input: Fb4V4ReviewBuildInput) {
  if (
    !input.baseV3AuthorityPath ||
    !input.semanticEvidencePath ||
    !input.v4SiteReviewEvidencePath ||
    !input.outputDirectory
  )
    throw new Error(
      "FB-4 V4 review build requires base V3, semantic evidence, V4 site evidence, and append-only output",
    );
  const [baseFile, semanticFile, siteFile] = await Promise.all(
      [input.baseV3AuthorityPath, input.semanticEvidencePath, input.v4SiteReviewEvidencePath].map(read),
    ),
    base = validateMultiRoomReviewAuthority(parse(baseFile.bytes));
  if (base.schema !== "limina.fb4-multi-room-review-authority/v3")
    throw new Error("FB-4 V4 must advance an exact historical V3 site authority");
  const syncRead = (path: string) => new Uint8Array(readFileSync(resolve(ROOT, path)));
  verifyMultiRoomReviewV3Closure(base, syncRead);
  const semantic = verifyBuildingSemanticEvidence(parse(semanticFile.bytes), syncRead);
  if (semantic.mechanicalVerdict !== "pass") throw new Error("FB-4 V4 requires passing exact semantic evidence");
  const manifestFile = await read(base.candidate.manifest.path),
    manifest = parse(manifestFile.bytes),
    architectureFile = await read(semantic.authority.architectureIr.path),
    architecture = parse(architectureFile.bytes),
    site = parse(siteFile.bytes);
  if (
    manifest.candidateId !== semantic.authority.candidateId ||
    manifest.compiler?.irHash !== base.candidate.irHash ||
    architecture.irHash !== base.candidate.irHash ||
    architecture.functionalContract?.buildingId !== semantic.authority.architectureId
  )
    throw new Error("FB-4 V4 candidate/IR/semantic identities do not close");
  if (manifest.functional?.spawnAnchors?.length !== 6)
    throw new Error("FB-4 V4 candidate must own exactly six spawn anchors");
  const views = base.evidenceViews,
    cameraSetHash = raw(new TextEncoder().encode(JSON.stringify(views)));
  if (
    site.schema !== "limina.fb4-multi-room-site-review-evidence/v1" ||
    site.verdict !== "pass" ||
    site.renderingPerformed !== false ||
    site.gpuUsed !== false ||
    site.visualQualityClaimed !== false ||
    site.humanDecision !== "pending" ||
    site.cameraSetHash !== cameraSetHash ||
    site.cameraEvidence?.views?.map((view: { id: string }) => view.id).join(",") !==
      views.map((view) => view.id).join(",")
  )
    throw new Error("FB-4 V4 site evidence does not prove the corrected camera set");
  const authority: MultiRoomReviewAuthority = {
    ...base,
    schema: "limina.fb4-multi-room-review-authority/v4",
    candidate: {
      candidateId: manifest.candidateId,
      architectureId: semantic.authority.architectureId,
      manifest: ref(manifestFile),
      glb: base.candidate.glb,
      architectureIr: ref(architectureFile),
      specHash: manifest.compiler.specHash,
      irHash: manifest.compiler.irHash,
    },
    topologyProof: { ...base.topologyProof, expectedAnchors: 6 },
    evidenceViews: views,
    semanticEvidence: ref(semanticFile),
    semanticViewMapping: Object.freeze(
      FB4_V4_SEMANTIC_VIEW_MAPPING.map((mapping, index) =>
        Object.freeze({ ...mapping, semanticViewId: semantic.claims[index].viewId }),
      ),
    ),
    siteReviewEvidence: { path: siteFile.path, sha256: siteFile.sha256, contentHash: siteFile.contentHash },
    cameraSetHash,
    reviewToolClosureHash: site.reviewToolClosureHash,
  };
  const validated = validateMultiRoomReviewAuthority(authority);
  verifyMultiRoomReviewV4Closure(validated, (path) => (path === siteFile.path ? siteFile.bytes : syncRead(path)));
  const output = resolve(ROOT, input.outputDirectory),
    staging = `${output}.staging-${process.pid}`,
    authorityBytes = serialize(validated);
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    await writeFile(resolve(staging, "review-authority.json"), authorityBytes, { flag: "wx", mode: 0o600 });
    await rename(staging, output);
  } catch (error) {
    throw error;
  }
  return Object.freeze({
    schema: validated.schema,
    authorityPath: `${input.outputDirectory}/review-authority.json`,
    authoritySha256: raw(authorityBytes),
    candidateId: validated.candidate.candidateId,
    cameraSetHash,
    expectedAnchors: validated.topologyProof.expectedAnchors,
    humanDecision: validated.approval.humanDecision,
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2),
    value = (flag: string) => {
      const index = args.indexOf(flag);
      return index < 0 ? undefined : args[index + 1];
    },
    baseV3AuthorityPath = value("--base-v3-authority"),
    semanticEvidencePath = value("--semantic-evidence"),
    v4SiteReviewEvidencePath = value("--site-evidence"),
    outputDirectory = value("--out");
  if (!baseV3AuthorityPath || !semanticEvidencePath || !v4SiteReviewEvidencePath || !outputDirectory)
    throw new Error(
      "usage: bun tools/architecture/build-fb4-multi-room-review-v4.ts --base-v3-authority <json> --semantic-evidence <json> --site-evidence <json> --out <new-directory>",
    );
  console.log(
    JSON.stringify(
      await buildFb4MultiRoomReviewV4({
        baseV3AuthorityPath,
        semanticEvidencePath,
        v4SiteReviewEvidencePath,
        outputDirectory,
      }),
      null,
      2,
    ),
  );
}
