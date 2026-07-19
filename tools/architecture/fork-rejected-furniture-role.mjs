import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  validateBuildingHitlDecision,
  validateBuildingStageArtifact,
} from "../../js/src/assets/staged-building-pipeline.mjs";
const args = process.argv.slice(2),
  at = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0 || !args[i + 1])
      throw new Error(
        "usage: node tools/architecture/fork-rejected-furniture-role.mjs --candidate <json> --decision <json> --out <json>",
      );
    return resolve(args[i + 1]);
  },
  source = validateBuildingStageArtifact(JSON.parse(await readFile(at("--candidate"), "utf8"))),
  decision = validateBuildingHitlDecision(JSON.parse(await readFile(at("--decision"), "utf8"))),
  outputPath = at("--out");
if (decision.decision !== "reject" || decision.artifactId !== source.artifactId)
  throw new Error("role fork requires the exact rejected source candidate");
const hash = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`,
  roleContractHash = hash(
    JSON.stringify({
      schema: "limina.furniture-role-contract/v1",
      kind: "high-back-chair",
      occupancy: 1,
      sourceContentHash: source.contentHash,
    }),
  );
const draft = validateBuildingStageArtifact({
  ...source,
  artifactId: "furniture/high-back-chair/r1",
  revision: 1,
  status: "draft",
  contractHash: roleContractHash,
  facets: source.facets.map((facet) => ({
    scope: facet.scope,
    hash: hash(`${facet.scope}:${roleContractHash}:${source.contentHash}`),
  })),
  evidence: [],
  metadata: {
    ...source.metadata,
    gate: "F1-asset",
    humanDecision: "not-reviewed-for-chair-role",
    role: "high-back-chair",
    occupancy: 1,
    reclassifiedFrom: source.artifactId,
    reclassificationDecision: decision.decisionId,
    sharedImmutableContentHash: source.contentHash,
  },
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
console.log(
  JSON.stringify(
    {
      artifactId: draft.artifactId,
      status: draft.status,
      role: draft.metadata.role,
      sharedImmutableContentHash: draft.contentHash,
    },
    null,
    2,
  ),
);
