import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { buildingCompositionManifestV2Hash, validateBuildingCompositionManifestV2 } from "../../js/src/assets/building-composition-manifest-v2.mjs";
import { validateBuildingHitlDecision, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { verifyFurnishedC1Composition } from "../architecture/verify-furnished-c1-composition.mjs";

const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const SOURCE_SHA256 = "adabb56bd808ea0731ec6f45531bc99ecb7670a8cf232769c9e93cc3c8fe94dd";
const COMPOSITION_ID = "composition/functional-hall-house-v4/r3";
const APPROVED = Object.freeze({
  manifest: Object.freeze({ path: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/composition-manifest.json", sha256: "12b822f1fc688d0b4fed45f8d4bfc1a1c7acf8a781d443c55e2ca2d90f002a3e" }),
  artifact: Object.freeze({ path: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/composition-artifact-approved.json", sha256: "1c699d4f1a8c9fbfe7bab5e03c0f4664b16ba3e7141bb6928edb15b6e2717fdb" }),
  decision: Object.freeze({ path: "assets/qc/internal/compositions/functional-hall-house-v4-c1-r3-v2/review-decision-approve.json", sha256: "b4a53f78b4cf032b7989b2e88989aee976faaf1b5b5068e6aabe3c8d18e7a5e6" }),
  authority: Object.freeze({ path: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/review-authority-v2.json", sha256: "d64b907c14024e529ee3316df4ec043890ff614a587287228693d3ad7defcfa7" }),
  capture: Object.freeze({ path: "assets/qc/internal/compositions/functional-hall-house-v4-c1-r3-v2/capture-evidence.json", sha256: "9f498efefa1e26d1830d3f0be76af033033d215a4f0a54a3fd0184b6450268f8" }),
  functional: Object.freeze({ path: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/functional-evidence-v2.json", sha256: "dbe152534d8261c4a7b74caf2702dab61f6c3c5a84125f18d57eb13b8bec3085" }),
  build: Object.freeze({ path: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/build-evidence.json", sha256: "7c18144a19ab9b8dadfd274734d24b66b4186ab91df1dfb936cd1502501ffd39" }),
  blend: Object.freeze({ path: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/furnished-c1-r3.blend", sha256: "5c0fa1aa5e237bf61eaa2e37690122b9b9d5fded8fca8ceb20e979a56eec34c1" }),
  glb: Object.freeze({ path: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/furnished-c1-r3.glb", sha256: SOURCE_SHA256 }),
  materialRuntime: Object.freeze({ path: "assets/buildings/authoring/functional-hall-house-v4/material-r2/runtime/shell-m1-production.glb", sha256: "5d973e3f6e0dcc0a150c5f08e58682aae22d3af87808e78f1ef3844209150b88" }),
  canonicalManifestHash: "sha256:5a904a1d629aa82fa2b32e0ebb82dbc70c7da45428ebae22793f0ab0078fecd6",
});
const EXPECTED = Object.freeze({
  buildingRoot: 393,
  compositionRoot: 654,
  doorRoot: 79,
  doorNodes: 14,
  staticSources: 487,
  shellTriangles: 5772,
  furnitureTriangles: 3360,
  measurements: Object.freeze([
    Object.freeze({ level: 0, triangles: 9132, sourcePrimitiveCount: 487 }),
    Object.freeze({ level: 1, triangles: 5052, sourcePrimitiveCount: 279 }),
    Object.freeze({ level: 2, triangles: 2748, sourcePrimitiveCount: 231 }),
  ]),
  sourceMaterials: 34,
  materials: 16,
  sourceTextures: 90,
  textures: 21,
  images: 21,
});

const pad4 = (value) => (value + 3) & ~3;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function containedPath(path, label) {
  if (isAbsolute(path)) throw new Error(`composition production LOD: ${label} must be workspace-relative`);
  const absolute = resolve(path);
  const rel = relative(resolve("."), absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`composition production LOD: ${label} escapes the workspace`);
  }
  return absolute;
}

async function exactApprovedResource(resource, label, json = false) {
  const path = containedPath(resource.path, label);
  const bytes = await readFile(path);
  const actual = sha256(bytes);
  if (actual !== resource.sha256) throw new Error(`composition production LOD: exact approved ${label} bytes drifted`);
  return { path: resource.path, bytes, ...(json ? { json: JSON.parse(bytes.toString("utf8")) } : {}) };
}

async function verifyApprovedC1Authority(input, source) {
  if (input !== resolve(APPROVED.glb.path)) throw new Error("composition production LOD: input must be the exact approved C1 r3 GLB path");
  const functional = await verifyFurnishedC1Composition({ manifestPath: APPROVED.manifest.path });
  if (functional.verdict !== "pass" || functional.summary?.failed !== 0 || functional.inputs?.manifestSha256 !== `sha256:${APPROVED.manifest.sha256}`
    || functional.inputs?.manifestHash !== APPROVED.canonicalManifestHash) {
    throw new Error("composition production LOD: furnished C1 functional closure no longer passes");
  }
  const [manifestFile, artifactFile, decisionFile, authorityFile, captureFile, functionalFile, buildFile, blendFile, glbFile, materialRuntimeFile] = await Promise.all([
    exactApprovedResource(APPROVED.manifest, "manifest", true),
    exactApprovedResource(APPROVED.artifact, "artifact", true),
    exactApprovedResource(APPROVED.decision, "decision", true),
    exactApprovedResource(APPROVED.authority, "authority", true),
    exactApprovedResource(APPROVED.capture, "capture", true),
    exactApprovedResource(APPROVED.functional, "functional evidence", true),
    exactApprovedResource(APPROVED.build, "build evidence", true),
    exactApprovedResource(APPROVED.blend, "Blend source"),
    exactApprovedResource(APPROVED.glb, "GLB source"),
    exactApprovedResource(APPROVED.materialRuntime, "M1 material runtime"),
  ]);
  if (!glbFile.bytes.equals(source)) throw new Error("composition production LOD: input bytes differ from the approved GLB authority");
  const manifest = validateBuildingCompositionManifestV2(manifestFile.json);
  if (manifest.id !== COMPOSITION_ID || manifest.revision !== 3 || buildingCompositionManifestV2Hash(manifest) !== APPROVED.canonicalManifestHash) {
    throw new Error("composition production LOD: approved composition manifest identity drifted");
  }
  if (manifest.dependencies.materialPalette.runtimeGlb.path !== APPROVED.materialRuntime.path
    || manifest.dependencies.materialPalette.runtimeGlb.sha256 !== `sha256:${APPROVED.materialRuntime.sha256}`) {
    throw new Error("composition production LOD: approved composition no longer binds the exact M1 material runtime");
  }
  const artifact = validateBuildingStageArtifact(artifactFile.json);
  const decision = validateBuildingHitlDecision(decisionFile.json);
  const evidenceHashes = artifact.evidence.map((entry) => entry.contentHash);
  if (artifact.artifactId !== COMPOSITION_ID || artifact.kind !== "composition" || artifact.status !== "approved"
    || artifact.contractHash !== APPROVED.canonicalManifestHash || artifact.contentHash !== `sha256:${SOURCE_SHA256}`
    || artifact.metadata?.fireExcluded !== true || artifact.metadata?.lodClosure !== "not-claimed"
    || artifact.metadata?.approval?.path !== APPROVED.decision.path || artifact.metadata?.approval?.sha256 !== `sha256:${APPROVED.decision.sha256}`
    || decision.schema !== "limina.building-hitl-decision/v1" || decision.decision !== "approve" || decision.artifactId !== artifact.artifactId
    || decision.contractHash !== artifact.contractHash || decision.contentHash !== artifact.contentHash || decision.blockingFindings.length !== 0
    || canonical(decision.evidenceHashes) !== canonical(evidenceHashes)) {
    throw new Error("composition production LOD: exact C1 approval binding drifted");
  }
  const expectedBindings = [
    [artifact.metadata.authority, APPROVED.authority], [artifact.metadata.capture, APPROVED.capture],
    [artifact.metadata.functionalEvidence, APPROVED.functional], [artifact.metadata.integratedSource?.evidence, APPROVED.build],
    [artifact.metadata.integratedSource?.blend, APPROVED.blend], [artifact.metadata.integratedSource?.glb, APPROVED.glb],
  ];
  if (expectedBindings.some(([binding, expected]) => binding?.path !== expected.path || binding?.sha256 !== `sha256:${expected.sha256}`)) {
    throw new Error("composition production LOD: approved artifact resource binding drifted");
  }
  const authority = authorityFile.json;
  if (authority.manifest?.path !== APPROVED.manifest.path || authority.manifest?.sha256 !== `sha256:${APPROVED.manifest.sha256}`
    || authority.manifest?.canonicalHash !== APPROVED.canonicalManifestHash || authority.integratedSource?.glb?.sha256 !== `sha256:${SOURCE_SHA256}`
    || authority.integratedSource?.blend?.sha256 !== `sha256:${APPROVED.blend.sha256}`
    || authority.integratedSource?.evidence?.sha256 !== `sha256:${APPROVED.build.sha256}`
    || authority.functionalEvidence?.sha256 !== `sha256:${APPROVED.functional.sha256}`
    || authority.approvalPolicy?.fireExcluded !== true || captureFile.json.backend !== "native-webgpu"
    || functionalFile.json.verdict !== "pass" || buildFile.json.asset?.sha256 !== `sha256:${SOURCE_SHA256}`) {
    throw new Error("composition production LOD: authority, capture, functional, or build closure drifted");
  }
  const materialRuntime = parseGlb(materialRuntimeFile.bytes).json;
  const functionalAuthority = materialRuntime.asset?.extras?.liminaFunctionalBuilding;
  const materialScene = materialRuntime.scenes?.[materialRuntime.scene ?? 0];
  const materialRoot = materialRuntime.nodes?.[materialScene?.nodes?.[0]];
  if (functionalAuthority?.schema !== "limina.functional-building/v1" || functionalAuthority.rootNodeId !== "building/root"
    || materialRuntime.scenes?.length !== 1 || materialRuntime.scene !== 0 || materialScene?.nodes?.length !== 1
    || materialRoot?.extras?.limina?.id !== functionalAuthority.rootNodeId || materialRoot?.extras?.limina?.role !== "root") {
    throw new Error("composition production LOD: exact M1 functional building authority is invalid");
  }
  return { manifest, artifact, decision, functional, functionalAuthority, blendBytes: blendFile.bytes.length };
}

function parseGlb(bytes) {
  if (bytes.byteLength < 28 || bytes.readUInt32LE(0) !== MAGIC || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.byteLength) {
    throw new Error("composition production LOD: source is not a complete GLB 2.0 file");
  }
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== JSON_CHUNK || 20 + jsonLength + 8 > bytes.byteLength) {
    throw new Error("composition production LOD: GLB JSON chunk is malformed");
  }
  const binaryHeader = 20 + jsonLength;
  const binaryLength = bytes.readUInt32LE(binaryHeader);
  if (bytes.readUInt32LE(binaryHeader + 4) !== BIN_CHUNK || binaryHeader + 8 + binaryLength !== bytes.byteLength) {
    throw new Error("composition production LOD: GLB must contain exactly one complete BIN chunk");
  }
  return {
    json: JSON.parse(bytes.subarray(20, binaryHeader).toString().trim()),
    binary: bytes.subarray(binaryHeader + 8),
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(stableValue(value));
}

function withoutName(value) {
  if (Array.isArray(value)) return value.map(withoutName);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "name").map(([key, child]) => [key, withoutName(child)]));
  }
  return value;
}

function remapMaterialTextures(material, textureMap) {
  const visit = (value, parentKey = "") => {
    if (Array.isArray(value)) return value.map((child) => visit(child, parentKey));
    if (value === null || typeof value !== "object") return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "index" && Number.isInteger(child) && parentKey.toLowerCase().includes("texture")) {
        if (textureMap[child] === undefined) throw new Error(`composition production LOD: material texture ${child} is out of range`);
        output[key] = textureMap[child];
      } else output[key] = visit(child, key);
    }
    return output;
  };
  return visit(material);
}

function dedupeRepresentation(gltf) {
  if (gltf.textures?.length !== EXPECTED.sourceTextures || gltf.materials?.length !== EXPECTED.sourceMaterials || gltf.images?.length !== EXPECTED.images) {
    throw new Error("composition production LOD: approved source representation counts drifted");
  }
  const textureKeys = new Map();
  const textureMap = [];
  const textures = [];
  for (const texture of gltf.textures) {
    const key = canonical(withoutName(texture));
    let index = textureKeys.get(key);
    if (index === undefined) {
      index = textures.length;
      textureKeys.set(key, index);
      textures.push(texture);
    }
    textureMap.push(index);
  }
  if (textures.length !== EXPECTED.textures) throw new Error(`composition production LOD: expected 21 canonical textures, found ${textures.length}`);

  const remappedMaterials = gltf.materials.map((material) => remapMaterialTextures(material, textureMap));
  const materialKeys = new Map();
  const materialMap = [];
  const materials = [];
  for (const material of remappedMaterials) {
    const key = canonical(withoutName(material));
    let index = materialKeys.get(key);
    if (index === undefined) {
      index = materials.length;
      materialKeys.set(key, index);
      materials.push(material);
    }
    materialMap.push(index);
  }
  if (materials.length !== EXPECTED.materials) throw new Error(`composition production LOD: expected 16 canonical materials, found ${materials.length}`);
  for (const mesh of gltf.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
    if (!Number.isInteger(primitive.material) || materialMap[primitive.material] === undefined) {
      throw new Error("composition production LOD: primitive material closure failed");
    }
    primitive.material = materialMap[primitive.material];
  }
  gltf.textures = textures;
  gltf.materials = materials;
  return { textureMap, materialMap };
}

function multiply(a, b) {
  const output = Array(16).fill(0);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) {
    output[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  }
  return output;
}

function localMatrix(node) {
  if (node.matrix !== undefined) {
    if (!Array.isArray(node.matrix) || node.matrix.length !== 16 || node.matrix.some((value) => !Number.isFinite(value))) {
      throw new Error("composition production LOD: invalid authored node matrix");
    }
    return node.matrix;
  }
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  if ([x, y, z, w, sx, sy, sz, tx, ty, tz].some((value) => !Number.isFinite(value)) || sx === 0 || sy === 0 || sz === 0) {
    throw new Error("composition production LOD: invalid authored node transform");
  }
  return [
    (1 - 2 * y * y - 2 * z * z) * sx, (2 * x * y + 2 * w * z) * sx, (2 * x * z - 2 * w * y) * sx, 0,
    (2 * x * y - 2 * w * z) * sy, (1 - 2 * x * x - 2 * z * z) * sy, (2 * y * z + 2 * w * x) * sy, 0,
    (2 * x * z + 2 * w * y) * sz, (2 * y * z - 2 * w * x) * sz, (1 - 2 * x * x - 2 * y * y) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function transformPoint(matrix, [x, y, z]) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

/** Transform a column-vector normal by the inverse transpose of a column-major affine matrix. */
export function transformCompositionNormal(matrix, [x, y, z]) {
  const a = matrix[0], b = matrix[4], c = matrix[8];
  const d = matrix[1], e = matrix[5], f = matrix[9];
  const h = matrix[2], i = matrix[6], j = matrix[10];
  const determinant = a * (e * j - f * i) - b * (d * j - f * h) + c * (d * i - e * h);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error("composition production LOD: singular world transform");
  const nx = ((e * j - f * i) * x + (f * h - d * j) * y + (d * i - e * h) * z) / determinant;
  const ny = ((c * i - b * j) * x + (a * j - c * h) * y + (b * h - a * i) * z) / determinant;
  const nz = ((b * f - c * e) * x + (c * d - a * f) * y + (a * e - b * d) * z) / determinant;
  const length = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(length) || length < 1e-12) throw new Error("composition production LOD: invalid transformed normal");
  return [nx / length, ny / length, nz / length];
}

function accessorReader(gltf, binary) {
  const componentCounts = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const componentSizes = { 5123: 2, 5125: 4, 5126: 4 };
  return (index) => {
    const accessor = gltf.accessors?.[index];
    const view = gltf.bufferViews?.[accessor?.bufferView];
    const components = componentCounts[accessor?.type];
    const size = componentSizes[accessor?.componentType];
    if (!accessor || !view || accessor.sparse !== undefined || accessor.normalized === true || !components || !size || view.buffer !== 0) {
      throw new Error(`composition production LOD: unsupported accessor ${index}`);
    }
    const stride = view.byteStride ?? components * size;
    const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    if (base < 0 || base + Math.max(0, accessor.count - 1) * stride + components * size > binary.byteLength) {
      throw new Error(`composition production LOD: accessor ${index} exceeds the BIN chunk`);
    }
    const rows = [];
    for (let row = 0; row < accessor.count; row++) {
      const values = [];
      for (let component = 0; component < components; component++) {
        const offset = base + row * stride + component * size;
        values.push(accessor.componentType === 5126 ? binary.readFloatLE(offset)
          : accessor.componentType === 5125 ? binary.readUInt32LE(offset) : binary.readUInt16LE(offset));
      }
      rows.push(components === 1 ? values[0] : values);
    }
    return rows;
  };
}

function descendants(nodes, root) {
  const result = new Set();
  const visit = (index) => {
    if (!Number.isInteger(index) || !nodes[index]) throw new Error("composition production LOD: hierarchy references an invalid node");
    if (result.has(index)) throw new Error("composition production LOD: articulated door hierarchy contains a cycle or duplicate");
    result.add(index);
    for (const child of nodes[index].children ?? []) visit(child);
  };
  visit(root);
  return result;
}

function encodeGlb(gltf, binary) {
  const json = Buffer.from(JSON.stringify(gltf));
  const jsonPadded = Buffer.concat([json, Buffer.alloc(pad4(json.length) - json.length, 0x20)]);
  const binPadded = Buffer.concat([binary, Buffer.alloc(pad4(binary.length) - binary.length)]);
  const output = Buffer.alloc(12 + 8 + jsonPadded.length + 8 + binPadded.length);
  output.writeUInt32LE(MAGIC, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonPadded.length, 12);
  output.writeUInt32LE(JSON_CHUNK, 16);
  jsonPadded.copy(output, 20);
  const binaryHeader = 20 + jsonPadded.length;
  output.writeUInt32LE(binPadded.length, binaryHeader);
  output.writeUInt32LE(BIN_CHUNK, binaryHeader + 4);
  binPadded.copy(output, binaryHeader + 8);
  return output;
}

export async function batchCompositionProductionLod(inputPath, outputPath) {
  const input = containedPath(inputPath, "input");
  const output = containedPath(outputPath, "output");
  if (input === output) throw new Error("composition production LOD: output must not overwrite the approved source");
  const source = await readFile(input);
  const sourceSha256 = sha256(source);
  if (sourceSha256 !== SOURCE_SHA256) throw new Error(`composition production LOD: approved C1 r3 source hash mismatch ${sourceSha256}`);
  const approved = await verifyApprovedC1Authority(input, source);
  const { json: gltf, binary: sourceBinary } = parseGlb(source);
  const composition = gltf.asset?.extras?.liminaBuildingComposition;
  if (composition?.schema !== "limina.building-composition-manifest/v2" || composition.id !== COMPOSITION_ID || composition.revision !== 3) {
    throw new Error("composition production LOD: exact approved C1 r3 manifest is missing");
  }
  if (!Array.isArray(gltf.nodes) || !Array.isArray(gltf.meshes) || !Array.isArray(gltf.scenes) || !Array.isArray(gltf.buffers) || gltf.buffers.length !== 1) {
    throw new Error("composition production LOD: source glTF structure is unsupported");
  }
  const semanticIds = gltf.nodes.map((node) => node.extras?.limina?.id ?? node.extras?.["limina.id"]).filter((id) => typeof id === "string");
  const semanticRoles = gltf.nodes.map((node) => node.extras?.limina?.role ?? node.extras?.["limina.role"]);
  const doorAnimation = gltf.animations?.filter((animation) => animation.name === "door/front/open") ?? [];
  if (semanticIds.length !== 654 || new Set(semanticIds).size !== 654
    || semanticRoles.filter((role) => role === "collider").length !== 123
    || semanticRoles.filter((role) => role === "socket").length !== 12
    || semanticRoles.filter((role) => role === "composition-instance").length !== 7
    || gltf.skins !== undefined || gltf.meshes.some((mesh) => mesh.weights !== undefined || mesh.primitives?.some((primitive) => primitive.targets !== undefined))
    || doorAnimation.length !== 1 || doorAnimation[0].channels?.length !== 1 || doorAnimation[0].channels[0].target?.node !== EXPECTED.doorRoot
    || doorAnimation[0].channels[0].target?.path !== "rotation") {
    throw new Error("composition production LOD: semantic, collider, socket, instance, skin, morph, or door-animation closure drifted");
  }
  const originalSceneRoots = [...gltf.scenes[gltf.scene ?? 0].nodes];
  const originalChildren = gltf.nodes.map((node) => node.children === undefined ? undefined : [...node.children]);
  const buildingRoot = gltf.nodes.findIndex((node) => node.extras?.limina?.id === approved.functionalAuthority.rootNodeId
    && node.extras?.limina?.role === "root");
  const compositionRoot = gltf.nodes.findIndex((node) => node.extras?.["limina.id"] === COMPOSITION_ID
    && node.extras?.["limina.role"] === "building-composition");
  if (buildingRoot !== EXPECTED.buildingRoot || compositionRoot !== EXPECTED.compositionRoot
    || canonical(originalSceneRoots) !== canonical([buildingRoot, compositionRoot])
    || canonical(localMatrix(gltf.nodes[buildingRoot])) !== canonical(identity())) {
    throw new Error("composition production LOD: canonical building/composition root closure drifted");
  }
  gltf.asset.extras.liminaFunctionalBuilding = approved.functionalAuthority;

  dedupeRepresentation(gltf);
  const parents = Array(gltf.nodes.length).fill(-1);
  gltf.nodes.forEach((node, index) => (node.children ?? []).forEach((child) => {
    if (!Number.isInteger(child) || !gltf.nodes[child] || parents[child] !== -1) throw new Error("composition production LOD: node hierarchy is not a tree");
    parents[child] = index;
  }));
  const world = gltf.nodes.map((_, index) => {
    const chain = [];
    for (let cursor = index; cursor >= 0; cursor = parents[cursor]) chain.push(cursor);
    return chain.reverse().reduce((matrix, nodeIndex) => multiply(matrix, localMatrix(gltf.nodes[nodeIndex])), identity());
  });
  const doorRoot = gltf.nodes.findIndex((node) => node.extras?.limina?.role === "door");
  if (doorRoot !== EXPECTED.doorRoot) throw new Error(`composition production LOD: articulated door root drifted to ${doorRoot}`);
  const doorNodes = descendants(gltf.nodes, doorRoot);
  if (doorNodes.size !== EXPECTED.doorNodes) throw new Error(`composition production LOD: articulated door subtree drifted to ${doorNodes.size} nodes`);

  const readAccessor = accessorReader(gltf, sourceBinary);
  const groups = Array.from({ length: gltf.materials.length }, () => []);
  const sources = [];
  let shellTriangles = 0;
  let furnitureTriangles = 0;
  for (let nodeIndex = 0; nodeIndex < gltf.nodes.length; nodeIndex++) {
    const node = gltf.nodes[nodeIndex];
    if (node.mesh === undefined || doorNodes.has(nodeIndex)) continue;
    const shell = node.extras?.limina?.role === "architecture-primitive";
    const furniture = node.extras?.["limina.role"] === "furniture-part" && typeof node.extras?.["limina.compositionInstanceId"] === "string";
    if (shell === furniture) throw new Error(`composition production LOD: unclassified static visual node ${nodeIndex}`);
    const levels = shell ? node.extras?.limina?.lodLevels : [0];
    if (!Array.isArray(levels) || levels.length === 0 || levels[0] !== 0 || levels.some((level, index) => ![0, 1, 2].includes(level) || index > 0 && level <= levels[index - 1])) {
      throw new Error(`composition production LOD: invalid LOD authority on node ${nodeIndex}`);
    }
    const mesh = gltf.meshes[node.mesh];
    if (!mesh || mesh.primitives?.length !== 1) throw new Error(`composition production LOD: static node ${nodeIndex} must own exactly one primitive`);
    const primitive = mesh.primitives[0];
    if ((primitive.mode ?? 4) !== 4 || primitive.indices === undefined || primitive.attributes?.POSITION === undefined || primitive.attributes?.NORMAL === undefined
      || Object.keys(primitive.attributes).some((attribute) => !["POSITION", "NORMAL", "TEXCOORD_0"].includes(attribute))) {
      throw new Error(`composition production LOD: unsupported static primitive on node ${nodeIndex}`);
    }
    const positions = readAccessor(primitive.attributes.POSITION).map((value) => transformPoint(world[nodeIndex], value));
    const normals = readAccessor(primitive.attributes.NORMAL).map((value) => transformCompositionNormal(world[nodeIndex], value));
    const uv = primitive.attributes.TEXCOORD_0 === undefined ? positions.map(() => [0, 0]) : readAccessor(primitive.attributes.TEXCOORD_0);
    const indices = readAccessor(primitive.indices);
    if (positions.length !== normals.length || positions.length !== uv.length || indices.length % 3 !== 0 || indices.some((index) => !Number.isInteger(index) || index < 0 || index >= positions.length)) {
      throw new Error(`composition production LOD: malformed static primitive on node ${nodeIndex}`);
    }
    const record = { nodeIndex, levels, positions, normals, uv, indices, kind: shell ? "shell" : "furniture" };
    groups[primitive.material].push(record);
    sources.push(record);
    if (shell) shellTriangles += indices.length / 3;
    else furnitureTriangles += indices.length / 3;
    delete node.mesh;
  }
  if (sources.length !== EXPECTED.staticSources || shellTriangles !== EXPECTED.shellTriangles || furnitureTriangles !== EXPECTED.furnitureTriangles) {
    throw new Error(`composition production LOD: static closure drifted (${sources.length} sources, ${shellTriangles} shell tris, ${furnitureTriangles} furniture tris)`);
  }

  const chunks = [Buffer.from(sourceBinary)];
  const views = gltf.bufferViews;
  const accessors = gltf.accessors;
  let byteLength = sourceBinary.length;
  const append = (buffer, target) => {
    const start = pad4(byteLength);
    chunks.push(Buffer.alloc(start - byteLength), buffer);
    byteLength = start + buffer.length;
    views.push({ buffer: 0, byteOffset: start, byteLength: buffer.length, ...(target === undefined ? {} : { target }) });
    return views.length - 1;
  };
  const addAccessor = (values, type, componentType, target, bounds = false) => {
    const flat = values.flat();
    const size = componentType === 5123 ? 2 : 4;
    const buffer = Buffer.alloc(flat.length * size);
    flat.forEach((value, index) => componentType === 5126 ? buffer.writeFloatLE(value, index * 4)
      : componentType === 5125 ? buffer.writeUInt32LE(value, index * 4) : buffer.writeUInt16LE(value, index * 2));
    const accessor = { bufferView: append(buffer, target), componentType, count: values.length, type };
    if (bounds) {
      accessor.min = [0, 1, 2].map((axis) => Math.min(...values.map((value) => value[axis])));
      accessor.max = [0, 1, 2].map((axis) => Math.max(...values.map((value) => value[axis])));
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };

  const lodRoots = [];
  const measurements = [];
  for (const level of [0, 1, 2]) {
    gltf.nodes.push({
      name: `${COMPOSITION_ID}/production/LOD${level}`,
      extras: { liminaLod: { level, orphan: level > 0, strategy: "approved-shell-plus-lod0-furniture" } },
      children: [],
    });
    const rootIndex = gltf.nodes.length - 1;
    const root = gltf.nodes[rootIndex];
    lodRoots.push(rootIndex);
    let triangles = 0;
    let sourcePrimitiveCount = 0;
    for (let material = 0; material < groups.length; material++) {
      const selected = groups[material].filter((record) => record.levels.includes(level));
      if (selected.length === 0) continue;
      const positions = [], normals = [], uv = [], indices = [], ranges = [];
      for (const record of selected) {
        const firstIndex = indices.length;
        const base = positions.length;
        positions.push(...record.positions);
        normals.push(...record.normals);
        uv.push(...record.uv);
        indices.push(...record.indices.map((index) => index + base));
        sourcePrimitiveCount++;
        if (level === 0) ranges.push({ record, firstIndex, indexCount: indices.length - firstIndex });
      }
      const indexComponent = positions.length > 65535 ? 5125 : 5123;
      const primitive = {
        attributes: {
          POSITION: addAccessor(positions, "VEC3", 5126, 34962, true),
          NORMAL: addAccessor(normals, "VEC3", 5126, 34962),
          TEXCOORD_0: addAccessor(uv, "VEC2", 5126, 34962),
        },
        indices: addAccessor(indices, "SCALAR", indexComponent, 34963),
        material,
      };
      gltf.meshes.push({ name: `${COMPOSITION_ID}/production/LOD${level}/${gltf.materials[material].name}`, primitives: [primitive] });
      gltf.nodes.push({
        name: `${COMPOSITION_ID}/production/LOD${level}/${gltf.materials[material].name}`,
        mesh: gltf.meshes.length - 1,
        extras: { liminaBatch: { lod: level, material, materialName: gltf.materials[material].name, indexCount: indices.length, sourcePrimitiveCount: selected.length, strategy: "approved-shell-plus-lod0-furniture" } },
      });
      const batchNode = gltf.nodes.length - 1;
      root.children.push(batchNode);
      triangles += indices.length / 3;
      if (level === 0) for (const range of ranges) {
        const min = [0, 1, 2].map((axis) => Math.min(...range.record.positions.map((position) => position[axis])));
        const max = [0, 1, 2].map((axis) => Math.max(...range.record.positions.map((position) => position[axis])));
        gltf.nodes[range.record.nodeIndex].extras.visualBatchRange = {
          schema: "limina.visual-batch-range/1", lod: 0, batchNode, firstIndex: range.firstIndex,
          indexCount: range.indexCount, bounds: { min, max }, material,
          sourceKind: range.record.kind, authoritative: true,
        };
      }
    }
    measurements.push({ level, triangles, draws: root.children.length, sourcePrimitiveCount });
  }
  for (const expected of EXPECTED.measurements) {
    const measured = measurements[expected.level];
    if (measured.triangles !== expected.triangles || measured.sourcePrimitiveCount !== expected.sourcePrimitiveCount) {
      throw new Error(`composition production LOD: LOD${expected.level} closure drifted`);
    }
  }
  const activeScene = gltf.scenes[gltf.scene ?? 0];
  if (!activeScene || !Array.isArray(activeScene.nodes)) throw new Error("composition production LOD: active scene roots are missing");
  const authoredRootChildren = originalChildren[buildingRoot] ?? [];
  if (authoredRootChildren.includes(compositionRoot) || lodRoots.some((root) => authoredRootChildren.includes(root))) {
    throw new Error("composition production LOD: production roots already occur in the authored building hierarchy");
  }
  gltf.nodes[buildingRoot].children = [...authoredRootChildren, compositionRoot, ...lodRoots];
  activeScene.nodes = [buildingRoot];
  if (originalChildren.some((children, index) => index !== buildingRoot && canonical(gltf.nodes[index].children) !== canonical(children))) {
    throw new Error("composition production LOD: authored hierarchy outside building/root changed");
  }
  gltf.asset.extras.liminaStaticBatch = {
    schema: "limina.static-batch/1",
    sourceSha256,
    sourceCompositionId: COMPOSITION_ID,
    lodRoots,
    doorRoot,
    lodStrategy: "approved-shell-plus-lod0-furniture",
    furniturePolicy: "LOD0-only",
    representationDedupe: {
      sourceTextures: EXPECTED.sourceTextures, textures: gltf.textures.length,
      sourceMaterials: EXPECTED.sourceMaterials, materials: gltf.materials.length,
      images: gltf.images.length,
    },
    measurements,
  };
  gltf.buffers[0].byteLength = pad4(byteLength);
  const binary = Buffer.concat([...chunks, Buffer.alloc(pad4(byteLength) - byteLength)]);
  const encoded = encodeGlb(gltf, binary);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, encoded, { flag: "wx" });
  return Object.freeze({
    sha256: sha256(encoded), bytes: encoded.length, sourceSha256,
    compositionId: COMPOSITION_ID, doorRoot, lodRoots: Object.freeze([...lodRoots]),
    measurements: Object.freeze(measurements.map((measurement) => Object.freeze({ ...measurement }))),
    representationDedupe: Object.freeze({ sourceTextures: 90, textures: 21, sourceMaterials: 34, materials: 16, images: 21 }),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("usage: node tools/asset/batch-composition-production-lod.mjs <approved-c1-r3.glb> <new-output.glb>");
  console.log(JSON.stringify(await batchCompositionProductionLod(input, output), null, 2));
}
