import { canonicalStringify } from "../authoring/canonical.ts";
import { sha256 } from "../world/sha256.mjs";

/**
 * Experimental semantic input to architectural synthesis. This contract deliberately stops
 * before ArchitectureSpec: it contains no coordinates, volume/opening ids, mesh decisions,
 * materials, or furnishing instructions.
 */
export const BUILDING_PROGRAM_V1 = "limina.building-program/v1" as const;
export const BUILDING_PROGRAM_V2 = "limina.building-program/v2" as const;

const ID = /^[a-z0-9][a-z0-9._/-]{0,95}$/;
const STOREYS = ["ground", "upper"] as const;
const SPACE_USES = ["hall", "kitchen", "pantry", "utility", "bedroom", "landing", "washroom", "storage", "study"] as const;
const PRIVACY_CLASSES = ["public", "household", "private", "service", "circulation"] as const;
const FACADES = ["front", "rear", "left", "right"] as const;
const CONNECTION_KINDS = ["door", "open-passage", "stair"] as const;
const OBJECTIVES = ["circulation-efficiency", "daylight", "usable-area", "structural-legibility", "facade-rhythm", "roof-simplicity"] as const;
const OBJECTIVES_V2 = ["circulation-efficiency", "daylight", "usable-area", "construction-expression", "facade-rhythm", "roof-simplicity", "silhouette-articulation"] as const;
const HASH = /^sha256:[0-9a-f]{64}$/;

export type BuildingProgramStorey = typeof STOREYS[number];
export type BuildingProgramSpaceUse = typeof SPACE_USES[number];
export type BuildingProgramFacade = typeof FACADES[number];
export type BuildingProgramObjective = typeof OBJECTIVES[number];

export interface BuildingProgramRange {
  readonly minimum: number;
  readonly target: number;
  readonly maximum: number;
}

