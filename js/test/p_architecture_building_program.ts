import { BUILDING_PROGRAM_V1, buildingProgramHash, parseBuildingProgram } from "../src/architecture/building-program.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_architecture_building_program FAIL: ${message}`); }
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  try { fn(); } catch (error) { if (pattern.test(error instanceof Error ? error.message : String(error))) return; throw error; }
  throw new Error(`p_architecture_building_program FAIL: ${message}`);
}

const room = (id: string, storey: "ground" | "upper", use: string, privacy: string, target: number, windows: number, facades: string[]) => ({
  id, storey, use, privacy, areaM2: { minimum: target - 2, target, maximum: target + 3 },
  daylight: { exteriorWindows: windows ? "required" : "not-required", minimumWindowCount: windows, preferredFacades: facades },
});
const program = {
  schema: BUILDING_PROGRAM_V1,
  id: "building-program/timber-hall/prototype-a",
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
    room("space/ground-hall", "ground", "hall", "public", 28, 2, ["front", "rear"]),
    room("space/kitchen", "ground", "kitchen", "household", 15, 1, ["rear"]),
    room("space/upper-landing", "upper", "landing", "circulation", 8, 0, []),
    room("space/bedroom-a", "upper", "bedroom", "private", 15, 1, ["front"]),
    room("space/bedroom-b", "upper", "bedroom", "private", 13, 1, ["rear"]),
  ],
  connections: [
    { id: "connection/hall-kitchen", fromSpaceId: "space/ground-hall", toSpaceId: "space/kitchen", kind: "open-passage", minimumClearWidthM: 1.2 },
    { id: "connection/primary-stair", fromSpaceId: "space/ground-hall", toSpaceId: "space/upper-landing", kind: "stair", minimumClearWidthM: 1, wallPlacement: "exterior-wall" },
    { id: "connection/landing-bedroom-a", fromSpaceId: "space/upper-landing", toSpaceId: "space/bedroom-a", kind: "door", minimumClearWidthM: 0.85 },
    { id: "connection/landing-bedroom-b", fromSpaceId: "space/upper-landing", toSpaceId: "space/bedroom-b", kind: "door", minimumClearWidthM: 0.85 },
  ],
  entrances: [{ id: "entrance/primary", role: "primary", connectsToSpaceId: "space/ground-hall", facade: "front", stepFree: "preferred", weatherProtection: "required" }],
  requirements: {
    circulation: { wallAdjacentPrimaryStair: true, allSpacesReachPrimaryEntrance: true },
    daylight: { everyUpperHabitableSpaceHasExteriorWindow: true, minimumUpperFloorWindowCount: 2 },
    construction: { timberFrameExpression: "required", timberFrameVerification: "perceptual" },
    roof: { preserveContinuousWeatherLayer: true, resolveEveryRoofWallJunction: true },
  },
  objectives: [
    "circulation-efficiency",
    "structural-legibility",
    "daylight",
  ],
  budgets: { lod0MaximumTriangles: 180000, lod1MaximumTriangles: 90000, lod2MaximumTriangles: 30000, maximumDrawCalls: 128, visualFloorHash: `sha256:${"a".repeat(64)}` },
};

