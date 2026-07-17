import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";

export const TREE_IMPOSTOR_SCHEMA = "limina.tree-impostor/2";
export const TREE_IMPOSTOR_PROJECTION = "upper-hemi-octa-rotated-diamond";
const HASH = /^sha256:[0-9a-f]{64}$/;

function sha256(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function finite(value, label) { if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`); return value; }
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${label} must be a safe integer in [${min}, ${max}]`);
  return value;
}
function rounded(value) { return Number(value.toFixed(8)); }
/** Bijective rotated-diamond square-to-upper-hemisphere mapping. */
export function decodeUpperHemisphereOcta(u, v) {
  finite(u, "octa u"); finite(v, "octa v");
  if (u < 0 || u > 1 || v < 0 || v > 1) throw new RangeError("octa uv must be in [0, 1]");
  const qx = u * 2 - 1, qy = v * 2 - 1;
  const x = (qx + qy) * 0.5, z = (qx - qy) * 0.5;
  const y = Math.max(0, 1 - Math.abs(x) - Math.abs(z));
  const length = Math.hypot(x, y, z);
  return Object.freeze([rounded(x / length), rounded(y / length), rounded(z / length)]);
}

export function encodeUpperHemisphereOcta(direction) {
  if (!Array.isArray(direction) || direction.length !== 3 || direction.some((value) => !Number.isFinite(value))) throw new TypeError("upper-hemi direction must be a finite vec3");
  const length = Math.abs(direction[0]) + Math.max(direction[1], 0) + Math.abs(direction[2]);
  if (length === 0) throw new RangeError("upper-hemi direction must be non-zero");
  const x = direction[0] / length, z = direction[2] / length;
  return Object.freeze([rounded((x + z + 1) * 0.5), rounded((x - z + 1) * 0.5)]);
}

export function treeImpostorViewDirections(grid) {
  integer(grid, 2, 16, "tree impostor grid");
  const directions = [];
  for (let row = 0; row < grid; row++) for (let column = 0; column < grid; column++) {
    directions.push(decodeUpperHemisphereOcta((column + 0.5) / grid, (row + 0.5) / grid));
  }
  return Object.freeze(directions);
}

export function normalizeTreeImpostorConfig(config) {
  const grid = integer(config?.grid ?? 8, 2, 16, "tree impostor grid");
  const cellSize = integer(config?.cellSize ?? 128, 32, 512, "tree impostor cellSize");
  const alphaCutoff = finite(config?.alphaCutoff ?? 0.45, "tree impostor alphaCutoff");
  if (alphaCutoff <= 0 || alphaCutoff >= 1) throw new RangeError("tree impostor alphaCutoff must be in (0, 1)");
  return Object.freeze({ grid, cellSize, atlasSize: grid * cellSize, alphaCutoff,
    projection: TREE_IMPOSTOR_PROJECTION, normalEncoding: "view-normal-xy-rg-unorm8-positive-z",
    depthEncoding: "linear-view-depth-b-unorm8", alphaEncoding: "coverage-a-unorm8" });
}

