// Pure-byte, render-independent quality contract for authored functional buildings. This gate
// proves structural facts that are present in the GLB; it deliberately does not assign a visual
// score or replace fixed-camera human review.

export const FUNCTIONAL_BUILDING_VISUAL_CONTRACT = "limina.functional-building-visual/v1" as const;
export type VisualFacade = "north" | "south" | "east" | "west";
export type VisualOpening = Readonly<{ id: string; kind: "window" | "door"; facade: VisualFacade;
  /** Additive v2 topology classification; omitted by replay-era single-room assets. */
  exterior?: boolean;
  aperture: Readonly<{ center: readonly [number, number, number]; halfExtents: readonly [number, number, number] }>;
  glazingNodeId?: string; leafNodeId?: string; revealNodeIds: readonly [string, string, string, string];
  frameNodeIds?: readonly string[]; mullionNodeIds?: readonly string[]; cameNodeIds?: readonly string[];
  plankNodeIds?: readonly string[]; ironworkNodeIds?: readonly string[] }>;
export interface FunctionalBuildingVisualContract {
  readonly schema: typeof FUNCTIONAL_BUILDING_VISUAL_CONTRACT;
  readonly openings: readonly VisualOpening[];
  readonly materialRoles: readonly Readonly<{ role: string; materialName: string }>[];
  readonly interior: Readonly<{ walkableNodeIds: readonly string[]; ceilingNodeIds: readonly string[]; shellNodeIds: readonly string[];
    furnishingNodeIds: readonly string[]; hearth?: Readonly<{ apertureCenter: readonly [number,number,number]; apertureHalfExtents: readonly [number,number,number];
      surroundNodeIds: readonly string[]; fuelNodeIds: readonly string[]; emberNodeId: string; flameNodeIds: readonly string[]; lightNodeId: string }>;
    clearAisle: Readonly<{ from: readonly [number,number,number]; to: readonly [number,number,number]; halfWidth: number; minClearHeight: number }> }>;
  readonly lod: Readonly<{ identity: string; lod0RootNodeId: string; triangleBudget: number; drawBudget: number;
    lod1TriangleBudget: number; lod2TriangleBudget: number }>;
}

type Obj = Record<string, unknown>;
const obj = (value: unknown, label: string): Obj => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`functional building visual: ${label} must be an object`);
  return value as Obj;
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`functional building visual: ${label} must be a non-empty string`);
  return value;
};
const integer = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`functional building visual: ${label} must be a positive safe integer`);
  return value as number;
};
const vec3 = (value: unknown, label: string, positive = false): readonly [number, number, number] => {
  if (!Array.isArray(value) || value.length !== 3 || value.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new Error(`functional building visual: ${label} must be a finite vec3`);
  }
  if (positive && value.some((n) => n <= 0)) throw new Error(`functional building visual: ${label} axes must be positive`);
  return [value[0], value[1], value[2]];
};
const ids = (value: unknown, label: string, exact?: number): string[] => {
  if (!Array.isArray(value) || value.length === 0 || (exact !== undefined && value.length !== exact)) {
    throw new Error(`functional building visual: ${label} must contain ${exact ?? "one or more"} ids`);
  }
  const result = value.map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`functional building visual: ${label} contains duplicate ids`);
  return result;
};
const optionalIds = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value)) throw new Error(`functional building visual: ${label} must be an id array`);
  return value.length === 0 ? [] : ids(value, label);
};

