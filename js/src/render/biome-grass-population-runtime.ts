import * as THREE from "../../build/three.bundle.mjs";
import type { CameraLike } from "../engine.ts";
import type { GrassFieldQualityTier } from "./grass-field-config.ts";
import type { GrassFieldLod, GrassFieldVisualPackage, GrassFieldVisualProfile } from "./grass-field-package.ts";

export const BIOME_GRASS_POPULATION_MAX_PAGE_INSTANCES = 1_024;
export const BIOME_GRASS_POPULATION_MAX_RESIDENT_DRAWS = 128;
export const BIOME_GRASS_POPULATION_LOD_HYSTERESIS = 0.1;
export const BIOME_GRASS_POPULATION_MAX_RECYCLED_GEOMETRIES_PER_LOD = 8;

/** Defers package construction off the caller's render-frame stack. Tests inject a manually
 * advanced scheduler; production uses one zero-delay task per page so a residency change never
 * constructs more than one bounded page in one turn. */
export type BiomeGrassPopulationBuildScheduler = <Result>(work: () => Result) => Promise<Result>;

export interface BiomeGrassPopulationPlacement {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly scale: number;
  readonly pageX: number;
  readonly pageZ: number;
}

export interface BiomeGrassPopulationRuntimeInput {
  readonly role: string;
  readonly placements: readonly BiomeGrassPopulationPlacement[];
  readonly visualPackage: GrassFieldVisualPackage;
  readonly quality: GrassFieldQualityTier;
  readonly variant: string;
  readonly bladeScale: readonly [number, number];
  readonly scene: { add?(object: unknown): void; remove?(object: unknown): void };
  readonly onError?: (error: unknown) => void;
  readonly lodHysteresis?: number;
  readonly buildScheduler?: BiomeGrassPopulationBuildScheduler;
}

interface Page {
  readonly key: string;
  readonly pageX: number;
  readonly pageZ: number;
  readonly ranked: readonly RankedPlacement[];
  readonly origin: readonly [number, number, number];
  readonly bounds: Readonly<{ minX: number; minZ: number; maxX: number; maxZ: number }>;
}

interface RankedPlacement extends BiomeGrassPopulationPlacement { readonly rank: number }
interface Selection { readonly page: Page; readonly lod: GrassFieldLod; readonly placements: readonly RankedPlacement[]; readonly signature: string }
interface MountedPage {
  readonly signature: string;
  readonly lod: GrassFieldLod;
  readonly blades: number;
  readonly mesh: THREE.InstancedMesh;
  readonly visual: CachedVisual;
}
interface CachedVisual {
  readonly key: string;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  readonly recycled: THREE.BufferGeometry[];
  disposed: boolean;
}
interface PendingBuild { readonly key: string; readonly signature: string; readonly generation: number; readonly task: Promise<void> }

function finite(value: number, label: string): number {
  if (!Number.isFinite(value) || Object.is(value, -0)) throw new RangeError(`${label} must be a canonical finite number`);
  return value;
}

function cameraPosition(camera: CameraLike): THREE.Vector3 {
  const resolved = camera as unknown as {
    getWorldPosition?(target: THREE.Vector3): THREE.Vector3;
    position?: { x?: number; y?: number; z?: number };
  };
  const position = new THREE.Vector3();
  if (resolved.getWorldPosition !== undefined) resolved.getWorldPosition(position);
  else position.set(resolved.position?.x ?? 0, resolved.position?.y ?? 0, resolved.position?.z ?? 0);
  if (![position.x, position.y, position.z].every(Number.isFinite)) throw new RangeError("biome grass camera must be finite");
  return position;
}

