/** Production Three/TSL projection of the authoritative staged-building fire runtime.
 *
 * The binding owns render resources only. Animation reads mutable uniforms populated exclusively
 * by BuildingFireLightSample; it never reads TSL time, performance.now(), Date.now(), or random.
 * Fuel geometry remains a separately pinned GLB owned by the V1 package/review mount.
 */

import * as THREE from "../../build/three.bundle.mjs";
import { BUILDING_FIRE_TICK_HZ, type BuildingFireLightSample, type BuildingFireRuntimeBinding } from "./building-fire-runtime.ts";
import { createBuildingFireVolume, type BuildingFireVolume, type BuildingFireVolumeContract } from "./building-fire-volumetric.ts";

// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;
const TWO_PI = Math.PI * 2;

type V3 = readonly [number, number, number];

interface FireSocket { readonly id: string; readonly kind: string; readonly position: V3 }
interface FireBox { readonly center: V3; readonly halfExtents: V3 }
interface FlameLayer {
  readonly id: string; readonly region: "inner" | "outer"; readonly socketId: string;
  readonly geometry: "ribbon-stack"; readonly ribbonCount: number; readonly segments: number;
  readonly heightM: number; readonly widthM: number; readonly phase01: number;
  readonly deformation: Readonly<{ frequencyHz: number; lateralAmplitudeM: number; heightAmplitudeM: number; noiseOctaves: number }>;
}
interface SmokeContract {
  readonly enabled: boolean; readonly socketId?: string; readonly particleCount?: number;
  readonly lifespanSeconds?: number; readonly riseMps?: number; readonly maxOpacity?: number;
  readonly flueTraversalClaim: false; readonly absorbBeforeThroat: true;
}
interface FuelCoal {
  readonly id: string; readonly socketId: string; readonly materialRole: "hearth-embers";
  readonly offset: V3; readonly halfExtents: V3; readonly emission01: number;
}
export interface BuildingFireRenderContract {
  readonly packageId: string;
  readonly revision: number;
  readonly shellInterface: Readonly<{
    readonly containment: FireBox; readonly flue: FireBox; readonly sockets: readonly FireSocket[];
  }>;
  readonly fuelAsset: Readonly<{
    readonly runtimeGlb: Readonly<{ path: string; sha256: string; assetId: string }>;
    readonly coals: readonly FuelCoal[];
    readonly emberBed: Readonly<{ socketId: string; halfExtents: V3 }>;
  }>;
  readonly visuals: Readonly<{
    readonly flameLayers: readonly FlameLayer[];
    readonly embers: Readonly<{ socketId: string; pulseFrequencyHz: number; pulseAmplitude01: number }>;
    readonly smoke: SmokeContract;
  }> | Readonly<{
    readonly flameVolume: BuildingFireVolumeContract;
    readonly embers: Readonly<{ socketId: string; pulseFrequencyHz: number; pulseAmplitude01: number }>;
    readonly smoke: SmokeContract;
  }>;
  readonly light: Readonly<{
    readonly socketId: string; readonly colorPolicy: "building-fire-runtime-warm-flicker-srgb";
    readonly baseCandela: number; readonly flickerAmplitudeCandela: number;
    readonly distanceM: number; readonly decay: 2; readonly castsShadow: boolean;
  }>;
  readonly simulation: Readonly<{
    readonly tickHz: 60; readonly seed: number;
    readonly parameters: Readonly<{ readonly ignitionTicks: number; readonly extinguishTicks: number;
      readonly lightBaseCandela: number; readonly lightFlickerCandela: number;
      readonly lightDistanceM: number; readonly lightDecay: 2 }>;
  }>;
  readonly budgets: Readonly<{
    readonly maxDrawCalls: number; readonly maxTriangles: number; readonly maxParticles: number;
    readonly maxOwnedLights: number; readonly maxOwnedMaterials: number; readonly timestampQueriesEnabled: false;
    readonly maxVolumeDrawCalls?: number; readonly maxVolumeProxyTriangles?: number;
    readonly maxRaymarchSteps?: number; readonly maxNoiseOctaves?: number;
    readonly maxVolumeTextures?: number; readonly maxVolumeTextureBytes?: number;
    readonly maxFragmentNoiseSamplesPerCoveredPixel?: number;
  }>;
}

