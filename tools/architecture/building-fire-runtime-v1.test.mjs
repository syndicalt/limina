import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BUILDING_FIRE_RUNTIME_V1_SCHEMA, buildingFireRuntimeV1Hash, validateBuildingFireRuntimeV1 } from "../../js/src/assets/building-fire-runtime-v1.mjs";
import { BUILDING_FIRE_SNAPSHOT_SCHEMA, BUILDING_FIRE_TICK_HZ, BuildingFireRuntime } from "../../js/src/render/building-fire-runtime.ts";

const H = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const dependency = ({ artifactId, kind, revision, contractHash, contentHash, decisionId, decisionHash, facets }) => ({ artifactId, kind, revision, status: "approved", contractHash, contentHash, approvalDecision: { decisionId, sha256: decisionHash }, facets });

const AUTHORITY = Object.freeze({
  packageId: "fire/functional-hall-house-v4/v1",
  fireplaceId: "hall-hearth",
  dependencies: {
    shell: { artifactId: "shell/functional-hall-house-v4/r4", contractHash: "sha256:16e53efe05d769dc345687453a1ff2eca8bbfa734979fdc7065700d1ce2037ee", contentHash: "sha256:4aba79d5285d5bd0dddbc454b1949e986bf7cf52ce2e743a23814433b04b69ed", approvalDecisionSha256: "sha256:a10da9070834d2c2c49c00b0e22367a0ba6e5a8b9fe379937eefa691cedf50cb", facetHashes: { "hearth-flue-sockets": "sha256:e3703d8d7b8acd0ab273ced3e63ce16322579c96bcff555ddfa530abc4a52aaa", "runtime-geometry": "sha256:8a37119a862582c928172412e86d5a0d61d309b5ebb08ee1be6b34e241670250" } },
    materials: { artifactId: "materials/functional-hall-house-v4/r2", contractHash: "sha256:3fc8962ec7af10a0f341cac0d087d61a81da61d52e3c67a8eac14e5755dca721", contentHash: "sha256:5d973e3f6e0dcc0a150c5f08e58682aae22d3af87808e78f1ef3844209150b88", approvalDecisionSha256: "sha256:c58be2224939253a001fbbc2f528de8a1d40859d978a1cbec55cdee82111970c", facetHashes: { "role-contract": "sha256:91a41735a85818000b6b3bfeec64264c59d61202c7c3e035018ce5ae4fe94dfa", "surface-parameters": "sha256:2673b10256ea6015dc2ff4313121b439c1841bca587ad6429bbb6c60da775ffc" } },
    interiorPlan: { artifactId: "interior/functional-hall-house-v4/r4", contractHash: "sha256:58a7021047e59c6374d7e420925cdc234d922b65ff11ecb6d91c196338506864", contentHash: "sha256:32a25b969c940b4ee78365da6c75c9b47a7e70646e9faf04ce6c29b1357e2f0f", approvalDecisionSha256: "sha256:86e05208d98d0261bb4abf97ba15b4a671ee7414a1d8ee303da73928a4f9158c", facetHashes: { "vfx-intent": "sha256:5d72b56ff008fdbf19627b588a062a8b82f3cbe6783ae87a52223aecabe62c32" } },
  },
});