export interface BuildingProgramV1 {
  readonly schema: typeof BUILDING_PROGRAM_V1;
  readonly id: string;
  readonly prototype: {
    readonly typology: "two-storey-timber-hall-house";
    readonly storeys: 2;
    readonly structuralSystem: "timber-frame";
    readonly framingExpression: "legible";
    readonly primaryRoof: "gable";
  };
  readonly household: { readonly residents: BuildingProgramRange };
  readonly envelope: {
    readonly footprintWidthM: BuildingProgramRange;
    readonly footprintDepthM: BuildingProgramRange;
    readonly groundClearHeightM: BuildingProgramRange;
    readonly upperClearHeightM: BuildingProgramRange;
    readonly wallThicknessM: BuildingProgramRange;
    readonly floorAssemblyThicknessM: BuildingProgramRange;
    readonly gable: {
      readonly ridgeRiseM: BuildingProgramRange;
      readonly pitchDegrees: BuildingProgramRange;
      readonly overhangM: BuildingProgramRange;
    };
  };
  readonly circulation: {
    readonly minimumStairClearWidthM: number;
    readonly minimumHeadroomM: number;
    readonly minimumLandingDepthM: number;
  };
  readonly site: {
    readonly maximumGradeDegrees: number;
    readonly minimumTerrainClearanceM: number;
    readonly minimumVegetationClearanceM: number;
    readonly maximumTerrainReliefM: number;
  };
  readonly spaces: readonly {
    readonly id: string;
    readonly storey: BuildingProgramStorey;
    readonly use: BuildingProgramSpaceUse;
    readonly privacy: typeof PRIVACY_CLASSES[number];
    readonly areaM2: BuildingProgramRange;
    readonly daylight: {
      readonly exteriorWindows: "required" | "preferred" | "not-required";
      readonly minimumWindowCount: number;
      readonly preferredFacades: readonly BuildingProgramFacade[];
    };
  }[];
  readonly connections: readonly {
    readonly id: string;
    readonly fromSpaceId: string;
    readonly toSpaceId: string;
    readonly kind: typeof CONNECTION_KINDS[number];
    readonly minimumClearWidthM: number;
    readonly wallPlacement?: "exterior-wall" | "interior-bearing-wall";
  }[];
  readonly entrances: readonly {
    readonly id: string;
    readonly role: "primary" | "service";
    readonly connectsToSpaceId: string;
    readonly facade: BuildingProgramFacade;
    readonly stepFree: "required" | "preferred" | "not-required";
    readonly weatherProtection: "required" | "preferred";
  }[];
  readonly requirements: {
    readonly circulation: {
      readonly wallAdjacentPrimaryStair: true;
      readonly allSpacesReachPrimaryEntrance: true;
    };
    readonly daylight: {
      readonly everyUpperHabitableSpaceHasExteriorWindow: true;
      readonly minimumUpperFloorWindowCount: number;
    };
    readonly construction: {
      readonly timberFrameExpression: "required";
      readonly timberFrameVerification: "perceptual";
    };
    readonly roof: {
      readonly preserveContinuousWeatherLayer: true;
      readonly resolveEveryRoofWallJunction: true;
    };
  };
  /** Stable priority order. The synthesizer uses an auditable lexicographic score, never opaque weights. */
  readonly objectives: readonly BuildingProgramObjective[];
  readonly budgets: {
    readonly lod0MaximumTriangles: number;
    readonly lod1MaximumTriangles: number;
    readonly lod2MaximumTriangles: number;
    readonly maximumDrawCalls: number;
    readonly visualFloorHash: `sha256:${string}`;
  };
}
export interface BuildingProgramV2 extends Omit<BuildingProgramV1,"schema"|"objectives"> {
  readonly schema:typeof BUILDING_PROGRAM_V2;
  readonly objectives:readonly typeof OBJECTIVES_V2[number][];
  readonly articulation:{
    readonly upper:{readonly composition:"single-front-gable-dormer";readonly daylightSourceSpaceId:string;readonly baySelection:"rulebook"};
    readonly entrance:{readonly composition:"covered-primary";readonly weatherProtection:"compiler-owned"};
    readonly chimney:{readonly required:true;readonly fireplaceSpaceId:string;readonly roofPenetration:"curb-flashing-cricket-cap";readonly distinctRoofBayFromDormer:true};
    readonly visualFloor:{readonly minimumSecondarySilhouetteElements:3;readonly requireFacadeAsymmetry:true;readonly requireMultiViewCpuProxy:true};
  };
}

type RecordValue = Record<string, unknown>;
function fail(message: string): never { throw new Error(`building program: ${message}`); }
function record(value: unknown, required: readonly string[], optional: readonly string[], label: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`);
  const keys = Object.keys(value);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${label} is missing '${key}'`);
  for (const key of keys) if (!required.includes(key) && !optional.includes(key)) fail(`${label} has unknown field '${key}'`);
  return value as RecordValue;
}
function array(value: unknown, minimum: number, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(`${label} must contain ${minimum}..${maximum} items`);
  return value;
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${label} is unsupported`);
  return value as T;
}
function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} must be a bounded stable lowercase id`);
  return value;
}
function finite(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail(`${label} must be finite in ${minimum}..${maximum}`);
  return value;
}
function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  const result = finite(value, minimum, maximum, label);
  if (!Number.isSafeInteger(result)) fail(`${label} must be a safe integer`);
  return result;
}
function range(value: unknown, minimum: number, maximum: number, integerOnly: boolean, label: string): BuildingProgramRange {
  const r = record(value, ["minimum", "target", "maximum"], [], label);
  const read = integerOnly ? integer : finite;
  const low = read(r.minimum, minimum, maximum, `${label}.minimum`);
  const target = read(r.target, minimum, maximum, `${label}.target`);
  const high = read(r.maximum, minimum, maximum, `${label}.maximum`);
  if (low > target || target > high) fail(`${label} must satisfy minimum <= target <= maximum`);
  return r as unknown as BuildingProgramRange;
}
function freezeDeep<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as RecordValue)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** Descriptor-only traversal: rejects hostile shape before canonicalization can detach it. */
function assertRawShape(value: unknown, path = "$", active = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  const object = value as object;
  if (active.has(object)) fail(`${path} must not be cyclic`);
  active.add(object);
  try {
    const isArray = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== (isArray ? Array.prototype : Object.prototype)) fail(`${path} must use the canonical ${isArray ? "array" : "plain object"} prototype`);
    if (Object.getOwnPropertySymbols(object).length) fail(`${path} must not contain symbol keys`);
    const descriptors = Object.getOwnPropertyDescriptors(object);
    const names = Object.keys(descriptors);
    if (isArray) {
      const length = (object as unknown[]).length;
      const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
      if (names.some(name => !expected.has(name)) || names.length !== expected.size) fail(`${path} must be a dense, field-free array`);
    }
    for (const name of names) {
      if (name === "length" && isArray) continue;
      const descriptor = descriptors[name]!;
      if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) fail(`${path}.${name} must be an enumerable data field, not an accessor`);
      assertRawShape(descriptor.value, `${path}.${name}`, active);
    }
  } finally { active.delete(object); }
}