async function packViews(paths, config) {
  if (!Array.isArray(paths) || paths.length !== config.grid * config.grid) {
    throw new RangeError(`tree impostor view list must contain ${config.grid * config.grid} cells`);
  }
  const composite = [];
  for (let index = 0; index < paths.length; index++) {
    const bytes = await readFile(resolve(paths[index]));
    const metadata = await sharp(bytes).metadata();
    if (metadata.width !== config.cellSize || metadata.height !== config.cellSize || metadata.format !== "png") {
      throw new Error(`tree impostor cell ${index} must be a ${config.cellSize}x${config.cellSize} PNG`);
    }
    composite.push({ input: bytes, left: (index % config.grid) * config.cellSize, top: Math.floor(index / config.grid) * config.cellSize });
  }
  return sharp({ create: { width: config.atlasSize, height: config.atlasSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composite).png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer();
}

export async function packTreeImpostorViews({ albedoViews, normalDepthViews, config }) {
  const normalized = normalizeTreeImpostorConfig(config);
  const [albedo, normalDepth] = await Promise.all([packViews(albedoViews, normalized), packViews(normalDepthViews, normalized)]);
  return Object.freeze({ config: normalized, albedo, normalDepth });
}

function validateBounds(bounds) {
  const min = bounds?.min, max = bounds?.max;
  if (!Array.isArray(min) || !Array.isArray(max) || min.length !== 3 || max.length !== 3) throw new RangeError("tree impostor bounds require min/max vec3");
  for (let axis = 0; axis < 3; axis++) {
    finite(min[axis], `tree impostor bounds.min[${axis}]`); finite(max[axis], `tree impostor bounds.max[${axis}]`);
    if (max[axis] <= min[axis]) throw new RangeError("tree impostor bounds must have positive extent on every axis");
  }
  return Object.freeze({ min: Object.freeze(min.map(rounded)), max: Object.freeze(max.map(rounded)) });
}

function quadDocument({ albedo, normalDepth, descriptor }) {
  const document = new Document();
  const buffer = document.createBuffer("limina-impostor-buffer");
  const width = Math.max(descriptor.bounds.max[0] - descriptor.bounds.min[0], descriptor.bounds.max[2] - descriptor.bounds.min[2]);
  const minY = descriptor.bounds.min[1], maxY = descriptor.bounds.max[1];
  const positions = new Float32Array([-width / 2, minY, 0, width / 2, minY, 0, width / 2, maxY, 0, -width / 2, maxY, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const primitive = document.createPrimitive("limina-impostor-quad")
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(positions).setBuffer(buffer))
    .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setArray(normals).setBuffer(buffer))
    .setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setArray(uvs).setBuffer(buffer))
    .setIndices(document.createAccessor().setType("SCALAR").setArray(indices).setBuffer(buffer));
  const albedoTexture = document.createTexture("limina-impostor-albedo").setImage(albedo).setMimeType("image/png");
  const normalDepthTexture = document.createTexture("limina-impostor-normal-depth").setImage(normalDepth).setMimeType("image/png");
  const material = document.createMaterial("limina-impostor-material").setBaseColorTexture(albedoTexture)
    .setNormalTexture(normalDepthTexture).setMetallicFactor(0).setRoughnessFactor(1)
    .setAlphaMode("MASK").setAlphaCutoff(descriptor.config.alphaCutoff).setDoubleSided(true);
  primitive.setMaterial(material);
  const mesh = document.createMesh("limina-impostor-quad").addPrimitive(primitive);
  const node = document.createNode("limina-impostor").setMesh(mesh).setExtras({ liminaTreeImpostor: descriptor });
  const scene = document.createScene("limina-impostor-scene").addChild(node);
  document.getRoot().setDefaultScene(scene);
  return document;
}

async function atomicWrite(path, bytes) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o644); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); throw error;
  }
}

export async function buildTreeImpostorArtifact({ sourceSha256, lodSha256, sourceContentHash, lodContentHash, bounds, packed, bakeConfig = {}, output }) {
  if (![sourceSha256, lodSha256, sourceContentHash, lodContentHash].every((hash) => HASH.test(hash))) throw new RangeError("tree impostor raw/content hashes must be sha256:<64 lowercase hex>");
  if (!(packed?.albedo instanceof Uint8Array) || !(packed?.normalDepth instanceof Uint8Array)) throw new TypeError("tree impostor packed PNG bytes are required");
  const config = normalizeTreeImpostorConfig(packed.config);
  const normalizedBounds = validateBounds(bounds);
  const directions = treeImpostorViewDirections(config.grid);
  const normalizedBake = Object.freeze({ blenderVersion: "5.1.2", engine: "CYCLES", device: "CPU", samples: 32, seed: 1, ...bakeConfig });
  const cacheKey = treeImpostorCacheKey({ sourceSha256, lodSha256, sourceContentHash, lodContentHash, bounds: normalizedBounds, config, bake: normalizedBake });
  const descriptor = Object.freeze({ schema: TREE_IMPOSTOR_SCHEMA, sourceSha256, lodSha256, sourceContentHash, lodContentHash, cacheKey, bounds: normalizedBounds,
    config, bake: normalizedBake, viewDirections: directions });
  const io = new NodeIO();
  const bytes = await io.writeBinary(quadDocument({ albedo: packed.albedo, normalDepth: packed.normalDepth, descriptor }));
  const qc = await validateTreeImpostorArtifact(bytes);
  if (output !== undefined) await atomicWrite(resolve(output), bytes);
  return Object.freeze({ schema: TREE_IMPOSTOR_SCHEMA, descriptor, bytes, sha256: sha256(bytes), qc });
}