function fixture() {
  const socket = (kind, position, direction = [0, 1, 0]) => ({ id: `socket/${kind}`, kind, position, direction });
  const shell = AUTHORITY.dependencies.shell, materials = AUTHORITY.dependencies.materials, interior = AUTHORITY.dependencies.interiorPlan;
  return {
    schema: BUILDING_FIRE_RUNTIME_V1_SCHEMA, packageId: AUTHORITY.packageId, revision: 1,
    dependencies: {
      shell: dependency({ artifactId: shell.artifactId, kind: "shell", revision: 4, contractHash: shell.contractHash, contentHash: shell.contentHash, decisionId: "shell/functional-hall-house-v4/r4/approve-user-r4", decisionHash: shell.approvalDecisionSha256, facets: [{ scope: "hearth-flue-sockets", hash: shell.facetHashes["hearth-flue-sockets"] }, { scope: "runtime-geometry", hash: shell.facetHashes["runtime-geometry"] }] }),
      materials: dependency({ artifactId: materials.artifactId, kind: "material-palette", revision: 2, contractHash: materials.contractHash, contentHash: materials.contentHash, decisionId: "materials/functional-hall-house-v4/r2/approve-user-r2", decisionHash: materials.approvalDecisionSha256, facets: [{ scope: "role-contract", hash: materials.facetHashes["role-contract"] }, { scope: "surface-parameters", hash: materials.facetHashes["surface-parameters"] }] }),
      interiorPlan: dependency({ artifactId: interior.artifactId, kind: "interior-plan", revision: 4, contractHash: interior.contractHash, contentHash: interior.contentHash, decisionId: "interior/functional-hall-house-v4/r4/approve-user-r4", decisionHash: interior.approvalDecisionSha256, facets: [{ scope: "vfx-intent", hash: interior.facetHashes["vfx-intent"] }] }),
    },
    shellInterface: {
      fireplaceId: "hall-hearth", coordinateSpace: "building-root-y-up-meters",
      sourceSemanticIds: { base: "fireplace/hall-hearth/base", cavity: "fireplace/hall-hearth/cavity", fireback: "fireplace/hall-hearth/fireback", throat: "fireplace/hall-hearth/throat", flueLiners: ["chimney/hall/flue-liner-east", "chimney/hall/flue-liner-north", "chimney/hall/flue-liner-south", "chimney/hall/flue-liner-west"] },
      aperture: { center: [2.95, 1.08, 2.7], halfExtents: [.7, .72, .7] }, containment: { center: [2.95, 1.05, 2.7], halfExtents: [.6, .6, .55] }, occlusion: { center: [2.95, 1.08, 2.7], halfExtents: [.75, .85, .75] }, flue: { center: [2.95, 2.2, 2.7], halfExtents: [.3, .6, .3] },
      sockets: [socket("ember", [2.95, .5, 2.7]), socket("flame", [2.95, .55, 2.64]), socket("fuel", [2.95, .58, 2.65]), socket("light", [2.95, .82, 2.32]), socket("smoke", [2.95, 1.4, 2.7])],
    },
    materialRoles: ["flame-inner", "flame-outer", "hearth-embers", "hearth-soot"],
    fuelAsset: {
      recipeId: "fire-fuel/functional-hall-house-v4/v1", sourceBlend: { path: "assets/buildings/authoring/functional-hall-house-v4/fire-v1/fuel.source.blend", sha256: H("blend") }, runtimeGlb: { path: "assets/buildings/authoring/functional-hall-house-v4/fire-v1/fuel.glb", sha256: H("glb"), assetId: "buildings/functional-hall-house-v4/fire-fuel-v1" },
      logs: [
        { id: "log/a", socketId: "socket/fuel", materialRole: "hearth-soot", lengthM: .9, radiusM: .11, radialSegments: 12, profileRadii: [.82, 1.08, .94, 1.14], bend: [.04, .01, -.02], rotationRadians: [0, 0, -.35] },
        { id: "log/b", socketId: "socket/fuel", materialRole: "hearth-soot", lengthM: .82, radiusM: .105, radialSegments: 14, profileRadii: [1.12, .91, 1.04, .79], bend: [-.03, .02, .04], rotationRadians: [0, .2, .38] },
        { id: "log/c", socketId: "socket/fuel", materialRole: "hearth-soot", lengthM: .74, radiusM: .09, radialSegments: 11, profileRadii: [.88, 1.17, 1.02, .83], bend: [.02, .04, .03], rotationRadians: [.1, -.2, 1.48] },
      ],
      coals: Array.from({ length: 8 }, (_, index) => ({ id: `coal/${String(index).padStart(2, "0")}`, socketId: "socket/ember", materialRole: "hearth-embers", offset: [((index % 4) - 1.5) * .16, index % 2 * .025, (Math.floor(index / 4) - .5) * .22], halfExtents: [.055 + index * .002, .025, .04], emission01: .35 + index * .05 })),
      emberBed: { id: "ember/bed", socketId: "socket/ember", materialRole: "hearth-embers", halfExtents: [.52, .025, .38] },
    },
    visuals: {
      flameLayers: [
        { id: "flame/inner-a", region: "inner", socketId: "socket/flame", materialRole: "flame-inner", geometry: "ribbon-stack", ribbonCount: 3, segments: 9, heightM: .48, widthM: .16, phase01: .11, deformation: { frequencyHz: 2.3, lateralAmplitudeM: .07, heightAmplitudeM: .12, noiseOctaves: 3 } },
        { id: "flame/inner-b", region: "inner", socketId: "socket/flame", materialRole: "flame-inner", geometry: "ribbon-stack", ribbonCount: 2, segments: 8, heightM: .36, widthM: .12, phase01: .37, deformation: { frequencyHz: 3.1, lateralAmplitudeM: .05, heightAmplitudeM: .09, noiseOctaves: 3 } },
        { id: "flame/outer-a", region: "outer", socketId: "socket/flame", materialRole: "flame-outer", geometry: "ribbon-stack", ribbonCount: 4, segments: 11, heightM: .76, widthM: .31, phase01: .62, deformation: { frequencyHz: 1.7, lateralAmplitudeM: .11, heightAmplitudeM: .18, noiseOctaves: 4 } },
        { id: "flame/outer-b", region: "outer", socketId: "socket/flame", materialRole: "flame-outer", geometry: "ribbon-stack", ribbonCount: 3, segments: 10, heightM: .61, widthM: .24, phase01: .89, deformation: { frequencyHz: 2.7, lateralAmplitudeM: .09, heightAmplitudeM: .14, noiseOctaves: 3 } },
      ],
      embers: { socketId: "socket/ember", materialRole: "hearth-embers", pulseFrequencyHz: .7, pulseAmplitude01: .3 }, smoke: { enabled: true, socketId: "socket/smoke", materialRole: "hearth-soot", particleCount: 24, lifespanSeconds: 3.2, riseMps: .28, maxOpacity: .12, flueTraversalClaim: false, absorbBeforeThroat: true },
    },
    light: { socketId: "socket/light", colorPolicy: "building-fire-runtime-warm-flicker-srgb", baseCandela: 6.3, flickerAmplitudeCandela: .3, distanceM: 2.2, decay: 2, castsShadow: true },
    simulation: { authority: "explicit-authoritative-tick", tickHz: 60, seed: 271828, phases: ["off", "igniting", "burning", "extinguishing"], commands: ["extinguish", "start"], parameters: { ignitionTicks: 60, extinguishTicks: 90, lightBaseCandela: 6.3, lightFlickerCandela: .3, lightDistanceM: 2.2, lightDecay: 2 }, initialState: { tick: 0, phase: "off", phaseStartedTick: 0, transitionStartEnvelopeQ: 0 }, snapshot: { schema: "limina.building-fire-runtime-snapshot/v1", authorityFields: ["parameters", "schema", "seed", "state", "tickHz"], stateFields: ["phase", "phaseStartedTick", "tick", "transitionStartEnvelopeQ"], canonicalReplayRequired: true } },
    lifecycle: { start: true, burn: true, extinguish: true, save: true, restoreReplay: true, idempotentTeardown: true, resourceBaselineRequired: true },
    budgets: { maxDrawCalls: 10, maxTriangles: 12000, maxParticles: 64, maxCpuUpdateMsP95: .5, maxOwnedLights: 1, maxOwnedMaterials: 4, timestampQueriesEnabled: false },
    evidenceContract: {
      renderer: "limina-production-native-engine", minimumResolution: [1920, 1080],
      sampleTicks: [{ id: "off-initial", tick: 0, phase: "off" }, { id: "ignition", tick: 30, phase: "igniting" }, { id: "burn-a", tick: 75, phase: "burning" }, { id: "burn-b", tick: 105, phase: "burning" }, { id: "burn-c", tick: 135, phase: "burning" }, { id: "burn-d", tick: 165, phase: "burning" }, { id: "extinguish", tick: 195, phase: "extinguishing" }, { id: "off-final", tick: 300, phase: "off" }],
      views: [{ id: "fuel-detail", role: "fuel-detail", position: [1.4, 1.1, .9], target: [2.95, .7, 2.7], fovDeg: 42 }, { id: "hearth-motion", role: "flame-motion", position: [.9, 1.45, -.4], target: [2.95, 1, 2.7], fovDeg: 52 }, { id: "reflected-light", role: "reflected-light", position: [-.8, 1.6, -1.7], target: [2.95, 1.1, 2.7], fovDeg: 58 }],
      exposure: { pairedOffOn: true, maxClippedPixelFraction: .0025, maxChannelP99: .98 }, humanDecisionRequired: true,
    },
  };
}