function validateSnapshot(value: unknown): BuildingProgramV1 {
  const root = record(value, ["schema", "id", "prototype", "household", "envelope", "circulation", "site", "spaces", "connections", "entrances", "requirements", "objectives", "budgets"], [], "root");
  if (root.schema !== BUILDING_PROGRAM_V1) fail("schema is unsupported");
  stableId(root.id, "id");

  const prototype = record(root.prototype, ["typology", "storeys", "structuralSystem", "framingExpression", "primaryRoof"], [], "prototype");
  if (prototype.typology !== "two-storey-timber-hall-house" || prototype.storeys !== 2 || prototype.structuralSystem !== "timber-frame" || prototype.framingExpression !== "legible" || prototype.primaryRoof !== "gable") {
    fail("v1 supports only the legible two-storey timber hall-house prototype");
  }
  const household = record(root.household, ["residents"], [], "household");
  range(household.residents, 1, 12, true, "household.residents");
  const envelope = record(root.envelope, ["footprintWidthM", "footprintDepthM", "groundClearHeightM", "upperClearHeightM", "wallThicknessM", "floorAssemblyThicknessM", "gable"], [], "envelope");
  range(envelope.footprintWidthM, 4, 30, false, "envelope.footprintWidthM");
  range(envelope.footprintDepthM, 4, 30, false, "envelope.footprintDepthM");
  range(envelope.groundClearHeightM, 2.1, 4.5, false, "envelope.groundClearHeightM");
  range(envelope.upperClearHeightM, 2.1, 4.5, false, "envelope.upperClearHeightM");
  range(envelope.wallThicknessM, .1, .6, false, "envelope.wallThicknessM");
  range(envelope.floorAssemblyThicknessM, .15, .8, false, "envelope.floorAssemblyThicknessM");
  const gable = record(envelope.gable, ["ridgeRiseM", "pitchDegrees", "overhangM"], [], "envelope.gable");
  range(gable.ridgeRiseM, 1, 8, false, "envelope.gable.ridgeRiseM");
  range(gable.pitchDegrees, 25, 60, false, "envelope.gable.pitchDegrees");
  range(gable.overhangM, .15, 1.5, false, "envelope.gable.overhangM");
  const circulationPolicy = record(root.circulation, ["minimumStairClearWidthM", "minimumHeadroomM", "minimumLandingDepthM"], [], "circulation");
  const minimumStairWidth = finite(circulationPolicy.minimumStairClearWidthM, .75, 2, "circulation.minimumStairClearWidthM");
  finite(circulationPolicy.minimumHeadroomM, 2, 3, "circulation.minimumHeadroomM");
  finite(circulationPolicy.minimumLandingDepthM, .8, 3, "circulation.minimumLandingDepthM");
  const site = record(root.site, ["maximumGradeDegrees", "minimumTerrainClearanceM", "minimumVegetationClearanceM", "maximumTerrainReliefM"], [], "site");
  finite(site.maximumGradeDegrees, 0, 20, "site.maximumGradeDegrees");
  finite(site.minimumTerrainClearanceM, 0, 1, "site.minimumTerrainClearanceM");
  finite(site.minimumVegetationClearanceM, 0, 10, "site.minimumVegetationClearanceM");
  finite(site.maximumTerrainReliefM, 0, 3, "site.maximumTerrainReliefM");

  const spaces = array(root.spaces, 4, 24, "spaces");
  const spaceById = new Map<string, { storey: BuildingProgramStorey; use: BuildingProgramSpaceUse }>();
  let targetAreaM2 = 0;
  let upperWindowCount = 0;
  const habitableUses = new Set<BuildingProgramSpaceUse>(["hall", "kitchen", "bedroom", "study"]);
  for (const [index, value] of spaces.entries()) {
    const space = record(value, ["id", "storey", "use", "privacy", "areaM2", "daylight"], [], `spaces[${index}]`);
    const spaceId = stableId(space.id, `spaces[${index}].id`);
    if (spaceById.has(spaceId)) fail("space ids must be unique");
    const storey = enumValue(space.storey, STOREYS, `spaces[${index}].storey`);
    const use = enumValue(space.use, SPACE_USES, `spaces[${index}].use`);
    enumValue(space.privacy, PRIVACY_CLASSES, `spaces[${index}].privacy`);
    const area = range(space.areaM2, 2, 150, false, `spaces[${index}].areaM2`);
    targetAreaM2 += area.target;
    const daylight = record(space.daylight, ["exteriorWindows", "minimumWindowCount", "preferredFacades"], [], `spaces[${index}].daylight`);
    const windowPolicy = enumValue(daylight.exteriorWindows, ["required", "preferred", "not-required"] as const, `spaces[${index}].daylight.exteriorWindows`);
    const windowCount = integer(daylight.minimumWindowCount, 0, 8, `spaces[${index}].daylight.minimumWindowCount`);
    const facades = array(daylight.preferredFacades, 0, 4, `spaces[${index}].daylight.preferredFacades`).map((facade, facadeIndex) => enumValue(facade, FACADES, `spaces[${index}].daylight.preferredFacades[${facadeIndex}]`));
    if (new Set(facades).size !== facades.length) fail("preferred facades must be unique");
    if (windowPolicy === "not-required" && (windowCount !== 0 || facades.length !== 0)) fail("not-required daylight cannot prescribe windows or facades");
    if (windowPolicy === "required" && (windowCount < 1 || facades.length < 1)) fail("required daylight needs a positive window count and preferred facade");
    if (storey === "upper") upperWindowCount += windowCount;
    if (storey === "upper" && habitableUses.has(use) && (windowPolicy !== "required" || windowCount < 1)) fail("every upper habitable space requires an exterior window");
    spaceById.set(spaceId, { storey, use });
  }
  if (targetAreaM2 < 25 || targetAreaM2 > 400) fail("total target area must be in 25..400 square metres");
  const count = (storey: BuildingProgramStorey, use: BuildingProgramSpaceUse) => [...spaceById.values()].filter(space => space.storey === storey && space.use === use).length;
  if (count("ground", "hall") !== 1 || count("ground", "kitchen") !== 1 || count("upper", "landing") !== 1 || count("upper", "bedroom") < 1) fail("prototype requires one ground hall, one ground kitchen, one upper landing, and at least one upper bedroom");
  if ([...spaceById.values()].some(space => space.use === "landing" && space.storey !== "upper")) fail("the prototype landing must be on the upper storey");
  if (!STOREYS.every(storey => [...spaceById.values()].some(space => space.storey === storey))) fail("both prototype storeys require spaces");

  const connections = array(root.connections, spaces.length - 1, 64, "connections");
  const connectionIds = new Set<string>();
  const connectedPairs = new Set<string>();
  const graph = new Map([...spaceById.keys()].map(id => [id, new Set<string>()]));
  let stairCount = 0;
  for (const [index, value] of connections.entries()) {
    const connection = record(value, ["id", "fromSpaceId", "toSpaceId", "kind", "minimumClearWidthM"], ["wallPlacement"], `connections[${index}]`);
    const connectionId = stableId(connection.id, `connections[${index}].id`);
    if (connectionIds.has(connectionId)) fail("connection ids must be unique");
    connectionIds.add(connectionId);
    const from = stableId(connection.fromSpaceId, `connections[${index}].fromSpaceId`);
    const to = stableId(connection.toSpaceId, `connections[${index}].toSpaceId`);
    if (!spaceById.has(from) || !spaceById.has(to) || from === to) fail("connections must join two different declared spaces");
    const pair = [from, to].sort().join("\u0000");
    if (connectedPairs.has(pair)) fail("a space pair may have only one semantic connection");
    connectedPairs.add(pair);
    const kind = enumValue(connection.kind, CONNECTION_KINDS, `connections[${index}].kind`);
    finite(connection.minimumClearWidthM, 0.75, 3, `connections[${index}].minimumClearWidthM`);
    const fromSpace = spaceById.get(from)!;
    const toSpace = spaceById.get(to)!;
    if (kind === "stair") {
      stairCount++;
      enumValue(connection.wallPlacement, ["exterior-wall", "interior-bearing-wall"] as const, `connections[${index}].wallPlacement`);
      if (fromSpace.storey === toSpace.storey) fail("stairs must connect the ground and upper storeys");
      const upper = fromSpace.storey === "upper" ? fromSpace : toSpace;
      const lower = fromSpace.storey === "ground" ? fromSpace : toSpace;
      if (upper.use !== "landing" || lower.use !== "hall") fail("the prototype stair must connect the ground hall to the upper landing");
      if ((connection.minimumClearWidthM as number) < minimumStairWidth) fail("primary stair width does not meet the circulation minimum");
    } else {
      if (connection.wallPlacement !== undefined) fail("only stairs may prescribe wall placement");
      if (fromSpace.storey !== toSpace.storey) fail("non-stair connections cannot cross storeys");
    }
    graph.get(from)!.add(to);
    graph.get(to)!.add(from);
  }
  if (stairCount !== 1) fail("the prototype requires exactly one wall-adjacent primary stair");
  const firstSpaceId = spaceById.keys().next().value as string;
  const visited = new Set([firstSpaceId]);
  const pending = [firstSpaceId];
  while (pending.length) for (const neighbour of graph.get(pending.shift()!)!) if (!visited.has(neighbour)) { visited.add(neighbour); pending.push(neighbour); }
  if (visited.size !== spaceById.size) fail("the semantic space graph must be connected");

  const entrances = array(root.entrances, 1, 4, "entrances");
  const entranceIds = new Set<string>();
  let primaryEntrySpaceId: string | undefined;
  for (const [index, value] of entrances.entries()) {
    const entrance = record(value, ["id", "role", "connectsToSpaceId", "facade", "stepFree", "weatherProtection"], [], `entrances[${index}]`);
    const entranceId = stableId(entrance.id, `entrances[${index}].id`);
    if (entranceIds.has(entranceId)) fail("entrance ids must be unique");
    entranceIds.add(entranceId);
    const role = enumValue(entrance.role, ["primary", "service"] as const, `entrances[${index}].role`);
    const spaceId = stableId(entrance.connectsToSpaceId, `entrances[${index}].connectsToSpaceId`);
    const space = spaceById.get(spaceId);
    if (!space || space.storey !== "ground") fail("entrances must connect to declared ground-floor spaces");
    enumValue(entrance.facade, FACADES, `entrances[${index}].facade`);
    enumValue(entrance.stepFree, ["required", "preferred", "not-required"] as const, `entrances[${index}].stepFree`);
    enumValue(entrance.weatherProtection, ["required", "preferred"] as const, `entrances[${index}].weatherProtection`);
    if (role === "primary") {
      if (primaryEntrySpaceId !== undefined) fail("the prototype requires exactly one primary entrance");
      if (space.use !== "hall") fail("the primary entrance must connect to the ground hall");
      primaryEntrySpaceId = spaceId;
    }
  }
  if (primaryEntrySpaceId === undefined) fail("the prototype requires exactly one primary entrance");

  const requirements = record(root.requirements, ["circulation", "daylight", "construction", "roof"], [], "requirements");
  const circulation = record(requirements.circulation, ["wallAdjacentPrimaryStair", "allSpacesReachPrimaryEntrance"], [], "requirements.circulation");
  if (circulation.wallAdjacentPrimaryStair !== true || circulation.allSpacesReachPrimaryEntrance !== true) fail("prototype circulation guarantees are mandatory");
  const daylight = record(requirements.daylight, ["everyUpperHabitableSpaceHasExteriorWindow", "minimumUpperFloorWindowCount"], [], "requirements.daylight");
  if (daylight.everyUpperHabitableSpaceHasExteriorWindow !== true) fail("upper habitable daylight guarantee is mandatory");
  const requiredUpperWindows = integer(daylight.minimumUpperFloorWindowCount, 2, 16, "requirements.daylight.minimumUpperFloorWindowCount");
  if (upperWindowCount < requiredUpperWindows) fail("space daylight requirements do not meet the upper-floor window minimum");
  const construction = record(requirements.construction, ["timberFrameExpression", "timberFrameVerification"], [], "requirements.construction");
  if (construction.timberFrameExpression !== "required" || construction.timberFrameVerification !== "perceptual") fail("timber framing is a required perceptual design intent, not a mechanical load-path proof");
  const roof = record(requirements.roof, ["preserveContinuousWeatherLayer", "resolveEveryRoofWallJunction"], [], "requirements.roof");
  if (roof.preserveContinuousWeatherLayer !== true || roof.resolveEveryRoofWallJunction !== true) fail("roof closure guarantees are mandatory");

  const objectives = array(root.objectives, 3, OBJECTIVES.length, "objectives");
  const objectiveIds = new Set(objectives.map((value, index) =>
    enumValue(value, OBJECTIVES, `objectives[${index}]`)));
  if (objectiveIds.size !== objectives.length) fail("objective criteria must be unique");
  if (!objectiveIds.has("circulation-efficiency") || !objectiveIds.has("structural-legibility")) fail("circulation and structural legibility must be ranked");

  const budgets = record(root.budgets, ["lod0MaximumTriangles", "lod1MaximumTriangles", "lod2MaximumTriangles", "maximumDrawCalls", "visualFloorHash"], [], "budgets");
  const lod0 = integer(budgets.lod0MaximumTriangles, 1_000, 2_000_000, "budgets.lod0MaximumTriangles");
  const lod1 = integer(budgets.lod1MaximumTriangles, 500, 1_000_000, "budgets.lod1MaximumTriangles");
  const lod2 = integer(budgets.lod2MaximumTriangles, 100, 500_000, "budgets.lod2MaximumTriangles");
  if (!(lod0 > lod1 && lod1 > lod2)) fail("LOD triangle budgets must strictly decrease from LOD0 through LOD2");
  integer(budgets.maximumDrawCalls, 1, 2_048, "budgets.maximumDrawCalls");
  if (typeof budgets.visualFloorHash !== "string" || !HASH.test(budgets.visualFloorHash)) fail("budgets.visualFloorHash must be an exact lowercase SHA-256 authority");

  return root as unknown as BuildingProgramV1;
}