function rankPlacement(placement: BiomeGrassPopulationPlacement): number {
  const x = Math.round(placement.x * 1_000) | 0;
  const z = Math.round(placement.z * 1_000) | 0;
  const yaw = Math.round(placement.yaw * 10_000) | 0;
  let hash = (Math.imul(x, 0x9e3779b1) ^ Math.imul(z, 0x85ebca77) ^ Math.imul(yaw, 0xc2b2ae3d)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

function profile(input: BiomeGrassPopulationRuntimeInput): GrassFieldVisualProfile {
  const result = input.visualPackage.profile(input.quality);
  if (!Number.isSafeInteger(result.maxResidentBlades) || result.maxResidentBlades < 1) {
    throw new RangeError(`grass visual package '${input.visualPackage.id}' has an invalid resident blade budget`);
  }
  for (const [index, value] of result.bladesPerInstance.entries()) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`grass visual package '${input.visualPackage.id}' has invalid LOD${index} blades-per-instance`);
  }
  for (const [index, value] of result.spacingMultipliers.entries()) {
    if (!Number.isFinite(value) || value < 1) throw new RangeError(`grass visual package '${input.visualPackage.id}' has invalid LOD${index} spacing multiplier`);
  }
  return result;
}

function pageDistance(page: Page, x: number, z: number): number {
  const dx = x < page.bounds.minX ? page.bounds.minX - x : x > page.bounds.maxX ? x - page.bounds.maxX : 0;
  const dz = z < page.bounds.minZ ? page.bounds.minZ - z : z > page.bounds.maxZ ? z - page.bounds.maxZ : 0;
  return Math.hypot(dx, dz);
}

function defaultBuildScheduler<Result>(work: () => Result): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    setTimeout(() => {
      try { resolve(work()); } catch (error) { reject(error); }
    }, 0);
  });
}

function releasePageGeometry(resource: CachedVisual, geometry: THREE.BufferGeometry, errors: unknown[]): void {
  // Do not retain per-page wind arrays while an otherwise reusable topology wrapper is idle.
  geometry.deleteAttribute("aWind");
  if (!resource.disposed && resource.recycled.length < BIOME_GRASS_POPULATION_MAX_RECYCLED_GEOMETRIES_PER_LOD) {
    resource.recycled.push(geometry);
    return;
  }
  try { geometry.dispose(); } catch (error) { errors.push(error); }
}

/** Page geometries own their instance attributes; package templates/materials are cache-owned. */
function disposeMountedPage(mounted: MountedPage): void {
  const errors: unknown[] = [];
  try { mounted.mesh.dispose(); } catch (error) { errors.push(error); }
  releasePageGeometry(mounted.visual, mounted.mesh.geometry, errors);
  if (errors.length > 0) throw new AggregateError(errors, `biome grass page disposal failed in ${errors.length} operation(s)`);
}

function disposeCachedVisual(resource: CachedVisual): void {
  if (resource.disposed) return;
  resource.disposed = true;
  const errors: unknown[] = [];
  for (const geometry of resource.recycled.splice(0)) try { geometry.dispose(); } catch (error) { errors.push(error); }
  try { resource.geometry.dispose(); } catch (error) { errors.push(error); }
  try { resource.material.dispose(); } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, `biome grass cached visual disposal failed in ${errors.length} operation(s)`);
}

