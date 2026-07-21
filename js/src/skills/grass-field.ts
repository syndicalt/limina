import * as THREE from "../../build/three.bundle.mjs";
import { z } from "../../build/zod.bundle.mjs";
import { MAX_ENTITIES, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import type { Transformable } from "../ecs/world.ts";
import type { ScatterExclusion, AssetInstance } from "../terrain/asset-scatter.ts";
import {
  grassFieldCandidate,
  grassFieldRandom,
  validateGrassFieldResidentSlots,
} from "../render/grass-field-plan.ts";
import { prepareGrassFieldTerrainPages, type PreparedGrassFieldPage } from "../render/grass-field-terrain.ts";
import {
  buildGrassFieldCompute,
  isNativeGrassFieldComputeRenderer,
  type GrassFieldComputeInput,
  type GrassFieldComputeResource,
} from "../render/grass-field-compute.ts";
import type { GrassFieldVisualPackage } from "../render/grass-field-package.ts";
import { grassFieldInstanceSpacing } from "../render/grass-field-package.ts";
import { buildGrassInstancedMesh } from "../render/grass-placement-mesh.ts";
import { tagEntity } from "./ecs.ts";
import type { EditableTerrain } from "./terrain-edit.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const MAX_GRID_TILES = 225;
const inertTransform = (): Transformable => ({ position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } });
type SceneLike = { add?: (object: unknown) => void; remove?: (object: unknown) => void };

const inputSchema = z.object({
  terrain: z.string().optional(),
  seed: z.number().int().min(-0x80000000).max(0x7fffffff).default(1337),
  spacing: z.number().positive().default(0.75),
  tileSize: z.number().positive().default(24),
  elevationMin: z.number().optional(),
  elevationMax: z.number().optional(),
  slopeMax: z.number().nonnegative().default(0.9),
  sizeRange: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).default([0.7, 1.3]),
  climate: z.enum(["summer", "autumn", "dry", "winter"]).default("summer"),
}).strict().superRefine((value, ctx) => {
  if (value.sizeRange[1] < value.sizeRange[0]) ctx.addIssue({ code: "custom", message: "sizeRange max must be >= min", path: ["sizeRange"] });
  if (value.elevationMin !== undefined && value.elevationMax !== undefined && value.elevationMax < value.elevationMin) {
    ctx.addIssue({ code: "custom", message: "elevationMax must be >= elevationMin", path: ["elevationMax"] });
  }
});

const outputSchema = z.object({
  entity: z.string(), gridTiles: z.number().int(), candidateSlots: z.number().int(), planHash: z.string(),
}).strict();

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;
type ComputeBuilder = (input: GrassFieldComputeInput) => GrassFieldComputeResource;

type PreparedTile = PreparedGrassFieldPage;
interface TileMount { mesh: THREE.InstancedMesh; dispose(): void }
interface FieldMount { root: THREE.Group; tiles: readonly TileMount[]; dispose(): void }

function throwCleanup(primary: unknown, cleanup: unknown[], label: string): never {
  if (cleanup.length === 0) throw primary;
  throw new AggregateError([primary, ...cleanup], `${label}; ${cleanup.length} cleanup operation(s) also failed`);
}

function attemptCleanup(operation: () => void, errors: unknown[]): void {
  try { operation(); } catch (error) { errors.push(error); }
}

