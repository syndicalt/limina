import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  validateBuildingHitlDecision,
  validateBuildingStageArtifact,
} from "../../js/src/assets/staged-building-pipeline.mjs";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

export const PRODUCTION_PACKAGE_SCHEMA = "limina.building-production-package/v1";
export const PRODUCTION_PACKAGE_EVIDENCE_SCHEMA = "limina.building-production-package-cpu-evidence/v1";
export const EXACT_R1_PUBLICATION = Object.freeze({
  lodManifest: Object.freeze({
    path: "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/lod-manifest.json",
    sha256: "sha256:6304265870dbee19d2c4c68e915a404718177d69f4cca2ca020ec7a54c83b0a3",
  }),
  ktx2Manifest: Object.freeze({
    path: "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/ktx2-manifest.json",
    sha256: "sha256:5d373926ec66a0e4a6d0d5031fb823873d2b21e4ab9597fb705c6f62c647a966",
  }),
  lodGlb: Object.freeze({
    path: "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/functional-hall-house-v4-lod.glb",
    sha256: "sha256:111b07b7f070d18fb521289c01e9be4b88295b7a4a0970de537491ff798b0fe4",
  }),
  productionGlb: Object.freeze({
    path: "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/functional-hall-house-v4-production.glb",
    sha256: "sha256:20063648f0c7aa7331b348e66bb714b419e2b8a1fa215045fb775d6c0ee3fb99",
  }),
  mountEvidence: Object.freeze({
    path: "traces/building-production-mount-cpu-9ba6f653aa2e8954-76eb0e9cbd511880-residual-v1.json",
    sha256: "sha256:498e869f8e37faf04f05e9e4d334d305d5ea4d70b6383512ac35f10ed926f33c",
  }),
});

const DEFAULT_ROOT = resolve(import.meta.dirname, "../..");
const HASH = /^sha256:[0-9a-f]{64}$/;
const EXPECTED_LODS = Object.freeze([
  Object.freeze({ level: 0, triangles: 9132, draws: 15, sourcePrimitiveCount: 487 }),
  Object.freeze({ level: 1, triangles: 5052, draws: 10, sourcePrimitiveCount: 279 }),
  Object.freeze({ level: 2, triangles: 2748, draws: 10, sourcePrimitiveCount: 231 }),
]);
const EXPECTED_COUNTS = Object.freeze({ semantics: 654, colliders: 123, sockets: 12, instances: 7 });
const EXACT = Object.freeze({
  composition: Object.freeze({
    manifest: Object.freeze({
      path: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/composition-manifest.json",
      sha256: "sha256:12b822f1fc688d0b4fed45f8d4bfc1a1c7acf8a781d443c55e2ca2d90f002a3e",
    }),
    blend: Object.freeze({
      path: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/furnished-c1-r3.blend",
      sha256: "sha256:5c0fa1aa5e237bf61eaa2e37690122b9b9d5fded8fca8ceb20e979a56eec34c1",
    }),
    sourceGlbSha256: "sha256:adabb56bd808ea0731ec6f45531bc99ecb7670a8cf232769c9e93cc3c8fe94dd",
    artifact: Object.freeze({
      path: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/composition-artifact-approved.json",
      sha256: "sha256:1c699d4f1a8c9fbfe7bab5e03c0f4664b16ba3e7141bb6928edb15b6e2717fdb",
    }),
    decision: Object.freeze({
      path: "assets/qc/internal/compositions/functional-hall-house-v4-c1-r3-v2/review-decision-approve.json",
      sha256: "sha256:b4a53f78b4cf032b7989b2e88989aee976faaf1b5b5068e6aabe3c8d18e7a5e6",
    }),
  }),
  materialRuntime: Object.freeze({
    path: "assets/buildings/authoring/functional-hall-house-v4/material-r2/runtime/shell-m1-production.glb",
    sha256: "sha256:5d973e3f6e0dcc0a150c5f08e58682aae22d3af87808e78f1ef3844209150b88",
  }),
  fire: Object.freeze({
    artifact: Object.freeze({
      path: "assets/buildings/authoring/functional-hall-house-v4/fire-r4/fire-runtime-artifact-approved-r15.json",
      sha256: "sha256:d9c0c1034d14919442a5f22e5f0a2330ad0214a87a148e870a59adb27302c783",
    }),
    decision: Object.freeze({
      path: "assets/buildings/authoring/functional-hall-house-v4/fire-r4/fire-review-decision-approve-r15.json",
      sha256: "sha256:1aaed1f7fc3e4d3c41bbce2ae42fa3d84ae190a3c24c933f7650b30035fb9cf5",
    }),
    authority: Object.freeze({
      path: "assets/buildings/authoring/functional-hall-house-v4/fire-r4/fire-review-authority-r7.json",
      sha256: "sha256:2443394c43b083e080bc154f6fa3395c19e7e041ea5b37e79f1f7e8e89580cf0",
    }),
    contract: Object.freeze({
      path: "assets/buildings/authoring/functional-hall-house-v4/fire-r4/fire-runtime-contract.json",
      sha256: "sha256:c769abd3f99373ded28e90e3d0f2660fa65cbb418a31b5efa8bc73bb3123c046",
    }),
  }),
  productionMountSources: Object.freeze([
    Object.freeze({
      path: "js/src/render/building-production-package.ts",
      sha256: "sha256:9ba6f653aa2e89548e0e534f86b0827d80809581806da4bb5b0a4b94381df701",
    }),
    Object.freeze({
      path: "js/src/render/building-fire-production-facet.ts",
      sha256: "sha256:76eb0e9cbd51188064ca7348bb35cac33d45436e2eb724732fc1c2d5ecc7d15b",
    }),
  ]),
  productionMountVerifier: Object.freeze({
    path: "js/test/p_building_production_package.ts",
    sha256: "sha256:e2f2e88313d3069bd1a51490cfd0cc7922afe2c8b8e1591f49d3c45ef6c65f40",
  }),
});

