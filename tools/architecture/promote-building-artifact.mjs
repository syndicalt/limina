import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  validateBuildingStageArtifact,
  validateBuildingHitlDecision,
  assertBuildingArtifactReviewable,
} from "../../js/src/assets/staged-building-pipeline.mjs";
const args = process.argv.slice(2),
  at = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0 || !args[i + 1])
      throw new Error(
        "usage: node tools/architecture/promote-building-artifact.mjs --candidate <json> --decision <json> --out <json> [--dependency <approved-artifact.json> ...]",
      );
    return resolve(args[i + 1]);
  },
  all = (flag) => args.flatMap((entry, index) => (entry === flag && args[index + 1] ? [resolve(args[index + 1])] : [])),
  candidatePath = at("--candidate"),
  decisionPath = at("--decision"),
  out = at("--out"),
  repo = resolve(import.meta.dirname, "../.."),
  candidate = validateBuildingStageArtifact(JSON.parse(await readFile(candidatePath, "utf8"))),
  decisionBytes = await readFile(decisionPath),
  decision = validateBuildingHitlDecision(JSON.parse(decisionBytes)),
  dependencies = await Promise.all(
    all("--dependency").map(async (path) => validateBuildingStageArtifact(JSON.parse(await readFile(path, "utf8")))),
  );
if (decision.decision !== "approve") throw new Error("only an exact approval can promote a building artifact");
assertBuildingArtifactReviewable(candidate, decision, [...dependencies, candidate]);
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  portable = (path) => relative(repo, path).split(sep).join("/");
const approval = {
    decisionId: decision.decisionId,
    path: portable(decisionPath),
    sha256: hash(decisionBytes),
    reviewer: decision.reviewer,
    timestamp: decision.timestamp,
  },
  production = candidate.kind === "production-package";
const approved = validateBuildingStageArtifact({
  ...candidate,
  status: "approved",
  metadata: {
    ...(candidate.metadata ?? {}),
    humanDecision: "approved",
    ...(production
      ? {
          visualApprovalClaimed: true,
          review: {
            ...(candidate.metadata?.review ?? {}),
            status: "approved",
            humanDecision: "approved",
            visualApprovalClaimed: true,
            decision: { path: portable(decisionPath), sha256: approval.sha256, decisionId: decision.decisionId },
          },
        }
      : {}),
    approval,
  },
});
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(approved, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(
  JSON.stringify(
    {
      artifactId: approved.artifactId,
      status: approved.status,
      contentHash: approved.contentHash,
      approval: approved.metadata.approval,
    },
    null,
    2,
  ),
);
