import { canonicalStringify } from "../authoring/canonical.ts";
import { sha256 } from "../world/sha256.mjs";

export const BUILDING_FIRE_RUNTIME_V1_SCHEMA = "limina.building-fire-runtime/v1";

const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/;
const DEPENDENCIES = Object.freeze({
  shell: Object.freeze({ kind: "shell", facets: Object.freeze(["hearth-flue-sockets", "runtime-geometry"]) }),
  materials: Object.freeze({ kind: "material-palette", facets: Object.freeze(["role-contract", "surface-parameters"]) }),
  interiorPlan: Object.freeze({ kind: "interior-plan", facets: Object.freeze(["vfx-intent"]) }),
});
const REQUIRED_SOCKET_KINDS = Object.freeze(["fuel", "ember", "flame", "light"]);
const ALLOWED_SOCKET_KINDS = Object.freeze([...REQUIRED_SOCKET_KINDS, "smoke"]);
const REQUIRED_MATERIAL_ROLES = Object.freeze(["flame-inner", "flame-outer", "hearth-embers", "hearth-soot"]);
const STATES = Object.freeze(["off", "igniting", "burning", "extinguishing"]);
const PHASES = new Set(STATES);

function fail(label, message) { throw new TypeError(`${label} ${message}`); }
function object(value, label) { if (value === null || typeof value !== "object" || Array.isArray(value)) fail(label, "must be an object"); return value; }
function exact(value, required, optional, label) { const allowed = new Set([...required, ...optional]); for (const key of required) if (!(key in value)) fail(`${label}.${key}`, "is required"); for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label}.${key}`, "is unsupported"); }
function text(value, label) { if (typeof value !== "string" || value.trim() === "") fail(label, "is required"); return value; }
function id(value, label) { text(value, label); if (!ID.test(value)) fail(label, "must be a stable lowercase id"); return value; }
function hash(value, label) { if (typeof value !== "string" || !HASH.test(value)) fail(label, "must be lowercase sha256"); return value; }
function path(value, label) { text(value, label); if (!PATH.test(value)) fail(label, "must be a portable repository-relative path"); return value; }
function number(value, label, min, max) { if (!Number.isFinite(value) || value < min || value > max) fail(label, `must be within [${min}, ${max}]`); return value; }
function integer(value, label, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(label, `must be an integer within [${min}, ${max}]`); return value; }
function bool(value, label) { if (typeof value !== "boolean") fail(label, "must be boolean"); return value; }
function tuple(value, length, label, min = -Infinity, max = Infinity) { if (!Array.isArray(value) || value.length !== length) fail(label, `must contain exactly ${length} numbers`); value.forEach((entry, index) => number(entry, `${label}[${index}]`, min, max)); return value; }
function list(value, label, min, max) { if (!Array.isArray(value) || value.length < min || value.length > max) fail(label, `must contain ${min}..${max} entries`); return value; }
function unique(values, label) { if (new Set(values).size !== values.length) fail(label, "must be unique"); }
function sorted(values, label) { if (JSON.stringify(values) !== JSON.stringify([...values].sort())) fail(label, "must be canonically sorted"); }
function same(values, expected, label) { if (JSON.stringify(values) !== JSON.stringify(expected)) fail(label, `must equal ${JSON.stringify(expected)}`); }
function deepFreeze(value) { if (value !== null && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
function inside(point, box, tolerance = 1e-6) { return point.every((coordinate, axis) => Math.abs(coordinate - box.center[axis]) <= box.halfExtents[axis] + tolerance); }
function boxesOverlap(inner, outer, tolerance = 1e-6) { return inner.center.every((coordinate, axis) => Math.abs(coordinate - outer.center[axis]) + inner.halfExtents[axis] <= outer.halfExtents[axis] + tolerance); }

function validateDependency(raw, key, label) {
  const value = object(raw, label), expected = DEPENDENCIES[key];
  exact(value, ["artifactId", "kind", "revision", "status", "contractHash", "contentHash", "approvalDecision", "facets"], [], label);
  id(value.artifactId, `${label}.artifactId`); if (value.kind !== expected.kind) fail(`${label}.kind`, `must be '${expected.kind}'`);
  integer(value.revision, `${label}.revision`, 1, 1_000_000); if (value.status !== "approved") fail(`${label}.status`, "must be approved");
  hash(value.contractHash, `${label}.contractHash`); hash(value.contentHash, `${label}.contentHash`);
  const decision = object(value.approvalDecision, `${label}.approvalDecision`);
  exact(decision, ["decisionId", "sha256"], [], `${label}.approvalDecision`); id(decision.decisionId, `${label}.approvalDecision.decisionId`); hash(decision.sha256, `${label}.approvalDecision.sha256`);
  const facets = list(value.facets, `${label}.facets`, expected.facets.length, expected.facets.length), scopes = [];
  for (const [index, rawFacet] of facets.entries()) { const facet = object(rawFacet, `${label}.facets[${index}]`); exact(facet, ["scope", "hash"], [], `${label}.facets[${index}]`); text(facet.scope, `${label}.facets[${index}].scope`); hash(facet.hash, `${label}.facets[${index}].hash`); scopes.push(facet.scope); }
  unique(scopes, `${label}.facets scopes`); same(scopes, expected.facets, `${label}.facets scopes`);
}

function validateBox(raw, label) {
  const value = object(raw, label); exact(value, ["center", "halfExtents"], [], label);
  tuple(value.center, 3, `${label}.center`); tuple(value.halfExtents, 3, `${label}.halfExtents`, 0.001, 100);
  return value;
}

function validateShellInterface(raw) {
  const value = object(raw, "shellInterface");
  exact(value, ["fireplaceId", "coordinateSpace", "sourceSemanticIds", "aperture", "containment", "occlusion", "flue", "sockets"], [], "shellInterface");
  id(value.fireplaceId, "shellInterface.fireplaceId"); if (value.coordinateSpace !== "building-root-y-up-meters") fail("shellInterface.coordinateSpace", "is unsupported");
  const semantics = object(value.sourceSemanticIds, "shellInterface.sourceSemanticIds"); exact(semantics, ["base", "cavity", "fireback", "throat", "flueLiners"], [], "shellInterface.sourceSemanticIds");
  for (const key of ["base", "cavity", "fireback", "throat"]) id(semantics[key], `shellInterface.sourceSemanticIds.${key}`);
  const liners = list(semantics.flueLiners, "shellInterface.sourceSemanticIds.flueLiners", 4, 16); liners.forEach((entry, index) => id(entry, `shellInterface.sourceSemanticIds.flueLiners[${index}]`)); unique(liners, "shellInterface.sourceSemanticIds.flueLiners"); sorted(liners, "shellInterface.sourceSemanticIds.flueLiners");
  const aperture = validateBox(value.aperture, "shellInterface.aperture"), containment = validateBox(value.containment, "shellInterface.containment"), occlusion = validateBox(value.occlusion, "shellInterface.occlusion"), flue = validateBox(value.flue, "shellInterface.flue");
  if (!boxesOverlap(containment, aperture)) fail("shellInterface.containment", "must fit inside the aperture");
  if (!boxesOverlap(aperture, occlusion)) fail("shellInterface.aperture", "must fit inside the occlusion volume");
  if (flue.center[1] - flue.halfExtents[1] > aperture.center[1] + aperture.halfExtents[1] + 0.6) fail("shellInterface.flue", "must connect to the firebox throat");
  const sockets = list(value.sockets, "shellInterface.sockets", REQUIRED_SOCKET_KINDS.length, 16), kinds = [], socketIds = [];
  for (const [index, rawSocket] of sockets.entries()) {
    const socket = object(rawSocket, `shellInterface.sockets[${index}]`); exact(socket, ["id", "kind", "position", "direction"], [], `shellInterface.sockets[${index}]`);
    id(socket.id, `shellInterface.sockets[${index}].id`); if (!ALLOWED_SOCKET_KINDS.includes(socket.kind)) fail(`shellInterface.sockets[${index}].kind`, "is unsupported");
    tuple(socket.position, 3, `shellInterface.sockets[${index}].position`); tuple(socket.direction, 3, `shellInterface.sockets[${index}].direction`, -1, 1);
    const magnitude = Math.hypot(...socket.direction); if (Math.abs(magnitude - 1) > 1e-6) fail(`shellInterface.sockets[${index}].direction`, "must be unit length");
    if (!inside(socket.position, containment)) fail(`shellInterface.sockets[${index}].position`, "must be inside containment");
    if (socket.kind === "smoke" && (!inside(socket.position, occlusion) || socket.position[1] >= flue.center[1] - flue.halfExtents[1])) fail(`shellInterface.sockets[${index}].position`, "must remain in audited occlusion below the throat/flue entry");
    kinds.push(socket.kind); socketIds.push(socket.id);
  }
  unique(socketIds, "shellInterface socket ids"); sorted(socketIds, "shellInterface socket ids");
  for (const kind of REQUIRED_SOCKET_KINDS) if (!kinds.includes(kind)) fail("shellInterface.sockets", `must include a ${kind} socket`);
  return new Map(sockets.map((socket) => [socket.id, socket]));
}

function validateFuelAsset(raw, sockets) {
  const value = object(raw, "fuelAsset");
  exact(value, ["recipeId", "sourceBlend", "runtimeGlb", "logs", "coals", "emberBed"], [], "fuelAsset"); id(value.recipeId, "fuelAsset.recipeId");
  for (const [key, expectedExtension] of [["sourceBlend", ".blend"], ["runtimeGlb", ".glb"]]) {
    const asset = object(value[key], `fuelAsset.${key}`); exact(asset, ["path", "sha256"], key === "runtimeGlb" ? ["assetId"] : [], `fuelAsset.${key}`);
    path(asset.path, `fuelAsset.${key}.path`); if (!asset.path.endsWith(expectedExtension)) fail(`fuelAsset.${key}.path`, `must end in ${expectedExtension}`); hash(asset.sha256, `fuelAsset.${key}.sha256`); if (asset.assetId !== undefined) id(asset.assetId, `fuelAsset.${key}.assetId`);
  }
  const logs = list(value.logs, "fuelAsset.logs", 3, 12), logIds = [], transforms = [];
  for (const [index, rawLog] of logs.entries()) {
    const log = object(rawLog, `fuelAsset.logs[${index}]`); exact(log, ["id", "socketId", "materialRole", "lengthM", "radiusM", "radialSegments", "profileRadii", "bend", "rotationRadians"], [], `fuelAsset.logs[${index}]`);
    id(log.id, `fuelAsset.logs[${index}].id`); id(log.socketId, `fuelAsset.logs[${index}].socketId`); if (sockets.get(log.socketId)?.kind !== "fuel") fail(`fuelAsset.logs[${index}].socketId`, "must resolve to a fuel socket");
    if (log.materialRole !== "hearth-soot") fail(`fuelAsset.logs[${index}].materialRole`, "must be hearth-soot"); number(log.lengthM, `fuelAsset.logs[${index}].lengthM`, .35, 1.4); number(log.radiusM, `fuelAsset.logs[${index}].radiusM`, .04, .2); integer(log.radialSegments, `fuelAsset.logs[${index}].radialSegments`, 8, 32);
    const profile = list(log.profileRadii, `fuelAsset.logs[${index}].profileRadii`, 4, 12); profile.forEach((entry, profileIndex) => number(entry, `fuelAsset.logs[${index}].profileRadii[${profileIndex}]`, .55, 1.35));
    if (Math.max(...profile) - Math.min(...profile) < .08) fail(`fuelAsset.logs[${index}].profileRadii`, "must describe an irregular profile");
    tuple(log.bend, 3, `fuelAsset.logs[${index}].bend`, -.25, .25); if (Math.hypot(...log.bend) < .01) fail(`fuelAsset.logs[${index}].bend`, "must be visibly nonzero");
    tuple(log.rotationRadians, 3, `fuelAsset.logs[${index}].rotationRadians`, -Math.PI, Math.PI); logIds.push(log.id); transforms.push(JSON.stringify([log.bend, log.rotationRadians]));
  }
  unique(logIds, "fuelAsset log ids"); sorted(logIds, "fuelAsset log ids"); if (new Set(transforms).size < 3) fail("fuelAsset.logs", "must contain at least three distinct irregular transforms");
  const coals = list(value.coals, "fuelAsset.coals", 8, 96), coalIds = [];
  for (const [index, rawCoal] of coals.entries()) { const coal = object(rawCoal, `fuelAsset.coals[${index}]`); exact(coal, ["id", "socketId", "materialRole", "offset", "halfExtents", "emission01"], [], `fuelAsset.coals[${index}]`); id(coal.id, `fuelAsset.coals[${index}].id`); id(coal.socketId, `fuelAsset.coals[${index}].socketId`); if (sockets.get(coal.socketId)?.kind !== "ember") fail(`fuelAsset.coals[${index}].socketId`, "must resolve to an ember socket"); if (coal.materialRole !== "hearth-embers") fail(`fuelAsset.coals[${index}].materialRole`, "must be hearth-embers"); tuple(coal.offset, 3, `fuelAsset.coals[${index}].offset`, -.7, .7); tuple(coal.halfExtents, 3, `fuelAsset.coals[${index}].halfExtents`, .005, .14); number(coal.emission01, `fuelAsset.coals[${index}].emission01`, 0, 1); coalIds.push(coal.id); }
  unique(coalIds, "fuelAsset coal ids"); sorted(coalIds, "fuelAsset coal ids");
  const bed = object(value.emberBed, "fuelAsset.emberBed"); exact(bed, ["id", "socketId", "materialRole", "halfExtents"], [], "fuelAsset.emberBed"); id(bed.id, "fuelAsset.emberBed.id"); id(bed.socketId, "fuelAsset.emberBed.socketId"); if (sockets.get(bed.socketId)?.kind !== "ember") fail("fuelAsset.emberBed.socketId", "must resolve to an ember socket"); if (bed.materialRole !== "hearth-embers") fail("fuelAsset.emberBed.materialRole", "must be hearth-embers"); tuple(bed.halfExtents, 3, "fuelAsset.emberBed.halfExtents", .01, .7);
  unique([...logIds, ...coalIds, bed.id], "fuelAsset semantic ids");
}

function validateVisuals(raw, sockets) {
  const value = object(raw, "visuals"); exact(value, ["flameLayers", "embers", "smoke"], [], "visuals");
  const layers = list(value.flameLayers, "visuals.flameLayers", 4, 12), ids = [], regions = [], phases = [];
  for (const [index, rawLayer] of layers.entries()) {
    const layer = object(rawLayer, `visuals.flameLayers[${index}]`); exact(layer, ["id", "region", "socketId", "materialRole", "geometry", "ribbonCount", "segments", "heightM", "widthM", "phase01", "deformation"], [], `visuals.flameLayers[${index}]`);
    id(layer.id, `visuals.flameLayers[${index}].id`); if (!new Set(["inner", "outer"]).has(layer.region)) fail(`visuals.flameLayers[${index}].region`, "must be inner or outer"); if (layer.materialRole !== `flame-${layer.region}`) fail(`visuals.flameLayers[${index}].materialRole`, "must match its flame region");
    id(layer.socketId, `visuals.flameLayers[${index}].socketId`); if (sockets.get(layer.socketId)?.kind !== "flame") fail(`visuals.flameLayers[${index}].socketId`, "must resolve to a flame socket"); if (layer.geometry !== "ribbon-stack") fail(`visuals.flameLayers[${index}].geometry`, "must be ribbon-stack (static cones are prohibited)");
    integer(layer.ribbonCount, `visuals.flameLayers[${index}].ribbonCount`, 2, 8); integer(layer.segments, `visuals.flameLayers[${index}].segments`, 5, 24); number(layer.heightM, `visuals.flameLayers[${index}].heightM`, .18, 1.2); number(layer.widthM, `visuals.flameLayers[${index}].widthM`, .04, .5); number(layer.phase01, `visuals.flameLayers[${index}].phase01`, 0, 1);
    const deformation = object(layer.deformation, `visuals.flameLayers[${index}].deformation`); exact(deformation, ["frequencyHz", "lateralAmplitudeM", "heightAmplitudeM", "noiseOctaves"], [], `visuals.flameLayers[${index}].deformation`); number(deformation.frequencyHz, `visuals.flameLayers[${index}].deformation.frequencyHz`, .35, 8); number(deformation.lateralAmplitudeM, `visuals.flameLayers[${index}].deformation.lateralAmplitudeM`, .015, .22); number(deformation.heightAmplitudeM, `visuals.flameLayers[${index}].deformation.heightAmplitudeM`, .02, .3); integer(deformation.noiseOctaves, `visuals.flameLayers[${index}].deformation.noiseOctaves`, 2, 5);
    ids.push(layer.id); regions.push(layer.region); phases.push(layer.phase01);
  }
  unique(ids, "visuals flame layer ids"); sorted(ids, "visuals flame layer ids"); if (regions.filter((entry) => entry === "inner").length < 2 || regions.filter((entry) => entry === "outer").length < 2) fail("visuals.flameLayers", "must have at least two inner and two outer layers"); if (new Set(phases).size < 4) fail("visuals.flameLayers phase01", "must contain at least four distinct phases");
  const embers = object(value.embers, "visuals.embers"); exact(embers, ["socketId", "materialRole", "pulseFrequencyHz", "pulseAmplitude01"], [], "visuals.embers"); id(embers.socketId, "visuals.embers.socketId"); if (sockets.get(embers.socketId)?.kind !== "ember") fail("visuals.embers.socketId", "must resolve to an ember socket"); if (embers.materialRole !== "hearth-embers") fail("visuals.embers.materialRole", "must be hearth-embers"); number(embers.pulseFrequencyHz, "visuals.embers.pulseFrequencyHz", .05, 3); number(embers.pulseAmplitude01, "visuals.embers.pulseAmplitude01", .05, .65);
  const smoke = object(value.smoke, "visuals.smoke");
  if (smoke.enabled === false) {
    exact(smoke, ["enabled", "flueTraversalClaim", "absorbBeforeThroat"], [], "visuals.smoke");
  } else if (smoke.enabled === true) {
    exact(smoke, ["enabled", "socketId", "materialRole", "particleCount", "lifespanSeconds", "riseMps", "maxOpacity", "flueTraversalClaim", "absorbBeforeThroat"], [], "visuals.smoke"); id(smoke.socketId, "visuals.smoke.socketId"); if (sockets.get(smoke.socketId)?.kind !== "smoke") fail("visuals.smoke.socketId", "must resolve to a bounded smoke socket below the throat"); if (smoke.materialRole !== "hearth-soot") fail("visuals.smoke.materialRole", "must be hearth-soot"); integer(smoke.particleCount, "visuals.smoke.particleCount", 8, 96); number(smoke.lifespanSeconds, "visuals.smoke.lifespanSeconds", .5, 8); number(smoke.riseMps, "visuals.smoke.riseMps", .05, 1.5); number(smoke.maxOpacity, "visuals.smoke.maxOpacity", .01, .3);
  } else fail("visuals.smoke.enabled", "must be boolean");
  if (smoke.flueTraversalClaim !== false) fail("visuals.smoke.flueTraversalClaim", "must be false because throat/flue traversal is unproven"); if (smoke.absorbBeforeThroat !== true) fail("visuals.smoke.absorbBeforeThroat", "must be true");
}

function validateLight(raw, sockets) {
  const value = object(raw, "light"); exact(value, ["socketId", "colorPolicy", "baseCandela", "flickerAmplitudeCandela", "distanceM", "decay", "castsShadow"], [], "light"); id(value.socketId, "light.socketId"); if (sockets.get(value.socketId)?.kind !== "light") fail("light.socketId", "must resolve to a light socket"); if (value.colorPolicy !== "building-fire-runtime-warm-flicker-srgb") fail("light.colorPolicy", "must use the runtime-owned warm flicker policy");
  number(value.baseCandela, "light.baseCandela", 6, 8); number(value.flickerAmplitudeCandela, "light.flickerAmplitudeCandela", 0, .48); if (value.flickerAmplitudeCandela > value.baseCandela * .06 || value.baseCandela + value.flickerAmplitudeCandela > 8) fail("light candela envelope", "must use a nonnegative runtime flicker amplitude no greater than 6% of base with peak <=8");
  number(value.distanceM, "light.distanceM", 1.5, 8); if (value.decay !== 2) fail("light.decay", "must equal 2"); bool(value.castsShadow, "light.castsShadow");
}

function validateSimulation(raw, light) {
  const value = object(raw, "simulation"); exact(value, ["authority", "tickHz", "seed", "phases", "commands", "parameters", "initialState", "snapshot"], [], "simulation"); if (value.authority !== "explicit-authoritative-tick") fail("simulation.authority", "is unsupported"); if (value.tickHz !== 60) fail("simulation.tickHz", "must equal the runtime authority of 60"); integer(value.seed, "simulation.seed", 0, 0xffffffff); same(value.phases, STATES, "simulation.phases"); same(value.commands, ["extinguish", "start"], "simulation.commands");
  const parameters = object(value.parameters, "simulation.parameters"); exact(parameters, ["ignitionTicks", "extinguishTicks", "lightBaseCandela", "lightFlickerCandela", "lightDistanceM", "lightDecay"], [], "simulation.parameters"); integer(parameters.ignitionTicks, "simulation.parameters.ignitionTicks", 1, 600); integer(parameters.extinguishTicks, "simulation.parameters.extinguishTicks", 1, 1200); number(parameters.lightBaseCandela, "simulation.parameters.lightBaseCandela", 6, 8); number(parameters.lightFlickerCandela, "simulation.parameters.lightFlickerCandela", 0, .48); if (parameters.lightFlickerCandela > parameters.lightBaseCandela * .06 || parameters.lightBaseCandela + parameters.lightFlickerCandela > 8) fail("simulation.parameters light envelope", "does not match BuildingFireRuntime bounds"); number(parameters.lightDistanceM, "simulation.parameters.lightDistanceM", 1.5, 8); if (parameters.lightDecay !== 2) fail("simulation.parameters.lightDecay", "must equal 2"); if (parameters.lightBaseCandela !== light.baseCandela || parameters.lightFlickerCandela !== light.flickerAmplitudeCandela || parameters.lightDistanceM !== light.distanceM || parameters.lightDecay !== light.decay) fail("simulation.parameters", "must exactly bind the declared light authority");
  const state = object(value.initialState, "simulation.initialState"); exact(state, ["tick", "phase", "phaseStartedTick", "transitionStartEnvelopeQ"], [], "simulation.initialState"); if (state.tick !== 0 || state.phase !== "off" || state.phaseStartedTick !== 0 || state.transitionStartEnvelopeQ !== 0) fail("simulation.initialState", "must equal BuildingFireRuntime's canonical off state");
  const snapshot = object(value.snapshot, "simulation.snapshot"); exact(snapshot, ["schema", "authorityFields", "stateFields", "canonicalReplayRequired"], [], "simulation.snapshot"); if (snapshot.schema !== "limina.building-fire-runtime-snapshot/v1") fail("simulation.snapshot.schema", "is unsupported"); same(snapshot.authorityFields, ["parameters", "schema", "seed", "state", "tickHz"], "simulation.snapshot.authorityFields"); same(snapshot.stateFields, ["phase", "phaseStartedTick", "tick", "transitionStartEnvelopeQ"], "simulation.snapshot.stateFields"); if (snapshot.canonicalReplayRequired !== true) fail("simulation.snapshot.canonicalReplayRequired", "must be true");
}

function validateLifecycle(raw) { const value = object(raw, "lifecycle"); const keys = ["start", "burn", "extinguish", "save", "restoreReplay", "idempotentTeardown", "resourceBaselineRequired"]; exact(value, keys, [], "lifecycle"); for (const key of keys) if (value[key] !== true) fail(`lifecycle.${key}`, "must be true"); }
function validateBudgets(raw) { const value = object(raw, "budgets"); exact(value, ["maxDrawCalls", "maxTriangles", "maxParticles", "maxCpuUpdateMsP95", "maxOwnedLights", "maxOwnedMaterials", "timestampQueriesEnabled"], [], "budgets"); integer(value.maxDrawCalls, "budgets.maxDrawCalls", 1, 16); integer(value.maxTriangles, "budgets.maxTriangles", 100, 50_000); integer(value.maxParticles, "budgets.maxParticles", 8, 256); number(value.maxCpuUpdateMsP95, "budgets.maxCpuUpdateMsP95", .01, 2); integer(value.maxOwnedLights, "budgets.maxOwnedLights", 1, 1); integer(value.maxOwnedMaterials, "budgets.maxOwnedMaterials", 3, 12); if (value.timestampQueriesEnabled !== false) fail("budgets.timestampQueriesEnabled", "must be false"); }

function validateEvidence(raw, simulation) {
  const value = object(raw, "evidenceContract"); exact(value, ["renderer", "minimumResolution", "sampleTicks", "views", "exposure", "humanDecisionRequired"], [], "evidenceContract"); if (value.renderer !== "limina-production-native-engine") fail("evidenceContract.renderer", "is unsupported"); tuple(value.minimumResolution, 2, "evidenceContract.minimumResolution", 1, 16384); if (value.minimumResolution[0] < 1920 || value.minimumResolution[1] < 1080) fail("evidenceContract.minimumResolution", "must be at least 1920x1080");
  const samples = list(value.sampleTicks, "evidenceContract.sampleTicks", 8, 64), ids = [], ticks = [], phases = [];
  for (const [index, rawSample] of samples.entries()) { const sample = object(rawSample, `evidenceContract.sampleTicks[${index}]`); exact(sample, ["id", "tick", "phase"], [], `evidenceContract.sampleTicks[${index}]`); id(sample.id, `evidenceContract.sampleTicks[${index}].id`); integer(sample.tick, `evidenceContract.sampleTicks[${index}].tick`, 0, 10_000_000); if (!PHASES.has(sample.phase)) fail(`evidenceContract.sampleTicks[${index}].phase`, "is unsupported"); ids.push(sample.id); ticks.push(sample.tick); phases.push(sample.phase); }
  unique(ids, "evidenceContract sample ids"); unique(ticks, "evidenceContract ticks"); if (ticks.some((tick, index) => index > 0 && tick <= ticks[index - 1])) fail("evidenceContract.sampleTicks", "must be strictly time ordered"); if (phases[0] !== "off" || phases.at(-1) !== "off" || phases.filter((phase) => phase === "burning").length < 4 || !phases.includes("igniting") || !phases.includes("extinguishing")) fail("evidenceContract.sampleTicks", "must cover off, ignition, at least four burn samples, extinguish, and off");
  const views = list(value.views, "evidenceContract.views", 3, 8), roles = [], viewIds = [];
  for (const [index, rawView] of views.entries()) { const view = object(rawView, `evidenceContract.views[${index}]`); exact(view, ["id", "role", "position", "target", "fovDeg"], [], `evidenceContract.views[${index}]`); id(view.id, `evidenceContract.views[${index}].id`); if (!new Set(["flame-motion", "fuel-detail", "reflected-light"]).has(view.role)) fail(`evidenceContract.views[${index}].role`, "is unsupported"); tuple(view.position, 3, `evidenceContract.views[${index}].position`); tuple(view.target, 3, `evidenceContract.views[${index}].target`); number(view.fovDeg, `evidenceContract.views[${index}].fovDeg`, 20, 90); viewIds.push(view.id); roles.push(view.role); }
  unique(viewIds, "evidenceContract view ids"); sorted(viewIds, "evidenceContract view ids"); for (const role of ["flame-motion", "fuel-detail", "reflected-light"]) if (!roles.includes(role)) fail("evidenceContract.views", `must include ${role}`);
  const exposure = object(value.exposure, "evidenceContract.exposure"); exact(exposure, ["pairedOffOn", "maxClippedPixelFraction", "maxChannelP99"], [], "evidenceContract.exposure"); if (exposure.pairedOffOn !== true) fail("evidenceContract.exposure.pairedOffOn", "must be true"); number(exposure.maxClippedPixelFraction, "evidenceContract.exposure.maxClippedPixelFraction", 0, .01); number(exposure.maxChannelP99, "evidenceContract.exposure.maxChannelP99", .8, .995); if (value.humanDecisionRequired !== true) fail("evidenceContract.humanDecisionRequired", "must be true");
  void simulation;
}

function validateAuthority(contract, authority) {
  if (authority === undefined) return;
  const value = object(authority, "fire runtime authority"); exact(value, ["dependencies"], ["packageId", "fireplaceId"], "fire runtime authority");
  if (value.packageId !== undefined && contract.packageId !== value.packageId) fail("packageId", "does not match authority"); if (value.fireplaceId !== undefined && contract.shellInterface.fireplaceId !== value.fireplaceId) fail("shellInterface.fireplaceId", "does not match authority");
  const expected = object(value.dependencies, "fire runtime authority.dependencies"); exact(expected, Object.keys(DEPENDENCIES), [], "fire runtime authority.dependencies");
  for (const key of Object.keys(DEPENDENCIES)) { const actual = contract.dependencies[key], wanted = object(expected[key], `fire runtime authority.dependencies.${key}`); exact(wanted, ["artifactId", "contractHash", "contentHash", "approvalDecisionSha256", "facetHashes"], [], `fire runtime authority.dependencies.${key}`); for (const field of ["artifactId", "contractHash", "contentHash"]) if (actual[field] !== wanted[field]) fail(`dependencies.${key}.${field}`, "does not match authority"); if (actual.approvalDecision.sha256 !== wanted.approvalDecisionSha256) fail(`dependencies.${key}.approvalDecision.sha256`, "does not match authority"); const actualFacets = Object.fromEntries(actual.facets.map((facet) => [facet.scope, facet.hash])); const wantedFacets = object(wanted.facetHashes, `fire runtime authority.dependencies.${key}.facetHashes`); exact(wantedFacets, DEPENDENCIES[key].facets, [], `fire runtime authority.dependencies.${key}.facetHashes`); for (const scope of DEPENDENCIES[key].facets) { hash(wantedFacets[scope], `fire runtime authority.dependencies.${key}.facetHashes.${scope}`); if (actualFacets[scope] !== wantedFacets[scope]) fail(`dependencies.${key}.facets.${scope}`, "does not match authority"); } }
}

export function validateBuildingFireRuntimeV1(input, authority) {
  const value = JSON.parse(canonicalStringify(input));
  exact(value, ["schema", "packageId", "revision", "dependencies", "shellInterface", "materialRoles", "fuelAsset", "visuals", "light", "simulation", "lifecycle", "budgets", "evidenceContract"], [], "building fire runtime");
  if (value.schema !== BUILDING_FIRE_RUNTIME_V1_SCHEMA) fail("building fire runtime.schema", "is unsupported"); id(value.packageId, "packageId"); integer(value.revision, "revision", 1, 1_000_000);
  const dependencies = object(value.dependencies, "dependencies"); exact(dependencies, Object.keys(DEPENDENCIES), [], "dependencies"); for (const key of Object.keys(DEPENDENCIES)) validateDependency(dependencies[key], key, `dependencies.${key}`);
  same(value.materialRoles, REQUIRED_MATERIAL_ROLES, "materialRoles");
  const sockets = validateShellInterface(value.shellInterface); validateFuelAsset(value.fuelAsset, sockets); validateVisuals(value.visuals, sockets); validateLight(value.light, sockets); validateSimulation(value.simulation, value.light); validateLifecycle(value.lifecycle); validateBudgets(value.budgets); validateEvidence(value.evidenceContract, value.simulation); validateAuthority(value, authority);
  return deepFreeze(value);
}

export function buildingFireRuntimeV1Hash(input, authority) {
  return `sha256:${sha256(canonicalStringify(validateBuildingFireRuntimeV1(input, authority)))}`;
}