function prepareTiles(layer: EditableTerrain, input: Input, exclusions: readonly ScatterExclusion[],
  visualPackage?: GrassFieldVisualPackage): PreparedTile[] {
  const tile = layer.tile;
  const [ox, , oz] = tile.origin, [sx, , sz] = tile.scale;
  const f = { x0: ox - sx / 2, z0: oz - sz / 2, x1: ox + sx / 2, z1: oz + sz / 2 };
  const minTileX = Math.floor(f.x0 / input.tileSize), maxTileX = Math.ceil(f.x1 / input.tileSize);
  const minTileZ = Math.floor(f.z0 / input.tileSize), maxTileZ = Math.ceil(f.z1 / input.tileSize);
  const count = (maxTileX - minTileX) * (maxTileZ - minTileZ);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_GRID_TILES) throw new RangeError(`vegetation.grassField grid tiles must be in [1, ${MAX_GRID_TILES}]`);
  const packageSpacing = visualPackage === undefined ? input.spacing
    : grassFieldInstanceSpacing(visualPackage, "balanced", 0);
  const spacing = Math.min(input.spacing, packageSpacing);
  const prepared: PreparedTile[] = [];
  for (let tz = minTileZ; tz < maxTileZ; tz++) for (let tx = minTileX; tx < maxTileX; tx++) {
    const minX = Math.max(f.x0, tx * input.tileSize), maxX = Math.min(f.x1, (tx + 1) * input.tileSize);
    const minZ = Math.max(f.z0, tz * input.tileSize), maxZ = Math.min(f.z1, (tz + 1) * input.tileSize);
    if (!(maxX > minX && maxZ > minZ)) continue;
    prepared.push(...prepareGrassFieldTerrainPages(tile, {
      seed: input.seed, spacing,
      elevationMin: input.elevationMin ?? layer.elevationColors?.seaLevel ?? -Infinity,
      elevationMax: input.elevationMax ?? Infinity, slopeMax: input.slopeMax, exclusions,
    }, { minX, minZ, maxX, maxZ }));
  }
  validateGrassFieldResidentSlots(prepared.map((entry) => entry.plan.slots));
  if (visualPackage === undefined) return prepared;
  const profile = visualPackage.profile("balanced");
  const bladesPerInstance = profile.bladesPerInstance[0];
  let remainingInstances = Math.floor(profile.maxResidentBlades / bladesPerInstance);
  // Keep complete canonical pages nearest the terrain center. This bounds covered AREA without
  // hash-thinning the whole field below its visual-density contract.
  const centered = [...prepared].sort((left, right) => {
    const lc = left.plan.bounds, rc = right.plan.bounds;
    const lx = (lc.minX + lc.maxX) / 2 - tile.origin[0], lz = (lc.minZ + lc.maxZ) / 2 - tile.origin[2];
    const rx = (rc.minX + rc.maxX) / 2 - tile.origin[0], rz = (rc.minZ + rc.maxZ) / 2 - tile.origin[2];
    return lx * lx + lz * lz - (rx * rx + rz * rz)
      || lc.minZ - rc.minZ || lc.minX - rc.minX;
  });
  const bounded: PreparedTile[] = [];
  for (const entry of centered) {
    if (entry.plan.slots > remainingInstances) continue;
    bounded.push(entry);
    remainingInstances -= entry.plan.slots;
  }
  return bounded;
}

