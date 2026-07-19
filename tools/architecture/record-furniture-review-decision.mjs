import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  validateBuildingHitlDecision,
  validateBuildingStageArtifact,
  assertBuildingArtifactReviewable,
} from "../../js/src/assets/staged-building-pipeline.mjs";

const args = process.argv.slice(2),
  at = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0 || !args[i + 1])
      throw new Error(
        "usage: node tools/architecture/record-furniture-review-decision.mjs --candidate <json> --out <json> --decision reject|revise|approve --dependency <approved-artifact.json>... [--finding <text>] [--observation <text>] [--instruction <text>]",
      );
    return args[i + 1];
  },
  all = (flag) => args.flatMap((value, index) => (value === flag && args[index + 1] ? [args[index + 1]] : [])),
  optional = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
const candidatePath = resolve(at("--candidate")),
  outputPath = resolve(at("--out")),
  decision = at("--decision"),
  candidate = validateBuildingStageArtifact(JSON.parse(await readFile(candidatePath, "utf8"))),
  dependencies = await Promise.all(
    all("--dependency").map(async (path) =>
      validateBuildingStageArtifact(JSON.parse(await readFile(resolve(path), "utf8"))),
    ),
  );
if (candidate.kind !== "furniture-pack") throw new Error("candidate is not a furniture pack");
const returning = decision === "reject" || decision === "revise",
  findings = all("--finding"),
  observations = all("--observation"),
  instruction = optional("--instruction"),
  record = validateBuildingHitlDecision({
    schema: "limina.building-hitl-decision/v1",
    decisionId: `${candidate.artifactId}/${decision}-user-1`,
    gate: "F1-asset",
    artifactId: candidate.artifactId,
    contractHash: candidate.contractHash,
    contentHash: candidate.contentHash,
    reviewer: "user",
    timestamp: new Date().toISOString(),
    decision,
    evidenceHashes: candidate.evidence.map((entry) => entry.contentHash),
    blockingFindings: returning
      ? findings.length
        ? findings
        : ["The asset requires revision before it can pass this gate."]
      : [],
    observations,
    markedRegions: [],
    ...(returning
      ? { instruction: instruction ?? "Author a corrected replacement and return it to F1 asset review." }
      : {}),
    ...(decision === "reject" ? { returnToGate: "F1-asset" } : {}),
  });
assertBuildingArtifactReviewable(candidate, record, [...dependencies, candidate]);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(
  JSON.stringify(
    {
      decisionId: record.decisionId,
      decision: record.decision,
      returnToGate: record.returnToGate,
      evidenceHashes: record.evidenceHashes,
    },
    null,
    2,
  ),
);
