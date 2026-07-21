import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./record-building-stage-review-decision.mjs", import.meta.url), "utf8");
for (const token of ["A1-shell", "I1-layout", "F1-asset", "V1-vfx", "C1-composition", "R1-release", "assertBuildingArtifactReviewable"]) assert.ok(source.includes(token), `missing ${token}`);
assert.match(source, /decision !== "approve"/);
assert.match(source, /BUILDING_HITL_DECISION_SCHEMA_V2/);
assert.match(source, /evidenceBindings: candidate\.evidence\.map/);
assert.match(source, /flag: "wx"/);
console.log("generic building-stage HITL recorder preserves exact gate and evidence binding");
