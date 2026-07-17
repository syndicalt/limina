export const TREE_POPULATION_PAGE_SIZE = 48;
export const TREE_POPULATION_MAX_SPECIES = 12;
export const TREE_POPULATION_MAX_ACTIVE = 24_576;
export const TREE_POPULATION_MAX_ACTIVE_AND_PENDING = 30_720;

export type TreePopulationRung = 0 | 1 | 2;

export interface TreePopulationPlacement {
  readonly speciesId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly scale: number;
}

export interface TreeSpeciesLodPolicy {
  readonly speciesId: string;
  /** LOD0 geometry changes to meshopt-reduced geometry at this distance. */
  readonly reducedDistance: number;
  /** Reduced geometry changes to the octahedral impostor at this distance. */
  readonly impostorDistance: number;
  /** The impostor is no longer resident beyond this distance. */
  readonly cullDistance: number;
  readonly hysteresis?: number;
}

export interface PlannedTreeInstance extends TreePopulationPlacement {
  readonly ordinal: number;
  readonly localX: number;
  readonly localZ: number;
}

export interface TreePopulationPage {
  readonly key: string;
  readonly pageX: number;
  readonly pageZ: number;
  readonly originX: number;
  readonly originZ: number;
  readonly instances: readonly Readonly<PlannedTreeInstance>[];
}

export interface TreePopulationPlan {
  readonly pageSize: number;
  readonly policies: ReadonlyMap<string, Readonly<TreeSpeciesLodPolicy>>;
  readonly pages: readonly Readonly<TreePopulationPage>[];
  readonly species: readonly string[];
  readonly trees: number;
  readonly hash: string;
}