function buildPages(placements: readonly BiomeGrassPopulationPlacement[]): readonly Page[] {
  const groups = new Map<string, BiomeGrassPopulationPlacement[]>();
  for (const [index, placement] of placements.entries()) {
    for (const [axis, value] of [["x", placement.x], ["y", placement.y], ["z", placement.z], ["yaw", placement.yaw], ["scale", placement.scale]] as const) {
      finite(value, `biome grass placement ${index}.${axis}`);
    }
    if (!(placement.scale > 0)) throw new RangeError(`biome grass placement ${index}.scale must be positive`);
    if (!Number.isSafeInteger(placement.pageX) || !Number.isSafeInteger(placement.pageZ)) {
      throw new RangeError(`biome grass placement ${index} page coordinates must be safe integers`);
    }
    const key = `${placement.pageZ}:${placement.pageX}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [placement]); else group.push(placement);
  }
  const pages: Page[] = [];
  const ordered = [...groups.entries()].sort((left, right) => {
    const [lz, lx] = left[0].split(":").map(Number), [rz, rx] = right[0].split(":").map(Number);
    return lz! - rz! || lx! - rx!;
  });
  for (const [groupKey, group] of ordered) {
    const [pageZ, pageX] = groupKey.split(":").map(Number);
    const ranked = group.map((placement) => Object.freeze({ ...placement, rank: rankPlacement(placement) }))
      .sort((left, right) => left.rank - right.rank || left.z - right.z || left.x - right.x || left.y - right.y || left.yaw - right.yaw);
    for (let offset = 0, chunk = 0; offset < ranked.length; offset += BIOME_GRASS_POPULATION_MAX_PAGE_INSTANCES, chunk++) {
      const slice = Object.freeze(ranked.slice(offset, offset + BIOME_GRASS_POPULATION_MAX_PAGE_INSTANCES));
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const placement of slice) {
        minX = Math.min(minX, placement.x); minY = Math.min(minY, placement.y); minZ = Math.min(minZ, placement.z);
        maxX = Math.max(maxX, placement.x); maxZ = Math.max(maxZ, placement.z);
      }
      pages.push(Object.freeze({ key: `${pageX}:${pageZ}:${chunk}`, pageX: pageX!, pageZ: pageZ!, ranked: slice,
        origin: Object.freeze([(minX + maxX) / 2, minY, (minZ + maxZ) / 2]) as readonly [number, number, number],
        bounds: Object.freeze({ minX, minZ, maxX, maxZ }) }));
    }
  }
  return Object.freeze(pages);
}

export class BiomeGrassPopulationRuntime {
  readonly root = new THREE.Group();
  readonly maxResidentBlades: number;
  readonly maxResidentDraws = BIOME_GRASS_POPULATION_MAX_RESIDENT_DRAWS;
  private readonly input: BiomeGrassPopulationRuntimeInput;
  private readonly profile: GrassFieldVisualProfile;
  private readonly pages: readonly Page[];
  private readonly errors: unknown[] = [];
  private readonly buildScheduler: BiomeGrassPopulationBuildScheduler;
  private readonly hysteresis: number;
  private readonly visualCache = new Map<GrassFieldLod, CachedVisual>();
  private active = new Map<string, MountedPage>();
  private desired = new Map<string, Selection>();
  private desiredIdentity = "";
  private pending: PendingBuild | undefined;
  private failed: Readonly<{ key: string; signature: string; generation: number }> | undefined;
  private generation = 0;
  private initialized = false;
  private published = false;
  private disposed = false;

  constructor(input: BiomeGrassPopulationRuntimeInput) {
    if (!input.visualPackage.variants.includes(input.variant)) {
      throw new Error(`grass visual package '${input.visualPackage.id}' does not support variant '${input.variant}'`);
    }
    if (input.bladeScale.length !== 2 || !input.bladeScale.every((value) => Number.isFinite(value) && value > 0)
        || input.bladeScale[0] > input.bladeScale[1]) throw new RangeError("biome grass bladeScale must be a sorted positive pair");
    this.input = input;
    this.profile = profile(input);
    this.maxResidentBlades = this.profile.maxResidentBlades;
    this.pages = buildPages(input.placements);
    const hysteresis = input.lodHysteresis ?? BIOME_GRASS_POPULATION_LOD_HYSTERESIS;
    if (!Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis > 0.5) {
      throw new RangeError("biome grass LOD hysteresis must be finite and in [0, 0.5]");
    }
    this.hysteresis = hysteresis;
    this.buildScheduler = input.buildScheduler ?? defaultBuildScheduler;
    this.root.name = `limina:biome-grass-population:${input.role}`;
  }

  /** Initial staging is synchronous so publication cannot expose an empty candidate. Subsequent
   * camera-driven changes are deferred through the bounded scheduler. */
  initialize(camera: CameraLike): void { this.initializeSelection(this.select(camera)); }

  publish(): void {
    if (this.disposed) throw new Error("cannot publish a disposed biome grass population");
    if (this.published) return;
    try { this.input.scene.add?.(this.root); }
    catch (primary) {
      try { this.input.scene.remove?.(this.root); } catch (rollback) {
        throw new AggregateError([primary, rollback], "biome grass population publication rollback failed");
      }
      throw primary;
    }
    this.published = true;
  }

  update(camera: CameraLike): void {
    if (this.disposed) return;
    try { this.reconcile(camera); } catch (error) { this.report(error); }
  }

  get draws(): number { return this.active.size; }
  get bladeCount(): number { let count = 0; for (const mounted of this.active.values()) count += mounted.blades; return count; }
  get lods(): ReadonlySet<GrassFieldLod> { return new Set([...this.active.values()].map((mounted) => mounted.lod)); }
  get pendingBuilds(): number { return this.pending === undefined ? 0 : 1; }
  get cachedVisuals(): number { return this.visualCache.size; }
  get recycledGeometries(): number {
    let count = 0; for (const resource of this.visualCache.values()) count += resource.recycled.length; return count;
  }
  takeErrors(): unknown[] { return this.errors.splice(0); }
  async settle(): Promise<void> {
    while (this.pending !== undefined) await this.pending.task;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++; this.desired.clear(); this.desiredIdentity = ""; this.failed = undefined;
    const errors: unknown[] = [];
    if (this.published) try { this.input.scene.remove?.(this.root); } catch (error) { errors.push(error); }
    for (const mounted of this.active.values()) try { disposeMountedPage(mounted); } catch (error) { errors.push(error); }
    this.active.clear(); this.root.clear(); this.published = false;
    this.clearVisualCache(errors);
    if (errors.length > 0) throw new AggregateError(errors, `biome grass population disposal failed in ${errors.length} operation(s)`);
  }

  private select(camera: CameraLike): Map<string, Selection> {
    const position = cameraPosition(camera);
    const lod0Fade = this.profile.lod[0].fade, lod1Fade = this.profile.lod[1].fade;
    const fineDistance = lod0Fade?.start ?? Math.max(1, this.profile.fineRadius * 48);
    const cullDistance = lod1Fade?.end ?? Math.max(fineDistance + 1, this.profile.radius * 48);
    if (!(fineDistance >= 0) || !(cullDistance > fineDistance)) {
      throw new RangeError(`grass visual package '${this.input.visualPackage.id}' has invalid LOD distance coverage`);
    }
    const fineBand = Math.max(1, fineDistance) * this.hysteresis;
    const cullBand = Math.max(1, cullDistance) * this.hysteresis;
    const candidates = this.pages.map((page) => ({ page, distance: pageDistance(page, position.x, position.z) }))
      .filter((entry) => entry.distance <= cullDistance + (this.active.has(entry.page.key) ? cullBand : 0))
      .sort((left, right) => left.distance - right.distance || left.page.pageZ - right.page.pageZ
        || left.page.pageX - right.page.pageX || left.page.key.localeCompare(right.page.key));
    const selected = new Map<string, Selection>();
    let blades = 0, draws = 0;
    for (const candidate of candidates) {
      if (draws >= this.maxResidentDraws || blades >= this.maxResidentBlades) break;
      const previous = this.active.get(candidate.page.key);
      const lod: GrassFieldLod = previous?.lod === 0
        ? (candidate.distance <= fineDistance + fineBand ? 0 : 1)
        : previous?.lod === 1
        ? (candidate.distance < fineDistance - fineBand ? 0 : 1)
        : (candidate.distance <= fineDistance ? 0 : 1);
      const bladesPerInstance = this.profile.bladesPerInstance[lod];
      const densityCap = Math.max(1, Math.ceil(candidate.page.ranked.length / this.profile.spacingMultipliers[lod] ** 2));
      const budgetCap = Math.floor((this.maxResidentBlades - blades) / bladesPerInstance);
      const count = Math.min(candidate.page.ranked.length, densityCap, budgetCap);
      if (count < 1) continue;
      const placements = Object.freeze(candidate.page.ranked.slice(0, count));
      selected.set(candidate.page.key, Object.freeze({ page: candidate.page, lod, placements,
        signature: `${lod}:${count}` }));
      blades += count * bladesPerInstance; draws++;
    }
    return selected;
  }

  private cachedVisual(lod: GrassFieldLod): CachedVisual {
    const prior = this.visualCache.get(lod);
    if (prior !== undefined) return prior;
    const bladesPerInstance = this.profile.bladesPerInstance[lod];
    const context = { quality: this.input.quality, lod,
      maxBlades: Math.min(this.maxResidentBlades, BIOME_GRASS_POPULATION_MAX_PAGE_INSTANCES * bladesPerInstance),
      variant: this.input.variant } as const;
    let geometry: THREE.BufferGeometry | undefined;
    try {
      geometry = this.input.visualPackage.createGeometry(context);
      const material = this.input.visualPackage.createMaterial(context);
      const resource: CachedVisual = {
        key: `${this.input.visualPackage.id}@${this.input.visualPackage.version}:${this.input.quality}:${this.input.variant}:lod${lod}`,
        geometry, material, recycled: [], disposed: false,
      };
      this.visualCache.set(lod, resource);
      return resource;
    } catch (primary) {
      if (geometry === undefined) throw primary;
      try { geometry.dispose(); } catch (rollback) {
        throw new AggregateError([primary, rollback], "biome grass cached visual construction rollback failed");
      }
      throw primary;
    }
  }

  private build(selection: Selection): MountedPage {
    const bladesPerInstance = this.profile.bladesPerInstance[selection.lod];
    let geometry: THREE.BufferGeometry | undefined, mesh: THREE.InstancedMesh | undefined;
    try {
      const visual = this.profile.lod[selection.lod];
      const cached = this.cachedVisual(selection.lod);
      // aWind is page-local. Cloning the package template preserves isolation while the expensive
      // package construction and node-material graph remain cached once per package/LOD identity.
      geometry = cached.recycled.pop() ?? cached.geometry.clone();
      mesh = new THREE.InstancedMesh(geometry, cached.material, selection.placements.length);
      mesh.userData.liminaGrassVisualCacheKey = cached.key;
      const wind = new Float32Array(selection.placements.length * 4);
      const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), position = new THREE.Vector3(), scale = new THREE.Vector3();
      const yAxis = new THREE.Vector3(0, 1, 0), scaleMin = this.input.bladeScale[0], scaleSpan = this.input.bladeScale[1] - scaleMin;
      for (let index = 0; index < selection.placements.length; index++) {
        const placement = selection.placements[index]!;
        position.set(placement.x - selection.page.origin[0], placement.y - selection.page.origin[1], placement.z - selection.page.origin[2]);
        rotation.setFromAxisAngle(yAxis, placement.yaw);
        const visualScale = scaleMin + placement.rank / 0xffff_ffff * scaleSpan;
        scale.setScalar(placement.scale * visualScale);
        matrix.compose(position, rotation, scale); mesh.setMatrixAt(index, matrix);
        wind[index * 4] = position.x; wind[index * 4 + 1] = position.z; wind[index * 4 + 3] = placement.yaw;
      }
      geometry.setAttribute("aWind", new THREE.InstancedBufferAttribute(wind, 4));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.position.set(...selection.page.origin);
      mesh.name = `limina:biome-grass-page:${selection.page.key}:lod${selection.lod}`;
      mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = true; mesh.computeBoundingSphere();
      if (mesh.boundingSphere !== null) mesh.boundingSphere.radius += visual.maxHorizontalDisplacement + visual.footprintRadius;
      return Object.freeze({ signature: selection.signature, lod: selection.lod,
        blades: selection.placements.length * bladesPerInstance, mesh, visual: cached });
    } catch (primary) {
      const errors: unknown[] = [primary];
      if (mesh !== undefined) try { mesh.dispose(); } catch (error) { errors.push(error); }
      if (geometry !== undefined) {
        const cached = this.visualCache.get(selection.lod);
        if (cached === undefined) try { geometry.dispose(); } catch (error) { errors.push(error); }
        else releasePageGeometry(cached, geometry, errors);
      }
      throw errors.length === 1 ? primary : new AggregateError(errors, "biome grass page build rollback failed");
    }
  }

  private initializeSelection(selected: Map<string, Selection>): void {
    if (this.disposed) throw new Error("cannot initialize a disposed biome grass population");
    if (this.initialized) throw new Error("biome grass population is already initialized");
    const built = new Map<string, MountedPage>();
    try {
      for (const [key, selection] of selected) built.set(key, this.build(selection));
    } catch (primary) {
      const errors: unknown[] = [primary];
      for (const mounted of built.values()) try { disposeMountedPage(mounted); } catch (error) { errors.push(error); }
      this.clearVisualCache(errors);
      throw errors.length === 1 ? primary : new AggregateError(errors, "biome grass population build rollback failed");
    }
    const added: MountedPage[] = [];
    try {
      for (const mounted of built.values()) { this.root.add(mounted.mesh); added.push(mounted); }
    } catch (primary) {
      const errors: unknown[] = [primary];
      for (const mounted of added) try { this.root.remove(mounted.mesh); } catch (error) { errors.push(error); }
      for (const mounted of built.values()) try { disposeMountedPage(mounted); } catch (error) { errors.push(error); }
      this.clearVisualCache(errors);
      throw errors.length === 1 ? primary : new AggregateError(errors, "biome grass population publication rollback failed");
    }
    this.active = built;
    this.desired = selected;
    this.desiredIdentity = this.selectionIdentity(selected);
    this.initialized = true;
  }

  private reconcile(camera: CameraLike): void {
    const selected = this.select(camera);
    const identity = this.selectionIdentity(selected);
    if (identity !== this.desiredIdentity) {
      this.generation++;
      this.desiredIdentity = identity;
      this.failed = undefined;
    }
    this.desired = selected;
    for (const [key, mounted] of [...this.active]) {
      if (selected.has(key)) continue;
      this.root.remove(mounted.mesh);
      this.active.delete(key);
      try { disposeMountedPage(mounted); } catch (error) { this.report(error); }
    }
    this.launchNext();
  }

  private selectionIdentity(selected: ReadonlyMap<string, Selection>): string {
    return [...selected].map(([key, selection]) => `${key}=${selection.signature}`).join("|");
  }

  private launchNext(): void {
    if (this.disposed || this.pending !== undefined) return;
    const candidate = [...this.desired].find(([key, selection]) => {
      if (this.active.get(key)?.signature === selection.signature) return false;
      return this.failed?.generation !== this.generation || this.failed.key !== key || this.failed.signature !== selection.signature;
    });
    if (candidate === undefined) return;
    const [key, selection] = candidate, generation = this.generation;
    let scheduled: Promise<MountedPage | undefined>;
    try {
      scheduled = this.buildScheduler(() => {
        if (this.disposed || generation !== this.generation || this.desired.get(key)?.signature !== selection.signature) return undefined;
        return this.build(selection);
      });
    } catch (error) {
      this.failed = Object.freeze({ key, signature: selection.signature, generation });
      this.report(error); return;
    }
    const task = scheduled.then((mounted) => {
      if (mounted === undefined) return;
      if (this.disposed || generation !== this.generation || this.desired.get(key)?.signature !== selection.signature) {
        try { disposeMountedPage(mounted); } catch (error) { this.report(error); }
        return;
      }
      if (!this.commitCandidate(key, mounted) && generation === this.generation) {
        this.failed = Object.freeze({ key, signature: selection.signature, generation });
      }
    }).catch((error) => {
      if (generation === this.generation) this.failed = Object.freeze({ key, signature: selection.signature, generation });
      this.report(error);
    }).finally(() => {
      if (this.pending?.generation === generation && this.pending.key === key) this.pending = undefined;
      this.launchNext();
    });
    this.pending = Object.freeze({ key, signature: selection.signature, generation, task });
  }

  private commitCandidate(key: string, mounted: MountedPage): boolean {
    const previous = this.active.get(key);
    let added = false, removed = false;
    try {
      this.root.add(mounted.mesh); added = true;
      if (previous !== undefined) { this.root.remove(previous.mesh); removed = true; }
    } catch (primary) {
      const errors: unknown[] = [primary];
      if (removed && previous !== undefined) try { this.root.add(previous.mesh); } catch (error) { errors.push(error); }
      if (added) try { this.root.remove(mounted.mesh); } catch (error) { errors.push(error); }
      try { disposeMountedPage(mounted); } catch (error) { errors.push(error); }
      this.report(errors.length === 1 ? primary : new AggregateError(errors, "biome grass population publication rollback failed"));
      return false;
    }
    this.active.set(key, mounted);
    if (previous !== undefined) try { disposeMountedPage(previous); } catch (error) { this.report(error); }
    return true;
  }

  private clearVisualCache(errors: unknown[]): void {
    for (const resource of this.visualCache.values()) {
      try { disposeCachedVisual(resource); } catch (error) { errors.push(error); }
    }
    this.visualCache.clear();
  }

  private report(error: unknown): void {
    this.errors.push(error);
    try { this.input.onError?.(error); } catch (observerError) { this.errors.push(observerError); }
  }
}
