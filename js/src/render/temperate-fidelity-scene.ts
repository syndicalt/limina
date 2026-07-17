import * as THREE from "../../build/three.bundle.mjs";
import { mountDerivedBiomePopulation } from "../browser/derived-biome-population-mount.ts";
import { DetachedDerivedRenderCandidate, parseTransferredDerivedRuntimeSnapshot } from "../browser/derived-runtime-render-candidate.ts";
import { DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA } from "../browser/derived-runtime-worker.ts";
import { createTransformStorage } from "../ecs/facade.ts";
import { createEcsWorld } from "../ecs/world.ts";
import { EntityTable, type EngineOps } from "../engine.ts";
import { HdrEnvironmentCache } from "./environment-hdri.ts";
import { buildPostPipeline, type PostPipeline } from "./post.ts";
import type { WorldContext } from "../skills/registry.ts";
import { GltfSceneCache } from "../skills/three.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { decodeBiomePopulationArtifact } from "../world/compiler/biome-population-artifact.mjs";
import { decodeSurfaceCompositeArtifact } from "../world/compiler/surface-composite-artifact.mjs";
import { decodeTerrainChunkArtifact } from "../world/compiler/terrain-artifact.mjs";
import { decodeWorldOverviewArtifact } from "../world/compiler/world-overview-artifact.mjs";
import { decodeHydrologyFieldArtifact } from "../world/hydrology-artifact.mjs";
import { inspectHydrologyWaterArtifactBindings } from "../world/hydrology-water-artifact.mjs";
import { prepareGeneratedWaterFieldInput } from "../world/water-field.mjs";

const FIDELITY_BUNDLE_PATH = "assets/derived/temperate-fidelity/runtime/bundle.json";
const FIDELITY_AUTHORITY_PATH = "art-direction/temperate-fidelity-scene.json";
const FIDELITY_HDR_PATH = "site/public/hero/hdri/fantasy.hdr";
const FIDELITY_HDR_ASSET_ID = "hero/hdri/fantasy.hdr";
const FIDELITY_HDR_HASH = "sha256:fd94c84997b8a3c353b62c2125a9b44e19509956986a126e472684432a02d798";

export interface TemperateFidelityResourceReader {
  readJson(path: string): Promise<unknown>;
  readBytes(path: string): Promise<Uint8Array>;
}

export type TemperateFidelityStage =
  | "authorityAndBundle"
  | "resourceFetchAndDecode"
  | "terrainCandidate"
  | "populationMount"
  | "lightingAndEnvironment";

interface FidelityCameraAuthority {
  readonly id: string;
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly fovDeg: number;
  readonly eyeHeightM?: number;
  readonly targetHeightM?: number;
}

// The bundle is decoded and identity-checked by the same runtime artifact decoders below.
// Keep its transport envelope loose at this boundary so the browser and native readers share
// one implementation rather than maintaining parallel handwritten schema projections.
// deno-lint-ignore no-explicit-any
type FidelityBundle = any;
// deno-lint-ignore no-explicit-any
type FidelityAuthority = any;

export interface LoadedTemperateFidelityCandidate {
  readonly bundle: FidelityBundle;
  readonly sceneAuthority: FidelityAuthority;
  readonly authored: FidelityCameraAuthority;
  readonly shot: string;
  readonly chunks: readonly unknown[];
  readonly candidate: DetachedDerivedRenderCandidate;
  readonly contentIndex: ReadonlyMap<string, unknown>;
  readonly reader: TemperateFidelityResourceReader;
}

export interface MountedTemperateFidelityScene {
  readonly bundle: FidelityBundle;
  readonly sceneAuthority: FidelityAuthority;
  readonly candidate: DetachedDerivedRenderCandidate;
  readonly world: WorldContext;
  readonly post: PostPipeline;
  readonly population: Readonly<{
    canopyInstances: number;
    groundCoverTiles: number;
    groundCoverBlades: number;
  }>;
  readonly metadata: Readonly<{
    manifestHash: string;
    terrain: number;
    surfaces: number;
    placements: number;
    canopy: number;
    grassTiles: number;
    grass: number;
    shot: string;
    camera: readonly number[];
    minimumResolution: readonly [number, number];
  }>;
  dispose(): Promise<void>;
}

// deno-lint-ignore no-explicit-any
function requiredArtifact(index: Map<string, any>, artifact: any): any {
  const entry = index.get(artifact.contentHash);
  if (entry === undefined || entry.artifactType !== artifact.artifactType
      || entry.byteLength !== artifact.byteLength || entry.mediaType !== artifact.mediaType) {
    throw new Error(`runtime bundle is missing exact '${artifact.artifactType}' artifact ${artifact.contentHash}`);
  }
  return entry;
}