function json(bytes: Uint8Array): Obj {
  if (bytes.byteLength < 20) throw new Error("functional building visual: truncated GLB");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(8, true) !== bytes.byteLength
      || view.getUint32(16, true) !== 0x4e4f534a) throw new Error("functional building visual: invalid GLB header");
  const length = view.getUint32(12, true);
  try { return obj(JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)).trim()), "glTF root"); }
  catch (error) { throw new Error(`functional building visual: invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

export function parseFunctionalBuildingVisualContract(bytes: Uint8Array): FunctionalBuildingVisualContract {
  const gltf = json(bytes);
  const authority = obj(obj(obj(gltf.asset, "asset").extras, "asset.extras").liminaFunctionalBuildingVisual,
    "asset.extras.liminaFunctionalBuildingVisual");
  if (authority.schema !== FUNCTIONAL_BUILDING_VISUAL_CONTRACT) throw new Error("functional building visual: unsupported schema");
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes.map((node, index) => obj(node, `nodes[${index}]`)) : [];
  const nodeIds = new Set<string>();
  for (let index = 0; index < nodes.length; index++) {
    const extras = nodes[index].extras === undefined ? undefined : obj(nodes[index].extras, `nodes[${index}].extras`);
    const limina = extras?.limina === undefined ? undefined : obj(extras.limina, `nodes[${index}].extras.limina`);
    if (limina?.id !== undefined) {
      const id = text(limina.id, `nodes[${index}] semantic id`);
      if (nodeIds.has(id)) throw new Error(`functional building visual: duplicate node id ${id}`);
      nodeIds.add(id);
    }
  }
  const requireNode = (id: string, label: string): string => {
    if (!nodeIds.has(id)) throw new Error(`functional building visual: ${label} references unresolved node ${id}`);
    return id;
  };
  const rawOpenings = Array.isArray(authority.openings) ? authority.openings : [];
  if (rawOpenings.length < 2) throw new Error("functional building visual: windows and an exterior door are required");
  const openingIds = new Set<string>(), allRevealIds = new Set<string>();
  const openings: VisualOpening[] = rawOpenings.map((raw, index) => {
    const opening = obj(raw, `openings[${index}]`), id = text(opening.id, `openings[${index}].id`);
    if (openingIds.has(id)) throw new Error(`functional building visual: duplicate opening id ${id}`); openingIds.add(id);
    const kind = opening.kind;
    if (kind !== "window" && kind !== "door") throw new Error(`functional building visual: ${id}.kind must be window or door`);
    const facade = opening.facade;
    if (facade !== "north" && facade !== "south" && facade !== "east" && facade !== "west") throw new Error(`functional building visual: ${id}.facade is invalid`);
    const aperture = obj(opening.aperture, `${id}.aperture`);
    const revealNodeIds = ids(opening.revealNodeIds, `${id}.revealNodeIds`, 4);
    for (const reveal of revealNodeIds) {
      requireNode(reveal, `${id}.revealNodeIds`);
      if (allRevealIds.has(reveal)) throw new Error(`functional building visual: reveal ${reveal} is shared across openings`);
      allRevealIds.add(reveal);
    }
    if (kind === "window") {
      if (opening.leafNodeId !== undefined) throw new Error(`functional building visual: window ${id} cannot carry a door leaf`);
      requireNode(text(opening.glazingNodeId, `${id}.glazingNodeId`), `${id}.glazingNodeId`);
      const frameNodeIds = ids(opening.frameNodeIds, `${id}.frameNodeIds`), mullionNodeIds = ids(opening.mullionNodeIds, `${id}.mullionNodeIds`), cameNodeIds = ids(opening.cameNodeIds, `${id}.cameNodeIds`);
      if (frameNodeIds.length < 4 || mullionNodeIds.length < 1 || cameNodeIds.length < 2) throw new Error(`functional building visual: window ${id} lacks frame, mullion, or lead-came construction`);
      for (const part of [...frameNodeIds,...mullionNodeIds,...cameNodeIds]) requireNode(part, `${id} window construction`);
      Object.assign(opening, { frameNodeIds, mullionNodeIds, cameNodeIds });
    } else {
      if (opening.glazingNodeId !== undefined) throw new Error(`functional building visual: door ${id} cannot carry glazing authority`);
      requireNode(text(opening.leafNodeId, `${id}.leafNodeId`), `${id}.leafNodeId`);
      const plankNodeIds=ids(opening.plankNodeIds,`${id}.plankNodeIds`),ironworkNodeIds=ids(opening.ironworkNodeIds,`${id}.ironworkNodeIds`);
      if(plankNodeIds.length<3||ironworkNodeIds.length<3)throw new Error(`functional building visual: door ${id} lacks authored planks or ironwork`);
      for(const part of [...plankNodeIds,...ironworkNodeIds])requireNode(part,`${id} door construction`);
      Object.assign(opening,{plankNodeIds,ironworkNodeIds});
    }
    if (opening.exterior !== undefined && typeof opening.exterior !== "boolean")
      throw new Error(`functional building visual: ${id}.exterior must be boolean when present`);
    return Object.freeze({ id, kind, facade, ...(opening.exterior === undefined ? {} : { exterior: opening.exterior as boolean }), aperture: Object.freeze({ center: vec3(aperture.center, `${id}.aperture.center`),
      halfExtents: vec3(aperture.halfExtents, `${id}.aperture.halfExtents`, true) }),
      ...(kind === "window" ? { glazingNodeId: opening.glazingNodeId as string, frameNodeIds: opening.frameNodeIds as string[], mullionNodeIds: opening.mullionNodeIds as string[], cameNodeIds: opening.cameNodeIds as string[] }
        : { leafNodeId: opening.leafNodeId as string, plankNodeIds: opening.plankNodeIds as string[], ironworkNodeIds: opening.ironworkNodeIds as string[] }),
      revealNodeIds: revealNodeIds as [string, string, string, string] });
  });
  const classified = openings.some((opening) => opening.exterior !== undefined),
    exteriorDoors = openings.filter((opening) => opening.kind === "door" && (classified ? opening.exterior === true : true));
  if (!openings.some((opening) => opening.kind === "window") || exteriorDoors.length !== 1 ||
    (classified && openings.some((opening) => opening.kind === "window" && opening.exterior !== true))) {
    throw new Error("functional building visual: contract requires exterior windows and exactly one exterior door");
  }
  const materials = Array.isArray(gltf.materials) ? gltf.materials.map((material, index) => obj(material, `materials[${index}]`)) : [];
  const materialNames = new Set(materials.map((material, index) => text(material.name, `materials[${index}].name`)));
  const rawRoles = Array.isArray(authority.materialRoles) ? authority.materialRoles : [];
  const roles = new Set<string>(), usedMaterials = new Set<string>();
  const materialRoles = rawRoles.map((raw, index) => {
    const record = obj(raw, `materialRoles[${index}]`), role = text(record.role, `materialRoles[${index}].role`), materialName = text(record.materialName, `${role}.materialName`);
    if (roles.has(role)) throw new Error(`functional building visual: duplicate material role ${role}`); roles.add(role);
    if (usedMaterials.has(materialName)) throw new Error(`functional building visual: material ${materialName} aliases multiple roles`); usedMaterials.add(materialName);
    if (!materialNames.has(materialName)) throw new Error(`functional building visual: material role ${role} is unresolved`);
    const material = materials.find((candidate) => candidate.name === materialName)!;
    const pbr = obj(material.pbrMetallicRoughness, `${materialName}.pbrMetallicRoughness`);
    const authoredUntexturedFinish = role === "glazing" || role === "door-hardware" || role === "roof-flashing"
      || role === "hearth-soot" || role === "hearth-embers" || role === "flame-outer" || role === "flame-inner"
      || role === "domestic-ceramic" || role === "domestic-ceramic-dark" || role === "textile-wool" || role === "wax";
    if (!authoredUntexturedFinish && (pbr.baseColorTexture === undefined || pbr.metallicRoughnessTexture === undefined || material.normalTexture === undefined)) {
      throw new Error(`functional building visual: material ${materialName} lacks mapped albedo, roughness, or normal depth`);
    }
    if (role === "glazing") {
      const alpha = Array.isArray(pbr.baseColorFactor) ? Number(pbr.baseColorFactor[3]) : 1;
      if (material.alphaMode !== "BLEND" || !Number.isFinite(alpha) || alpha < .08 || alpha > .35 || pbr.baseColorTexture !== undefined || material.normalTexture !== undefined) {
        throw new Error(`functional building visual: glazing ${materialName} is not restrained transparent optical glass`);
      }
    }
    return Object.freeze({ role, materialName });
  });
  for (const required of ["foundation", "mortar-reveal", "wall-exterior", "wall-interior", "structure-trim", "door-surface", "roof", "glazing", "door-hardware", "hearth-masonry"]) {
    if (!roles.has(required)) throw new Error(`functional building visual: required material role ${required} is missing`);
  }
  if (usedMaterials.size !== materialNames.size) throw new Error("functional building visual: every exported material requires one construction-specific role identity");
  const interiorRaw = obj(authority.interior, "interior");
  const aisleRaw=obj(interiorRaw.clearAisle,"interior.clearAisle"),halfWidth=Number(aisleRaw.halfWidth),minClearHeight=Number(aisleRaw.minClearHeight);
  if(!Number.isFinite(halfWidth)||halfWidth<.45||!Number.isFinite(minClearHeight)||minClearHeight<1.8)throw new Error("functional building visual: interior clear aisle is not traversable");
  const hearthRaw=interiorRaw.hearth===undefined?undefined:obj(interiorRaw.hearth,"interior.hearth");
  const hearth=hearthRaw===undefined?undefined:Object.freeze({
    apertureCenter:vec3(hearthRaw.apertureCenter,"interior.hearth.apertureCenter"),
    apertureHalfExtents:vec3(hearthRaw.apertureHalfExtents,"interior.hearth.apertureHalfExtents",true),
    surroundNodeIds:Object.freeze(ids(hearthRaw.surroundNodeIds,"interior.hearth.surroundNodeIds").map((id)=>requireNode(id,"interior.hearth.surroundNodeIds"))),
    fuelNodeIds:Object.freeze(ids(hearthRaw.fuelNodeIds,"interior.hearth.fuelNodeIds").map((id)=>requireNode(id,"interior.hearth.fuelNodeIds"))),
    emberNodeId:requireNode(text(hearthRaw.emberNodeId,"interior.hearth.emberNodeId"),"interior.hearth.emberNodeId"),
    flameNodeIds:Object.freeze(ids(hearthRaw.flameNodeIds,"interior.hearth.flameNodeIds").map((id)=>requireNode(id,"interior.hearth.flameNodeIds"))),
    lightNodeId:requireNode(text(hearthRaw.lightNodeId,"interior.hearth.lightNodeId"),"interior.hearth.lightNodeId"),
  });
  const interior = Object.freeze({
    walkableNodeIds: Object.freeze(ids(interiorRaw.walkableNodeIds, "interior.walkableNodeIds").map((id) => requireNode(id, "interior.walkableNodeIds"))),
    ceilingNodeIds: Object.freeze(ids(interiorRaw.ceilingNodeIds, "interior.ceilingNodeIds").map((id) => requireNode(id, "interior.ceilingNodeIds"))),
    shellNodeIds: Object.freeze(ids(interiorRaw.shellNodeIds, "interior.shellNodeIds").map((id) => requireNode(id, "interior.shellNodeIds"))),
    furnishingNodeIds: Object.freeze(optionalIds(interiorRaw.furnishingNodeIds,"interior.furnishingNodeIds").map((id)=>requireNode(id,"interior.furnishingNodeIds"))),
    ...(hearth===undefined?{}:{hearth}),
    clearAisle:Object.freeze({from:vec3(aisleRaw.from,"interior.clearAisle.from"),to:vec3(aisleRaw.to,"interior.clearAisle.to"),halfWidth,minClearHeight}),
  });
  const lodRaw = obj(authority.lod, "lod"), triangleBudget = integer(lodRaw.triangleBudget, "lod.triangleBudget"),
    drawBudget = integer(lodRaw.drawBudget, "lod.drawBudget"), lod1TriangleBudget = integer(lodRaw.lod1TriangleBudget, "lod.lod1TriangleBudget"),
    lod2TriangleBudget = integer(lodRaw.lod2TriangleBudget, "lod.lod2TriangleBudget");
  if (lod1TriangleBudget >= triangleBudget || lod2TriangleBudget >= lod1TriangleBudget) {
    throw new Error("functional building visual: LOD triangle budgets must strictly descend");
  }
  const lod = Object.freeze({ identity: text(lodRaw.identity, "lod.identity"),
    lod0RootNodeId: requireNode(text(lodRaw.lod0RootNodeId, "lod.lod0RootNodeId"), "lod.lod0RootNodeId"),
    triangleBudget, drawBudget, lod1TriangleBudget, lod2TriangleBudget });
  return Object.freeze({ schema: FUNCTIONAL_BUILDING_VISUAL_CONTRACT, openings: Object.freeze(openings),
    materialRoles: Object.freeze(materialRoles), interior, lod });
}