export interface BuildingFireRenderInventory {
  readonly flameLayers: number;
  readonly flameRibbons: number;
  readonly flameVolumes: number;
  readonly flameRepresentation: "ribbon-stack" | "three-fire-derived-volume-raymarch/v1";
  readonly volumeProxyTriangles: number;
  readonly fragmentWorkPerCoveredPixel: number;
  readonly volumeTextures: number;
  readonly emberGlowCores: number;
  readonly emberGlowGeometry: "irregular-instanced-coals";
  readonly smokeParticles: number;
  readonly ownedGeometries: number;
  readonly ownedMaterials: number;
  readonly ownedLights: 1;
  readonly predictedDrawCalls: number;
  readonly triangles: number;
  readonly smokeMaximumWorldY: number | null;
  readonly smokeFlueTraversalClaim: false;
}

export interface BuildingFireRenderBinding extends BuildingFireRuntimeBinding {
  readonly root: THREE.Group;
  readonly light: THREE.PointLight;
  readonly inventory: Readonly<BuildingFireRenderInventory>;
  readonly disposed: boolean;
  readonly visible: boolean;
  setVisible(visible: boolean): void;
}

interface ParentLike { add(child: THREE.Object3D): void; remove(child: THREE.Object3D): void }
export interface CreateBuildingFireRenderBindingInput {
  readonly parent: ParentLike;
  readonly contract: BuildingFireRenderContract;
}

interface AuthorityUniforms {
  // TSL is exposed dynamically by the pinned Three bundle; its fluent Node type is not present in
  // the public `three` declaration surface, while `.value` remains the intentional CPU write seam.
  // deno-lint-ignore no-explicit-any
  readonly time: any;
  // deno-lint-ignore no-explicit-any
  readonly envelope: any;
}