function aggregateHash(tiles: readonly PreparedTile[]): string {
  let hash = 0xcbf29ce484222325n;
  const feed = (byte: number) => { hash = (hash ^ BigInt(byte & 0xff)) * 0x100000001b3n & 0xffffffffffffffffn; };
  const encoder = new TextEncoder();
  const floatBytes = new DataView(new ArrayBuffer(4));
  for (const tile of tiles) {
    for (const byte of encoder.encode(tile.plan.hash)) feed(byte);
    for (const height of tile.heights) {
      floatBytes.setFloat32(0, height, true);
      for (let index = 0; index < 4; index++) feed(floatBytes.getUint8(index));
    }
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function cpuTile(entry: PreparedTile, input: Input, visualPackage: GrassFieldVisualPackage): TileMount | null {
  const placements: AssetInstance[] = [];
  for (let slot = 0; slot < entry.plan.slots; slot++) if (entry.plan.accepted[slot] === 1) {
    const candidate = grassFieldCandidate(entry.plan, slot), style = grassFieldRandom(input.seed, candidate.gridX, candidate.gridZ, 2);
    placements.push({ assetId: "__grass_field__", x: candidate.x, y: entry.heights[slot], z: candidate.z,
      yaw: (style & 0xffff) * Math.PI * 2 / 65536,
      scale: input.sizeRange[0] + (style >>> 16) / 65536 * (input.sizeRange[1] - input.sizeRange[0]) });
  }
  const mesh = buildGrassInstancedMesh(
    placements,
    { maxBlades: entry.plan.slots * visualPackage.profile("balanced").bladesPerInstance[0], featureOrigin: entry.featureOrigin },
    { visualPackage, quality: "balanced", lod: 0, variant: input.climate },
  );
  if (mesh === null) return null;
  const visual = visualPackage.profile("balanced").lod[0];
  mesh.frustumCulled = true;
  mesh.computeBoundingSphere();
  if (mesh.boundingSphere !== null) {
    mesh.boundingSphere.radius += visual.maxHeight * input.sizeRange[1] * 0.6
      + visual.maxHorizontalDisplacement + visual.footprintRadius + 0.15;
  }
  let disposed = false;
  return { mesh, dispose: () => {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    attemptCleanup(() => mesh.geometry.dispose(), errors);
    attemptCleanup(() => (mesh.material as THREE.Material).dispose(), errors);
    attemptCleanup(() => mesh.dispose(), errors);
    if (errors.length > 0) throw new AggregateError(errors, `CPU grass tile disposal failed in ${errors.length} operation(s)`);
  } };
}

async function gpuTile(entry: PreparedTile, input: Input, renderer: GrassFieldComputeInput["renderer"], buildCompute: ComputeBuilder, visualPackage: GrassFieldVisualPackage): Promise<TileMount> {
  let compute: GrassFieldComputeResource | undefined, geometry: THREE.BufferGeometry | undefined;
  let material: THREE.MeshStandardNodeMaterial | undefined, mesh: THREE.InstancedMesh | undefined;
  try {
    compute = buildCompute({ renderer, plan: entry.plan, heights: entry.heights, sizeRange: input.sizeRange, featureOrigin: entry.featureOrigin });
    const visualContext = { quality: "balanced", lod: 0, maxBlades: entry.plan.slots * visualPackage.profile("balanced").bladesPerInstance[0],
      variant: input.climate, featureOrigin: entry.featureOrigin,
      fieldAttributes: { rootYaw: compute.rootYawAttribute, scale: compute.scaleAttribute } } as const;
    geometry = visualPackage.createGeometry(visualContext);
    material = visualPackage.createMaterial(visualContext) as THREE.MeshStandardNodeMaterial;
    const visual = visualPackage.profile("balanced").lod[0];
    mesh = new THREE.InstancedMesh(geometry, material, entry.plan.slots);
    const identity = new THREE.Matrix4();
    for (let slot = 0; slot < entry.plan.slots; slot++) mesh.setMatrixAt(slot, identity);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.position.set(...entry.featureOrigin);
    mesh.name = "limina:grass-field-compute";
    mesh.castShadow = false; mesh.receiveShadow = false;
    let minY = Infinity, maxY = -Infinity;
    for (const y of entry.heights) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const cx = (entry.plan.bounds.minX + entry.plan.bounds.maxX) / 2 - entry.featureOrigin[0];
    const cz = (entry.plan.bounds.minZ + entry.plan.bounds.maxZ) / 2 - entry.featureOrigin[2];
    const cy = (minY + maxY) / 2 - entry.featureOrigin[1] + visual.maxHeight * input.sizeRange[1] / 2;
    const rx = (entry.plan.bounds.maxX - entry.plan.bounds.minX) / 2;
    const rz = (entry.plan.bounds.maxZ - entry.plan.bounds.minZ) / 2;
    const ry = (maxY - minY) / 2 + visual.maxHeight * input.sizeRange[1] + visual.maxHorizontalDisplacement;
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz),
      Math.sqrt(rx * rx + ry * ry + rz * rz) + visual.footprintRadius * input.sizeRange[1]);
    await compute.dispatch();
    let disposed = false;
    return { mesh, dispose: () => {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      attemptCleanup(() => compute!.dispose(), errors);
      attemptCleanup(() => geometry!.dispose(), errors);
      attemptCleanup(() => material!.dispose(), errors);
      attemptCleanup(() => mesh!.dispose(), errors);
      if (errors.length > 0) throw new AggregateError(errors, `GPU grass tile disposal failed in ${errors.length} operation(s)`);
    } };
  } catch (error) {
    const cleanup: unknown[] = [];
    if (compute !== undefined) attemptCleanup(() => compute!.dispose(), cleanup);
    if (geometry !== undefined) attemptCleanup(() => geometry!.dispose(), cleanup);
    if (material !== undefined) attemptCleanup(() => material!.dispose(), cleanup);
    if (mesh !== undefined) attemptCleanup(() => mesh!.dispose(), cleanup);
    throwCleanup(error, cleanup, "GPU grass tile build failed");
  }
}

