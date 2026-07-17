import * as THREE from "../../build/three.bundle.mjs";
import type { CameraLike } from "../engine.ts";
import type { GrassFieldQualityTier } from "./grass-field-config.ts";
import type { GrassFieldLod, GrassFieldVisualPackage, GrassFieldVisualProfile } from "./grass-field-package.ts";

export const BIOME_GRASS_POPULATION_MAX_PAGE_INSTANCES = 1_024;
export const BIOME_GRASS_POPULATION_MAX_RESIDENT_DRAWS = 128;

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
interface MountedPage { readonly signature: string; readonly lod: GrassFieldLod; readonly blades: number; readonly mesh: THREE.InstancedMesh }

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

function disposeMesh(mesh: THREE.InstancedMesh): void {
  const errors: unknown[] = [];
  try { mesh.geometry.dispose(); } catch (error) { errors.push(error); }
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) try { material.dispose(); } catch (error) { errors.push(error); }
  try { mesh.dispose(); } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, `biome grass mesh disposal failed in ${errors.length} operation(s)`);
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
  private active = new Map<string, MountedPage>();
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
    this.root.name = `limina:biome-grass-population:${input.role}`;
  }

  initialize(camera: CameraLike): void { this.reconcile(camera); }

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
  takeErrors(): unknown[] { return this.errors.splice(0); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    if (this.published) try { this.input.scene.remove?.(this.root); } catch (error) { errors.push(error); }
    for (const mounted of this.active.values()) try { disposeMesh(mounted.mesh); } catch (error) { errors.push(error); }
    this.active.clear(); this.root.clear(); this.published = false;
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
    const candidates = this.pages.map((page) => ({ page, distance: pageDistance(page, position.x, position.z) }))
      .filter((entry) => entry.distance <= cullDistance)
      .sort((left, right) => left.distance - right.distance || left.page.pageZ - right.page.pageZ
        || left.page.pageX - right.page.pageX || left.page.key.localeCompare(right.page.key));
    const selected = new Map<string, Selection>();
    let blades = 0, draws = 0;
    for (const candidate of candidates) {
      if (draws >= this.maxResidentDraws || blades >= this.maxResidentBlades) break;
      const lod: GrassFieldLod = candidate.distance <= fineDistance ? 0 : 1;
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

  private build(selection: Selection): MountedPage {
    const bladesPerInstance = this.profile.bladesPerInstance[selection.lod];
    const context = { quality: this.input.quality, lod: selection.lod,
      maxBlades: selection.placements.length * bladesPerInstance, featureOrigin: selection.page.origin,
      variant: this.input.variant } as const;
    let geometry: THREE.BufferGeometry | undefined, material: THREE.Material | undefined, mesh: THREE.InstancedMesh | undefined;
    try {
      const visual = this.profile.lod[selection.lod];
      geometry = this.input.visualPackage.createGeometry(context);
      material = this.input.visualPackage.createMaterial(context);
      mesh = new THREE.InstancedMesh(geometry, material, selection.placements.length);
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
        blades: selection.placements.length * bladesPerInstance, mesh });
    } catch (primary) {
      const errors: unknown[] = [primary];
      if (mesh !== undefined) try { mesh.dispose(); } catch (error) { errors.push(error); }
      if (material !== undefined) try { material.dispose(); } catch (error) { errors.push(error); }
      if (geometry !== undefined) try { geometry.dispose(); } catch (error) { errors.push(error); }
      throw errors.length === 1 ? primary : new AggregateError(errors, "biome grass page build rollback failed");
    }
  }

  private reconcile(camera: CameraLike): void {
    const selected = this.select(camera), built = new Map<string, MountedPage>();
    try {
      for (const [key, selection] of selected) {
        if (this.active.get(key)?.signature === selection.signature) continue;
        built.set(key, this.build(selection));
      }
    } catch (primary) {
      const errors: unknown[] = [primary];
      for (const mounted of built.values()) try { disposeMesh(mounted.mesh); } catch (error) { errors.push(error); }
      throw errors.length === 1 ? primary : new AggregateError(errors, "biome grass population build rollback failed");
    }

    const removed = [...this.active.entries()].filter(([key, mounted]) => selected.get(key)?.signature !== mounted.signature);
    const added: MountedPage[] = [];
    try {
      for (const mounted of built.values()) { this.root.add(mounted.mesh); added.push(mounted); }
      for (const [, mounted] of removed) this.root.remove(mounted.mesh);
    } catch (primary) {
      const errors: unknown[] = [primary];
      for (const [, mounted] of removed) try { this.root.add(mounted.mesh); } catch (error) { errors.push(error); }
      for (const mounted of added) try { this.root.remove(mounted.mesh); } catch (error) { errors.push(error); }
      for (const mounted of built.values()) try { disposeMesh(mounted.mesh); } catch (error) { errors.push(error); }
      throw errors.length === 1 ? primary : new AggregateError(errors, "biome grass population publication rollback failed");
    }

    const next = new Map<string, MountedPage>();
    for (const [key, selection] of selected) next.set(key, built.get(key) ?? this.active.get(key)!);
    this.active = next;
    const disposalErrors: unknown[] = [];
    for (const [, mounted] of removed) try { disposeMesh(mounted.mesh); } catch (error) { disposalErrors.push(error); }
    if (disposalErrors.length > 0) throw new AggregateError(disposalErrors, `biome grass replacement disposal failed in ${disposalErrors.length} operation(s)`);
  }

  private report(error: unknown): void {
    this.errors.push(error);
    try { this.input.onError?.(error); } catch (observerError) { this.errors.push(observerError); }
  }
}