const parsed = parseBuildingProgram(program);
assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.spaces) && Object.isFrozen(parsed.spaces[0].areaM2), "parsed snapshot is not deeply immutable");
const before = parsed.spaces[0].areaM2.target;
program.spaces[0].areaM2.target = 99;
assert(parsed.spaces[0].areaM2.target === before, "parsed authority aliases mutable caller state");
const reversedRoot = Object.fromEntries(Object.entries(program).reverse());
program.spaces[0].areaM2.target = before;
assert(buildingProgramHash(program) === buildingProgramHash(reversedRoot), "hash depends on object insertion order");
assert(/^sha256:[0-9a-f]{64}$/.test(buildingProgramHash(program)), "canonical hash is malformed");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const mutate = (fn: (value: any) => void) => { const value = clone(program); fn(value); return value; };
rejects(() => parseBuildingProgram(mutate(value => { value.xyz = [0, 0, 0]; })), /unknown field/, "root geometry escaped the semantic boundary");
rejects(() => parseBuildingProgram(mutate(value => { value.spaces[0].volumeId = "architecture-volume/ground"; })), /unknown field/, "downstream volume identity escaped the semantic boundary");
rejects(() => parseBuildingProgram(mutate(value => { value.spaces[0].openingOffset = 1.5; })), /unknown field/, "opening offset escaped the semantic boundary");
rejects(() => parseBuildingProgram(mutate(value => { value.materials = ["wood"]; })), /unknown field/, "material assignment escaped the semantic boundary");
rejects(() => parseBuildingProgram(mutate(value => { value.furniture = ["chair"]; })), /unknown field/, "furniture escaped the semantic boundary");
rejects(() => parseBuildingProgram(mutate(value => { value.prototype.typology = "generic-house"; })), /only the legible two-storey timber hall-house/, "unimplemented typology was accepted");
rejects(() => parseBuildingProgram(mutate(value => { value.spaces[3].daylight = { exteriorWindows: "not-required", minimumWindowCount: 0, preferredFacades: [] }; })), /upper habitable space/, "windowless upper bedroom was accepted");
rejects(() => parseBuildingProgram(mutate(value => { value.connections[1].wallPlacement = undefined; })), /wallPlacement/, "free-standing primary stair was accepted");
rejects(() => parseBuildingProgram(mutate(value => { value.connections.splice(1, 1); })), /connected|exactly one wall-adjacent|must contain/, "missing inter-storey circulation was accepted");
rejects(() => parseBuildingProgram(mutate(value => { value.connections[2].toSpaceId = "space/bedroom-b"; })), /only one semantic connection|connected/, "disconnected topology was accepted");
rejects(() => parseBuildingProgram(mutate(value => { value.entrances[0].connectsToSpaceId = "space/kitchen"; })), /ground hall/, "primary entry bypassed the hall");
rejects(() => parseBuildingProgram(mutate(value => { value.objectives[1] = value.objectives[0]; })), /unique/, "duplicate ordered objective was accepted");
rejects(() => parseBuildingProgram(mutate(value => { value.connections[1].minimumClearWidthM = .8; })), /circulation minimum/, "stair narrower than the program circulation policy was accepted");
rejects(() => parseBuildingProgram(mutate(value => { value.budgets.lod1MaximumTriangles = value.budgets.lod0MaximumTriangles; })), /strictly decrease/, "non-decreasing LOD budgets were accepted");
rejects(() => parseBuildingProgram(mutate(value => { value.budgets.visualFloorHash = "latest"; })), /exact lowercase SHA-256/, "unbound visual floor was accepted");
rejects(() => parseBuildingProgram(mutate(value => { value.spaces = Array.from({ length: 25 }, (_, i) => ({ ...clone(value.spaces[0]), id: `space/extra-${i}` })); })), /4\.\.24/, "unbounded space inventory was accepted");

const accessor = clone(program) as any;
let getterExecuted = false;
Object.defineProperty(accessor.spaces[0], "use", { enumerable: true, get() { getterExecuted = true; throw new Error("getter executed"); } });
rejects(() => parseBuildingProgram(accessor), /accessor/, "accessor-backed input was accepted");
assert(!getterExecuted, "hostile getter executed during parsing");
const sparse = clone(program) as any; sparse.spaces.length++;
rejects(() => parseBuildingProgram(sparse), /dense, field-free array/, "sparse spaces were accepted");
const prototyped = clone(program) as any; Object.setPrototypeOf(prototyped.connections[0], { hostile: true });
rejects(() => parseBuildingProgram(prototyped), /plain object/, "custom-prototype connection was accepted");
const symbolField = clone(program) as any; symbolField[Symbol("hidden")] = true;
rejects(() => parseBuildingProgram(symbolField), /symbol keys/, "symbol field was accepted");

console.log("p_architecture_building_program OK: strict semantic prototype, bounded topology/daylight/circulation policy, detached canonical hashing, and hostile-shape rejection");