async function buildMount(prepared: readonly PreparedTile[], input: Input, renderer: unknown, buildCompute: ComputeBuilder, visualPackage: GrassFieldVisualPackage): Promise<FieldMount> {
  const root = new THREE.Group(); root.name = "limina:grass-field";
  const tiles: TileMount[] = [];
  const native = renderer !== undefined && isNativeGrassFieldComputeRenderer(renderer as GrassFieldComputeInput["renderer"]);
  try {
    for (const entry of prepared) {
      const tile = native ? await gpuTile(entry, input, renderer as GrassFieldComputeInput["renderer"], buildCompute, visualPackage) : cpuTile(entry, input, visualPackage);
      if (tile !== null) { tiles.push(tile); root.add(tile.mesh); }
    }
  } catch (error) {
    const cleanup: unknown[] = [];
    for (const tile of tiles) attemptCleanup(() => tile.dispose(), cleanup);
    root.clear();
    throwCleanup(error, cleanup, "grass field mount build failed");
  }
  let disposed = false;
  return { root, tiles: Object.freeze(tiles), dispose: () => {
    if (disposed) return;
    disposed = true;
    root.clear();
    const errors: unknown[] = [];
    for (const tile of tiles) attemptCleanup(() => tile.dispose(), errors);
    if (errors.length > 0) throw new AggregateError(errors, `grass field disposal failed for ${errors.length} tile resource(s)`);
  } };
}