async function inspectAtlas(texture, config, label, { requireTransparentMargin }) {
  const bytes = texture.getImage();
  if (!(bytes instanceof Uint8Array) || texture.getMimeType() !== "image/png") throw new Error(`${label} atlas must be an embedded PNG`);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== config.atlasSize || info.height !== config.atlasSize || info.channels !== 4) throw new Error(`${label} atlas dimensions/channels do not match descriptor`);
  for (let row = 0; row < config.grid; row++) for (let column = 0; column < config.grid; column++) {
    let occupied = 0, transparent = 0, depthEvidence = 0;
    for (let y = row * config.cellSize; y < (row + 1) * config.cellSize; y++) for (let x = column * config.cellSize; x < (column + 1) * config.cellSize; x++) {
      const offset = (y * info.width + x) * 4, alpha = data[offset + 3];
      if (alpha > 0) { occupied++; if (data[offset + 2] > 0) depthEvidence++; } else transparent++;
    }
    if (occupied === 0) throw new Error(`${label} atlas cell ${row}:${column} has no silhouette coverage`);
    if (requireTransparentMargin && transparent === 0) throw new Error(`${label} atlas cell ${row}:${column} has no transparent margin`);
    if (label === "normal-depth" && depthEvidence === 0) throw new Error(`normal-depth atlas cell ${row}:${column} has no encoded depth evidence`);
  }
  return Object.freeze({ width: info.width, height: info.height, channels: info.channels, sha256: sha256(bytes) });
}

export async function validateTreeImpostorArtifact(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("tree impostor artifact bytes must be Uint8Array");
  const document = await new NodeIO().readBinary(bytes);
  const root = document.getRoot(), scenes = root.listScenes(), meshes = root.listMeshes(), materials = root.listMaterials();
  if (scenes.length !== 1 || meshes.length !== 1 || meshes[0].listPrimitives().length !== 1 || materials.length !== 1) {
    throw new Error("tree impostor artifact must contain one scene, one mesh, one primitive, and one material");
  }
  const primitive = meshes[0].listPrimitives()[0], position = primitive.getAttribute("POSITION"), uv = primitive.getAttribute("TEXCOORD_0"), indices = primitive.getIndices();
  if (position?.getCount() !== 4 || uv?.getCount() !== 4 || indices?.getCount() !== 6) throw new Error("tree impostor artifact geometry must be one indexed quad");
  const material = materials[0], albedo = material.getBaseColorTexture(), normalDepth = material.getNormalTexture();
  if (material.getAlphaMode() !== "MASK" || !material.getDoubleSided() || albedo === null || normalDepth === null) {
    throw new Error("tree impostor material must be double-sided alpha-mask with albedo and normal-depth textures");
  }
  const descriptor = root.listNodes().find((node) => node.getName() === "limina-impostor")?.getExtras()?.liminaTreeImpostor;
  if (descriptor?.schema !== TREE_IMPOSTOR_SCHEMA || !HASH.test(descriptor.sourceSha256 ?? "") || !HASH.test(descriptor.lodSha256 ?? "") ||
      !HASH.test(descriptor.sourceContentHash ?? "") || !HASH.test(descriptor.lodContentHash ?? "") || !HASH.test(descriptor.cacheKey ?? "")) {
    throw new Error("tree impostor descriptor/hashes are missing or invalid");
  }
  const config = normalizeTreeImpostorConfig(descriptor.config), bounds = validateBounds(descriptor.bounds);
  if (Math.abs(material.getAlphaCutoff() - config.alphaCutoff) > 1e-6) throw new Error("tree impostor alpha cutoff differs from descriptor");
  const expectedDirections = treeImpostorViewDirections(config.grid);
  if (JSON.stringify(descriptor.viewDirections) !== JSON.stringify(expectedDirections)) throw new Error("tree impostor orientation table is stale or malformed");
  const [albedoQc, normalDepthQc] = await Promise.all([
    inspectAtlas(albedo, config, "albedo", { requireTransparentMargin: true }),
    inspectAtlas(normalDepth, config, "normal-depth", { requireTransparentMargin: true }),
  ]);
  return Object.freeze({ schema: TREE_IMPOSTOR_SCHEMA, bounds, config, albedo: albedoQc, normalDepth: normalDepthQc,
    triangles: 2, embeddedTextures: 2, selfContained: true });
}

export function treeImpostorCacheKey({ sourceSha256, lodSha256, sourceContentHash, lodContentHash, bounds, config, bake }) {
  return sha256(Buffer.from(JSON.stringify({ sourceSha256, lodSha256, sourceContentHash, lodContentHash, bounds: validateBounds(bounds),
    config: normalizeTreeImpostorConfig(config), bake })));
}

export async function readTreeImpostorDescriptor(bytes) {
  const document = await new NodeIO().readBinary(bytes);
  return document.getRoot().listNodes().find((node) => node.getName() === "limina-impostor")?.getExtras()?.liminaTreeImpostor;
}
