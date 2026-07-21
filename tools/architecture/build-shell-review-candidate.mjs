import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, relative, resolve, sep } from "node:path";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";

const args = process.argv.slice(2),
  at = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0 || !args[index + 1])
      throw new Error(
        "usage: node tools/architecture/build-shell-review-candidate.mjs --authority <json> --capture <json> --draft <json> --out <json>",
      );
    return resolve(args[index + 1]);
  };
const authorityPath = at("--authority"),
  capturePath = at("--capture"),
  draftPath = at("--draft"),
  outputPath = at("--out"),
  repo = resolve(import.meta.dirname, "../..");
const authorityBytes = await readFile(authorityPath),
  authority = JSON.parse(authorityBytes),
  capture = JSON.parse(await readFile(capturePath, "utf8")),
  draft = validateBuildingStageArtifact(JSON.parse(await readFile(draftPath, "utf8"))),
  authoritySha256 = `sha256:${createHash("sha256").update(authorityBytes).digest("hex")}`;
if (
  draft.kind !== "shell" ||
  draft.status !== "draft" ||
  draft.artifactId !== authority.artifact?.artifactId ||
  draft.contractHash !== authority.artifact?.contractHash ||
  draft.contentHash !== authority.asset?.sha256 ||
  draft.evidence.length !== 0
)
  throw new Error("draft does not bind the staged shell authority");
if (
  capture.schema !== "limina.staged-shell-native-review-set/v1" ||
  capture.backend !== "native-webgpu" ||
  capture.captureClass !== "production-engine" ||
  capture.authority?.path !== relative(repo, authorityPath).split(sep).join("/") ||
  capture.authority?.sha256 !== authoritySha256 ||
  capture.asset?.sha256 !== authority.asset?.sha256 ||
  capture.asset?.assetHash !== authority.asset?.assetHash
)
  throw new Error("capture does not bind the staged shell authority");
if (
  capture.guardEvidence?.schema !== "limina.nvidia-xid-guard/v1" ||
  capture.guardEvidence.preflight?.xidObserved !== false ||
  capture.guardEvidence.live?.xidObserved !== false ||
  capture.guardEvidence.postflight?.xidObserved !== false ||
  capture.timingPolicy?.gpuTimestampMode !== "disabled" ||
  capture.timingPolicy?.timestampQueriesEnabled !== false
)
  throw new Error("capture lacks the absolute native GPU guard contract");
const functionalKeys = ["buildingId", "doors", "colliders", "rooms", "portals"];
if (
  capture.functionalPlacement?.parts !== authority.functional?.colliders ||
  functionalKeys.some((key) => capture.functionalInventory?.[key] !== authority.functional?.[key]) ||
  capture.exclusions?.furniture !== true ||
  capture.exclusions?.domesticProps !== true ||
  capture.exclusions?.fireVisuals !== true ||
  capture.exclusions?.practicalLights !== true ||
  capture.renderPolicy?.level !== "source-lod0" ||
  capture.renderPolicy?.reason !== "exact-staged-shell-has-no-packaged-lod-roots"
)
  throw new Error("capture lacks the authority-bound A1 functional/exclusion/render contract");
const views = authority.evidenceViews;
if (
  !Array.isArray(capture.outputs) ||
  capture.outputs.length !== views.length ||
  capture.outputs.some(
    (output, index) =>
      output.id !== views[index].id ||
      output.state !== views[index].state ||
      output.role !== views[index].role ||
      !/^sha256:[0-9a-f]{64}$/.test(output.pngSha256) ||
      !Number.isSafeInteger(output.width) ||
      !Number.isSafeInteger(output.height),
  )
)
  throw new Error("capture does not contain the authority-bound exact A1 evidence set");
const candidate = validateBuildingStageArtifact({
  ...draft,
  status: "candidate",
  evidence: capture.outputs.map((output) => ({
    evidenceId: `${draft.artifactId}/${output.id}`,
    kind: "production-engine-png",
    contentHash: output.pngSha256,
    width: output.width,
    height: output.height,
    ...(output.timestamp === undefined ? {} : { timestamp: output.timestamp }),
  })),
  metadata: {
    ...draft.metadata,
    humanDecision: "pending",
    authorityPath: relative(repo, authorityPath).split(sep).join("/"),
    captureEvidencePath: relative(repo, capturePath).split(sep).join("/"),
    captureBackend: capture.backend,
    guardSchema: capture.guardEvidence.schema,
    renderPolicy: capture.renderPolicy,
  },
});
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, {
  mode: 0o600,
  flag: draft.revision > 1 ? "wx" : "w",
});
console.log(
  JSON.stringify(
    {
      artifactId: candidate.artifactId,
      status: candidate.status,
      evidence: candidate.evidence.map(({ evidenceId, contentHash }) => ({ evidenceId, contentHash })),
      humanDecision: candidate.metadata.humanDecision,
    },
    null,
    2,
  ),
);