const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
const canonical = (value) => JSON.stringify(stable(value));
const objectHash = (value) => sha(Buffer.from(canonical(value)));
const same = (a, b) => canonical(a) === canonical(b);
const decode = (bytes, label) => {
  try {
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
};
const portable = (root, path) => {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value))
    throw new Error(`production package path escapes repository: ${path}`);
  return value;
};
const confined = (root, value, label) => {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value))
    throw new Error(`${label} must be a workspace-relative path`);
  const path = resolve(root, value);
  portable(root, path);
  return path;
};
const KTX2_MAGIC = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
const glbParts = (bytes, label) => {
  if (
    bytes.length < 28 ||
    bytes.readUInt32LE(0) !== 0x46546c67 ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    throw new Error(`${label} is not a complete GLB 2.0 file`);
  const length = bytes.readUInt32LE(12),
    end = 20 + length;
  if (
    bytes.readUInt32LE(16) !== 0x4e4f534a ||
    end + 8 > bytes.length ||
    bytes.readUInt32LE(end + 4) !== 0x004e4942 ||
    end + 8 + bytes.readUInt32LE(end) !== bytes.length
  )
    throw new Error(`${label} chunk closure is invalid`);
  return { json: decode(bytes.subarray(20, end), `${label} JSON`), binary: bytes.subarray(end + 8) };
};
const glb = (bytes, label) => glbParts(bytes, label).json;

function resourceReader(root, injected) {
  return async (value, label, expectedHash) => {
    const path = confined(root, value, label),
      key = portable(root, path);
    let bytes;
    if (injected?.has(key)) bytes = Buffer.from(injected.get(key));
    else {
      const components = relative(root, path).split(sep).filter(Boolean);
      let cursor = root;
      for (const [index, component] of components.entries()) {
        cursor = resolve(cursor, component);
        const stat = await lstat(cursor);
        if (stat.isSymbolicLink() || (index < components.length - 1 ? !stat.isDirectory() : !stat.isFile()))
          throw new Error(`${label} must be a regular file reached without symlink components`);
      }
      const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(path)]),
        rel = relative(realRoot, realTarget);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error(`${label} resolved outside the real workspace root`);
      bytes = await readFile(path);
    }
    const actual = sha(bytes);
    if (expectedHash !== undefined && actual !== expectedHash) throw new Error(`${label} exact bytes drifted`);
    return Object.freeze({ path: key, bytes, sha256: actual });
  };
}

