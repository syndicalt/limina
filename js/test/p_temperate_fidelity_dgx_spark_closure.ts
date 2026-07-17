import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_temperate_fidelity_dgx_spark_closure FAIL: ${message}`);
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const closure = JSON.parse(fs.readFileSync(`${root}art-direction/temperate-fidelity-dgx-spark-v4-closure.json`, "utf8"));
const regression = JSON.parse(fs.readFileSync(`${root}art-direction/temperate-fidelity-native-regression.json`, "utf8"));
const artifactPath = `${root}assets/${closure.artifact.assetId}`;
const bytes = fs.readFileSync(artifactPath);
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

assert(closure.schema === "limina.visual-fidelity-candidate-review/v1", "closure schema drifted");
assert(closure.decision.status === "owner-accepted-nature-baseline-closed", "nature lane is not formally closed");
assert(closure.decision.releasePassed === false, "single-frame approval must not claim full performance release");
assert(closure.decision.nextProgram === "functional-buildings", "next program is not functional buildings");
assert(closure.evidence.humanReview.approved === true, "owner approval is missing");
assert(closure.evidence.facets.visualRegression === true && closure.evidence.facets.lifecycle === true,
  "mechanical regression or lifecycle evidence is missing");
assert(closure.evidence.facets.targetHardwarePerformance === false,
  "guarded single-frame capture must not claim sustained target-hardware performance");
assert(closure.capture.backend === "native-webgpu" && closure.capture.adapterDescription === "NVIDIA GB10",
  "DGX Spark native capture identity drifted");
assert(closure.capture.nvidiaXidObserved === false, "closure contains an NVIDIA Xid");
assert(closure.capture.timestampQueriesEnabled === false, "timestamp queries must remain disabled");
assert(bytes.byteLength === closure.artifact.byteLength, "artifact byte length drifted");
assert(sha256 === closure.artifact.sha256, "artifact content hash drifted");
assert(JSON.stringify(regression.candidateBaseline) === JSON.stringify({
  assetId: closure.artifact.assetId,
  sha256: closure.artifact.sha256,
  byteLength: closure.artifact.byteLength,
  width: closure.artifact.width,
  height: closure.artifact.height,
}), "fixed-camera regression authority is not pinned to the accepted artifact");

console.log(`p_temperate_fidelity_dgx_spark_closure OK: ${closure.artifact.width}x${closure.artifact.height}, sha256:${sha256}`);