const rejects = (mutate, pattern) => { const value = fixture(); mutate(value); assert.throws(() => validateBuildingFireRuntimeV1(value, AUTHORITY), pattern); };

test("validates the exact approved dependency closure, clones, freezes, and hashes canonically", () => {
  const source = fixture(), validated = validateBuildingFireRuntimeV1(source, AUTHORITY), hash = buildingFireRuntimeV1Hash(source, AUTHORITY);
  assert.ok(Object.isFrozen(validated) && Object.isFrozen(validated.visuals.flameLayers[0])); assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  source.light.baseCandela = 99; assert.equal(validated.light.baseCandela, 6.3); assert.equal(buildingFireRuntimeV1Hash(fixture(), AUTHORITY), hash);
  const reordered = fixture(), reversed = Object.fromEntries(Object.entries(reordered).reverse()); assert.equal(buildingFireRuntimeV1Hash(reversed, AUTHORITY), hash);
});

test("binds the exact BuildingFireRuntime phase, parameter, and snapshot authority", () => {
  const contract = validateBuildingFireRuntimeV1(fixture(), AUTHORITY), parameters = contract.simulation.parameters;
  assert.equal(contract.simulation.tickHz, BUILDING_FIRE_TICK_HZ); assert.equal(contract.simulation.snapshot.schema, BUILDING_FIRE_SNAPSHOT_SCHEMA);
  const runtime = new BuildingFireRuntime({ seed: contract.simulation.seed, ignitionTicks: parameters.ignitionTicks, extinguishTicks: parameters.extinguishTicks, lightBaseCandela: parameters.lightBaseCandela, lightFlickerCandela: parameters.lightFlickerCandela, lightDistanceM: parameters.lightDistanceM });
  const snapshot = runtime.snapshot(); assert.deepEqual(Object.keys(snapshot).sort(), contract.simulation.snapshot.authorityFields); assert.deepEqual(Object.keys(snapshot.state).sort(), contract.simulation.snapshot.stateFields); assert.equal(snapshot.state.phase, "off"); assert.deepEqual(snapshot.parameters, parameters); runtime.dispose();
});

