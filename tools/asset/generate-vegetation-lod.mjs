import { createHash, randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { NodeIO, Primitive } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { simplify } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";

export const SUMMARY_SCHEMA = "limina.vegetation-lod/1";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const MESHOPT_EXTENSION = "EXT_meshopt_compression";
const DRACO_EXTENSION = "KHR_draco_mesh_compression";

function assertUnitInterval(name, value, { allowZero }) {
  if (!Number.isFinite(value) || value > 1 || value < 0 || (!allowZero && value === 0)) {
    const interval = allowZero ? "[0, 1]" : "(0, 1]";
    throw new TypeError(`${name} must be a finite number in ${interval}; received ${String(value)}`);
  }
}

function parseGlbJson(bytes, label) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error(`${label} is not a GLB 2.0 binary`);
  }
  if (view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) {
    throw new Error(`${label} has an invalid GLB header`);
  }
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK_TYPE || 20 + jsonLength > bytes.byteLength) {
    throw new Error(`${label} has an invalid GLB JSON chunk`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).trimEnd());
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${error.message}`, { cause: error });
  }
}

function assertNoUnsupportedCompression(json, label) {
  const used = new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]);
  const compression = [MESHOPT_EXTENSION, DRACO_EXTENSION].find((extension) => used.has(extension));
  if (compression) {
    throw new Error(`${label} uses ${compression}; compressed GLBs are not supported by this pipeline`);
  }
}

function primitiveTriangleCount(primitive) {
  const elementCount = primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")?.getCount() ?? 0;
  switch (primitive.getMode()) {
    case Primitive.Mode.TRIANGLES:
      return Math.floor(elementCount / 3);
    case Primitive.Mode.TRIANGLE_STRIP:
    case Primitive.Mode.TRIANGLE_FAN:
      return Math.max(0, elementCount - 2);
    default:
      return 0;
  }
}

function triangleCount(document) {
  let count = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) count += primitiveTriangleCount(primitive);
  }
  return count;
}

function snapshotPrimitiveContracts(document) {
  return document.getRoot().listMeshes().map((mesh) => mesh.listPrimitives().map((primitive) => ({
    material: primitive.getMaterial(),
    hasNormal: primitive.getAttribute("NORMAL") !== null,
    texcoords: primitive.listSemantics().filter((semantic) => semantic.startsWith("TEXCOORD_")).sort(),
  })));
}

function assertPrimitiveContracts(document, contracts) {
  const meshes = document.getRoot().listMeshes();
  if (meshes.length !== contracts.length) {
    throw new Error("simplification changed the mesh count");
  }
  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
    const primitives = meshes[meshIndex].listPrimitives();
    const expected = contracts[meshIndex];
    if (primitives.length !== expected.length) {
      throw new Error(`simplification changed primitive count for mesh ${meshIndex}`);
    }
    for (let primitiveIndex = 0; primitiveIndex < primitives.length; primitiveIndex++) {
      const primitive = primitives[primitiveIndex];
      const contract = expected[primitiveIndex];
      if (primitive.getMaterial() !== contract.material) {
        throw new Error(`simplification changed material assignment at mesh ${meshIndex}, primitive ${primitiveIndex}`);
      }
      if (contract.hasNormal && primitive.getAttribute("NORMAL") === null) {
        throw new Error(`simplification removed NORMAL at mesh ${meshIndex}, primitive ${primitiveIndex}`);
      }
      const texcoords = primitive.listSemantics().filter((semantic) => semantic.startsWith("TEXCOORD_")).sort();
      if (texcoords.length !== contract.texcoords.length || texcoords.some((value, index) => value !== contract.texcoords[index])) {
        throw new Error(`simplification changed UV sets at mesh ${meshIndex}, primitive ${primitiveIndex}`);
      }
    }
  }
}

async function canonicalOutputPath(outputPath) {
  try {
    return await realpath(outputPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return resolve(outputPath);
  }
}

async function atomicWrite(path, bytes) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o644);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function generateVegetationLod({ input, output, ratio, error }) {
  if (typeof input !== "string" || input.length === 0) throw new TypeError("input must be a non-empty path");
  if (typeof output !== "string" || output.length === 0) throw new TypeError("output must be a non-empty path");
  assertUnitInterval("ratio", ratio, { allowZero: false });
  assertUnitInterval("error", error, { allowZero: true });

  const inputPath = resolve(input);
  const outputPath = resolve(output);
  if (extname(inputPath).toLowerCase() !== ".glb" || extname(outputPath).toLowerCase() !== ".glb") {
    throw new Error("input and output paths must use the .glb extension");
  }
  const [inputRealPath, outputRealPath] = await Promise.all([realpath(inputPath), canonicalOutputPath(outputPath)]);
  if (inputRealPath === outputRealPath) throw new Error("refusing to overwrite the input GLB in place");

  const inputBytes = await readFile(inputRealPath);
  const inputJson = parseGlbJson(inputBytes, "input");
  assertNoUnsupportedCompression(inputJson, "input");

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.readBinary(inputBytes);
  const trianglesBefore = triangleCount(document);
  if (trianglesBefore === 0) throw new Error("input GLB contains no triangles");
  const contracts = snapshotPrimitiveContracts(document);

  await document.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error }));
  assertPrimitiveContracts(document, contracts);
  const trianglesAfter = triangleCount(document);
  if (trianglesAfter === 0) throw new Error("simplification produced zero triangles");
  if (trianglesAfter >= trianglesBefore) {
    throw new Error(`simplification did not reduce triangle count (${trianglesBefore} -> ${trianglesAfter})`);
  }

  const outputBytes = await io.writeBinary(document);
  const outputJson = parseGlbJson(outputBytes, "output");
  assertNoUnsupportedCompression(outputJson, "output");

  await stat(dirname(outputPath));
  await atomicWrite(outputPath, outputBytes);

  return {
    schema: SUMMARY_SCHEMA,
    input: inputPath,
    output: outputPath,
    ratio,
    error,
    trianglesBefore,
    trianglesAfter,
    reductionRatio: Number((1 - trianglesAfter / trianglesBefore).toFixed(6)),
    bytesBefore: inputBytes.byteLength,
    bytesAfter: outputBytes.byteLength,
    outputSha256: sha256(outputBytes),
    meshoptCompressed: false,
  };
}
