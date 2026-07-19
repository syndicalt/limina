import { canonicalStringify } from "../authoring/canonical.ts";
import { sha256 } from "../world/sha256.mjs";
import { validateBuildingFireRuntimeV1 } from "./building-fire-runtime-v1.mjs";

export const BUILDING_FIRE_RUNTIME_V2_SCHEMA = "limina.building-fire-runtime/v2";
const ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;

function fail(label, message) { throw new TypeError(`${label} ${message}`); }
function object(value, label) { if (value === null || typeof value !== "object" || Array.isArray(value)) fail(label, "must be an object"); return value; }
function exact(value, keys, label) { const allowed = new Set(keys); for (const key of keys) if (!(key in value)) fail(`${label}.${key}`, "is required"); for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label}.${key}`, "is unsupported"); }
function number(value, label, min, max) { if (!Number.isFinite(value) || value < min || value > max) fail(label, `must be within [${min}, ${max}]`); return value; }
function integer(value, label, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(label, `must be an integer within [${min}, ${max}]`); return value; }
function tuple(value, length, label, min, max) { if (!Array.isArray(value) || value.length !== length) fail(label, `must contain exactly ${length} numbers`); value.forEach((entry, index) => number(entry, `${label}[${index}]`, min, max)); return value; }
function deepFreeze(value) { if (value !== null && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }

function validateVolume(raw, contract) {
  const value = object(raw, "visuals.flameVolume");
  exact(value, ["id", "socketId", "representation", "geometry", "materialRole", "technique", "centerOffsetM", "halfExtentsM",
    "iterations", "noiseOctaves", "noiseScale", "magnitude", "lacunarity", "gain", "densityTextureResolution",
    "densityProfile", "timeAuthority", "seedAuthority", "depthTest", "depthWrite"], "visuals.flameVolume");
  if (typeof value.id !== "string" || !ID.test(value.id)) fail("visuals.flameVolume.id", "must be a stable lowercase id");
  const socket = contract.shellInterface.sockets.find((entry) => entry.id === value.socketId);
  if (socket?.kind !== "flame") fail("visuals.flameVolume.socketId", "must resolve to the flame socket");
  if (value.representation !== "three-fire-derived-volume-raymarch/v1" || value.geometry !== "volumetric-raymarch-box" || value.materialRole !== "flame-volume") fail("visuals.flameVolume", "must use the selected THREE.Fire-derived volumetric representation");
  const technique = object(value.technique, "visuals.flameVolume.technique"); exact(technique, ["upstream", "version", "license", "adaptation"], "visuals.flameVolume.technique");
  if (technique.upstream !== "typeWolffo/THREE.Fire" || technique.version !== "1.4.0" || technique.license !== "MIT" || technique.adaptation !== "deterministic-limina-tsl/v1") fail("visuals.flameVolume.technique", "must pin the audited upstream and deterministic adaptation");
  tuple(value.centerOffsetM, 3, "visuals.flameVolume.centerOffsetM", -.8, .8); tuple(value.halfExtentsM, 3, "visuals.flameVolume.halfExtentsM", .03, .8);
  const center = socket.position.map((coordinate, axis) => coordinate + value.centerOffsetM[axis]);
  const containment = contract.shellInterface.containment;
  if (center.some((coordinate, axis) => Math.abs(coordinate - containment.center[axis]) + value.halfExtentsM[axis] > containment.halfExtents[axis] + 1e-6)) fail("visuals.flameVolume", "must fit inside audited firebox containment");
  integer(value.iterations, "visuals.flameVolume.iterations", 8, 32); integer(value.noiseOctaves, "visuals.flameVolume.noiseOctaves", 1, 5);
  tuple(value.noiseScale, 4, "visuals.flameVolume.noiseScale", .01, 8); number(value.magnitude, "visuals.flameVolume.magnitude", .5, 3); number(value.lacunarity, "visuals.flameVolume.lacunarity", 1, 4); number(value.gain, "visuals.flameVolume.gain", .1, 1);
  tuple(value.densityTextureResolution, 2, "visuals.flameVolume.densityTextureResolution", 32, 512);
  value.densityTextureResolution.forEach((entry, index) => integer(entry, `visuals.flameVolume.densityTextureResolution[${index}]`, 32, 512));
  if (value.densityProfile !== "analytic-radial-height/v1" || value.timeAuthority !== "explicit-runtime-tick-uniform" || value.seedAuthority !== "simulation-seed" || value.depthTest !== true || value.depthWrite !== false) fail("visuals.flameVolume", "violates deterministic density, temporal, or depth authority");
  return value;
}

function validateBudgets(raw, volume) {
  const value = object(raw, "budgets"); exact(value, ["maxDrawCalls", "maxTriangles", "maxParticles", "maxCpuUpdateMsP95", "maxOwnedLights", "maxOwnedMaterials", "timestampQueriesEnabled", "maxVolumeDrawCalls", "maxVolumeProxyTriangles", "maxRaymarchSteps", "maxNoiseOctaves", "maxVolumeTextures", "maxVolumeTextureBytes", "maxFragmentNoiseSamplesPerCoveredPixel"], "budgets");
  integer(value.maxDrawCalls, "budgets.maxDrawCalls", 2, 16); integer(value.maxTriangles, "budgets.maxTriangles", 100, 50_000); integer(value.maxParticles, "budgets.maxParticles", 8, 256); number(value.maxCpuUpdateMsP95, "budgets.maxCpuUpdateMsP95", .01, 2);
  if (value.maxOwnedLights !== 1 || value.timestampQueriesEnabled !== false) fail("budgets", "must retain one-light and timestamp-disabled authority"); integer(value.maxOwnedMaterials, "budgets.maxOwnedMaterials", 2, 12);
  if (value.maxVolumeDrawCalls !== 1 || value.maxVolumeProxyTriangles !== 12 || value.maxVolumeTextures !== 1) fail("budgets", "must bind one box volume, twelve proxy triangles, and one density texture");
  integer(value.maxRaymarchSteps, "budgets.maxRaymarchSteps", 8, 32); integer(value.maxNoiseOctaves, "budgets.maxNoiseOctaves", 1, 5); integer(value.maxVolumeTextureBytes, "budgets.maxVolumeTextureBytes", 4096, 4_194_304); integer(value.maxFragmentNoiseSamplesPerCoveredPixel, "budgets.maxFragmentNoiseSamplesPerCoveredPixel", 8, 160);
  const textureBytes = volume.densityTextureResolution[0] * volume.densityTextureResolution[1] * 4;
  if (volume.iterations > value.maxRaymarchSteps || volume.noiseOctaves > value.maxNoiseOctaves || textureBytes > value.maxVolumeTextureBytes || volume.iterations * volume.noiseOctaves > value.maxFragmentNoiseSamplesPerCoveredPixel) fail("budgets", "do not cover the selected volumetric fire work");
}

function validateLightAndSimulation(value) {
  const sockets = new Map(value.shellInterface.sockets.map((entry) => [entry.id, entry]));
  const light = object(value.light, "light");
  exact(light, ["socketId", "colorPolicy", "baseCandela", "flickerAmplitudeCandela", "distanceM", "decay", "castsShadow"], "light");
  if (sockets.get(light.socketId)?.kind !== "light") fail("light.socketId", "must resolve to the light socket");
  if (light.colorPolicy !== "building-fire-runtime-warm-flicker-srgb") fail("light.colorPolicy", "must retain the runtime warm-flicker policy");
  number(light.baseCandela, "light.baseCandela", 1, 8); number(light.flickerAmplitudeCandela, "light.flickerAmplitudeCandela", 0, .48);
  if (light.flickerAmplitudeCandela > light.baseCandela * .06 || light.baseCandela + light.flickerAmplitudeCandela > 8) fail("light candela envelope", "must be nonnegative, no greater than 6% of base, and peak at or below 8 candela");
  number(light.distanceM, "light.distanceM", 1.5, 8); if (light.decay !== 2) fail("light.decay", "must equal physically based inverse-square decay 2"); if (typeof light.castsShadow !== "boolean") fail("light.castsShadow", "must be boolean");

  const parameters = object(value.simulation?.parameters, "simulation.parameters");
  exact(parameters, ["ignitionTicks", "extinguishTicks", "lightBaseCandela", "lightFlickerCandela", "lightDistanceM", "lightDecay"], "simulation.parameters");
  integer(parameters.ignitionTicks, "simulation.parameters.ignitionTicks", 1, 600); integer(parameters.extinguishTicks, "simulation.parameters.extinguishTicks", 1, 1200);
  number(parameters.lightBaseCandela, "simulation.parameters.lightBaseCandela", 1, 8); number(parameters.lightFlickerCandela, "simulation.parameters.lightFlickerCandela", 0, .48); number(parameters.lightDistanceM, "simulation.parameters.lightDistanceM", 1.5, 8);
  if (parameters.lightFlickerCandela > parameters.lightBaseCandela * .06 || parameters.lightBaseCandela + parameters.lightFlickerCandela > 8 || parameters.lightDecay !== 2) fail("simulation.parameters light envelope", "violates the runtime light bounds");
  if (parameters.lightBaseCandela !== light.baseCandela || parameters.lightFlickerCandela !== light.flickerAmplitudeCandela || parameters.lightDistanceM !== light.distanceM || parameters.lightDecay !== light.decay) fail("simulation.parameters", "must exactly bind the declared light authority");
}

function v1CompatibilityProjection(value) {
  const socketId = value.visuals.flameVolume.socketId;
  const fake = (id, region, phase01) => ({ id, region, socketId, materialRole: `flame-${region}`, geometry: "ribbon-stack", ribbonCount: 2, segments: 5, heightM: .2, widthM: .05, phase01, deformation: { frequencyHz: 1, lateralAmplitudeM: .02, heightAmplitudeM: .03, noiseOctaves: 2 } });
  const compatibilityLight = { ...value.light, baseCandela: 6, flickerAmplitudeCandela: .3 };
  return { ...value, schema: "limina.building-fire-runtime/v1", materialRoles: ["flame-inner", "flame-outer", "hearth-embers", "hearth-soot"], visuals: { flameLayers: [fake("compat/inner-a", "inner", .1), fake("compat/inner-b", "inner", .3), fake("compat/outer-a", "outer", .6), fake("compat/outer-b", "outer", .9)], embers: value.visuals.embers, smoke: value.visuals.smoke }, light: compatibilityLight, simulation: { ...value.simulation, parameters: { ...value.simulation.parameters, lightBaseCandela: compatibilityLight.baseCandela, lightFlickerCandela: compatibilityLight.flickerAmplitudeCandela } }, budgets: { maxDrawCalls: value.budgets.maxDrawCalls, maxTriangles: value.budgets.maxTriangles, maxParticles: value.budgets.maxParticles, maxCpuUpdateMsP95: value.budgets.maxCpuUpdateMsP95, maxOwnedLights: value.budgets.maxOwnedLights, maxOwnedMaterials: value.budgets.maxOwnedMaterials, timestampQueriesEnabled: value.budgets.timestampQueriesEnabled } };
}

export function validateBuildingFireRuntimeV2(input) {
  const value = JSON.parse(canonicalStringify(input));
  exact(value, ["schema", "packageId", "revision", "dependencies", "shellInterface", "materialRoles", "fuelAsset", "visuals", "light", "simulation", "lifecycle", "budgets", "evidenceContract"], "building fire runtime v2");
  if (value.schema !== BUILDING_FIRE_RUNTIME_V2_SCHEMA || !new Set([2, 3, 4]).has(value.revision) || value.packageId !== `fire/functional-hall-house-v4/v${value.revision}`) fail("building fire runtime v2 identity", "is unsupported");
  if (JSON.stringify(value.materialRoles) !== JSON.stringify(["flame-volume", "hearth-embers", "hearth-soot"])) fail("materialRoles", "must select the volumetric fire roles");
  const visuals = object(value.visuals, "visuals"); exact(visuals, ["flameVolume", "embers", "smoke"], "visuals");
  // Reuse the exact v1 validators for approved dependencies, shell/fuel sockets, embers,
  // disabled-smoke policy, light, fixed-tick simulation, lifecycle, and evidence cameras.
  validateBuildingFireRuntimeV1(v1CompatibilityProjection(value));
  validateLightAndSimulation(value);
  const volume = validateVolume(visuals.flameVolume, value); validateBudgets(value.budgets, volume);
  return deepFreeze(value);
}

export function buildingFireRuntimeV2Hash(input) { return `sha256:${sha256(canonicalStringify(validateBuildingFireRuntimeV2(input)))}`; }
