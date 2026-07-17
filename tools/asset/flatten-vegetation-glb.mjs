import { createHash, randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { getBounds, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { flatten, join } from "@gltf-transform/functions";
import { inspectGlbAsset } from "../qc/asset-manifest.mjs";

export const SUMMARY_SCHEMA = "limina.vegetation-flatten/1";

function hash(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function canonical(value) { return JSON.stringify(value); }
function rounded(value) { return Number(value.toFixed(6)); }

function textureContracts(document) {
  return document.getRoot().listTextures().map((texture) => {
    const image = texture.getImage();
    if (!(image instanceof Uint8Array)) throw new Error("flattening requires embedded texture payloads");
    return { mimeType: texture.getMimeType(), byteLength: image.byteLength, sha256: hash(image) };
  }).sort((a, b) => canonical(a).localeCompare(canonical(b)));
}

function materialContracts(document) {
  const textureHash = new Map(document.getRoot().listTextures().map((texture) => {
    const image = texture.getImage();
    if (!(image instanceof Uint8Array)) throw new Error("flattening requires embedded texture payloads");
    return [texture, hash(image)];
  }));
  const slot = (texture) => texture === null ? null : textureHash.get(texture);
  return document.getRoot().listMaterials().map((material) => ({
    baseColorFactor: material.getBaseColorFactor().map(rounded),
    emissiveFactor: material.getEmissiveFactor().map(rounded),
    metallicFactor: rounded(material.getMetallicFactor()),
    roughnessFactor: rounded(material.getRoughnessFactor()),
    alphaMode: material.getAlphaMode(),
    alphaCutoff: rounded(material.getAlphaCutoff()),
    doubleSided: material.getDoubleSided(),
    slots: {
      baseColor: slot(material.getBaseColorTexture()),
      metallicRoughness: slot(material.getMetallicRoughnessTexture()),
      normal: slot(material.getNormalTexture()),
      occlusion: slot(material.getOcclusionTexture()),
      emissive: slot(material.getEmissiveTexture()),
    },
  })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
}

function primitiveMaterialGroups(document) {
  const materials = document.getRoot().listMaterials();
  const groups = new Map();
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const material = primitive.getMaterial();
    const materialIndex = material === null ? -1 : materials.indexOf(material);
    const semantics = primitive.listSemantics().sort();
    const key = `${materialIndex}|${primitive.getMode()}|${semantics.join(",")}`;
    const current = groups.get(key) ?? { materialIndex, mode: primitive.getMode(), semantics, vertices: 0, elements: 0 };
    current.vertices += primitive.getAttribute("POSITION")?.getCount() ?? 0;
    current.elements += primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")?.getCount() ?? 0;
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
}

async function serializedRenderContract(io, document) {
  const { json } = await io.writeJSON(document);
  return {
    materials: json.materials ?? [],
    samplers: json.samplers ?? [],
    textures: json.textures ?? [],
    extensionsUsed: json.extensionsUsed ?? [],
    extensionsRequired: json.extensionsRequired ?? [],
  };
}

function documentBounds(document) {
  const scene = document.getRoot().getDefaultScene();
  if (scene === null) throw new Error("flattening requires a default scene");
  const bounds = getBounds(scene);
  return { min: bounds.min.map(rounded), max: bounds.max.map(rounded) };
}

async function snapshot(io, document, bytes) {
  return {
    metrics: inspectGlbAsset(bytes),
    bounds: documentBounds(document),
    textures: textureContracts(document),
    materials: materialContracts(document),
    primitiveMaterialGroups: primitiveMaterialGroups(document),
    serializedRenderContract: await serializedRenderContract(io, document),
    animations: document.getRoot().listAnimations().length,
    skins: document.getRoot().listSkins().length,
  };
}

function maxBoundsDelta(before, after) {
  const values = [];
  for (const key of ["min", "max"]) for (let axis = 0; axis < 3; axis++) values.push(Math.abs(before[key][axis] - after[key][axis]));
  return Math.max(...values);
}

function assertPreserved(before, after, maxMeshes) {
  if (before.animations !== 0 || before.skins !== 0) throw new Error("animated or skinned GLBs are outside the lossless vegetation flatten contract");
  if (after.metrics.vertexCount !== before.metrics.vertexCount) throw new Error(`flatten changed vertex count (${before.metrics.vertexCount} -> ${after.metrics.vertexCount})`);
  if (after.metrics.triangleCount !== before.metrics.triangleCount) throw new Error(`flatten changed triangle count (${before.metrics.triangleCount} -> ${after.metrics.triangleCount})`);
  const boundsDelta = maxBoundsDelta(before.bounds, after.bounds);
  if (boundsDelta > 0.00001 || after.metrics.boundsM.some((value, axis) => Math.abs(value - before.metrics.boundsM[axis]) > 0.00001)) {
    throw new Error(`flatten changed measured bounds beyond 0.00001m (${canonical(before.bounds)} -> ${canonical(after.bounds)})`);
  }
  if (canonical(after.textures) !== canonical(before.textures)) throw new Error("flatten changed embedded texture payload bytes or MIME types");
  if (canonical(after.materials) !== canonical(before.materials)) throw new Error("flatten changed material factors, texture bindings, or PBR slots");
  if (canonical(after.primitiveMaterialGroups) !== canonical(before.primitiveMaterialGroups)) throw new Error("flatten changed primitive-to-material assignments or vertex contracts");
  if (canonical(after.serializedRenderContract) !== canonical(before.serializedRenderContract)) {
    throw new Error("flatten changed material extensions, texture coordinates, samplers, or texture bindings");
  }
  if (after.metrics.materialCount !== before.metrics.materialCount) throw new Error("flatten changed material count");
  if (after.metrics.meshCount > maxMeshes) throw new Error(`flatten produced ${after.metrics.meshCount} meshes, exceeding target ${maxMeshes}`);
  if (after.metrics.meshCount >= before.metrics.meshCount) throw new Error(`flatten did not reduce mesh count (${before.metrics.meshCount} -> ${after.metrics.meshCount})`);
}

async function atomicWrite(path, bytes) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function flattenVegetationGlb({ input, output = input, maxMeshes = 2 }) {
  if (typeof input !== "string" || input.length === 0 || typeof output !== "string" || output.length === 0) throw new TypeError("input/output must be non-empty paths");
  if (!Number.isSafeInteger(maxMeshes) || maxMeshes < 1 || maxMeshes > 2) throw new RangeError("maxMeshes must be 1 or 2");
  const inputPath = await realpath(resolve(input));
  const outputPath = resolve(output);
  if (extname(inputPath).toLowerCase() !== ".glb" || extname(outputPath).toLowerCase() !== ".glb") throw new Error("input/output must use .glb");
  const inputBytes = await readFile(inputPath);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.readBinary(inputBytes);
  const before = await snapshot(io, document, inputBytes);
  if (before.metrics.meshCount <= maxMeshes) throw new Error(`input already has ${before.metrics.meshCount} mesh(es), within target ${maxMeshes}`);

  await document.transform(flatten({ cleanup: false }), join({ keepNamed: false, cleanup: true }));
  const outputBytes = await io.writeBinary(document);
  const after = await snapshot(io, document, outputBytes);
  assertPreserved(before, after, maxMeshes);
  await atomicWrite(outputPath, outputBytes);
  return Object.freeze({
    schema: SUMMARY_SCHEMA,
    input: inputPath,
    output: outputPath,
    bytesBefore: inputBytes.byteLength,
    bytesAfter: outputBytes.byteLength,
    sha256Before: hash(inputBytes),
    sha256After: hash(outputBytes),
    metricsBefore: before.metrics,
    metricsAfter: after.metrics,
    texturePayloadsPreserved: true,
    materialContractsPreserved: true,
    maxBoundsDeltaM: maxBoundsDelta(before.bounds, after.bounds),
  });
}
