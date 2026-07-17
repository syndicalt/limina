import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_temperate_fidelity_dgx_spark_closure FAIL: ${message}`);
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const closureBytes = fs.readFileSync(`${root}art-direction/temperate-fidelity-dgx-spark-v4-closure.json`);
const regressionBytes = fs.readFileSync(`${root}art-direction/temperate-fidelity-native-regression.json`);
const closure = JSON.parse(closureBytes.toString("utf8"));
const regression = JSON.parse(regressionBytes.toString("utf8"));

// The closure/regression records are FROZEN owner decisions. Without these byte pins,
// every prose assertion below is self-consistency (regenerating the JSON forges the
// verdict — the exact class the project's postmortems name). Re-pin ONLY alongside an
// explicit owner re-decision, in the same commit that changes the record.
assert(crypto.createHash("sha256").update(closureBytes).digest("hex")
  === "d953493b93367baba4f997042da5702ca12ac17d525827cba1542f4f80b1ac47",
  "closure record bytes drifted from the pinned owner decision");
assert(crypto.createHash("sha256").update(regressionBytes).digest("hex")
  === "144c2044aff93db65fb3c37e753a1983c12f2c99b479251da590be3464138264",
  "native-regression record bytes drifted from the pinned owner decision");
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