function authoredCamera(sceneAuthority: FidelityAuthority, shot: string): FidelityCameraAuthority {
  const authoredId = shot.replace(/-high$/, "");
  const authored = shot === "river-clearing"
    ? { id: "river-clearing", position: [28, 0, 68], target: [16.4, 0, 82.1], fovDeg: 55 }
    : shot === "river-bank"
    ? { id: "river-bank", position: [-80, 0, -5], target: [-55, 0, 0], fovDeg: 55 }
    // deno-lint-ignore no-explicit-any
    : sceneAuthority.cameras.find((entry: any) => entry.id === authoredId);
  if (authored === undefined) throw new Error(`unknown capture shot '${shot}'`);
  return authored as FidelityCameraAuthority;
}

export async function loadTemperateFidelityCandidate(input: {
  readonly reader: TemperateFidelityResourceReader;
  readonly shot: string;
  readonly captureRadius?: number;
  readonly stageComplete?: (stage: TemperateFidelityStage) => void;
}): Promise<LoadedTemperateFidelityCandidate> {
  const bundle = await input.reader.readJson(FIDELITY_BUNDLE_PATH) as FidelityBundle;
  const sceneAuthority = await input.reader.readJson(FIDELITY_AUTHORITY_PATH) as FidelityAuthority;
  if (sceneAuthority.presentation?.lighting === undefined || sceneAuthority.presentation?.atmosphere === undefined) {
    throw new Error("fidelity scene is missing its authored lighting or atmosphere authority");
  }
  const authored = authoredCamera(sceneAuthority, input.shot);
  input.stageComplete?.("authorityAndBundle");

  // deno-lint-ignore no-explicit-any
  const index = new Map<string, any>(bundle.artifactIndex.map((entry: any) => [entry.contentHash, entry]));
  const anchorTx = Math.floor((authored.position[0] - bundle.manifest.grid.origin[0]) / bundle.manifest.grid.chunkSizeM);
  const anchorTz = Math.floor((authored.position[2] - bundle.manifest.grid.origin[1]) / bundle.manifest.grid.chunkSizeM);
  const captureRadius = input.captureRadius ?? 2;
  if (!Number.isSafeInteger(captureRadius) || captureRadius < 0 || captureRadius > 8) {
    throw new RangeError("fidelity capture radius must be an integer in [0,8]");
  }
  // Fetch only the authenticated fixed-camera residency window. The complete manifest and
  // artifact index remain the authority; nonresident downloads add no closure evidence.
  // deno-lint-ignore no-explicit-any
  const residentChunkDescriptors = bundle.manifest.chunks.filter((chunk: any) =>
    Math.abs(chunk.tx - anchorTx) <= captureRadius && Math.abs(chunk.tz - anchorTz) <= captureRadius);
  // deno-lint-ignore no-explicit-any
  const chunks = await Promise.all(residentChunkDescriptors.map(async (chunk: any) => {
    // deno-lint-ignore no-explicit-any
    const terrainArtifact = chunk.artifacts.find((entry: any) => entry.artifactType === "terrain-chunk/v1");
    // deno-lint-ignore no-explicit-any
    const surfaceArtifact = chunk.artifacts.find((entry: any) => entry.artifactType === "surface-composite-tile/v1");
    // deno-lint-ignore no-explicit-any
    const populationArtifact = chunk.artifacts.find((entry: any) => entry.artifactType === "biome-population-plan/v1");
    if (terrainArtifact === undefined || surfaceArtifact === undefined || populationArtifact === undefined) {
      throw new Error(`runtime chunk '${chunk.chunkId}' is missing terrain, surface, or population`);
    }
    const terrainBytes = await input.reader.readBytes(`assets/${requiredArtifact(index, terrainArtifact).assetId}`);
    const surfaceBytes = await input.reader.readBytes(`assets/${requiredArtifact(index, surfaceArtifact).assetId}`);
    const populationBytes = await input.reader.readBytes(`assets/${requiredArtifact(index, populationArtifact).assetId}`);
    return { chunkId: chunk.chunkId, chunk, resource: { kind: "terrain-chunk/v1", decoded: decodeTerrainChunkArtifact(terrainBytes),
      surface: decodeSurfaceCompositeArtifact(surfaceBytes), population: decodeBiomePopulationArtifact(populationBytes),
      artifacts: { terrain: terrainArtifact, surface: surfaceArtifact, population: populationArtifact } } };
  }));
  // deno-lint-ignore no-explicit-any
  const globals = await Promise.all(bundle.manifest.globalArtifacts.map(async (artifact: any) => {
    const bytes = await input.reader.readBytes(`assets/${requiredArtifact(index, artifact).assetId}`);
    if (artifact.artifactType === "biome-field/v1" || artifact.artifactType === "biome-content-closure/v1"
        || artifact.artifactType === "biome-runtime-pack/v1" || artifact.artifactType === "navigation-index/v1") {
      return { artifactType: artifact.artifactType, artifact, resource: { kind: artifact.artifactType, bytes } };
    }
    if (artifact.artifactType === "world-overview-terrain/v1") return { artifactType: artifact.artifactType, artifact,
      resource: { kind: artifact.artifactType, decoded: decodeWorldOverviewArtifact(bytes) } };
    if (artifact.artifactType === "hydrology-field/v1") return { artifactType: artifact.artifactType, artifact,
      resource: { kind: artifact.artifactType, decoded: decodeHydrologyFieldArtifact(bytes) } };
    if (artifact.artifactType === "hydrology-water-topology/v1") {
      const bindings = inspectHydrologyWaterArtifactBindings(bytes);
      return { artifactType: artifact.artifactType, artifact, resource: { kind: artifact.artifactType, artifact, bytes, bindings,
        prepared: prepareGeneratedWaterFieldInput({ bytes, descriptor: artifact, expectedBindings: bindings }) } };
    }
    throw new Error(`unsupported capture global ${artifact.artifactType}`);
  }));
  input.stageComplete?.("resourceFetchAndDecode");
  const snapshot = { schema: DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA, projectId: bundle.manifest.projectId,
    branchId: bundle.manifest.branchId, manifestHash: bundle.manifest.manifestHash, source: bundle.manifest.source,
    manifest: bundle.manifest, residency: { ...bundle.residency, center: [authored.position[0], authored.position[2]], radius: captureRadius }, chunks, globals };
  const candidate = new DetachedDerivedRenderCandidate(parseTransferredDerivedRuntimeSnapshot(snapshot), { quality: "cinematic" });
  input.stageComplete?.("terrainCandidate");
  // deno-lint-ignore no-explicit-any
  const contentIndex = new Map<string, any>(bundle.contentIndex.map((entry: any) => [entry.sourceAssetId, entry]));
  return Object.freeze({ bundle, sceneAuthority, authored, shot: input.shot, chunks, candidate, contentIndex,
    reader: input.reader });
}

