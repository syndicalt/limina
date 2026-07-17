import { canonicalStringify } from "../src/authoring/canonical.ts";
import { BUILDING_PROGRAM_V1 } from "../src/architecture/building-program.ts";
import { BUILDING_SYNTHESIS_MANIFEST_V1, TIMBER_HALL_HOUSE_RULEBOOK_V1_HASH, synthesizeTimberHallHouse } from "../src/architecture/building-program-synthesizer.ts";
import { compileArchitecture } from "../src/architecture/compiler.ts";
import { sha256 } from "../src/world/sha256.mjs";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_architecture_building_program_synthesizer FAIL: ${message}`);
}

const space = (id: string, storey: "ground" | "upper", use: string, privacy: string, minimum: number, target: number, maximum: number, windows: number, facades: string[]) => ({
  id, storey, use, privacy, areaM2: { minimum, target, maximum },
  daylight: { exteriorWindows: windows ? "required" : "not-required", minimumWindowCount: windows, preferredFacades: facades },
});

const program = {
  schema: BUILDING_PROGRAM_V1,
  id: "building-program/timber-hall/synthesis-test",
  prototype: { typology: "two-storey-timber-hall-house", storeys: 2, structuralSystem: "timber-frame", framingExpression: "legible", primaryRoof: "gable" },
  household: { residents: { minimum: 2, target: 4, maximum: 6 } },
  envelope: {
    footprintWidthM: { minimum: 8, target: 10, maximum: 12 }, footprintDepthM: { minimum: 7, target: 8, maximum: 10 },
    groundClearHeightM: { minimum: 2.5, target: 2.8, maximum: 3.2 }, upperClearHeightM: { minimum: 2.4, target: 2.7, maximum: 3 },
    wallThicknessM: { minimum: .2, target: .28, maximum: .4 }, floorAssemblyThicknessM: { minimum: .25, target: .35, maximum: .5 },
    gable: { ridgeRiseM: { minimum: 2, target: 2.8, maximum: 3.5 }, pitchDegrees: { minimum: 35, target: 42, maximum: 50 }, overhangM: { minimum: .35, target: .55, maximum: .8 } },
  },
  circulation: { minimumStairClearWidthM: .9, minimumHeadroomM: 2.05, minimumLandingDepthM: 1 },
  site: { maximumGradeDegrees: 8, minimumTerrainClearanceM: .12, minimumVegetationClearanceM: .8, maximumTerrainReliefM: .6 },
  spaces: [
    space("space/ground-hall", "ground", "hall", "public", 25, 32, 35, 2, ["front", "rear"]),
    space("space/kitchen", "ground", "kitchen", "household", 38, 48, 51, 1, ["rear"]),
    space("space/upper-landing", "upper", "landing", "circulation", 25, 32, 35, 0, []),
    space("space/bedroom-front", "upper", "bedroom", "private", 19, 24, 27, 1, ["front"]),
    space("space/bedroom-rear", "upper", "bedroom", "private", 19, 24, 27, 1, ["rear"]),
  ],
  connections: [
    { id: "connection/hall-kitchen", fromSpaceId: "space/ground-hall", toSpaceId: "space/kitchen", kind: "open-passage", minimumClearWidthM: 1.2 },
    { id: "connection/primary-stair", fromSpaceId: "space/ground-hall", toSpaceId: "space/upper-landing", kind: "stair", minimumClearWidthM: 1, wallPlacement: "exterior-wall" },
    { id: "connection/landing-front", fromSpaceId: "space/upper-landing", toSpaceId: "space/bedroom-front", kind: "door", minimumClearWidthM: .85 },
    { id: "connection/landing-rear", fromSpaceId: "space/upper-landing", toSpaceId: "space/bedroom-rear", kind: "door", minimumClearWidthM: .85 },
  ],
  entrances: [{ id: "entrance/primary", role: "primary", connectsToSpaceId: "space/ground-hall", facade: "front", stepFree: "preferred", weatherProtection: "required" }],
  requirements: {
    circulation: { wallAdjacentPrimaryStair: true, allSpacesReachPrimaryEntrance: true },
    daylight: { everyUpperHabitableSpaceHasExteriorWindow: true, minimumUpperFloorWindowCount: 2 },
    construction: { timberFrameExpression: "required", timberFrameVerification: "perceptual" },
    roof: { preserveContinuousWeatherLayer: true, resolveEveryRoofWallJunction: true },
  },
  objectives: ["circulation-efficiency", "structural-legibility", "daylight", "usable-area", "facade-rhythm", "roof-simplicity"],
  budgets: { lod0MaximumTriangles: 180000, lod1MaximumTriangles: 90000, lod2MaximumTriangles: 30000, maximumDrawCalls: 128, visualFloorHash: `sha256:${"a".repeat(64)}` },
};

const first = synthesizeTimberHallHouse(program), second = synthesizeTimberHallHouse(structuredClone(program));
assert(first.evaluatedDecisionCount === 12, "rulebook did not evaluate its bounded 12-decision frontier");
assert(first.acceptedDecisionCount === 8, `expected eight valid wall-adjacent variants, got ${first.acceptedDecisionCount}`);
assert(first.candidates.length === 3, "synthesizer did not return the top three compiled candidates");
assert(first.rejections.length === 4 && first.rejections.every((item) => item.stage === "rulebook" && item.code === "STAIR_NOT_WALL_ADJACENT"), "invalid center stairs lack machine-readable rejections");
assert(canonicalStringify(first) === canonicalStringify(second), "synthesis is not byte-deterministic");
assert(new Set(first.candidates.map((candidate) => candidate.compiled.specHash)).size === 3, "top candidates are not distinct ArchitectureSpecs");
assert(new Set(first.candidates.map((candidate) => candidate.compiled.irHash)).size === 3, "top candidates are not distinct compiled IRs");

for (const candidate of first.candidates) {
  assert(candidate.rank >= 1 && candidate.rank <= 3, "candidate rank escaped top-three beam");
  assert(candidate.score.map((item) => item.criterion).join("|") === program.objectives.join("|"), "score vector does not preserve lexicographic program objective order");
  assert(candidate.manifest.schema === BUILDING_SYNTHESIS_MANIFEST_V1 && candidate.manifest.programHash === first.programHash, "manifest is not bound one-way to its program");
  assert(candidate.manifest.rulebookHash === TIMBER_HALL_HOUSE_RULEBOOK_V1_HASH && candidate.manifest.decisionId === candidate.decision.id, "manifest rulebook/decision binding drifted");
  assert(candidate.manifest.decisionHash === `sha256:${sha256(canonicalStringify(candidate.decision))}`, "manifest decision hash is not exact");
  assert(candidate.manifest.architectureSpecHash === candidate.compiled.specHash && candidate.manifest.architectureIrHash === candidate.compiled.irHash, "manifest is not bound to compiled spec/IR hashes");
  assert(candidate.manifest.perceptualRequirements[0].verification === "perceptual-only" && candidate.spec.interiorStructure === undefined
    && candidate.spec.perceptualTimberFrames?.length === 4
    && candidate.compiled.perceptualTimberFrames?.every((frame) => frame.verification === "perceptual-only" && frame.parts.length > 0),
    "timber framing escaped its compiler-derived perceptual-only authority boundary");
  assert(candidate.spec.roofSystems?.length === 1 && candidate.spec.roofPlanes === undefined
    && candidate.compiled.primitives.filter((primitive) => primitive.id.startsWith("gable/")).length === 2,
    "generated gable roof lacks two compiler-owned closure slabs");
  for (const space of program.spaces.filter((item) => item.daylight.exteriorWindows === "required"))
    assert(candidate.compiled.windows.filter((window) => window.openingId.startsWith(`window/${space.id}/`)).length >= space.daylight.minimumWindowCount,
      `${space.id} daylight requirement was silently dropped`);
  assert(candidate.compiled.perceptualTimberFrames?.flatMap((frame) => frame.parts).every((part) => part.materialRole === "timber-frame-exterior"
    && part.lodLevels?.includes(0) && part.derivedFrom.includes("perceptual-only")), "frame material, LOD, or provenance authority drifted");
  assert(candidate.compiled.functionalContract?.schema === "limina.functional-building/v2", "candidate did not pass the real v2 architecture compiler");
  assert(candidate.compiled.windows.filter((window) => window.apertureCenter[1] > 2.8).length >= 2, "upper windows were not compiler-authored structural openings");
  assert(candidate.spec.volumes?.length === 2 && candidate.spec.interiorPartitions?.length === 4, "rooms regressed into coincident structural volume envelopes");
  assert(candidate.compiled.walls.filter((wall) => wall.id.startsWith("partition/")).length === 4, "each shared room boundary must compile to one partition wall");
  const wallSegmentKeys = candidate.compiled.walls.flatMap((wall) => wall.segments.map((segment) => {
    const yaw = segment.yawRadians ?? 0, swapsAxes = Math.abs(Math.sin(yaw)) > Math.abs(Math.cos(yaw)),
      extents = swapsAxes ? [segment.halfExtents[2], segment.halfExtents[1], segment.halfExtents[0]] : segment.halfExtents;
    return [...segment.center, ...extents].map((value) => value.toFixed(6)).join("|");
  }));
  assert(new Set(wallSegmentKeys).size === wallSegmentKeys.length, "compiled candidate contains coincident wall solids");
  const functional = candidate.spec.functional!;
  assert("schema" in functional && functional.schema === "limina.functional-architecture/v2" && functional.layoutAuthority === "partitioned-shell" && functional.stairs.length === 1, "candidate lacks explicit partitioned-shell stair authority");
  if (!("schema" in functional) || functional.schema !== "limina.functional-architecture/v2") throw new Error("unreachable");
  const stair = functional.stairs[0], halfWidth = functional.site.footprintHalfExtents[0];
  const distanceToExteriorWall = halfWidth - Math.abs(stair.from[0]);
  assert(distanceToExteriorWall >= stair.clearWidth / 2 && distanceToExteriorWall <= stair.clearWidth / 2 + .5, "primary stair is not adjacent to an exterior wall");
  assert((Math.abs(stair.from[0] - stair.to[0]) < 1e-9) !== (Math.abs(stair.from[2] - stair.to[2]) < 1e-9), "primary stair is not straight/cardinal");
  assert(stair.upperFloorOpening.halfExtents[0] >= stair.clearWidth / 2 && stair.clearHeight >= program.circulation.minimumHeadroomM, "stair void/headroom authority drifted");
}

const expectCompileReject = (mutate: (spec: any) => void, fragment: string) => {
  const spec = structuredClone(first.candidates[0].spec) as any;
  mutate(spec);
  try { compileArchitecture(spec); }
  catch (error) {
    assert(String(error).includes(fragment), `unexpected compiler rejection: ${String(error)}`);
    return;
  }
  throw new Error(`p_architecture_building_program_synthesizer FAIL: compiler accepted ${fragment}`);
};
expectCompileReject((spec) => { spec.interiorPartitions.pop(); }, "exactly enumerate every shared room boundary");
expectCompileReject((spec) => { spec.functional.portals[1].center[2] += .1; }, "must exactly match its compiler-owned partition opening");
expectCompileReject((spec) => { spec.functional.rooms[0].bounds.halfExtents[0] -= .1; }, "non-overlapping exact rectangular partition");
expectCompileReject((spec) => { delete spec.perceptualTimberFrames[1].roofSystemId; }, "must reference exactly the compiler-owned gable");
expectCompileReject((spec) => { spec.perceptualTimberFrames[0].wallIds[0] = "volume/storey-ground/edge-1"; }, "wrong-facade wall");

const unsupported = structuredClone(program);
unsupported.entrances[0].facade = "rear";
const failedClosed = synthesizeTimberHallHouse(unsupported);
assert(failedClosed.candidates.length === 0 && failedClosed.rejections.length === 12 && failedClosed.rejections.every((item) => item.code === "UNSUPPORTED_ENTRANCE" || item.code === "STAIR_NOT_WALL_ADJACENT"), "unsupported semantic input did not fail closed with inspectable rejections");

const infeasible = structuredClone(program);
for (const [index, values] of ([[26, 28, 31], [13, 15, 18], [6, 8, 11], [13, 15, 18], [11, 13, 16]] as const).entries())
  infeasible.spaces[index].areaM2 = { minimum: values[0], target: values[1], maximum: values[2] };
const impossibleEnvelope = synthesizeTimberHallHouse(infeasible);
assert(impossibleEnvelope.candidates.length === 0 && impossibleEnvelope.rejections.length === 12 && impossibleEnvelope.rejections.every((item) => item.code === "ENVELOPE_STOREY_AREA_INFEASIBLE"), "envelope/storey aggregate contradiction was not rejected before layout search");

console.log("p_architecture_building_program_synthesizer OK: 12 bounded decisions, 8 compiler-valid variants, closed gables, exact daylight, compiler-derived perceptual frames, partitioned shells, one-way hashes, and fail-closed rulebook");
