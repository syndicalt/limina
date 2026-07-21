import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalStringify } from "../../js/src/authoring/canonical.ts";
import {
  buildingFireRuntimeV1Hash,
  validateBuildingFireRuntimeV1,
} from "../../js/src/assets/building-fire-runtime-v1.mjs";
import {
  BUILDING_STAGE_FACETS,
  validateBuildingHitlDecision,
  validateBuildingStageArtifact,
} from "../../js/src/assets/staged-building-pipeline.mjs";

const DEFAULTS = Object.freeze({
  shellArtifact: "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell-artifact-approved.json",
  materialArtifact:
    "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-palette-artifact-approved.json",
  interiorArtifact:
    "assets/buildings/authoring/functional-hall-house-v4/interior-r4/interior-plan-artifact-approved.json",
  recipe: "assets/buildings/authoring/functional-hall-house-v4/fire-r1/hearth-fuel-recipe.json",
  buildEvidence: "assets/buildings/authoring/functional-hall-house-v4/fire-r1/build-evidence.json",
  contractOutput: "assets/buildings/authoring/functional-hall-house-v4/fire-r1/fire-runtime-contract.json",
  artifactOutput: "assets/buildings/authoring/functional-hall-house-v4/fire-r1/fire-runtime-artifact-draft.json",
});
const SELECTED = Object.freeze({
  shell: Object.freeze({
    id: "shell/functional-hall-house-v4/r4",
    kind: "shell",
    revision: 4,
    gate: "A1-shell",
    facets: Object.freeze(["hearth-flue-sockets", "runtime-geometry"]),
  }),
  materials: Object.freeze({
    id: "materials/functional-hall-house-v4/r2",
    kind: "material-palette",
    revision: 2,
    gate: "M1-materials",
    facets: Object.freeze(["role-contract", "surface-parameters"]),
  }),
  interiorPlan: Object.freeze({
    id: "interior/functional-hall-house-v4/r4",
    kind: "interior-plan",
    revision: 4,
    gate: "I1-layout",
    facets: Object.freeze(["vfx-intent"]),
  }),
});
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonicalHash = (value) => sha(Buffer.from(canonicalStringify(value)));
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const portable = (root, path) => {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../"))
    throw new Error(`fire runtime path escapes repository: ${path}`);
  return value;
};

async function loadBytes(root, path) {
  const fullPath = resolve(root, path),
    bytes = await readFile(fullPath);
  return Object.freeze({ fullPath, path: portable(root, fullPath), bytes, sha256: sha(bytes) });
}
async function loadJson(root, path) {
  const loaded = await loadBytes(root, path);
  return Object.freeze({ ...loaded, json: JSON.parse(loaded.bytes.toString("utf8")) });
}
function facetMap(artifact) {
  return new Map(artifact.facets.map((facet) => [facet.scope, facet]));
}
function resource(file) {
  return Object.freeze({ path: file.path, sha256: file.sha256 });
}

async function approvedStage(root, artifactPath, selected) {
  const artifactFile = await loadJson(root, artifactPath),
    artifact = validateBuildingStageArtifact(artifactFile.json);
  if (
    artifact.artifactId !== selected.id ||
    artifact.kind !== selected.kind ||
    artifact.revision !== selected.revision ||
    artifact.status !== "approved"
  )
    throw new Error(`${selected.id} is not the exact selected approved stage`);
  const decisionPath = artifact.metadata?.approval?.path;
  if (typeof decisionPath !== "string") throw new Error(`${selected.id} lacks approval decision metadata`);
  const decisionFile = await loadJson(root, decisionPath),
    decision = validateBuildingHitlDecision(decisionFile.json);
  if (decision.decision !== "approve" || decision.gate !== selected.gate || decision.blockingFindings.length !== 0)
    throw new Error(`${selected.id} lacks an exact unblocked ${selected.gate} approval`);
  for (const key of ["artifactId", "contractHash", "contentHash"])
    if (decision[key] !== artifact[key]) throw new Error(`${selected.id} approval ${key} drifted`);
  if (
    artifact.metadata.approval.sha256 !== decisionFile.sha256 ||
    JSON.stringify([...decision.evidenceHashes].sort()) !==
      JSON.stringify(artifact.evidence.map((entry) => entry.contentHash).sort())
  )
    throw new Error(`${selected.id} approval bytes or complete evidence set drifted`);
  const facets = facetMap(artifact);
  for (const scope of selected.facets)
    if (!facets.has(scope)) throw new Error(`${selected.id} lacks required facet ${scope}`);
  return Object.freeze({ artifactFile, artifact, decisionFile, decision, facets });
}