function minimumResolution(authority: FidelityAuthority): readonly [number, number] {
  const value = authority.presentation?.minimumResolution;
  if (!Array.isArray(value) || value.length !== 2 || !value.every((item) => Number.isSafeInteger(item) && item > 0)) {
    throw new Error("fidelity scene is missing a valid minimumResolution authority");
  }
  return Object.freeze([value[0], value[1]] as const);
}

export function temperateFidelityCaptureSchedule(authority: FidelityAuthority): Readonly<{
  fixedTimeSeconds: number;
  warmupFrames: number;
}> {
  const fixedTimeSeconds = authority.presentation?.captureTimeSeconds;
  const warmupFrames = authority.presentation?.warmupFrames;
  if (!Number.isFinite(fixedTimeSeconds) || fixedTimeSeconds < 0) {
    throw new Error("fidelity scene is missing a finite nonnegative captureTimeSeconds authority");
  }
  if (!Number.isSafeInteger(warmupFrames) || warmupFrames < 1 || warmupFrames > 120) {
    throw new Error("fidelity scene is missing a warmupFrames authority in [1,120]");
  }
  return Object.freeze({ fixedTimeSeconds, warmupFrames });
}

export async function mountTemperateFidelityScene(input: {
  readonly loaded: LoadedTemperateFidelityCandidate;
  readonly renderer: unknown;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly ops: EngineOps;
  readonly width: number;
  readonly height: number;
  readonly waterDebug?: "" | "flat";
  readonly populationHardExclusionAt?: (x: number, z: number) => boolean;
  readonly discretePopulationHardExclusionAt?: (x: number, z: number) => boolean;
  /** Optional renderer-host cache. The scene owns only its lease; callers retain cache ownership. */
  readonly environmentCache?: HdrEnvironmentCache;
  /** Optional prewarmed glTF cache. The scene owns one world lease; callers retain cache ownership. */
  readonly gltfCache?: GltfSceneCache;
  readonly stageComplete?: (stage: TemperateFidelityStage) => void;
}): Promise<MountedTemperateFidelityScene> {
  const { bundle, sceneAuthority, authored, shot, chunks, candidate, contentIndex, reader } = input.loaded;
  const [minimumWidth, minimumHeight] = minimumResolution(sceneAuthority);
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height)
      || input.width < minimumWidth || input.height < minimumHeight) {
    throw new Error(`fidelity capture ${input.width}x${input.height} is below required ${minimumWidth}x${minimumHeight}`);
  }
  const look = sceneAuthority.presentation.lighting;
  const atmosphere = sceneAuthority.presentation.atmosphere;
  const renderer = input.renderer as THREE.WebGPURenderer;
  const prior = {
    shadowEnabled: renderer.shadowMap.enabled,
    shadowType: renderer.shadowMap.type,
    toneMapping: renderer.toneMapping,
    toneMappingExposure: renderer.toneMappingExposure,
    fog: input.scene.fog,
    environment: input.scene.environment,
    environmentIntensity: input.scene.environmentIntensity,
    environmentRotation: input.scene.environmentRotation.clone(),
    background: input.scene.background,
    backgroundIntensity: input.scene.backgroundIntensity,
    backgroundBlurriness: input.scene.backgroundBlurriness,
    backgroundRotation: input.scene.backgroundRotation.clone(),
    cameraAspect: input.camera.aspect,
    cameraNear: input.camera.near,
    cameraFar: input.camera.far,
    cameraFov: input.camera.fov,
    cameraPosition: input.camera.position.clone(),
    cameraQuaternion: input.camera.quaternion.clone(),
  };
  let stateRestored = false;
  const restoreHostState = (): void => {
    if (stateRestored) return;
    stateRestored = true;
    renderer.shadowMap.enabled = prior.shadowEnabled;
    renderer.shadowMap.type = prior.shadowType;
    renderer.toneMapping = prior.toneMapping;
    renderer.toneMappingExposure = prior.toneMappingExposure;
    input.scene.fog = prior.fog;
    input.scene.environment = prior.environment;
    input.scene.environmentIntensity = prior.environmentIntensity;
    input.scene.environmentRotation.copy(prior.environmentRotation);
    input.scene.background = prior.background;
    input.scene.backgroundIntensity = prior.backgroundIntensity;
    input.scene.backgroundBlurriness = prior.backgroundBlurriness;
    input.scene.backgroundRotation.copy(prior.backgroundRotation);
    input.camera.aspect = prior.cameraAspect;
    input.camera.near = prior.cameraNear;
    input.camera.far = prior.cameraFar;
    input.camera.fov = prior.cameraFov;
    input.camera.position.copy(prior.cameraPosition);
    input.camera.quaternion.copy(prior.cameraQuaternion);
    input.camera.updateProjectionMatrix();
    input.camera.updateMatrixWorld(true);
  };
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = look.toneMappingExposure;
  input.scene.add(candidate.root);
  const waterDebugMaterials: Array<Readonly<{
    mesh: THREE.Mesh;
    original: THREE.Material | THREE.Material[];
    debug: THREE.Material;
  }>> = [];
  if (input.waterDebug === "flat") candidate.root.traverse((object: THREE.Object3D) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || mesh.name !== "limina:generated-water-reach") return;
    const original = mesh.material;
    const debug = new THREE.MeshBasicMaterial({ color: 0x4aa6c2, transparent: true, opacity: 0.72,
      depthWrite: false, side: THREE.DoubleSide });
    mesh.material = debug;
    waterDebugMaterials.push(Object.freeze({ mesh, original, debug }));
  });
  let waterDebugRestored = false;
  const restoreWaterDebugMaterials = (): void => {
    if (waterDebugRestored) return;
    waterDebugRestored = true;
    const errors: unknown[] = [];
    for (const entry of waterDebugMaterials) {
      if (entry.mesh.material === entry.debug) entry.mesh.material = entry.original;
      try { entry.debug.dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "temperate fidelity water-debug material restoration failed");
  };
  input.scene.fog = new THREE.FogExp2(atmosphere.fogColor, atmosphere.fogDensity);
  input.camera.aspect = input.width / input.height;
  input.camera.near = 0.1;
  input.camera.far = 700;
  input.camera.fov = authored.fovDeg;
  input.camera.updateProjectionMatrix();
  const cameraGround = candidate.snapshot.terrain.sampleHeight(authored.position[0], authored.position[2]) ?? 0;
  const targetGround = candidate.snapshot.terrain.sampleHeight(authored.target[0], authored.target[2]) ?? 0;
  const high = shot.endsWith("-high");
  const bank = shot === "river-bank" || shot === "river-clearing" || shot === "river-leading-line";
  const eyeHeight = authored.eyeHeightM ?? (high ? 24 : bank ? 4 : 5.5);
  const targetHeight = authored.targetHeightM ?? (high ? 6 : bank ? 0.35 : 3);
  input.camera.position.set(authored.position[0], cameraGround + eyeHeight, authored.position[2]);
  input.camera.lookAt(authored.target[0], targetGround + targetHeight, authored.target[2]);

  const ecs = createEcsWorld();
  const gltfCache = input.gltfCache ?? new GltfSceneCache();
  const ownsGltfCache = input.gltfCache === undefined;
  gltfCache.beginWorld();
  const world: WorldContext = {
    ecs,
    transforms: createTransformStorage(ecs),
    entities: new EntityTable(),
    tags: new Map(),
    scene: input.scene,
    camera: input.camera,
    lods: [],
    ops: input.ops,
    renderer,
    mode: "windowed",
    gltfCache,
  };
  let population: Awaited<ReturnType<typeof mountDerivedBiomePopulation>> | undefined;
  let hdrCache: HdrEnvironmentCache | undefined = input.environmentCache;
  const ownsHdrCache = input.environmentCache === undefined;
  let hdr: ReturnType<HdrEnvironmentCache["acquire"]> | undefined;
  let post: PostPipeline | undefined;
  let sun: THREE.DirectionalLight | undefined;
  let hemisphere: THREE.HemisphereLight | undefined;
  try {
    await candidate.stagePopulation(async ({ plan, content, root, terrainWindow, biomeField, runtimePack, waterCoverageAt }) => {
      // deno-lint-ignore no-explicit-any
      const bundleField = bundle.manifest.globalArtifacts.find((entry: any) => entry.artifactType === "biome-field/v1");
      if (bundleField?.contentHash !== biomeField.contentHash || bundleField.byteLength !== biomeField.bytes.byteLength) {
        throw new Error("candidate biome field does not match the frozen runtime bundle");
      }
      if (bundle.runtimePack.contentHash !== runtimePack.semanticContentHash
          || bundle.runtimePack.byteLength !== runtimePack.bytes.byteLength
          || portableAssetContentHash(runtimePack.bytes) !== bundle.runtimePack.byteContentHash) {
        throw new Error("candidate runtime pack does not match the frozen runtime bundle");
      }
      population = await mountDerivedBiomePopulation({
        plan, content, root, terrainWindow, biomeField, runtimePack, waterCoverageAt,
        hardExclusionAt: input.populationHardExclusionAt, discreteHardExclusionAt: input.discretePopulationHardExclusionAt, world,
        camera: input.camera, quality: "cinematic", gltfCache, ops: input.ops,
        loadContent: async (entry, signal) => {
          if (signal.aborted) throw signal.reason;
          // deno-lint-ignore no-explicit-any
          const bundled = contentIndex.get(entry.assetId) as any;
          if (bundled === undefined || bundled.contentHash !== entry.contentHash
              || bundled.byteLength !== entry.byteLength || bundled.kind !== entry.kind) {
            throw new Error(`runtime bundle does not carry closure entry '${entry.assetId}' at ${entry.contentHash}`);
          }
          const bytes = await reader.readBytes(`assets/${bundled.assetId}`);
          if (signal.aborted) throw signal.reason;
          if (bytes.byteLength !== entry.byteLength || portableAssetContentHash(bytes) !== entry.contentHash) {
            throw new Error(`runtime bundle content '${entry.assetId}' failed byte identity verification`);
          }
          return { bytes };
        },
      });
      return population;
    });
    if (population === undefined) throw new Error("verified population mount did not publish");
    input.stageComplete?.("populationMount");
    candidate.root.traverse((object: THREE.Object3D) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = mesh.geometry?.userData?.derivedBiomeSurface !== true;
      mesh.receiveShadow = true;
    });
    sun = new THREE.DirectionalLight(look.sun.color, look.sun.intensity);
    sun.position.set(look.sun.position[0], look.sun.position[1], look.sun.position[2]);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.camera.left = -150;
    sun.shadow.camera.right = 150;
    sun.shadow.camera.top = 150;
    sun.shadow.camera.bottom = -150;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 400;
    sun.shadow.bias = -0.00025;
    hemisphere = new THREE.HemisphereLight(look.hemisphere.skyColor, look.hemisphere.groundColor, look.hemisphere.intensity);
    input.scene.add(sun, hemisphere);

    const hdrBytes = await reader.readBytes(FIDELITY_HDR_PATH);
    hdrCache ??= new HdrEnvironmentCache(renderer);
    hdr = hdrCache.acquire(FIDELITY_HDR_ASSET_ID, FIDELITY_HDR_HASH, hdrBytes);
    input.scene.environment = hdr.environment;
    input.scene.environmentIntensity = look.environmentIntensity;
    input.scene.background = hdr.background;
    input.scene.backgroundIntensity = look.backgroundIntensity;
    input.scene.backgroundBlurriness = 0.06;
    input.scene.backgroundRotation.y = look.environmentRotationY;
    input.scene.environmentRotation.y = look.environmentRotationY;
    input.stageComplete?.("lightingAndEnvironment");
    post = buildPostPipeline(renderer, input.scene, input.camera, sceneAuthority.presentation.post);
  } catch (error) {
    const rollback: unknown[] = [];
    try { post?.dispose(); } catch (cleanup) { rollback.push(cleanup); }
    try { input.scene.remove(candidate.root); } catch (cleanup) { rollback.push(cleanup); }
    try { restoreWaterDebugMaterials(); } catch (cleanup) { rollback.push(cleanup); }
    if (sun !== undefined) {
      try { input.scene.remove(sun); } catch (cleanup) { rollback.push(cleanup); }
      try { sun.dispose(); } catch (cleanup) { rollback.push(cleanup); }
    }
    if (hemisphere !== undefined) {
      try { input.scene.remove(hemisphere); } catch (cleanup) { rollback.push(cleanup); }
      try { hemisphere.dispose(); } catch (cleanup) { rollback.push(cleanup); }
    }
    try { candidate.dispose(); } catch (cleanup) { rollback.push(cleanup); }
    try { gltfCache.endWorld(); } catch (cleanup) { rollback.push(cleanup); }
    if (ownsGltfCache) try { await gltfCache.dispose(); } catch (cleanup) { rollback.push(cleanup); }
    try { restoreHostState(); } catch (cleanup) { rollback.push(cleanup); }
    try { hdr?.release(); } catch (cleanup) { rollback.push(cleanup); }
    if (ownsHdrCache) try { hdrCache?.dispose(); } catch (cleanup) { rollback.push(cleanup); }
    if (rollback.length > 0) throw new AggregateError([error, ...rollback], "temperate fidelity scene mount rollback failed");
    throw error;
  }

  const presentation = candidate.presentationStatus();
  const mountedPopulation = population;
  const metadata = Object.freeze({ manifestHash: bundle.manifest.manifestHash,
    terrain: candidate.terrainMeshCount, surfaces: chunks.length,
    placements: presentation.populationPlacements, canopy: mountedPopulation.canopyInstances,
    grassTiles: mountedPopulation.groundCoverTiles, grass: mountedPopulation.groundCoverBlades,
    shot, camera: Object.freeze(input.camera.position.toArray()),
    minimumResolution: Object.freeze([minimumWidth, minimumHeight] as const) });
  let disposed = false;
  return Object.freeze({ bundle, sceneAuthority, candidate, world, post, population: mountedPopulation, metadata,
    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      try { post!.dispose(); } catch (error) { errors.push(error); }
      try { input.scene.remove(candidate.root); } catch (error) { errors.push(error); }
      try { restoreWaterDebugMaterials(); } catch (error) { errors.push(error); }
      if (sun !== undefined) {
        try { input.scene.remove(sun); } catch (error) { errors.push(error); }
        try { sun.dispose(); } catch (error) { errors.push(error); }
      }
      if (hemisphere !== undefined) {
        try { input.scene.remove(hemisphere); } catch (error) { errors.push(error); }
        try { hemisphere.dispose(); } catch (error) { errors.push(error); }
      }
      try { candidate.dispose(); } catch (error) { errors.push(error); }
      try { gltfCache.endWorld(); } catch (error) { errors.push(error); }
      if (ownsGltfCache) try { await gltfCache.dispose(); } catch (error) { errors.push(error); }
      try { restoreHostState(); } catch (error) { errors.push(error); }
      try { hdr!.release(); } catch (error) { errors.push(error); }
      if (ownsHdrCache) try { hdrCache!.dispose(); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, "temperate fidelity scene disposal failed");
    } });
}