function validateV2Snapshot(value:unknown):BuildingProgramV2{
  const root=record(value,["schema","id","prototype","household","envelope","circulation","site","spaces","connections","entrances","requirements","objectives","budgets","articulation"],[],"root");
  if(root.schema!==BUILDING_PROGRAM_V2)fail("v2 schema is unsupported");
  const {articulation,...shared}=root,objectives=array(root.objectives,4,OBJECTIVES_V2.length,"objectives"),objectiveIds=new Set(objectives.map((entry,index)=>enumValue(entry,OBJECTIVES_V2,`objectives[${index}]`)));
  if(objectiveIds.size!==objectives.length||!objectiveIds.has("circulation-efficiency")||!objectiveIds.has("construction-expression")||!objectiveIds.has("silhouette-articulation")||objectiveIds.has("structural-legibility" as never))fail("v2 requires circulation, construction-expression, and silhouette-articulation objectives without a structural claim");
  validateSnapshot({...shared,schema:BUILDING_PROGRAM_V1,objectives:objectives.map(entry=>entry==="construction-expression"?"structural-legibility":entry==="silhouette-articulation"?"facade-rhythm":entry).filter((entry,index,all)=>all.indexOf(entry)===index)});
  const articulationRecord=record(articulation,["upper","entrance","chimney","visualFloor"],[],"articulation"),upper=record(articulationRecord.upper,["composition","daylightSourceSpaceId","baySelection"],[],"articulation.upper"),entrance=record(articulationRecord.entrance,["composition","weatherProtection"],[],"articulation.entrance"),chimney=record(articulationRecord.chimney,["required","fireplaceSpaceId","roofPenetration","distinctRoofBayFromDormer"],[],"articulation.chimney"),visual=record(articulationRecord.visualFloor,["minimumSecondarySilhouetteElements","requireFacadeAsymmetry","requireMultiViewCpuProxy"],[],"articulation.visualFloor");
  if(upper.composition!=="single-front-gable-dormer"||upper.baySelection!=="rulebook")fail("v2 upper articulation must be one rulebook-placed front gable dormer");const daylightSource=stableId(upper.daylightSourceSpaceId,"articulation.upper.daylightSourceSpaceId"),fireplaceSpace=stableId(chimney.fireplaceSpaceId,"articulation.chimney.fireplaceSpaceId"),spaces=root.spaces as any[],source=spaces.find(space=>space.id===daylightSource),hearth=spaces.find(space=>space.id===fireplaceSpace);
  if(!source||source.storey!=="upper"||source.daylight?.exteriorWindows!=="required"||!source.daylight.preferredFacades?.includes("front"))fail("v2 dormer must consume an existing front-preferred upper daylight aperture");
  if(entrance.composition!=="covered-primary"||entrance.weatherProtection!=="compiler-owned"||!(root.entrances as any[]).some(item=>item.role==="primary"&&item.weatherProtection==="required"))fail("v2 entrance composition must fulfill required primary weather protection");
  if(chimney.required!==true||chimney.roofPenetration!=="curb-flashing-cricket-cap"||chimney.distinctRoofBayFromDormer!==true||!hearth||hearth.storey!=="ground"||!(["hall","kitchen"] as string[]).includes(hearth.use))fail("v2 chimney must rise from a ground hearth space through a distinct fully flashed roof bay");
  if(visual.minimumSecondarySilhouetteElements!==3||visual.requireFacadeAsymmetry!==true||visual.requireMultiViewCpuProxy!==true)fail("v2 locked visual-floor articulation gates are mandatory");return root as unknown as BuildingProgramV2;
}

/** Parse into a detached, deeply immutable canonical snapshot before synthesis may consume it. */
export function parseBuildingProgram(value: unknown): BuildingProgramV1 {
  assertRawShape(value);
  const snapshot = JSON.parse(canonicalStringify(value)) as unknown;
  return freezeDeep(validateSnapshot(snapshot)) as BuildingProgramV1;
}

export function buildingProgramHash(value: unknown): `sha256:${string}` {
  return `sha256:${sha256(canonicalStringify(parseBuildingProgram(value)))}`;
}

/** V2 is opt-in and additive; V1 parsing and hashes remain byte-for-byte replay compatible. */
export function parseBuildingProgramV2(value:unknown):BuildingProgramV2{assertRawShape(value);const snapshot=JSON.parse(canonicalStringify(value)) as unknown;return freezeDeep(validateV2Snapshot(snapshot)) as BuildingProgramV2;}
export function buildingProgramV2Hash(value:unknown):`sha256:${string}`{return `sha256:${sha256(canonicalStringify(parseBuildingProgramV2(value)))}`;}