async function verifyRecipeAuthority(root, recipeFile, recipe, stages) {
  if (
    recipe.schema !== "limina.hearth-fuel-recipe/v1" ||
    recipe.id !== "fire/functional-hall-house-v4/hearth-fuel/r1" ||
    recipe.revision !== 1 ||
    recipe.status !== "authoring-recipe"
  )
    throw new Error("unsupported finalized hearth fuel recipe identity");
  if ("composition" in (recipe.authority ?? {}))
    throw new Error("C1 composition must not become a V1 content dependency");
  const expected = Object.freeze({
    shell: stages.shell.artifact,
    interiorPlan: stages.interiorPlan.artifact,
    materialsRuntime: stages.materials.artifact,
    materialsLock: stages.materials.artifact,
  });
  const loaded = {};
  for (const [key, artifact] of Object.entries(expected)) {
    const authority = recipe.authority?.[key];
    if (
      !authority ||
      authority.artifactId !== artifact.artifactId ||
      typeof authority.path !== "string" ||
      typeof authority.sha256 !== "string"
    )
      throw new Error(`hearth fuel recipe authority ${key} is incomplete`);
    loaded[key] = await loadBytes(root, authority.path);
    if (loaded[key].sha256 !== authority.sha256) throw new Error(`hearth fuel recipe authority ${key} bytes drifted`);
  }
  if (
    loaded.shell.sha256 !== stages.shell.artifact.contentHash ||
    loaded.materialsRuntime.sha256 !== stages.materials.artifact.contentHash ||
    loaded.interiorPlan.sha256 !== stages.interiorPlan.artifact.contentHash ||
    stages.materials.artifact.metadata?.materialsLock?.sha256 !== loaded.materialsLock.sha256
  )
    throw new Error("hearth fuel recipe does not bind the exact selected A1/M1/I1 runtime resources");
  const parts = Array.isArray(recipe.parts) ? recipe.parts : [],
    logs = parts.filter((part) => part.kind === "log"),
    coals = parts.filter((part) => part.kind === "coal-pocket"),
    beds = parts.filter((part) => part.kind === "ember-bed");
  if (
    logs.length !== 3 ||
    coals.length < 8 ||
    beds.length !== 1 ||
    new Set(parts.map((part) => part.id)).size !== parts.length
  )
    throw new Error("finalized hearth fuel recipe inventory is incomplete or ambiguous");
  return Object.freeze({ loaded: Object.freeze(loaded), logs, coals, emberBed: beds[0] });
}

