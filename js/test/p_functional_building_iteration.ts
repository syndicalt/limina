import { selectedFunctionalBuildingCycle, validateFunctionalBuildingIteration, verifyFunctionalBuildingReferenceSources } from "../src/assets/functional-building-iteration.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { ops } from "../src/engine.ts";
const manifest = JSON.parse(new TextDecoder().decode(ops.op_read_asset("art-direction/functional-cottage-v4-iteration.json")));
const valid = validateFunctionalBuildingIteration(manifest);
if (valid.status !== "engine-review" || valid.selectedCycle !== 13 || valid.targetEngineViews.length !== 6) throw new Error("iteration authority drifted");
verifyFunctionalBuildingReferenceSources(valid, (path: string) => { try { return ops.op_read_asset(path); } catch (error) { throw new Error(`iteration source unreadable: ${path}`, { cause: error }); } }, (bytes: Uint8Array) => `sha256:${sha256(bytes)}`);
const selected = selectedFunctionalBuildingCycle(valid);
if (selected.cycle !== 13 || selected.status !== "engine-review") throw new Error("wrong cycle selected for engine review");
if (selected.artifact?.assetId !== "buildings/functional-hall-house-v4-production.glb") throw new Error("selected production asset drifted");
if (selected.artifact?.rawSha256 !== "sha256:f199eaf6e401e448594146a16cee7bad6bb9e13283a4a9ddfe4c58bc9b3205b1") throw new Error("selected raw asset identity drifted");
if (selected.artifact?.engineContentHash !== "sha256:cbc367e24b62df6d8a72266939c56ca62cd9bfe8e4d6885ec50caaade65df6d8") throw new Error("selected engine asset identity drifted");
const bad = JSON.parse(JSON.stringify(manifest)); bad.targetEngineViews[2].id = bad.targetEngineViews[0].id;
try { validateFunctionalBuildingIteration(bad); throw new Error("duplicate view accepted"); } catch (error) { if ((error as Error).message === "duplicate view accepted") throw error; }
console.log("p_functional_building_iteration OK");
