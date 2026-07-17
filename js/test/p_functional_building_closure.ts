import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_functional_building_closure FAIL: ${message}`); }
const root = fileURLToPath(new URL("../../", import.meta.url));
const closure = JSON.parse(fs.readFileSync(`${root}art-direction/functional-cottage-v1-closure.json`, "utf8"));
const bytes = fs.readFileSync(`${root}assets/${closure.asset.assetId}`);
const digest = (value: Uint8Array) => crypto.createHash("sha256").update(value).digest("hex");
assert(bytes.byteLength === closure.asset.byteLength && digest(bytes) === closure.asset.sha256, "pinned GLB bytes drifted");
assert(digest(fs.readFileSync(`${root}${closure.generator.path}`)) === closure.generator.sha256, "generator drifted without closure update");
const contract = parseFunctionalBuildingContract(bytes);
assert(contract.schema === closure.asset.contract && contract.buildingId === closure.asset.buildingId, "embedded semantic identity drifted");
assert(Object.values(closure.mechanicalGates).every((value) => value === true), "mechanical closure contains an open gate");
assert(closure.visual.projectGorgonFloorPassed === false && closure.visual.humanApproved === false && closure.visual.reviewArtifact === null,
  "mechanical prototype falsely claims visual acceptance");
console.log(`p_functional_building_closure OK: ${bytes.byteLength} bytes, sha256:${closure.asset.sha256}`);