export function registerGrassFieldSkill(
  registry: SkillRegistry,
  layers: Map<string, EditableTerrain>,
  footprints: Map<string, ScatterExclusion[]> = new Map(),
  vegetationClears: Map<string, Array<() => void | Promise<void>>> = new Map(),
  dependencies: Readonly<{ buildCompute?: ComputeBuilder }> = {},
  visualPackage?: GrassFieldVisualPackage,
): void {
  const definition: SkillDefinition<Input, Output> = {
    name: "vegetation.grassField", version: "1.0.0", category: "terrain", permissions: ["scene.write"],
    description: "Create a deterministic, bounded, paint-driven grass field using native WebGPU compute when available and the canonical CPU field plan otherwise.",
    input: inputSchema, output: outputSchema,
    handler: async (input, ctx) => {
      let terrainId = input.terrain;
      if (terrainId === undefined) for (const key of layers.keys()) terrainId = key;
      const layer = terrainId === undefined ? undefined : layers.get(terrainId);
      if (layer === undefined || terrainId === undefined) throw new Error("vegetation.grassField: no terrain layer — create one with terrain.create first");
      const buildCompute = dependencies.buildCompute ?? buildGrassFieldCompute;
      const initial = prepareTiles(layer, input, footprints.get(terrainId) ?? [], visualPackage);
      const candidateSlots = validateGrassFieldResidentSlots(initial.map((entry) => entry.plan.slots));
      const planHash = aggregateHash(initial);
      const scene = ctx.world.scene as SceneLike;
      const canRender = ctx.world.mode !== "headless" && typeof scene?.add === "function";
      if (canRender && visualPackage === undefined) {
        throw new Error("vegetation.grassField: rendering requires an injected GrassFieldVisualPackage");
      }
      let mount: FieldMount | undefined;
      if (canRender) mount = await buildMount(initial, input, ctx.world.renderer, buildCompute, visualPackage!);
      const [ox, oy, oz] = layer.tile.origin;
      const eid = spawnRenderable(ctx.world.ecs, inertTransform(), ox, oy, oz);
      if (eid >= MAX_ENTITIES) { mount?.dispose(); despawnRenderable(ctx.world.ecs, eid); throw new Error("vegetation.grassField: entity capacity exceeded"); }
      let active = true, entity = "";
      let clear: (() => Promise<void>) | undefined;
      const runtimeDispose = (): void => {
        if (!active) return; active = false;
        const errors: unknown[] = [];
        if (mount !== undefined) {
          const prior = mount;
          mount = undefined;
          attemptCleanup(() => scene.remove?.(prior.root), errors);
          attemptCleanup(() => prior.dispose(), errors);
        }
        if (clear !== undefined) {
          const callbacks = vegetationClears.get(terrainId!); const index = callbacks?.indexOf(clear) ?? -1;
          if (index >= 0) callbacks!.splice(index, 1); if (callbacks?.length === 0) vegetationClears.delete(terrainId!);
        }
        if (errors.length > 0) throw new AggregateError(errors, `grass field runtime disposal failed in ${errors.length} operation(s)`);
      };
      try {
        entity = ctx.world.entities.create({ eid, origin: { tool: "vegetation.grassField", input: { ...input } }, runtimeDispose });
        tagEntity(ctx as never, entity, ["grass", "vegetation", "grass-field"]);
        if (mount !== undefined) scene.add?.(mount.root);
        clear = async () => {
          if (!active || !canRender) return;
          const replacementPrepared = prepareTiles(layer, input, footprints.get(terrainId!) ?? [], visualPackage);
          const replacement = await buildMount(replacementPrepared, input, ctx.world.renderer, buildCompute, visualPackage!);
          if (!active) { replacement.dispose(); return; }
          try {
            scene.add?.(replacement.root);
          } catch (error) {
            const cleanup: unknown[] = [];
            attemptCleanup(() => scene.remove?.(replacement.root), cleanup);
            attemptCleanup(() => replacement.dispose(), cleanup);
            throwCleanup(error, cleanup, "grass field replacement publication failed");
          }
          const prior = mount;
          mount = replacement;
          if (prior !== undefined) {
            const cleanup: unknown[] = [];
            attemptCleanup(() => scene.remove?.(prior.root), cleanup);
            attemptCleanup(() => prior.dispose(), cleanup);
            if (cleanup.length > 0) throw new AggregateError(cleanup, `grass field prior-mount disposal failed in ${cleanup.length} operation(s)`);
          }
        };
        const callbacks = vegetationClears.get(terrainId) ?? []; callbacks.push(clear); vegetationClears.set(terrainId, callbacks);
      } catch (error) {
        const cleanup: unknown[] = [];
        attemptCleanup(runtimeDispose, cleanup);
        if (entity !== "") attemptCleanup(() => { ctx.world.entities.destroy(entity); }, cleanup);
        attemptCleanup(() => despawnRenderable(ctx.world.ecs, eid), cleanup);
        throwCleanup(error, cleanup, "vegetation.grassField publication failed");
      }
      ctx.emit("vegetation.grass_field_created", { entity, terrain: terrainId, gridTiles: initial.length, candidateSlots, planHash });
      return { entity, gridTiles: initial.length, candidateSlots, planHash };
    },
  };
  registry.register(definition as unknown as Parameters<SkillRegistry["register"]>[0]);
}