async function verifyBuildEvidence(root, recipeFile, recipe, inventory, evidenceFile) {
  const evidence = evidenceFile.json;
  if (
    evidence.schema !== "limina.hearth-fuel-build-evidence/v1" ||
    evidence.id !== recipe.id ||
    evidence.status !== "cpu-authored-unreviewed" ||
    evidence.rendered !== false ||
    evidence.gpuUsed !== false
  )
    throw new Error("hearth fuel build evidence identity or CPU-only attestation drifted");
  if (
    evidence.recipe?.path !== recipeFile.path ||
    evidence.recipe?.sha256 !== recipeFile.sha256 ||
    evidence.recipe?.canonicalHash !== canonicalHash(recipe)
  )
    throw new Error("hearth fuel build evidence recipe identity drifted");
  if (JSON.stringify(evidence.authority) !== JSON.stringify(recipe.authority))
    throw new Error("hearth fuel build evidence authority drifted");
  if (
    evidence.inventory?.logs !== inventory.logs.length ||
    evidence.inventory?.coalPockets !== inventory.coals.length ||
    evidence.inventory?.emberBeds !== 1 ||
    evidence.inventory?.parts !== recipe.parts.length
  )
    throw new Error("hearth fuel build evidence inventory drifted");
  if (
    JSON.stringify(evidence.glbValidation?.semanticPartIds) !== JSON.stringify(recipe.parts.map((part) => part.id)) ||
    evidence.glbValidation?.rootSemanticId !== recipe.export.rootSemanticId ||
    evidence.glbValidation?.cameras !== 0 ||
    evidence.glbValidation?.lights !== 0
  )
    throw new Error("hearth fuel semantic GLB validation drifted");
  if (
    JSON.stringify(evidence.runtimeOwnership) !==
    JSON.stringify({
      included: ["fuel-logs", "ember-bed"],
      excluded: ["flames", "light", "smoke", "soot-heat-treatment"],
    })
  )
    throw new Error("hearth fuel/runtime ownership boundary drifted");
  const [blend, glb] = await Promise.all([
    loadBytes(root, evidence.sourceBlend?.path ?? "__missing_blend__"),
    loadBytes(root, evidence.asset?.path ?? "__missing_glb__"),
  ]);
  for (const [label, file, record] of [
    ["source blend", blend, evidence.sourceBlend],
    ["runtime GLB", glb, evidence.asset],
  ])
    if (record.sha256 !== file.sha256 || record.bytes !== file.bytes.length)
      throw new Error(`hearth fuel ${label} bytes drifted`);
  if (
    recipe.export.assetId !== glb.path.replace(/^assets\//, "") ||
    recipe.export.blendId !== blend.path.replace(/^assets\//, "")
  )
    throw new Error("hearth fuel outputs disagree with recipe export paths");
  return Object.freeze({ evidence, blend, glb });
}

function dependency(stage, selected) {
  return Object.freeze({
    artifactId: stage.artifact.artifactId,
    kind: stage.artifact.kind,
    revision: stage.artifact.revision,
    status: stage.artifact.status,
    contractHash: stage.artifact.contractHash,
    contentHash: stage.artifact.contentHash,
    approvalDecision: Object.freeze({ decisionId: stage.decision.decisionId, sha256: stage.decisionFile.sha256 }),
    facets: Object.freeze(selected.facets.map((scope) => Object.freeze({ ...stage.facets.get(scope) }))),
  });
}
function boxFromMinMax(bounds, inset = [0, 0, 0]) {
  return Object.freeze({
    center: Object.freeze(bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2)),
    halfExtents: Object.freeze(bounds.min.map((value, axis) => (bounds.max[axis] - value) / 2 - inset[axis])),
  });
}
function logContract(part) {
  const first = part.ringProfile[0],
    last = part.ringProfile.at(-1),
    yaw = Math.atan2(part.axis[2], part.axis[0]);
  return Object.freeze({
    id: part.id,
    socketId: "socket/fire/fuel",
    materialRole: "hearth-soot",
    lengthM: part.lengthM,
    radiusM: part.radiusM,
    radialSegments: part.radialSegments,
    profileRadii: Object.freeze(part.ringProfile.map((ring) => ring.radiusScale)),
    bend: Object.freeze([
      last.offsetA - first.offsetA,
      last.offsetB - first.offsetB,
      (last.twistRadians - first.twistRadians) * 0.1,
    ]),
    rotationRadians: Object.freeze([0, yaw, 0]),
  });
}
function coalContract(part, emberPosition, index, count) {
  return Object.freeze({
    id: part.id,
    socketId: "socket/fire/ember",
    materialRole: "hearth-embers",
    offset: Object.freeze(part.center.map((value, axis) => value - emberPosition[axis])),
    halfExtents: Object.freeze([...part.halfExtents]),
    emission01: Number((0.35 + (0.45 * index) / Math.max(1, count - 1)).toFixed(6)),
  });
}
function flame(
  id,
  region,
  heightM,
  widthM,
  phase01,
  frequencyHz,
  lateralAmplitudeM,
  heightAmplitudeM,
  noiseOctaves,
  ribbonCount,
  segments,
) {
  return Object.freeze({
    id,
    region,
    socketId: "socket/fire/flame",
    materialRole: `flame-${region}`,
    geometry: "ribbon-stack",
    ribbonCount,
    segments,
    heightM,
    widthM,
    phase01,
    deformation: Object.freeze({ frequencyHz, lateralAmplitudeM, heightAmplitudeM, noiseOctaves }),
  });
}

function contractFor(stages, recipe, inventory, built) {
  const opening = boxFromMinMax(recipe.firebox.openingBounds),
    fuel = boxFromMinMax(recipe.firebox.conservativeFuelBounds),
    containment = Object.freeze({
      center: Object.freeze([opening.center[0], 1.08, opening.center[2]]),
      halfExtents: Object.freeze([
        Math.min(0.56, opening.halfExtents[0] - 0.02),
        0.62,
        Math.min(0.46, opening.halfExtents[2] - 0.02),
      ]),
    }),
    emberPosition = Object.freeze([...inventory.emberBed.center]);
  return {
    schema: "limina.building-fire-runtime/v1",
    packageId: "fire/functional-hall-house-v4/v1",
    revision: 1,
    dependencies: {
      shell: dependency(stages.shell, SELECTED.shell),
      materials: dependency(stages.materials, SELECTED.materials),
      interiorPlan: dependency(stages.interiorPlan, SELECTED.interiorPlan),
    },
    shellInterface: {
      fireplaceId: "hall-hearth",
      coordinateSpace: "building-root-y-up-meters",
      sourceSemanticIds: {
        base: "fireplace/hall-hearth/base",
        cavity: "fireplace/hall-hearth/cavity",
        fireback: "fireplace/hall-hearth/fireback",
        throat: "fireplace/hall-hearth/throat",
        flueLiners: [
          "chimney/hall/flue-liner-east",
          "chimney/hall/flue-liner-north",
          "chimney/hall/flue-liner-south",
          "chimney/hall/flue-liner-west",
        ],
      },
      aperture: opening,
      containment,
      occlusion: Object.freeze({
        center: opening.center,
        halfExtents: Object.freeze([opening.halfExtents[0], opening.halfExtents[1] + 0.06, opening.halfExtents[2]]),
      }),
      flue: Object.freeze({ center: Object.freeze([2.95, 2.2, 2.7]), halfExtents: Object.freeze([0.3, 0.6, 0.3]) }),
      sockets: [
        Object.freeze({
          id: "socket/fire/ember",
          kind: "ember",
          position: emberPosition,
          direction: Object.freeze([0, 1, 0]),
        }),
        Object.freeze({
          id: "socket/fire/flame",
          kind: "flame",
          position: Object.freeze([2.95, 0.53, 2.72]),
          direction: Object.freeze([0, 1, 0]),
        }),
        Object.freeze({
          id: "socket/fire/fuel",
          kind: "fuel",
          position: fuel.center,
          direction: Object.freeze([0, 1, 0]),
        }),
        Object.freeze({
          id: "socket/fire/light",
          kind: "light",
          position: Object.freeze([2.95, 0.82, 2.32]),
          direction: Object.freeze([0, 0, -1]),
        }),
      ],
    },
    materialRoles: ["flame-inner", "flame-outer", "hearth-embers", "hearth-soot"],
    fuelAsset: {
      recipeId: recipe.id,
      sourceBlend: resource(built.blend),
      runtimeGlb: Object.freeze({ ...resource(built.glb), assetId: recipe.export.assetId }),
      logs: inventory.logs.map(logContract).sort((a, b) => a.id.localeCompare(b.id)),
      coals: inventory.coals
        .map((part, index) => coalContract(part, emberPosition, index, inventory.coals.length))
        .sort((a, b) => a.id.localeCompare(b.id)),
      emberBed: Object.freeze({
        id: inventory.emberBed.id,
        socketId: "socket/fire/ember",
        materialRole: "hearth-embers",
        halfExtents: Object.freeze([...inventory.emberBed.halfExtents]),
      }),
    },
    visuals: {
      flameLayers: [
        flame("flame/inner-a", "inner", 0.44, 0.14, 0.11, 2.3, 0.06, 0.1, 3, 3, 9),
        flame("flame/inner-b", "inner", 0.34, 0.11, 0.37, 3.1, 0.045, 0.08, 3, 2, 8),
        flame("flame/outer-a", "outer", 0.74, 0.3, 0.62, 1.7, 0.1, 0.17, 4, 4, 11),
        flame("flame/outer-b", "outer", 0.58, 0.23, 0.89, 2.7, 0.08, 0.13, 3, 3, 10),
      ],
      embers: Object.freeze({
        socketId: "socket/fire/ember",
        materialRole: "hearth-embers",
        pulseFrequencyHz: 0.7,
        pulseAmplitude01: 0.3,
      }),
      smoke: Object.freeze({ enabled: false, flueTraversalClaim: false, absorbBeforeThroat: true }),
    },
    light: {
      socketId: "socket/fire/light",
      colorPolicy: "building-fire-runtime-warm-flicker-srgb",
      baseCandela: 7.4,
      flickerAmplitudeCandela: 0.4,
      distanceM: 5.5,
      decay: 2,
      castsShadow: true,
    },
    simulation: {
      authority: "explicit-authoritative-tick",
      tickHz: 60,
      seed: 0x48454152,
      phases: ["off", "igniting", "burning", "extinguishing"],
      commands: ["extinguish", "start"],
      parameters: {
        ignitionTicks: 90,
        extinguishTicks: 150,
        lightBaseCandela: 7.4,
        lightFlickerCandela: 0.4,
        lightDistanceM: 5.5,
        lightDecay: 2,
      },
      initialState: { tick: 0, phase: "off", phaseStartedTick: 0, transitionStartEnvelopeQ: 0 },
      snapshot: {
        schema: "limina.building-fire-runtime-snapshot/v1",
        authorityFields: ["parameters", "schema", "seed", "state", "tickHz"],
        stateFields: ["phase", "phaseStartedTick", "tick", "transitionStartEnvelopeQ"],
        canonicalReplayRequired: true,
      },
    },
    lifecycle: {
      start: true,
      burn: true,
      extinguish: true,
      save: true,
      restoreReplay: true,
      idempotentTeardown: true,
      resourceBaselineRequired: true,
    },
    budgets: {
      maxDrawCalls: 10,
      maxTriangles: 12000,
      maxParticles: 64,
      maxCpuUpdateMsP95: 0.5,
      maxOwnedLights: 1,
      maxOwnedMaterials: 4,
      timestampQueriesEnabled: false,
    },
    evidenceContract: {
      renderer: "limina-production-native-engine",
      minimumResolution: [1920, 1080],
      sampleTicks: [
        { id: "off-initial", tick: 0, phase: "off" },
        { id: "ignition", tick: 45, phase: "igniting" },
        { id: "burn-a", tick: 120, phase: "burning" },
        { id: "burn-b", tick: 150, phase: "burning" },
        { id: "burn-c", tick: 180, phase: "burning" },
        { id: "burn-d", tick: 210, phase: "burning" },
        { id: "extinguish", tick: 270, phase: "extinguishing" },
        { id: "off-final", tick: 420, phase: "off" },
      ],
      views: [
        {
          id: "fuel-detail",
          role: "fuel-detail",
          position: [1.55, 1.05, 1.05],
          target: [2.95, 0.65, 2.72],
          fovDeg: 42,
        },
        {
          id: "hearth-motion",
          role: "flame-motion",
          position: [0.9, 1.45, -0.35],
          target: [2.95, 0.95, 2.7],
          fovDeg: 52,
        },
        {
          id: "reflected-light",
          role: "reflected-light",
          position: [-0.8, 1.6, -1.7],
          target: [2.95, 1.1, 2.7],
          fovDeg: 58,
        },
      ],
      exposure: { pairedOffOn: true, maxClippedPixelFraction: 0.0025, maxChannelP99: 0.98 },
      humanDecisionRequired: true,
    },
  };
}

export async function buildFireRuntimeStage({
  repoRoot = resolve(import.meta.dirname, "../.."),
  paths = {},
  write = true,
} = {}) {
  const root = resolve(repoRoot),
    selectedPaths = Object.freeze({ ...DEFAULTS, ...paths });
  const [shell, materials, interiorPlan, recipeFile, evidenceFile] = await Promise.all([
      approvedStage(root, selectedPaths.shellArtifact, SELECTED.shell),
      approvedStage(root, selectedPaths.materialArtifact, SELECTED.materials),
      approvedStage(root, selectedPaths.interiorArtifact, SELECTED.interiorPlan),
      loadJson(root, selectedPaths.recipe),
      loadJson(root, selectedPaths.buildEvidence),
    ]),
    stages = Object.freeze({ shell, materials, interiorPlan });
  const inventory = await verifyRecipeAuthority(root, recipeFile, recipeFile.json, stages),
    built = await verifyBuildEvidence(root, recipeFile, recipeFile.json, inventory, evidenceFile);
  const contract = validateBuildingFireRuntimeV1(contractFor(stages, recipeFile.json, inventory, built)),
    contractHash = buildingFireRuntimeV1Hash(contract),
    contractBytes = jsonBytes(contract),
    contentHash = sha(contractBytes);
  const facetPayloads = Object.freeze({
    "socket-requirements": contract.shellInterface,
    "state-machine": Object.freeze({
      phases: contract.simulation.phases,
      commands: contract.simulation.commands,
      initialState: contract.simulation.initialState,
    }),
    "authoritative-parameters": Object.freeze({
      light: contract.light,
      tickHz: contract.simulation.tickHz,
      seed: contract.simulation.seed,
      parameters: contract.simulation.parameters,
      snapshot: contract.simulation.snapshot,
    }),
    "runtime-visuals": Object.freeze({
      materialRoles: contract.materialRoles,
      fuelAsset: contract.fuelAsset,
      visuals: contract.visuals,
    }),
    "light-exposure": Object.freeze({ light: contract.light, exposure: contract.evidenceContract.exposure }),
    "performance-lifecycle": Object.freeze({ lifecycle: contract.lifecycle, budgets: contract.budgets }),
  });
  const facets = BUILDING_STAGE_FACETS["fire-runtime"].map((scope) =>
    Object.freeze({
      scope,
      hash: canonicalHash({ schema: "limina.fire-runtime-facet/v1", scope, payload: facetPayloads[scope] }),
    }),
  );
  const artifact = validateBuildingStageArtifact({
    schema: "limina.building-stage-artifact/v1",
    artifactId: "fire/functional-hall-house-v4/r1",
    kind: "fire-runtime",
    revision: 1,
    status: "draft",
    contractHash,
    contentHash,
    facets,
    inputs: [SELECTED.shell, SELECTED.materials, SELECTED.interiorPlan].map((selected, index) => {
      const stage = [shell, materials, interiorPlan][index];
      return Object.freeze({
        artifactId: stage.artifact.artifactId,
        kind: stage.artifact.kind,
        facets: selected.facets.map((scope) => Object.freeze({ ...stage.facets.get(scope) })),
      });
    }),
    evidence: [],
    metadata: {
      gate: "V1-vfx",
      humanDecision: "not-reviewed",
      contract: Object.freeze({
        path: portable(root, resolve(root, selectedPaths.contractOutput)),
        sha256: contentHash,
        canonicalHash: contractHash,
      }),
      hearthFuel: Object.freeze({
        recipe: resource(recipeFile),
        buildEvidence: resource(evidenceFile),
        sourceBlend: resource(built.blend),
        runtimeGlb: resource(built.glb),
      }),
      smoke: Object.freeze({ enabled: false, flueTraversalClaim: false, absorbBeforeThroat: true }),
      runtimeAuthority: Object.freeze({
        snapshotSchema: contract.simulation.snapshot.schema,
        tickHz: contract.simulation.tickHz,
        timestampQueriesEnabled: false,
      }),
      cpuOnlyBuild: true,
    },
  });
  const artifactBytes = jsonBytes(artifact);
  if (write) {
    const contractOutput = resolve(root, selectedPaths.contractOutput),
      artifactOutput = resolve(root, selectedPaths.artifactOutput);
    portable(root, contractOutput);
    portable(root, artifactOutput);
    for (const output of [contractOutput, artifactOutput])
      try {
        await readFile(output);
        throw new Error(`append-only fire runtime stage output already exists: ${portable(root, output)}`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    await Promise.all([
      mkdir(dirname(contractOutput), { recursive: true, mode: 0o700 }),
      mkdir(dirname(artifactOutput), { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(contractOutput, contractBytes, { flag: "wx", mode: 0o600 });
    await writeFile(artifactOutput, artifactBytes, { flag: "wx", mode: 0o600 });
  }
  return Object.freeze({ contract, contractHash, contractBytes, artifact, artifactBytes });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await buildFireRuntimeStage();
  console.log(
    JSON.stringify(
      {
        packageId: result.contract.packageId,
        contractHash: result.contractHash,
        artifactId: result.artifact.artifactId,
        status: result.artifact.status,
        smoke: result.contract.visuals.smoke,
      },
      null,
      2,
    ),
  );
}