export interface SelectedTreeInstance extends PlannedTreeInstance { readonly rung: TreePopulationRung }
export interface TreePopulationPageSelection {
  readonly key: string;
  readonly pageX: number;
  readonly pageZ: number;
  readonly originX: number;
  readonly originZ: number;
  readonly instances: readonly Readonly<SelectedTreeInstance>[];
  readonly nearestDistance: number;
  readonly signature: string;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function positive(value: number, label: string): number {
  finite(value, label);
  if (value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function hashWords(words: readonly number[]): string {
  let hash = 0xcbf29ce484222325n;
  for (const value of words) {
    let word = BigInt(value >>> 0);
    for (let byte = 0; byte < 4; byte++) {
      hash = (hash ^ (word & 0xffn)) * 0x100000001b3n & 0xffffffffffffffffn;
      word >>= 8n;
    }
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function floatWords(value: number): readonly [number, number] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return [view.getUint32(0, true), view.getUint32(4, true)];
}

export function validateTreeSpeciesPolicies(policies: readonly TreeSpeciesLodPolicy[]): ReadonlyMap<string, Readonly<TreeSpeciesLodPolicy>> {
  if (policies.length === 0 || policies.length > TREE_POPULATION_MAX_SPECIES) {
    throw new RangeError(`tree population species count must be in [1, ${TREE_POPULATION_MAX_SPECIES}]`);
  }
  const resolved = new Map<string, Readonly<TreeSpeciesLodPolicy>>();
  for (const [index, policy] of policies.entries()) {
    if (policy.speciesId.length === 0) throw new RangeError(`tree species policy ${index} requires a speciesId`);
    if (resolved.has(policy.speciesId)) throw new RangeError(`tree species policy '${policy.speciesId}' is duplicated`);
    const reducedDistance = positive(policy.reducedDistance, `tree species '${policy.speciesId}' reducedDistance`);
    const impostorDistance = positive(policy.impostorDistance, `tree species '${policy.speciesId}' impostorDistance`);
    const cullDistance = positive(policy.cullDistance, `tree species '${policy.speciesId}' cullDistance`);
    if (!(reducedDistance < impostorDistance && impostorDistance < cullDistance)) {
      throw new RangeError(`tree species '${policy.speciesId}' distances must be strictly increasing`);
    }
    const hysteresis = policy.hysteresis ?? 0.15;
    if (!Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis > 0.49) {
      throw new RangeError(`tree species '${policy.speciesId}' hysteresis must be in [0, 0.49]`);
    }
    resolved.set(policy.speciesId, Object.freeze({ ...policy, reducedDistance, impostorDistance, cullDistance, hysteresis }));
  }
  return resolved;
}

/** Stable signed 48 m paging. Instance matrices use page-local XZ, never million-metre positions. */
export function buildTreePopulationPlan(
  placements: readonly TreePopulationPlacement[],
  policies: readonly TreeSpeciesLodPolicy[],
  pageSize = TREE_POPULATION_PAGE_SIZE,
): TreePopulationPlan {
  positive(pageSize, "tree population pageSize");
  const policyBySpecies = validateTreeSpeciesPolicies(policies);
  const pages = new Map<string, { pageX: number; pageZ: number; instances: PlannedTreeInstance[] }>();
  const words: number[] = [...floatWords(pageSize), placements.length, policies.length];
  for (const [ordinal, placement] of placements.entries()) {
    const policy = policyBySpecies.get(placement.speciesId);
    if (policy === undefined) throw new RangeError(`tree placement ${ordinal} references unknown species '${placement.speciesId}'`);
    for (const [label, value] of [["x", placement.x], ["y", placement.y], ["z", placement.z], ["yaw", placement.yaw], ["scale", placement.scale]] as const) {
      finite(value, `tree placement ${ordinal}.${label}`);
    }
    if (placement.scale <= 0) throw new RangeError(`tree placement ${ordinal}.scale must be positive`);
    const pageX = Math.floor(placement.x / pageSize), pageZ = Math.floor(placement.z / pageSize);
    if (!Number.isSafeInteger(pageX) || !Number.isSafeInteger(pageZ)) throw new RangeError("tree population signed page coordinate exceeds safe integer range");
    const key = `${pageX}:${pageZ}`;
    let page = pages.get(key);
    if (page === undefined) { page = { pageX, pageZ, instances: [] }; pages.set(key, page); }
    page.instances.push(Object.freeze({ ...placement, ordinal, localX: placement.x - pageX * pageSize, localZ: placement.z - pageZ * pageSize }));
    words.push(ordinal, pageX, pageZ, ...floatWords(placement.x), ...floatWords(placement.y), ...floatWords(placement.z),
      ...floatWords(placement.yaw), ...floatWords(placement.scale));
    for (let index = 0; index < placement.speciesId.length; index++) words.push(placement.speciesId.charCodeAt(index));
  }
  const ordered = [...pages.entries()].sort((a, b) => a[1].pageZ - b[1].pageZ || a[1].pageX - b[1].pageX)
    .map(([key, page]) => Object.freeze({
      key, pageX: page.pageX, pageZ: page.pageZ,
      originX: page.pageX * pageSize, originZ: page.pageZ * pageSize,
      instances: Object.freeze(page.instances),
    }));
  return Object.freeze({
    pageSize, policies: policyBySpecies, pages: Object.freeze(ordered),
    species: Object.freeze([...policyBySpecies.keys()].sort()), trees: placements.length, hash: hashWords(words),
  });
}

export function classifyTreePopulationRung(
  distance: number,
  policy: TreeSpeciesLodPolicy,
  current?: TreePopulationRung,
): TreePopulationRung | undefined {
  finite(distance, "tree population distance");
  if (distance < 0) throw new RangeError("tree population distance must be non-negative");
  const h = policy.hysteresis ?? 0.15;
  if (current === 0) {
    if (distance < policy.reducedDistance * (1 + h)) return 0;
    return distance < policy.impostorDistance ? 1 : distance < policy.cullDistance ? 2 : undefined;
  }
  if (current === 1) {
    if (distance < policy.reducedDistance * (1 - h)) return 0;
    if (distance < policy.impostorDistance * (1 + h)) return 1;
    return distance < policy.cullDistance ? 2 : undefined;
  }
  if (current === 2) {
    if (distance >= policy.cullDistance * (1 + h)) return undefined;
    if (distance >= policy.impostorDistance * (1 - h)) return 2;
    return distance < policy.reducedDistance * (1 - h) ? 0 : 1;
  }
  if (distance < policy.reducedDistance) return 0;
  if (distance < policy.impostorDistance) return 1;
  if (distance < policy.cullDistance) return 2;
  return undefined;
}

export function selectTreePopulationPage(
  plan: TreePopulationPlan,
  page: TreePopulationPage,
  camera: Readonly<{ x: number; y: number; z: number }>,
  previous?: ReadonlyMap<number, TreePopulationRung>,
): TreePopulationPageSelection | undefined {
  finite(camera.x, "tree population camera.x"); finite(camera.y, "tree population camera.y"); finite(camera.z, "tree population camera.z");
  const selected: SelectedTreeInstance[] = [];
  const signatureWords: number[] = [page.pageX, page.pageZ];
  let nearestDistance = Infinity;
  for (const instance of page.instances) {
    const dx = camera.x - instance.x, dy = camera.y - instance.y, dz = camera.z - instance.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const policy = plan.policies.get(instance.speciesId)!;
    const rung = classifyTreePopulationRung(distance, policy, previous?.get(instance.ordinal));
    if (rung === undefined) continue;
    nearestDistance = Math.min(nearestDistance, distance);
    selected.push(Object.freeze({ ...instance, rung }));
    signatureWords.push(instance.ordinal, rung);
  }
  if (selected.length === 0) return undefined;
  return Object.freeze({
    key: page.key, pageX: page.pageX, pageZ: page.pageZ, originX: page.originX, originZ: page.originZ,
    instances: Object.freeze(selected), nearestDistance, signature: hashWords(signatureWords),
  });
}
