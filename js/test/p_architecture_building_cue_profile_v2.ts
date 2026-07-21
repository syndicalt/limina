import assert from "node:assert/strict";
import {
  BUILDING_CUE_PROFILE_V2,
  buildingCueProfileV2Hash,
  validateBuildingCueProfileV2,
  verifyBuildingCueProfileV2Facts,
} from "../src/architecture/building-cue-profile.ts";

const H = (digit: string) => `sha256:${digit.repeat(64)}`;
const owners = [
  "rulebook.massing.functional-cross-gable",
  "compiler.attached-bay.roof-wall-abutment",
  "compiler.attached-bay.foundation",
  "compiler.entrance-canopy.joinery",
  "compiler.roof-penetration",
  "program.requirements.daylight",
  "review.semantic-evidence",
] as const;
const cues = owners.map((_, index) => `cue/${index}`);
const profile = {
  schema: BUILDING_CUE_PROFILE_V2,
  id: "building/functional-hall-house/fb4-v3",
  visualDesign: { path: "art-direction/house-v3.json", sha256: H("1"), contractHash: H("2") },
  program: { path: "assets/buildings/program-v3.json", sha256: H("3"), programHash: H("4") },
  mappings: owners.map((owner, index) => ({
    cueId: cues[index], owner, verification: index === owners.length - 1 ? "cpu-and-human" : "compiler",
    assertions: [{ fact: `fact/${index}`, operator: index === 0 ? "minimum" : "equals", value: index === 0 ? 1 : true }],
  })),
};
const facts = Object.fromEntries(owners.map((_, index) => [`fact/${index}`, index === 0 ? 2 : true]));
assert.equal(validateBuildingCueProfileV2(profile, cues).schema, BUILDING_CUE_PROFILE_V2);
assert.match(buildingCueProfileV2Hash(profile, cues), /^sha256:[0-9a-f]{64}$/);
assert.equal(verifyBuildingCueProfileV2Facts(profile, facts, cues).id, profile.id);

const mutate = (change: (value: any) => void, pattern: RegExp) => {
  const value = structuredClone(profile); change(value); assert.throws(() => validateBuildingCueProfileV2(value, cues), pattern);
};
mutate((value) => { delete value.program.programHash; }, /fields are not exact/);
mutate((value) => { value.mappings[1].owner = value.mappings[0].owner; }, /owners must be exact and unique/);
mutate((value) => { value.mappings[1].assertions[0].fact = value.mappings[0].assertions[0].fact; }, /asserted more than once/);
mutate((value) => { value.mappings[0].assertions[0].value = true; }, /minimum assertions require numeric/);
assert.throws(() => verifyBuildingCueProfileV2Facts(profile, { ...facts, "fact/smuggled": true }, cues), /fact inventory is not exact/);
assert.throws(() => verifyBuildingCueProfileV2Facts(profile, { ...facts, "fact/0": 0 }, cues), /falls below/);
assert.throws(() => verifyBuildingCueProfileV2Facts(profile, { ...facts, "fact/1": false }, cues), /does not equal/);

console.log("p_architecture_building_cue_profile_v2 OK: exact program/design authority and machine-checkable cue facts");