async function assertSafeOutputParents(root, path) {
  const realRoot = await realpath(root),
    parts = relative(root, dirname(path)).split(sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error(`production package output parent is not a regular directory: ${portable(root, cursor)}`);
      const actual = await realpath(cursor),
        rel = relative(realRoot, actual);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error(`production package output parent resolves outside workspace: ${portable(root, cursor)}`);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
}

function inspectLodGeometry(document) {
  const batch = document.asset?.extras?.liminaStaticBatch,
    measurements = [];
  for (const [level, rootIndex] of (batch?.lodRoots ?? []).entries()) {
    const root = document.nodes?.[rootIndex];
    if (!root || !Array.isArray(root.children)) throw new Error(`production GLB LOD${level} root is invalid`);
    let triangles = 0,
      draws = 0;
    for (const childIndex of root.children) {
      const mesh = document.meshes?.[document.nodes?.[childIndex]?.mesh];
      if (!mesh || !Array.isArray(mesh.primitives) || mesh.primitives.length === 0)
        throw new Error(`production GLB LOD${level} batch child has no mesh`);
      for (const primitive of mesh.primitives) {
        const accessor = document.accessors?.[primitive.indices];
        if (
          (primitive.mode ?? 4) !== 4 ||
          !Number.isSafeInteger(accessor?.count) ||
          accessor.count < 3 ||
          accessor.count % 3 !== 0
        )
          throw new Error(`production GLB LOD${level} primitive is not independently countable triangles`);
        triangles += accessor.count / 3;
        draws++;
      }
    }
    measurements.push({ level, triangles, draws });
  }
  const expected = EXPECTED_LODS.map(({ level, triangles, draws }) => ({ level, triangles, draws }));
  if (!same(measurements, expected))
    throw new Error("production GLB independently derived LOD geometry/draw closure drifted");
  return measurements;
}

function inspectKtx2Payloads(parts, manifest) {
  if (!Array.isArray(manifest.textures) || manifest.textures.length !== 21)
    throw new Error("KTX2 manifest texture records are incomplete");
  let residencyBytes = 0;
  for (let image = 0; image < 21; image++) {
    const descriptor = parts.json.images?.[image],
      view = parts.json.bufferViews?.[descriptor?.bufferView],
      record = manifest.textures.find((entry) => entry.image === image);
    if (!view || view.buffer !== 0 || !Number.isSafeInteger(view.byteLength) || !record)
      throw new Error(`embedded KTX2 image ${image} binding is invalid`);
    const start = view.byteOffset ?? 0,
      payload = parts.binary.subarray(start, start + view.byteLength);
    if (payload.length !== view.byteLength || payload.length < 80 || !payload.subarray(0, 12).equals(KTX2_MAGIC))
      throw new Error(`embedded KTX2 image ${image} payload is invalid`);
    const header = {
        width: payload.readUInt32LE(20),
        height: payload.readUInt32LE(24),
        depth: payload.readUInt32LE(28),
        layers: payload.readUInt32LE(32),
        faces: payload.readUInt32LE(36),
        levels: payload.readUInt32LE(40),
      },
      scheme = payload.readUInt32LE(44);
    const blockBytes = scheme === 2 ? 16 : scheme === 1 ? 8 : 0;
    if (
      blockBytes === 0 ||
      header.width !== 1024 ||
      header.height !== 1024 ||
      header.depth !== 0 ||
      header.layers !== 0 ||
      header.faces !== 1 ||
      header.levels !== 11 ||
      record.ktx2Sha256 !== sha(payload).slice(7) ||
      record.ktx2Bytes !== payload.length ||
      !same(record.ktx2Header, header) ||
      record.transcodeBlockBytes !== blockBytes
    )
      throw new Error(`embedded KTX2 image ${image} header/hash/mode closure drifted`);
    let imageResidency = 0;
    for (let level = 0; level < header.levels; level++)
      imageResidency +=
        Math.ceil(Math.max(1, header.width >> level) / 4) *
        Math.ceil(Math.max(1, header.height >> level) / 4) *
        blockBytes;
    if (record.gpuResidencyBytes !== imageResidency)
      throw new Error(`embedded KTX2 image ${image} independently derived residency drifted`);
    residencyBytes += imageResidency;
  }
  if (residencyBytes !== manifest.gpuResidency?.bytes || residencyBytes > manifest.policy?.maxGpuResidencyBytes)
    throw new Error("independently derived KTX2 residency budget drifted");
  return residencyBytes;
}

async function exactAuthorities(root, read) {
  const entries = await Promise.all([
    ...Object.entries(EXACT.composition)
      .filter(([, value]) => value?.path)
      .map(async ([key, value]) => [key, await read(value.path, `C1 ${key}`, value.sha256)]),
    ["materialRuntime", await read(EXACT.materialRuntime.path, "M1 runtime", EXACT.materialRuntime.sha256)],
    ...Object.entries(EXACT.fire).map(async ([key, value]) => [
      `fire.${key}`,
      await read(value.path, `V1 ${key}`, value.sha256),
    ]),
  ]);
  const files = Object.fromEntries(entries),
    manifest = decode(files.manifest.bytes, "C1 manifest"),
    compositionArtifact = validateBuildingStageArtifact(decode(files.artifact.bytes, "C1 approved artifact"));
  const compositionDecision = validateBuildingHitlDecision(decode(files.decision.bytes, "C1 approval decision"));
  if (
    manifest.id !== "composition/functional-hall-house-v4/r3" ||
    manifest.revision !== 3 ||
    compositionArtifact.status !== "approved" ||
    compositionArtifact.artifactId !== manifest.id ||
    compositionDecision.decision !== "approve" ||
    compositionDecision.artifactId !== manifest.id ||
    compositionDecision.contentHash !== compositionArtifact.contentHash
  )
    throw new Error("exact approved C1 r3 authority is invalid");
  const fireArtifact = validateBuildingStageArtifact(decode(files["fire.artifact"].bytes, "V1 approved artifact")),
    fireDecision = validateBuildingHitlDecision(decode(files["fire.decision"].bytes, "V1 approval decision"));
  const fireAuthority = decode(files["fire.authority"].bytes, "V1 authority"),
    fireContract = decode(files["fire.contract"].bytes, "V1 contract");
  if (
    fireArtifact.artifactId !== "fire/functional-hall-house-v4/r4" ||
    fireArtifact.status !== "approved" ||
    fireArtifact.metadata?.approval?.sha256 !== EXACT.fire.decision.sha256 ||
    fireDecision.decision !== "approve" ||
    fireDecision.artifactId !== fireArtifact.artifactId ||
    fireDecision.contractHash !== fireArtifact.contractHash ||
    fireDecision.contentHash !== fireArtifact.contentHash ||
    fireAuthority.fireStage?.contract?.sha256 !== EXACT.fire.contract.sha256 ||
    fireArtifact.metadata?.runtimeAuthority?.timestampQueriesEnabled !== false
  )
    throw new Error("exact approved V1 r15 authority is invalid");
  const runtimeSources = fireAuthority.runtimeSources,
    fuel = fireAuthority.fuel;
  if (!runtimeSources || !fuel) throw new Error("V1 runtime facet source closure is missing");
  const facetResources = {};
  for (const [key, binding] of Object.entries({
    contract: fireArtifact.metadata.contract,
    recipe: fireArtifact.metadata.hearthFuel.recipe,
    fuelBuildEvidence: fuel.buildEvidence,
    fuelBlend: fuel.sourceBlend,
    fuelGlb: fuel.runtimeGlb,
    runtime: runtimeSources.runtime,
    renderBinding: runtimeSources.renderBinding,
    volumetric: runtimeSources.volumetric,
  })) {
    if (!binding?.path || !HASH.test(binding.sha256)) throw new Error(`V1 ${key} binding is invalid`);
    facetResources[key] = await read(binding.path, `V1 ${key}`, binding.sha256);
  }
  if (
    facetResources.contract.sha256 !== EXACT.fire.contract.sha256 ||
    fireContract.packageId !== "fire/functional-hall-house-v4/v4" ||
    fireContract.revision !== 4
  )
    throw new Error("V1 contract identity drifted");
  const decisions = [
    manifest.dependencies.shell.approvalDecision,
    manifest.dependencies.materialPalette.approvalDecision,
    manifest.dependencies.interiorPlan.approvalDecision,
    ...manifest.dependencies.catalog.map(({ approvalDecision }) => approvalDecision),
    { path: EXACT.composition.decision.path, sha256: EXACT.composition.decision.sha256 },
    { path: EXACT.fire.decision.path, sha256: EXACT.fire.decision.sha256 },
  ];
  for (const decision of decisions) await read(decision.path, `approval decision ${decision.path}`, decision.sha256);
  return { files, manifest, compositionArtifact, fireArtifact, fireAuthority, fireContract, facetResources, decisions };
}

function validateProductionDocument(document, functionalAuthority) {
  const batch = document.asset?.extras?.liminaStaticBatch;
  if (
    batch?.schema !== "limina.static-batch/1" ||
    batch.sourceSha256 !== EXACT.composition.sourceGlbSha256.slice(7) ||
    !same(batch.measurements, EXPECTED_LODS) ||
    batch.furniturePolicy !== "LOD0-only" ||
    !Array.isArray(batch.lodRoots) ||
    batch.lodRoots.length !== 3 ||
    new Set(batch.lodRoots).size !== 3
  )
    throw new Error("production GLB LOD closure drifted");
  if (!same(document.asset?.extras?.liminaFunctionalBuilding, functionalAuthority))
    throw new Error("production GLB shell functional authority drifted");
  const records =
    document.nodes?.map((node) => ({
      id: node.extras?.limina?.id ?? node.extras?.["limina.id"],
      role: node.extras?.limina?.role ?? node.extras?.["limina.role"],
    })) ?? [];
  const roles = records.map(({ role }) => role),
    ids = records.map(({ id }) => id).filter((id) => typeof id === "string");
  if (
    ids.length !== EXPECTED_COUNTS.semantics ||
    new Set(ids).size !== ids.length ||
    roles.filter((role) => role === "collider").length !== EXPECTED_COUNTS.colliders ||
    roles.filter((role) => role === "socket").length !== EXPECTED_COUNTS.sockets ||
    roles.filter((role) => role === "composition-instance").length !== EXPECTED_COUNTS.instances
  )
    throw new Error("production GLB semantic/collider/socket/instance closure drifted");
  const root = document.nodes.findIndex(
    (node) => node.extras?.limina?.id === functionalAuthority.rootNodeId && node.extras?.limina?.role === "root",
  );
  if (root < 0 || !same(document.scenes?.[document.scene ?? 0]?.nodes, [root]))
    throw new Error("production GLB canonical shell root closure drifted");
  if (
    !document.extensionsRequired?.includes("KHR_texture_basisu") ||
    document.images?.length !== 21 ||
    document.textures?.length !== 21 ||
    document.materials?.length !== 16 ||
    document.images.some((image) => image.mimeType !== "image/ktx2") ||
    document.textures.some(
      (texture) =>
        texture.source !== undefined || !Number.isSafeInteger(texture.extensions?.KHR_texture_basisu?.source),
    )
  )
    throw new Error("production GLB Basis/no-fallback closure drifted");
  const inventory = Object.fromEntries(
    [
      ["semantics", ids],
      ["colliders", records.filter(({ role }) => role === "collider").map(({ id }) => id)],
      ["sockets", records.filter(({ role }) => role === "socket").map(({ id }) => id)],
      ["instances", records.filter(({ role }) => role === "composition-instance").map(({ id }) => id)],
    ].map(([key, values]) => {
      if (values.some((id) => typeof id !== "string") || new Set(values).size !== values.length)
        throw new Error(`production GLB ${key} stable-id inventory drifted`);
      return [key, { count: values.length, idsHash: objectHash([...values].sort()) }];
    }),
  );
  return { batch, ids, roles, inventory };
}

export async function inspectProductionPackageInputs({
  repoRoot = DEFAULT_ROOT,
  lodManifestPath,
  ktx2ManifestPath,
  productionMountSources = EXACT.productionMountSources,
  injectedResources,
} = {}) {
  const root = resolve(repoRoot),
    read = resourceReader(root, injectedResources),
    authorities = await exactAuthorities(root, read);
  if (!same(productionMountSources, EXACT.productionMountSources))
    throw new Error("exact stable production mount source paths and hashes are required");
  const mountSources = await Promise.all(
    EXACT.productionMountSources.map((source) =>
      read(source.path, `production mount source ${source.path}`, source.sha256),
    ),
  );
  const mountVerifier = await read(
    EXACT.productionMountVerifier.path,
    "production mount verifier source",
    EXACT.productionMountVerifier.sha256,
  );
  const lodManifestFile = await read(lodManifestPath, "LOD manifest"),
    ktx2ManifestFile = await read(ktx2ManifestPath, "KTX2 manifest"),
    lodManifest = decode(lodManifestFile.bytes, "LOD manifest"),
    ktx2 = decode(ktx2ManifestFile.bytes, "KTX2 manifest");
  if (
    lodManifest.schema !== "limina.composition-production-lod-result/v1" ||
    lodManifest.outputPath !== ktx2.source?.path ||
    lodManifest.inspection?.method !== "independent-embedded-static-batch-inspection" ||
    lodManifest.inspection?.cpuOnly !== true ||
    lodManifest.inspection?.rendered !== false ||
    lodManifest.inspection?.gpuUsed !== false ||
    ktx2.schema !== "limina.glb-ktx2-production/v1" ||
    ktx2.source?.sha256 !== lodManifest.sha256 ||
    ktx2.source?.bytes !== lodManifest.bytes
  )
    throw new Error("LOD/KTX2 manifest chain or CPU inspection authority is inconsistent");
  const lodGlb = await read(ktx2.source.path, "LOD GLB", `sha256:${ktx2.source.sha256}`),
    productionGlb = await read(ktx2.output?.path, "KTX2 production GLB", `sha256:${ktx2.output?.sha256}`);
  if (
    lodGlb.bytes.length !== ktx2.source.bytes ||
    productionGlb.bytes.length !== ktx2.output.bytes ||
    ktx2.output.bytes > ktx2.policy?.maxArtifactBytes ||
    ktx2.gpuResidency?.bytes > ktx2.policy?.maxGpuResidencyBytes ||
    ktx2.gpuResidency?.limitBytes !== ktx2.policy?.maxGpuResidencyBytes ||
    ktx2.policy?.extension !== "KHR_texture_basisu" ||
    ktx2.policy?.fallback !== "none" ||
    ktx2.policy?.expectedImages !== 21 ||
    ktx2.policy?.maxTextureObjects !== 21
  )
    throw new Error("KTX2 production budget/policy closure drifted");
  if (portableAssetContentHash(productionGlb.bytes) !== ktx2.output.engineHash)
    throw new Error("KTX2 production engine content hash drifted");
  const materialDocument = glb(authorities.files.materialRuntime.bytes, "M1 runtime"),
    functionalAuthority = materialDocument.asset?.extras?.liminaFunctionalBuilding;
  if (
    functionalAuthority?.schema !== "limina.functional-building/v1" ||
    functionalAuthority.rootNodeId !== "building/root"
  )
    throw new Error("exact shell functional authority is invalid");
  const lodDocument = glb(lodGlb.bytes, "LOD GLB"),
    productionParts = glbParts(productionGlb.bytes, "KTX2 production GLB"),
    productionDocument = productionParts.json,
    closure = validateProductionDocument(productionDocument, functionalAuthority);
  closure.geometryMeasurements = inspectLodGeometry(productionDocument);
  closure.gpuResidencyBytes = inspectKtx2Payloads(productionParts, ktx2);
  if (
    !same(lodDocument.asset?.extras?.liminaStaticBatch, productionDocument.asset?.extras?.liminaStaticBatch) ||
    !same(lodManifest.measurements, EXPECTED_LODS) ||
    lodManifest.sourceSha256 !== EXACT.composition.sourceGlbSha256.slice(7) ||
    lodManifest.compositionId !== authorities.manifest.id ||
    !same(lodManifest.lodRoots, closure.batch.lodRoots) ||
    lodManifest.doorRoot !== closure.batch.doorRoot
  )
    throw new Error("LOD manifest does not bind the production hierarchy");
  const fuelIds = new Set(
    [
      ...(authorities.fireContract.fuelAsset?.logs ?? []),
      ...(authorities.fireContract.fuelAsset?.coals ?? []),
      authorities.fireContract.fuelAsset?.emberBed,
    ]
      .filter(Boolean)
      .map(({ id }) => id),
  );
  if ([...fuelIds].some((id) => closure.ids.includes(id)))
    throw new Error("V1 fuel was baked into the C1 production GLB");
  return {
    root,
    read,
    authorities,
    mountSources,
    mountVerifier,
    lodManifestFile,
    ktx2ManifestFile,
    lodManifest,
    ktx2,
    lodGlb,
    productionGlb,
    productionDocument,
    closure,
  };
}

function packageFrom(inspected) {
  const { authorities: a, lodManifestFile, ktx2ManifestFile, lodManifest, ktx2, lodGlb, productionGlb } = inspected;
  const approvalDecisions = a.decisions.map(({ path, sha256 }) => ({ path, sha256 }));
  return {
    schema: PRODUCTION_PACKAGE_SCHEMA,
    packageId: "production/functional-hall-house-v4/r1",
    revision: 1,
    status: "draft",
    humanDecision: "pending",
    visualApprovalClaimed: false,
    composition: {
      id: a.manifest.id,
      manifest: { path: EXACT.composition.manifest.path, sha256: EXACT.composition.manifest.sha256 },
      editableBlend: { path: EXACT.composition.blend.path, sha256: EXACT.composition.blend.sha256 },
      approvedArtifact: { path: EXACT.composition.artifact.path, sha256: EXACT.composition.artifact.sha256 },
      approvalDecision: { path: EXACT.composition.decision.path, sha256: EXACT.composition.decision.sha256 },
    },
    runtime: {
      productionGlb: {
        path: productionGlb.path,
        sha256: productionGlb.sha256,
        bytes: productionGlb.bytes.length,
        engineHash: ktx2.output.engineHash,
      },
      lodGlb: { path: lodGlb.path, sha256: lodGlb.sha256, bytes: lodGlb.bytes.length },
      lodManifest: { path: lodManifestFile.path, sha256: lodManifestFile.sha256 },
      ktx2Manifest: { path: ktx2ManifestFile.path, sha256: ktx2ManifestFile.sha256 },
      productionMountSources: inspected.mountSources.map(({ path, sha256 }) => ({ path, sha256 })),
    },
    closure: {
      counts: EXPECTED_COUNTS,
      inventories: inspected.closure.inventory,
      lods: EXPECTED_LODS,
      representation: {
        images: 21,
        textures: 21,
        materials: 16,
        basisExtension: "KHR_texture_basisu",
        rasterFallback: false,
      },
      budgets: {
        artifact: { bytes: ktx2.output.bytes, limitBytes: ktx2.policy.maxArtifactBytes },
        gpuResidency: { bytes: ktx2.gpuResidency.bytes, limitBytes: ktx2.policy.maxGpuResidencyBytes },
      },
      shellFunctionalAuthority: {
        source: EXACT.materialRuntime,
        schema: "limina.functional-building/v1",
        rootNodeId: "building/root",
        hash: objectHash(inspected.productionDocument.asset.extras.liminaFunctionalBuilding),
      },
    },
    runtimeFacets: {
      fire: {
        mount: "separate-runtime-facet",
        bakedIntoProductionGlb: false,
        approvedArtifact: { path: EXACT.fire.artifact.path, sha256: EXACT.fire.artifact.sha256 },
        approvalDecision: { path: EXACT.fire.decision.path, sha256: EXACT.fire.decision.sha256 },
        contract: { path: a.facetResources.contract.path, sha256: a.facetResources.contract.sha256 },
        fuel: {
          recipe: { path: a.facetResources.recipe.path, sha256: a.facetResources.recipe.sha256 },
          buildEvidence: {
            path: a.facetResources.fuelBuildEvidence.path,
            sha256: a.facetResources.fuelBuildEvidence.sha256,
          },
          sourceBlend: { path: a.facetResources.fuelBlend.path, sha256: a.facetResources.fuelBlend.sha256 },
          runtimeGlb: { path: a.facetResources.fuelGlb.path, sha256: a.facetResources.fuelGlb.sha256 },
        },
        proceduralSources: ["runtime", "renderBinding", "volumetric"].map((key) => ({
          path: a.facetResources[key].path,
          sha256: a.facetResources[key].sha256,
        })),
      },
    },
    approvals: { decisions: approvalDecisions },
    buildPolicy: { cpuOnly: true, rendered: false, gpuUsed: false, timestampQueriesEnabled: false, appendOnly: true },
  };
}

async function validateMountEvidence(inspected, manifest, contractHash, mountEvidencePath) {
  const file = await inspected.read(mountEvidencePath, "production mount CPU evidence"),
    value = decode(file.bytes, "production mount CPU evidence");
  const fireSources = Object.fromEntries(
    manifest.runtimeFacets.fire.proceduralSources.map(({ path, sha256 }) => [path, sha256]),
  );
  const approvals = {
    compositionArtifact: manifest.composition.approvedArtifact,
    compositionDecision: manifest.composition.approvalDecision,
    fireArtifact: manifest.runtimeFacets.fire.approvedArtifact,
    fireDecision: manifest.runtimeFacets.fire.approvalDecision,
  };
  if (
    value.schema !== "limina.building-production-mount-cpu-evidence/v1" ||
    value.packageId !== manifest.packageId ||
    !same(value.candidate, { contractHash, contentHash: manifest.runtime.productionGlb.sha256 }) ||
    value.productionGlb?.path !== manifest.runtime.productionGlb.path ||
    value.productionGlb?.sha256 !== manifest.runtime.productionGlb.sha256 ||
    value.productionGlb?.bytes !== manifest.runtime.productionGlb.bytes ||
    value.productionGlb?.engineHash !== manifest.runtime.productionGlb.engineHash ||
    value.productionGlb?.rawSha256 !== manifest.runtime.productionGlb.sha256 ||
    !same(value.manifests?.lod, { ...manifest.runtime.lodManifest, rawSha256: manifest.runtime.lodManifest.sha256 }) ||
    !same(value.manifests?.ktx2, {
      ...manifest.runtime.ktx2Manifest,
      rawSha256: manifest.runtime.ktx2Manifest.sha256,
    }) ||
    !same(value.mountSources, manifest.runtime.productionMountSources) ||
    !same(value.verifierSource, { path: inspected.mountVerifier.path, sha256: inspected.mountVerifier.sha256 }) ||
    !same(value.approvals, approvals) ||
    !same(value.pinnedFireSources, fireSources)
  )
    throw new Error("production mount evidence assembly authority tuple drifted");
  if (
    !same(value.transform, { position: [11.25, 0.4, -7.75], yaw: 0.37 }) ||
    !same(value.inventories, {
      semantics: 654,
      colliders: 123,
      shellColliders: 37,
      furnitureColliders: 86,
      sockets: 12,
      instances: 7,
      doors: 1,
    }) ||
    !same(value.visualMounts, {
      productionBuilding: 1,
      articulatedDoorFromProductionBuilding: 1,
      fuel: 1,
      proceduralFire: 1,
      semanticFurniture: 0,
      reviewComposition: 0,
    }) ||
    !same(value.lifecycle, {
      cycles: 3,
      idempotentDispose: true,
      disposedCommandsRejected: true,
      retryAfterInjectedOneShotTeardownFailure: true,
      reconstructionDeterministic: true,
      snapshotSemanticRoots: 7,
      snapshotSockets: 12,
      fireSnapshotRestore: true,
    }) ||
    !same(value.semanticFurnitureReplayProof, {
      verifierSource: {
        path: "js/test/p_functional_furniture_semantic_only.ts",
        sha256: "sha256:046909bf670a7168424104c8fa9a1846baba49251d08822118aff4a6689082ca",
      },
      actualSkillReplay: true,
      snapshotRestore: true,
      scope: "seven semantic-only C1 furniture instances; package reconstruction is tested separately",
    }) ||
    value.cpuOnly !== true ||
    value.rendered !== false ||
    value.gpuUsed !== false ||
    value.timestampQueriesEnabled !== false
  )
    throw new Error("production mount evidence policy/results drifted");
  if (
    !Array.isArray(value.cycles) ||
    value.cycles.length !== 3 ||
    value.cycles.some(
      (cycle, index) =>
        cycle.cycle !== index ||
        cycle.sceneVisualRoots !== 4 ||
        cycle.sceneRoots !== 4 ||
        cycle.semanticSnapshotRoots !== 7 ||
        cycle.socketCount !== 12 ||
        !HASH.test(cycle.deterministicSignature),
    ) ||
    new Set(value.cycles.map(({ deterministicSignature }) => deterministicSignature)).size !== 1
  )
    throw new Error("production mount evidence reconstruction closure drifted");
  return { file, value };
}

/** Exact immutable authority boundary for the final R1 candidate and future capture authority. */
export function assertExactR1PublicationProfile({
  lodManifestPath,
  ktx2ManifestPath,
  mountEvidencePath,
  inspected,
  mountEvidence,
}) {
  const refs = [
    [
      lodManifestPath,
      EXACT_R1_PUBLICATION.lodManifest.path,
      inspected.lodManifestFile.sha256,
      EXACT_R1_PUBLICATION.lodManifest.sha256,
      "LOD manifest",
    ],
    [
      ktx2ManifestPath,
      EXACT_R1_PUBLICATION.ktx2Manifest.path,
      inspected.ktx2ManifestFile.sha256,
      EXACT_R1_PUBLICATION.ktx2Manifest.sha256,
      "KTX2 manifest",
    ],
    [
      inspected.lodGlb.path,
      EXACT_R1_PUBLICATION.lodGlb.path,
      inspected.lodGlb.sha256,
      EXACT_R1_PUBLICATION.lodGlb.sha256,
      "LOD GLB",
    ],
    [
      inspected.productionGlb.path,
      EXACT_R1_PUBLICATION.productionGlb.path,
      inspected.productionGlb.sha256,
      EXACT_R1_PUBLICATION.productionGlb.sha256,
      "production GLB",
    ],
    [
      mountEvidencePath,
      EXACT_R1_PUBLICATION.mountEvidence.path,
      mountEvidence?.file?.sha256,
      EXACT_R1_PUBLICATION.mountEvidence.sha256,
      "mount evidence",
    ],
  ];
  for (const [actualPath, expectedPath, actualHash, expectedHash, label] of refs) {
    if (actualPath !== expectedPath || actualHash !== expectedHash)
      throw new Error(`exact immutable R1 publication ${label} authority drifted`);
  }
  return Object.freeze({ profile: "functional-hall-house-v4/r1/9ba6f653", verdict: "pass" });
}

export async function buildProductionPackageCandidate({
  repoRoot = DEFAULT_ROOT,
  lodManifestPath,
  ktx2ManifestPath,
  productionMountSources = EXACT.productionMountSources,
  mountEvidencePath,
  assemblyOnly = false,
  manifestOutputPath,
  evidenceOutputPath,
  candidateOutputPath,
  write = true,
  injectedResources,
} = {}) {
  if (!manifestOutputPath || !evidenceOutputPath || !candidateOutputPath)
    throw new Error("manifestOutputPath, evidenceOutputPath, and candidateOutputPath are required");
  const inspected = await inspectProductionPackageInputs({
      repoRoot,
      lodManifestPath,
      ktx2ManifestPath,
      productionMountSources,
      injectedResources,
    }),
    manifest = packageFrom(inspected),
    contractHash = objectHash(manifest);
  if (assemblyOnly && mountEvidencePath !== undefined) throw new Error("assemblyOnly cannot accept mount evidence");
  const mountEvidence = assemblyOnly
    ? undefined
    : await validateMountEvidence(inspected, manifest, contractHash, mountEvidencePath);
  if (!assemblyOnly)
    assertExactR1PublicationProfile({ lodManifestPath, ktx2ManifestPath, mountEvidencePath, inspected, mountEvidence });
  const checks = [
    "exact-approved-c1-r3",
    "exact-approved-v1-r15",
    "editable-blend-bound",
    "lod-chain",
    "basis-no-fallback",
    "budget-closure",
    "semantic-inventory",
    "shell-functional-authority",
    "v1-separate-runtime-facet",
    "approval-decision-hashes",
  ].map((id) => ({ id, verdict: "pass" }));
  checks.push({ id: "integrated-production-mount", verdict: assemblyOnly ? "pending" : "pass" });
  const evidence = {
    schema: PRODUCTION_PACKAGE_EVIDENCE_SCHEMA,
    packageId: manifest.packageId,
    contractHash,
    verdict: assemblyOnly ? "mount-pending" : "pass",
    cpuOnly: true,
    rendered: false,
    gpuUsed: false,
    humanDecision: "pending",
    checks,
    inputs: {
      lodManifest: manifest.runtime.lodManifest,
      ktx2Manifest: manifest.runtime.ktx2Manifest,
      productionGlb: manifest.runtime.productionGlb,
      productionMountSources: manifest.runtime.productionMountSources,
      productionMountVerifier: { path: inspected.mountVerifier.path, sha256: inspected.mountVerifier.sha256 },
      ...(mountEvidence === undefined
        ? {}
        : { mountEvidence: { path: mountEvidence.file.path, sha256: mountEvidence.file.sha256 } }),
    },
  };
  const evidenceHash = objectHash(evidence);
  const facets = {
    "asset-closure": { composition: manifest.composition, runtime: manifest.runtime },
    "semantic-closure": { counts: manifest.closure.counts, inventories: manifest.closure.inventories },
    "texture-closure": { representation: manifest.closure.representation, budgets: manifest.closure.budgets },
    "lod-closure": manifest.closure.lods,
    "runtime-closure": {
      shellFunctionalAuthority: manifest.closure.shellFunctionalAuthority,
      runtimeFacets: manifest.runtimeFacets,
    },
  };
  const candidate = validateBuildingStageArtifact({
    schema: "limina.building-stage-artifact/v1",
    artifactId: manifest.packageId,
    kind: "production-package",
    revision: 1,
    status: "candidate",
    contractHash,
    contentHash: manifest.runtime.productionGlb.sha256,
    facets: Object.entries(facets).map(([scope, value]) => ({ scope, hash: objectHash(value) })),
    inputs: [
      {
        artifactId: inspected.authorities.compositionArtifact.artifactId,
        kind: "composition",
        facets: inspected.authorities.compositionArtifact.facets,
      },
      {
        artifactId: inspected.authorities.fireArtifact.artifactId,
        kind: "fire-runtime",
        facets: inspected.authorities.fireArtifact.facets,
      },
    ],
    evidence: [
      {
        evidenceId: `${manifest.packageId}/cpu-closure`,
        kind: "cpu-production-package-closure",
        contentHash: evidenceHash,
      },
      {
        evidenceId: `${manifest.packageId}/lod-manifest`,
        kind: "lod-manifest-json",
        contentHash: manifest.runtime.lodManifest.sha256,
      },
      {
        evidenceId: `${manifest.packageId}/ktx2-manifest`,
        kind: "ktx2-production-manifest-json",
        contentHash: manifest.runtime.ktx2Manifest.sha256,
      },
      ...(mountEvidence === undefined
        ? []
        : [
            {
              evidenceId: `${manifest.packageId}/production-mount`,
              kind: "cpu-production-mount-evidence",
              contentHash: mountEvidence.file.sha256,
            },
          ]),
    ],
    metadata: {
      gate: "R1-release",
      humanDecision: "pending",
      visualApprovalClaimed: false,
      cpuOnly: true,
      rendered: false,
      gpuUsed: false,
      timestampQueriesEnabled: false,
      manifest: {
        path: portable(inspected.root, resolve(inspected.root, manifestOutputPath)),
        canonicalHash: contractHash,
      },
      evidence: {
        path: portable(inspected.root, resolve(inspected.root, evidenceOutputPath)),
        canonicalHash: evidenceHash,
      },
      fireMount: "separate-runtime-facet",
      productionMountEvidence:
        mountEvidence === undefined ? "pending" : { path: mountEvidence.file.path, sha256: mountEvidence.file.sha256 },
    },
  });
  if (write) {
    const outputs = [manifestOutputPath, evidenceOutputPath, candidateOutputPath].map((path) =>
      confined(inspected.root, path, "output"),
    );
    if (new Set(outputs).size !== outputs.length) throw new Error("production package output paths must be distinct");
    for (const path of outputs) {
      await assertSafeOutputParents(inspected.root, path);
      try {
        await lstat(path);
        throw new Error(`production package output already exists: ${portable(inspected.root, path)}`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await Promise.all(outputs.map((path) => mkdir(dirname(path), { recursive: true, mode: 0o700 })));
    for (const path of outputs) await assertSafeOutputParents(inspected.root, path);
    for (const [path, value] of [
      [outputs[0], manifest],
      [outputs[1], evidence],
      [outputs[2], candidate],
    ])
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return Object.freeze({ manifest, evidence, candidate });
}

export async function verifyProductionPackageCandidate({
  repoRoot = DEFAULT_ROOT,
  manifestPath,
  evidencePath,
  candidatePath,
  injectedResources,
} = {}) {
  const root = resolve(repoRoot),
    read = resourceReader(root, injectedResources),
    manifestFile = await read(manifestPath, "package manifest"),
    evidenceFile = await read(evidencePath, "package evidence"),
    candidateFile = await read(candidatePath, "package candidate");
  const actualManifest = decode(manifestFile.bytes, "package manifest"),
    actualEvidence = decode(evidenceFile.bytes, "package evidence"),
    actualCandidate = validateBuildingStageArtifact(decode(candidateFile.bytes, "package candidate"));
  const assemblyOnly = actualCandidate.metadata?.productionMountEvidence === "pending",
    mountEvidencePath = assemblyOnly ? undefined : actualCandidate.metadata?.productionMountEvidence?.path;
  const rebuilt = await buildProductionPackageCandidate({
    repoRoot: root,
    lodManifestPath: actualManifest.runtime?.lodManifest?.path,
    ktx2ManifestPath: actualManifest.runtime?.ktx2Manifest?.path,
    productionMountSources: actualManifest.runtime?.productionMountSources,
    mountEvidencePath,
    assemblyOnly,
    manifestOutputPath: manifestPath,
    evidenceOutputPath: evidencePath,
    candidateOutputPath: candidatePath,
    write: false,
    injectedResources,
  });
  if (
    !same(actualManifest, rebuilt.manifest) ||
    !same(actualEvidence, rebuilt.evidence) ||
    !same(actualCandidate, rebuilt.candidate)
  )
    throw new Error("production package candidate is not the deterministic pending CPU closure");
  if (
    actualManifest.status !== "draft" ||
    actualManifest.humanDecision !== "pending" ||
    actualManifest.visualApprovalClaimed !== false ||
    actualCandidate.status !== "candidate" ||
    actualCandidate.metadata?.humanDecision !== "pending"
  )
    throw new Error("production package improperly claims R1 approval");
  return Object.freeze({
    verdict: "pass",
    manifestSha256: manifestFile.sha256,
    evidenceSha256: evidenceFile.sha256,
    candidateSha256: candidateFile.sha256,
    contractHash: actualCandidate.contractHash,
    humanDecision: "pending",
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2),
    at = (flag) => {
      const index = args.indexOf(flag);
      if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`);
      return args[index + 1];
    };
  const assemblyOnly = args.includes("--assembly-only"),
    result = await buildProductionPackageCandidate({
      lodManifestPath: at("--lod-manifest"),
      ktx2ManifestPath: at("--ktx2-manifest"),
      ...(assemblyOnly ? { assemblyOnly: true } : { mountEvidencePath: at("--mount-evidence") }),
      manifestOutputPath: at("--manifest-out"),
      evidenceOutputPath: at("--evidence-out"),
      candidateOutputPath: at("--candidate-out"),
    });
  console.log(
    JSON.stringify(
      {
        packageId: result.manifest.packageId,
        status: result.candidate.status,
        humanDecision: result.candidate.metadata.humanDecision,
        contractHash: result.candidate.contractHash,
      },
      null,
      2,
    ),
  );
}