function finite(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be finite in [${minimum}, ${maximum}]`);
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value as number;
}

function socketMap(contract: BuildingFireRenderContract): Map<string, FireSocket> {
  const sockets = new Map<string, FireSocket>();
  for (const socket of contract.shellInterface.sockets) {
    if (sockets.has(socket.id)) throw new Error(`duplicate fire render socket ${socket.id}`);
    if (!Array.isArray(socket.position) || socket.position.length !== 3 || socket.position.some((entry) => !Number.isFinite(entry))) {
      throw new Error(`fire render socket ${socket.id} has an invalid position`);
    }
    sockets.set(socket.id, socket);
  }
  return sockets;
}

function requiredSocket(sockets: ReadonlyMap<string, FireSocket>, id: string, kind: string): FireSocket {
  const socket = sockets.get(id);
  if (socket?.kind !== kind) throw new Error(`fire render socket ${id} must resolve to ${kind}`);
  return socket;
}

function contains(box: FireBox, point: V3, radius: V3 = [0, 0, 0]): boolean {
  return point.every((coordinate, axis) => Math.abs(coordinate - box.center[axis]) + radius[axis] <= box.halfExtents[axis] + 1e-6);
}

function geometryTriangles(geometry: THREE.BufferGeometry): number {
  const count = geometry.index?.count ?? geometry.getAttribute("position").count;
  return Math.floor(count / 3);
}

function ribbonGeometry(layer: FlameLayer): THREE.BufferGeometry {
  integer(layer.ribbonCount, 2, 8, `${layer.id}.ribbonCount`);
  integer(layer.segments, 5, 24, `${layer.id}.segments`);
  const positions: number[] = [], shapes: number[] = [], deformations: number[] = [];
  const laterals: number[] = [], indices: number[] = [];
  for (let ribbon = 0; ribbon < layer.ribbonCount; ribbon++) {
    const angle = (ribbon / layer.ribbonCount) * Math.PI + layer.phase01 * Math.PI * 0.37;
    const widthX = Math.cos(angle), widthZ = Math.sin(angle), lateralX = -widthZ, lateralZ = widthX;
    const ribbonPhase = (layer.phase01 + ribbon / layer.ribbonCount) % 1;
    const base = positions.length / 3;
    for (let segment = 0; segment <= layer.segments; segment++) {
      const height01 = segment / layer.segments, halfWidth = layer.widthM * 0.5 * (1 - height01 * 0.78);
      for (const side of [-1, 1]) {
        positions.push(widthX * halfWidth * side, layer.heightM * height01, widthZ * halfWidth * side);
        shapes.push(height01, side, ribbonPhase, layer.deformation.frequencyHz);
        deformations.push(layer.deformation.lateralAmplitudeM, layer.deformation.heightAmplitudeM,
          layer.deformation.noiseOctaves, 0);
        laterals.push(lateralX, 0, lateralZ);
      }
    }
    for (let segment = 0; segment < layer.segments; segment++) {
      const a = base + segment * 2, b = a + 1, c = a + 2, d = a + 3;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("fireShape", new THREE.Float32BufferAttribute(shapes, 4));
  geometry.setAttribute("fireDeformation", new THREE.Float32BufferAttribute(deformations, 4));
  geometry.setAttribute("fireLateral", new THREE.Float32BufferAttribute(laterals, 3));
  geometry.setIndex(indices); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

function flameMaterial(region: "inner" | "outer", authority: AuthorityUniforms): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: region === "inner" ? THREE.AdditiveBlending : THREE.NormalBlending });
  const shape = T.attribute("fireShape", "vec4"), deformation = T.attribute("fireDeformation", "vec4");
  const height = shape.x, side = shape.y, phase = shape.z, frequency = shape.w;
  const lateralAmplitude = deformation.x, heightAmplitude = deformation.y, octaveCount = deformation.z;
  const lateral = T.attribute("fireLateral", "vec3");
  const cycle = authority.time.mul(frequency).add(phase).add(height.mul(0.31));
  let noise = T.float(0), weight = 0.58, scale = 1;
  for (let octave = 0; octave < 5; octave++) {
    const coordinate = T.vec3(T.positionLocal.x.mul(scale * 3.1).add(phase.mul(7.3)), height.mul(scale * 2.4), cycle.mul(scale));
    const enabled = T.step(T.float(octave + 0.5), octaveCount);
    noise = noise.add(T.mx_noise_float(coordinate).mul(weight).mul(enabled));
    scale *= 1.91; weight *= 0.51;
  }
  const carrier = cycle.mul(TWO_PI).sin().mul(0.42).add(noise.mul(0.58));
  const bend = lateral.mul(carrier.mul(lateralAmplitude).mul(height.mul(height)));
  const lift = cycle.mul(TWO_PI * 0.71).sin().mul(heightAmplitude).mul(height).mul(T.oneMinus(height)).mul(0.42);
  material.positionNode = T.positionLocal.add(bend).add(T.vec3(0, lift, 0));
  const edge = T.oneMinus(T.abs(side).pow(5)), baseFade = T.smoothstep(0, 0.08, height), tipFade = T.oneMinus(T.smoothstep(0.68, 1, height));
  const breakup = T.clamp(noise.mul(0.22).add(0.82), 0.45, 1);
  material.opacityNode = authority.envelope.mul(edge).mul(baseFade).mul(tipFade).mul(breakup)
    .mul(region === "inner" ? 0.92 : 0.72);
  const bottom = region === "inner" ? T.vec3(2.3, 0.82, 0.09) : T.vec3(1.55, 0.18, 0.012);
  const top = region === "inner" ? T.vec3(1.75, 0.22, 0.015) : T.vec3(0.92, 0.025, 0.004);
  material.colorNode = T.mix(bottom, top, T.smoothstep(0.08, 0.95, height)).mul(authority.envelope);
  material.toneMapped = true;
  material.userData.liminaFireRegion = region;
  material.userData.liminaAuthoritativeTimeOnly = true;
  return material;
}

function emberMaterial(contract: BuildingFireRenderContract, authority: AuthorityUniforms): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x210702, roughness: 0.72, metalness: 0 });
  const pulse = authority.time.mul(contract.visuals.embers.pulseFrequencyHz * TWO_PI).sin().mul(0.5).add(0.5);
  const authoredEmission = T.attribute("fireCoalEmission01", "float");
  const gain = authoredEmission.mul(T.float(0.22).add(pulse.mul(contract.visuals.embers.pulseAmplitude01))).mul(authority.envelope);
  material.emissiveNode = T.vec3(.44, .026, .002).mul(gain);
  material.userData.liminaFireMaterial = "embers/v1";
  material.userData.liminaAuthoritativeTimeOnly = true;
  return material;
}

function coalGlowGeometry(): THREE.DodecahedronGeometry {
  const geometry = new THREE.DodecahedronGeometry(1, 0), positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  // Break the shared Platonic silhouette deterministically without introducing per-frame state.
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
    const distortion = 0.82 + (((index * 37 + 11) % 17) / 16) * 0.25;
    positions.setXYZ(index, x * distortion, y * (0.76 + ((index * 13) % 9) / 30), z * (1.04 - (distortion - 0.82) * 0.35));
  }
  positions.needsUpdate = true; geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData.liminaGeometry = "irregular-low-poly-coal-core/v1";
  return geometry;
}

function stableCoalRotation(id: string): V3 {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619) >>> 0;
  return [((hash & 255) / 255 - 0.5) * 0.7, (((hash >>> 8) & 255) / 255) * Math.PI,
    (((hash >>> 16) & 255) / 255 - 0.5) * 0.55];
}

function smokeGeometry(count: number, seed: number): THREE.BufferGeometry {
  const positions: number[] = [], phases: number[] = [], drifts: number[] = [], indices: number[] = [];
  const hash01 = (value: number): number => { let h = value | 0; h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); return ((h ^ (h >>> 16)) >>> 0) / 0x1_0000_0000; };
  for (let index = 0; index < count; index++) {
    const phase = (index + hash01(seed ^ index)) / count, angle = hash01(seed ^ (index * 17 + 3)) * Math.PI;
    const width = 0.055 + hash01(seed ^ (index * 31 + 7)) * 0.07, height = width * 1.35;
    const cx = (hash01(seed ^ (index * 43 + 11)) - 0.5) * 0.3, cz = (hash01(seed ^ (index * 59 + 13)) - 0.5) * 0.22;
    const dx = Math.cos(angle) * width, dz = Math.sin(angle) * width, base = positions.length / 3;
    positions.push(cx - dx, -height, cz - dz, cx + dx, -height, cz + dz, cx - dx, height, cz - dz, cx + dx, height, cz + dz);
    for (let vertex = 0; vertex < 4; vertex++) { phases.push(phase); drifts.push(Math.cos(angle + Math.PI / 2), 0, Math.sin(angle + Math.PI / 2)); }
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("smokePhase01", new THREE.Float32BufferAttribute(phases, 1));
  geometry.setAttribute("smokeDrift", new THREE.Float32BufferAttribute(drifts, 3)); geometry.setIndex(indices);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere(); return geometry;
}

function smokeMaterial(smoke: Required<Pick<SmokeContract, "lifespanSeconds" | "maxOpacity">>, maxRiseM: number,
  authority: AuthorityUniforms): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({ color: 0x292723, transparent: true, depthWrite: false,
    side: THREE.DoubleSide, blending: THREE.NormalBlending });
  const phase = T.attribute("smokePhase01", "float"), drift = T.attribute("smokeDrift", "vec3");
  const progress = authority.time.div(smoke.lifespanSeconds).add(phase).fract();
  const lateral = progress.mul(TWO_PI).add(phase.mul(7.1)).sin().mul(0.055).mul(progress);
  material.positionNode = T.positionLocal.add(T.vec3(0, progress.mul(maxRiseM), 0)).add(drift.mul(lateral));
  const lifeFade = T.smoothstep(0, 0.16, progress).mul(T.oneMinus(T.smoothstep(0.58, 1, progress)));
  material.opacityNode = authority.envelope.mul(smoke.maxOpacity).mul(lifeFade);
  material.colorNode = T.mix(T.vec3(0.08, 0.075, 0.065), T.vec3(0.19, 0.18, 0.16), progress);
  material.toneMapped = true;
  material.userData.liminaFireMaterial = "bounded-smoke/v1";
  material.userData.liminaAuthoritativeTimeOnly = true;
  material.userData.liminaFlueTraversalClaim = false;
  material.userData.liminaAbsorbBeforeThroat = true;
  return material;
}

export function createBuildingFireRenderBinding(input: CreateBuildingFireRenderBindingInput): BuildingFireRenderBinding {
  if (input.parent === null || typeof input.parent?.add !== "function" || typeof input.parent?.remove !== "function") {
    throw new TypeError("building fire render parent must expose add/remove");
  }
  const contract = input.contract, sockets = socketMap(contract), containment = contract.shellInterface.containment;
  if (contract.simulation.tickHz !== BUILDING_FIRE_TICK_HZ) throw new Error("fire render contract tick authority does not match BuildingFireRuntime");
  if (contract.budgets.timestampQueriesEnabled !== false) throw new Error("fire render binding prohibits timestamp queries");
  if (contract.budgets.maxOwnedLights !== 1) throw new Error("fire render binding requires exactly one bounded owned light");
  const authority: AuthorityUniforms = { time: T.uniform(0), envelope: T.uniform(0) };
  const root = new THREE.Group(); root.name = "limina:building-fire-v1";
  root.userData.liminaAuthoritativeTickHz = BUILDING_FIRE_TICK_HZ;
  root.userData.liminaSmokeFlueTraversalClaim = false;
  root.userData.liminaAuthoritativeEnvelope = 0;
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  let light: THREE.PointLight | undefined, smokeMaximumWorldY: number | null = null, flameRibbons = 0;
  let volume: BuildingFireVolume | undefined;
  try {
    if ("flameVolume" in contract.visuals) {
      const selected = contract.visuals.flameVolume, socket = requiredSocket(sockets, selected.socketId, "flame");
      const center = socket.position.map((coordinate, axis) => coordinate + selected.centerOffsetM[axis]) as unknown as V3;
      if (!contains(containment, center, selected.halfExtentsM)) throw new Error("volumetric fire escapes firebox containment");
      volume = createBuildingFireVolume({ contract: selected, socketPosition: socket.position, simulationSeed: contract.simulation.seed });
      if (contract.budgets.maxVolumeDrawCalls !== 1 || contract.budgets.maxVolumeProxyTriangles !== volume.triangles
          || contract.budgets.maxVolumeTextures !== 1 || volume.fragmentWorkPerCoveredPixel > (contract.budgets.maxFragmentNoiseSamplesPerCoveredPixel ?? 0)) {
        throw new Error("volumetric fire construction exceeds its dedicated structural budget");
      }
      root.add(volume.mesh);
    } else {
      const inner = flameMaterial("inner", authority), outer = flameMaterial("outer", authority); materials.add(inner); materials.add(outer);
      for (const layer of contract.visuals.flameLayers) {
        if (layer.geometry !== "ribbon-stack") throw new Error(`fire layer ${layer.id} is not a production ribbon stack`);
        const socket = requiredSocket(sockets, layer.socketId, "flame");
        const horizontal = layer.widthM * 0.5 + layer.deformation.lateralAmplitudeM;
        const radius: V3 = [horizontal, layer.heightM + layer.deformation.heightAmplitudeM, horizontal];
        const upperCenter: V3 = [socket.position[0], socket.position[1] + radius[1] * 0.5, socket.position[2]];
        if (!contains(containment, upperCenter, [radius[0], radius[1] * 0.5, radius[2]])) throw new Error(`fire layer ${layer.id} escapes firebox containment`);
        const geometry = ribbonGeometry(layer); geometries.add(geometry);
        const mesh = new THREE.Mesh(geometry, layer.region === "inner" ? inner : outer); mesh.name = `limina:${layer.id}`;
        mesh.position.set(...socket.position); mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
        mesh.renderOrder = layer.region === "inner" ? 21 : 20; mesh.userData.liminaSemanticId = layer.id; root.add(mesh);
        flameRibbons += layer.ribbonCount;
      }
    }
    const emberSocket = requiredSocket(sockets, contract.visuals.embers.socketId, "ember");
    if (!Array.isArray(contract.fuelAsset.coals) || contract.fuelAsset.coals.length < 1) throw new Error("dynamic ember glow requires authored fuel coals");
    const emberGeometry = coalGlowGeometry();
    const emberMat = emberMaterial(contract, authority); geometries.add(emberGeometry); materials.add(emberMat);
    const ember = new THREE.InstancedMesh(emberGeometry, emberMat, contract.fuelAsset.coals.length);
    const coalEmission = new THREE.InstancedBufferAttribute(new Float32Array(contract.fuelAsset.coals.length), 1);
    emberGeometry.setAttribute("fireCoalEmission01", coalEmission);
    const coalIds = new Set<string>(), transform = new THREE.Object3D();
    for (const [index, coal] of contract.fuelAsset.coals.entries()) {
      if (coalIds.has(coal.id)) throw new Error(`duplicate dynamic ember coal ${coal.id}`); coalIds.add(coal.id);
      const socket = requiredSocket(sockets, coal.socketId, "ember");
      if (socket.id !== emberSocket.id || coal.materialRole !== "hearth-embers") throw new Error(`dynamic ember coal ${coal.id} authority drifted`);
      const half = coal.halfExtents.map((value: number, axis: number) => finite(value, 0.005, 0.14, `${coal.id}.halfExtents[${axis}]`)) as unknown as V3;
      const offset = coal.offset.map((value: number, axis: number) => finite(value, -0.7, 0.7, `${coal.id}.offset[${axis}]`)) as unknown as V3;
      const center: V3 = [socket.position[0] + offset[0], socket.position[1] + offset[1], socket.position[2] + offset[2]];
      if (!contains(containment, center, half)) throw new Error(`dynamic ember coal ${coal.id} escapes firebox containment`);
      transform.position.set(...offset); transform.rotation.set(...stableCoalRotation(coal.id)); transform.scale.set(...half);
      transform.updateMatrix(); ember.setMatrixAt(index, transform.matrix); coalEmission.setX(index, finite(coal.emission01, 0, 1, `${coal.id}.emission01`));
    }
    ember.instanceMatrix.needsUpdate = true; coalEmission.needsUpdate = true; ember.computeBoundingBox(); ember.computeBoundingSphere();
    ember.name = "limina:fire-irregular-coal-glow-cores"; ember.position.set(...emberSocket.position);
    ember.castShadow = false; ember.receiveShadow = false; ember.userData.liminaDynamicEmberGlow = true;
    ember.userData.liminaNoMoundOrBoxGlow = true; root.add(ember);

    const smoke = contract.visuals.smoke;
    if (smoke.enabled) {
      const count = integer(smoke.particleCount, 1, contract.budgets.maxParticles, "fire smoke particleCount");
      const lifespan = finite(smoke.lifespanSeconds, 0.1, 30, "fire smoke lifespanSeconds");
      const rise = finite(smoke.riseMps, 0.01, 3, "fire smoke riseMps");
      const maxOpacity = finite(smoke.maxOpacity, 0.001, 0.3, "fire smoke maxOpacity");
      if (smoke.flueTraversalClaim !== false || smoke.absorbBeforeThroat !== true) throw new Error("fire smoke cannot claim unaudited flue traversal");
      const smokeSocket = requiredSocket(sockets, smoke.socketId!, "smoke"), flueBottom = contract.shellInterface.flue.center[1] - contract.shellInterface.flue.halfExtents[1];
      const containmentTop = containment.center[1] + containment.halfExtents[1], particleHalfHeight = 0.17;
      const maximumRise = Math.min(rise * lifespan, flueBottom - smokeSocket.position[1] - particleHalfHeight - 0.03,
        containmentTop - smokeSocket.position[1] - particleHalfHeight - 0.01);
      if (!(maximumRise > 0.02)) throw new Error("fire smoke lacks bounded space to fade before the throat");
      smokeMaximumWorldY = smokeSocket.position[1] + particleHalfHeight + maximumRise;
      if (smokeMaximumWorldY >= flueBottom) throw new Error("fire smoke reaches the unaudited flue entry");
      const geometry = smokeGeometry(count, contract.simulation.seed), material = smokeMaterial({ lifespanSeconds: lifespan, maxOpacity }, maximumRise, authority);
      geometries.add(geometry); materials.add(material); const mesh = new THREE.Mesh(geometry, material);
      mesh.name = "limina:fire-bounded-smoke"; mesh.position.set(...smokeSocket.position); mesh.frustumCulled = false;
      mesh.castShadow = false; mesh.receiveShadow = false; mesh.renderOrder = 22;
      mesh.userData.liminaParticleCount = count; mesh.userData.liminaMaximumWorldY = smokeMaximumWorldY;
      mesh.userData.liminaFlueTraversalClaim = false; mesh.userData.liminaAbsorbBeforeThroat = true; root.add(mesh);
    }

    const lightSocket = requiredSocket(sockets, contract.light.socketId, "light");
    if (contract.light.colorPolicy !== "building-fire-runtime-warm-flicker-srgb") {
      throw new Error("fire light must use the authoritative runtime warm-flicker sRGB color policy");
    }
    const peakCandela = finite(contract.light.baseCandela, 1, 8, "fire light baseCandela")
      + finite(contract.light.flickerAmplitudeCandela, 0, 0.48, "fire light flickerAmplitudeCandela");
    if (peakCandela > 8 || contract.light.flickerAmplitudeCandela > contract.light.baseCandela * 0.06) {
      throw new Error("fire light escapes the 8 cd / 6% authority");
    }
    const distanceM = finite(contract.light.distanceM, 1.5, 8, "fire light distanceM");
    if (contract.light.decay !== 2) throw new Error("fire light decay must equal 2");
    // Color is deliberately dark until the first authoritative runtime sample supplies its sRGB
    // value. The contract owns the policy; the runtime owns the color at every sampled tick.
    light = new THREE.PointLight(new THREE.Color(0, 0, 0), 0, distanceM, contract.light.decay);
    light.name = "limina:fire-point-light"; light.position.set(...lightSocket.position); light.castShadow = contract.light.castsShadow;
    light.shadow.mapSize.set(512, 512); light.shadow.camera.near = 0.05; light.shadow.camera.far = distanceM;
    light.userData.liminaMaximumCandela = peakCandela; light.userData.liminaAuthoritativeTickOnly = true; root.add(light);

    const triangleCount = [...geometries].reduce((sum, geometry) => sum + geometryTriangles(geometry), 0) + (volume?.triangles ?? 0);
    const flameLayerCount = "flameLayers" in contract.visuals ? contract.visuals.flameLayers.length : 0;
    const predictedDrawCalls = (volume === undefined ? flameLayerCount : 1) + 1 + (smoke.enabled ? 1 : 0);
    const ownedMaterialCount = materials.size + (volume === undefined ? 0 : 1), ownedGeometryCount = geometries.size + (volume === undefined ? 0 : 1);
    if (predictedDrawCalls > contract.budgets.maxDrawCalls || triangleCount > contract.budgets.maxTriangles
      || ownedMaterialCount > contract.budgets.maxOwnedMaterials) throw new Error("fire render construction exceeds declared draw, triangle, or material budget");
    const inventory = Object.freeze({ flameLayers: flameLayerCount, flameRibbons, flameVolumes: volume === undefined ? 0 : 1,
      flameRepresentation: volume === undefined ? "ribbon-stack" as const : "three-fire-derived-volume-raymarch/v1" as const,
      volumeProxyTriangles: volume?.triangles ?? 0, fragmentWorkPerCoveredPixel: volume?.fragmentWorkPerCoveredPixel ?? 0,
      volumeTextures: volume === undefined ? 0 : 1,
      emberGlowCores: contract.fuelAsset.coals.length, emberGlowGeometry: "irregular-instanced-coals" as const,
      smokeParticles: smoke.enabled ? smoke.particleCount! : 0, ownedGeometries: ownedGeometryCount,
      ownedMaterials: ownedMaterialCount, ownedLights: 1 as const, predictedDrawCalls, triangles: triangleCount,
      smokeMaximumWorldY, smokeFlueTraversalClaim: false as const });
    input.parent.add(root);
    let disposed = false, visible = true, latest: Readonly<BuildingFireLightSample> | undefined;
    const live = (): void => { if (disposed) throw new Error("building fire render binding is disposed"); };
    const binding: BuildingFireRenderBinding = {
      root, light, inventory,
      get disposed() { return disposed; }, get visible() { return visible; },
      apply(value) {
        live();
        integer(value.tick, 0, Number.MAX_SAFE_INTEGER, "fire render sample tick");
        if (Math.abs(value.authoritativeTimeSeconds - value.tick / BUILDING_FIRE_TICK_HZ) > 1e-12) throw new Error("fire render sample time is not authoritative tick time");
        finite(value.envelope, 0, 1, "fire render sample envelope"); finite(value.flicker01, 0, 1, "fire render sample flicker");
        const maximum = contract.light.baseCandela + contract.light.flickerAmplitudeCandela;
        finite(value.intensityCandela, 0, maximum + 1e-9, "fire render sample intensityCandela");
        if (value.distanceM !== contract.light.distanceM || value.decay !== contract.light.decay) {
          throw new Error("fire render sample light distance or decay drifted from contract");
        }
        if (!Array.isArray(value.colorSrgb) || value.colorSrgb.length !== 3) throw new Error("fire render sample colorSrgb must contain three channels");
        for (const channel of value.colorSrgb) finite(channel, 0, 1, "fire render sample colorSrgb channel");
        authority.time.value = value.authoritativeTimeSeconds; authority.envelope.value = value.envelope;
        volume?.update(value.authoritativeTimeSeconds, value.envelope);
        root.userData.liminaAuthoritativeEnvelope = value.envelope;
        light!.color.setRGB(value.colorSrgb[0], value.colorSrgb[1], value.colorSrgb[2], THREE.SRGBColorSpace);
        light!.intensity = value.intensityCandela; light!.distance = value.distanceM; light!.decay = value.decay;
        latest = value; light!.visible = visible && value.intensityCandela > 0;
      },
      setVisible(next) { live(); if (typeof next !== "boolean") throw new TypeError("fire render visibility must be boolean");
        visible = next; root.visible = next; light!.visible = next && (latest?.intensityCandela ?? 0) > 0; },
      dispose() {
        if (disposed) return; disposed = true; input.parent.remove(root); root.remove(...root.children);
        volume?.dispose(); for (const geometry of geometries) geometry.dispose(); for (const material of materials) material.dispose(); light!.dispose();
        geometries.clear(); materials.clear(); latest = undefined;
      },
    };
    return Object.freeze(binding);
  } catch (error) {
    const failures: unknown[] = [error];
    input.parent.remove(root); root.remove(...root.children);
    try { volume?.dispose(); } catch (cleanup) { failures.push(cleanup); }
    for (const geometry of geometries) try { geometry.dispose(); } catch (cleanup) { failures.push(cleanup); }
    for (const material of materials) try { material.dispose(); } catch (cleanup) { failures.push(cleanup); }
    try { light?.dispose(); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, "fire render binding construction and rollback failed");
    throw error;
  }
}
