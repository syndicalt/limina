import fs from "node:fs";
import { canonicalStringify } from "../src/authoring/canonical.ts";
import { verifyBuildingCueProfileV2Facts } from "../src/architecture/building-cue-profile.ts";
import {
  BUILDING_SYNTHESIS_MANIFEST_V3,
  synthesizeTimberHallHouseV3,
} from "../src/architecture/building-program-synthesizer-v3.ts";
import { validateVisualDesignContract } from "../src/architecture/visual-design-contract.ts";
import { compileArchitecture } from "../src/architecture/compiler.ts";

const assert = (value: unknown, message: string): asserts value => {
  if (!value) throw new Error(`p_architecture_building_program_synthesizer_v3 FAIL: ${message}`);
};
const program = JSON.parse(fs.readFileSync("assets/buildings/programs/functional-hall-house-fb4-program-v3.json", "utf8"));
const first = synthesizeTimberHallHouseV3(program), second = synthesizeTimberHallHouseV3(structuredClone(program));
assert(canonicalStringify(first) === canonicalStringify(second), "V3 synthesis is not deterministic");
assert(first.acceptedDecisionCount === 1 && first.candidates.length === 1, "V3 did not retain exactly the collision-free right-wall frontier");
const candidate = first.candidates[0], { spec, compiled, manifest } = candidate, bay = compiled.attachedBays?.[0], canopy = compiled.entranceCanopies?.[0];
assert(candidate.decision.id === "target/front-to-rear/right-wall", "V3 selected a doorway-burying layout");
assert(manifest.schema === BUILDING_SYNTHESIS_MANIFEST_V3 && manifest.programHash === first.programHash, "V3 manifest identity drifted");
assert(compiled.specHash === "sha256:735feb69c00c08102a7bfe751c45e9cd8065327dbaa83cacdd65510be266afec", "V3 selected spec hash drifted");
assert(compiled.irHash === "sha256:4d0958830888aec31208eb3714e338391783b98d077882586d39023f2bbff21b", "V3 selected IR hash drifted");
assert(bay?.functionalRoomId === "room/space/service-pantry" && bay.portalId === "portal/connection/hall-service-pantry", "service mass lost functional room/passage binding");
assert(bay.passageThreshold.center[1] + bay.passageThreshold.halfExtents[1] === 0 && bay.functionalFloorColliderIds.every((id) => compiled.functionalContract?.colliders.some((collider) => collider.id === id)), "service passage lacks a flush compiler-owned floor join");
assert(compiled.functionalContract?.roomIds.length === 6 && compiled.functionalContract.portalIds.length === 5, "service mass did not extend the real functional contract");
assert(bay.roofAbutmentIds.length === 2 && !compiled.primitives.some((primitive) => primitive.id === `gable/${bay.roofSystemId}/rear`), "service roof headwall closure drifted");
assert(compiled.windows.filter((window) => window.openingId.startsWith("window/space/bedroom-a/")).every((window) => window.facade === "west"), "upper gable daylight was not preserved outside the service roof");
assert(compiled.windows.some((window) => window.openingId === bay.frontWindowId && window.facade === "south"), "service room lacks its occupied front gable window");
assert(spec.functional && "schema" in spec.functional && spec.functional.stairs[0]?.flights?.length === 2 && spec.functional.stairs[0]?.intermediateLandings?.length === 1
  && spec.functional.stairs[0]?.approaches?.bottom.center[2] === -2.4 && spec.functional.stairs[0]?.approaches?.top.center[2] === -1.5,
  "V3 stair lost its return-flight or occupiable landing-centered approach authority");
assert(spec.functional && "schema" in spec.functional && spec.functional.stairs[0].upperFloorOpening.center[0] === 3.63
  && spec.functional.stairs[0].upperFloorOpening.halfExtents[0] > .98,
  "V3 stairwell opening no longer clears both return flights for headroom");