test("fails closed on stale dependency identities, facets, and undeclared inputs", () => {
  rejects((value) => value.dependencies.shell.facets[0].hash = H("stale"), /does not match authority/);
  rejects((value) => value.dependencies.materials.facets.push({ scope: "runtime-textures", hash: H("extra") }), /must contain 2\.\.2 entries/);
  rejects((value) => value.dependencies.composition = {}, /dependencies\.composition is unsupported/);
  rejects((value) => value.dependencies.interiorPlan.status = "candidate", /must be approved/);
});

test("prohibits placeholder cones, uniform fuel, disconnected sockets, and excessive light", () => {
  rejects((value) => value.visuals.flameLayers[0].geometry = "tapered-cone", /static cones are prohibited/);
  rejects((value) => value.fuelAsset.logs[0].profileRadii = [1, 1, 1, 1], /irregular profile/);
  rejects((value) => value.shellInterface.sockets.find(({ kind }) => kind === "flame").position = [0, 0, 0], /must be inside containment/);
  rejects((value) => { value.light.baseCandela = 7.8; value.light.flickerAmplitudeCandela = .3; }, /candela envelope/);
});

test("requires deterministic lifecycle, smoke, multi-frame evidence, and timestamp-free budgets", () => {
  rejects((value) => value.simulation.authority = "wall-clock", /authority is unsupported/);
  rejects((value) => value.simulation.snapshot.schema = "limina.building-fire-runtime-state\/v1", /snapshot\.schema is unsupported/);
  rejects((value) => value.simulation.parameters.lightBaseCandela = 7, /exactly bind the declared light authority/);
  rejects((value) => value.lifecycle.restoreReplay = false, /restoreReplay must be true/);
  rejects((value) => value.visuals.smoke.flueTraversalClaim = true, /must be false because throat\/flue traversal is unproven/);
  rejects((value) => value.visuals.smoke.absorbBeforeThroat = false, /must be true/);
  rejects((value) => value.shellInterface.sockets.find(({ kind }) => kind === "smoke").position[1] = 1.61, /below the throat\/flue entry/);
  rejects((value) => value.evidenceContract.sampleTicks.find(({ phase }) => phase === "extinguishing").phase = "burning", /must cover off, ignition/);
  rejects((value) => value.budgets.timestampQueriesEnabled = true, /must be false/);
});

test("allows smoke to be disabled without claiming unsupported throat traversal", () => {
  const value = fixture(); value.visuals.smoke = { enabled: false, flueTraversalClaim: false, absorbBeforeThroat: true }; value.shellInterface.sockets = value.shellInterface.sockets.filter(({ kind }) => kind !== "smoke");
  const validated = validateBuildingFireRuntimeV1(value, AUTHORITY); assert.equal(validated.visuals.smoke.enabled, false);
});
