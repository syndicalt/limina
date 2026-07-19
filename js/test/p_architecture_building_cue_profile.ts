import fs from "node:fs";
import assert from "node:assert/strict";
import { buildingCueProfileHash, validateBuildingCueProfile } from "../src/architecture/building-cue-profile.ts";
import { validateVisualDesignContract, visualDesignContractHash } from "../src/architecture/visual-design-contract.ts";

const visual=validateVisualDesignContract(JSON.parse(fs.readFileSync("art-direction/functional-hall-house-v4-v2-visual-design.json","utf8")));
const source=JSON.parse(fs.readFileSync("assets/buildings/programs/functional-hall-house-fb4-cue-profile-v2.json","utf8"));
const cueIds=visual.cues.map((cue)=>cue.id),profile=validateBuildingCueProfile(source,cueIds);
assert.equal(profile.visualDesignContractHash,visualDesignContractHash(visual));
assert.match(buildingCueProfileHash(profile,cueIds),/^sha256:[0-9a-f]{64}$/);
const rejects=(mutate:(copy:any)=>void,pattern:RegExp)=>{const copy=structuredClone(source);mutate(copy);assert.throws(()=>validateBuildingCueProfile(copy,cueIds),pattern)};
rejects(copy=>copy.mappings[0].cueId=copy.mappings[1].cueId,/unique/);
rejects(copy=>copy.mappings[0].owner=copy.mappings[1].owner,/exact and unique/);
rejects(copy=>copy.sourceUrl="https://example.com/reference.jpg",/fields are not exact/);
rejects(copy=>copy.mappings[0].cueId="unmapped-cue",/exactly map/);
console.log("p_architecture_building_cue_profile OK: exact source-neutral cue-to-program/compiler closure without image geometry authority");