assert(spec.doors?.find((door) => door.id === "door/landing-rear")?.openYawDegrees === -95, "rear bedroom door no longer swings clear of stair circulation");
assert(compiled.functionalContract?.colliders.filter((collider) => collider.id.match(/^collider\/stairs\/stairs\/primary\/flight-[01]\/tread-\d+$/)).length === 20
  && spec.functional && "schema" in spec.functional && spec.functional.stairs[0].intermediateLandings?.[0].halfExtents[1] === .95,
  "V3 return stair lost autostep surfaces or its rear turn landing clearance");
assert(compiled.fireplaces[0]?.flueTransition?.length === 4 && compiled.fireplaces[0].flueTransition.every((panel) => panel.derivedFrom.includes("fireplace/hall") && panel.derivedFrom.includes("chimney/hall")), "hearth and shaft lost their closed compiler-owned masonry transition");
assert(spec.roofSystems?.every((roof) => roof.roofWallConnection === "weather-bearing-v1") && spec.attachedBays?.every((attached) => attached.headwallTermination === "exterior-weather-face-v1"), "weather-bearing roof policy drifted");
assert(compiled.primitives.filter((primitive) => primitive.id.startsWith("roof-wall-flashing/attached-bay/service-cross-gable/")).every((primitive) => primitive.kind === "linear-member" && primitive.from[2] === -3.6 && primitive.to[2] === -3.6), "service roof no longer terminates on the exterior weather face");
const roofCover = (id: string, x: number, z: number) => {
  const primitive = compiled.primitives.find((entry) => entry.id === id);
  assert(primitive?.kind === "plane-slab", `${id} weather surface is missing`);
  return primitive.origin[1] - (primitive.normal[0] * (x - primitive.origin[0]) + primitive.normal[2] * (z - primitive.origin[2])) / primitive.normal[1];
};
assert(roofCover("roof-weather/roof/main/south/fragment-left", -4, -3.8) >= 6.49, "main weather surface exposes the proud eave frame");
assert(roofCover("roof-weather/roof/service-cross-gable/west", -4.93, -5) >= 3.72, "service weather surface exposes the proud eave frame");
const rejects = (mutate: (copy: any) => void, pattern: RegExp) => { const copy = structuredClone(spec) as any; mutate(copy); let error = ""; try { compileArchitecture(copy); } catch (cause) { error = String(cause); } assert(pattern.test(error), `expected ${pattern}, got ${error}`); };
rejects((copy) => { copy.functional.stairs[0].approaches.bottom.center[2] = -3.2; }, /landing constraints/);
rejects((copy) => { copy.functional.stairs[0].upperFloorOpening.center[0] = 4.12; copy.functional.stairs[0].upperFloorOpening.halfExtents[0] = .47; }, /headroom\/landing constraints/);
rejects((copy) => { const stair = copy.functional.stairs[0]; delete stair.flights; delete stair.intermediateLandings; delete stair.approaches; stair.from = [4.12, 0, -2.5]; stair.to = [4.12, 3.46, 2.5]; stair.upperFloorOpening = { center: [4.12, .5326589595375724], halfExtents: [.47, 1.9873410404624277] }; }, /landing constraints/);
assert(canopy?.kneeBraces?.length === 2, "primary canopy lacks compiler-owned knee braces");
assert(spec.dormers?.[0]?.alongCenter === 2.45, "attic dormer was not moved to the roof bay opposite the service mass");
assert(first.rejections.some((entry) => entry.code === "V3_EXISTING_FACADE_OPENING_BURIED"), "doorway-burying alternatives did not fail closed");

const visual = validateVisualDesignContract(JSON.parse(fs.readFileSync("art-direction/functional-hall-house-v4-v3-visual-design.json", "utf8"))),
  cueProfile = JSON.parse(fs.readFileSync("assets/buildings/programs/functional-hall-house-fb4-cue-profile-v3.json", "utf8"));
verifyBuildingCueProfileV2Facts(cueProfile, {
  ...manifest.cueFacts,
  "evidence/required-claim-view-count": 5,
  "evidence/unresolved-semantic-target-count": 0,
  "evidence/clipped-required-target-count": 0,
}, visual.cues.map((cue) => cue.id));

console.log("p_architecture_building_program_synthesizer_v3 OK: one collision-free functional cross-gable frontier with exact room, passage, daylight, headwall, foundation, canopy, cue, spec, and IR authority");
