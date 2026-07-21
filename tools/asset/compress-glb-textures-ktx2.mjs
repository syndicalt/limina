import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

export const KTX_SOFTWARE_VERSION = "4.4.2";
export const PINNED_TOKTX_PATH = "js/.tools/ktx/4.4.2/linux-arm64/root/usr/bin/toktx";
export const KTX2_COMPOSITION_POLICY = Object.freeze({
  schema: "limina.glb-ktx2-policy/v1",
  extension: "KHR_texture_basisu",
  fallback: "none",
  expectedImages: 21,
  expectedWidth: 1024,
  expectedHeight: 1024,
  maxTextureObjects: 21,
  maxArtifactBytes: 24 * 1024 * 1024,
  maxGpuResidencyBytes: 72 * 1024 * 1024,
  mipFilter: "lanczos4",
  residencyAccounting: "produced-ktx2-dimensions-and-level-count-exact-4x4-transcode-blocks",
});

export const PINNED_TOKTX_OPTIONS = Object.freeze({
  uastcNormal: Object.freeze(["--t2", "--encode", "uastc", "--uastc_quality", "3", "--uastc_rdo_l", "0.5", "--uastc_rdo_m", "--zcmp", "18"]),
  uastcAlbedo: Object.freeze(["--t2", "--encode", "uastc", "--uastc_quality", "3", "--uastc_rdo_l", "0.75", "--uastc_rdo_m", "--zcmp", "18"]),
  etc1s: Object.freeze(["--t2", "--encode", "etc1s", "--qlevel", "160", "--clevel", "5", "--threads", "1"]),
});

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const KTX2_MAGIC = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
const pad4 = (value) => (value + 3) & ~3;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function parseGlb(bytes) {
  const source = Buffer.from(bytes);
  if (source.length < 28 || source.readUInt32LE(0) !== GLB_MAGIC || source.readUInt32LE(4) !== 2 || source.readUInt32LE(8) !== source.length) throw new Error("source must be an exact GLB 2.0 document");
  const jsonLength = source.readUInt32LE(12);
  if (source.readUInt32LE(16) !== JSON_CHUNK) throw new Error("GLB JSON chunk is missing");
  const binHeader = 20 + jsonLength;
  if (binHeader + 8 > source.length || source.readUInt32LE(binHeader + 4) !== BIN_CHUNK) throw new Error("GLB BIN chunk is missing");
  const binLength = source.readUInt32LE(binHeader);
  if (binHeader + 8 + binLength > source.length) throw new Error("GLB BIN chunk is truncated");
  return { json: JSON.parse(source.subarray(20, binHeader).toString().trimEnd()), bin: source.subarray(binHeader + 8, binHeader + 8 + binLength) };
}

function packGlb(json, binary) {
  json.buffers[0].byteLength = binary.length;
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc(pad4(jsonBytes.length) - jsonBytes.length, 0x20)]);
  const binaryPadded = Buffer.concat([binary, Buffer.alloc(pad4(binary.length) - binary.length)]);
  const output = Buffer.alloc(28 + jsonPadded.length + binaryPadded.length);
  output.writeUInt32LE(GLB_MAGIC, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonPadded.length, 12); output.writeUInt32LE(JSON_CHUNK, 16); jsonPadded.copy(output, 20);
  const binaryHeader = 20 + jsonPadded.length;
  output.writeUInt32LE(binaryPadded.length, binaryHeader); output.writeUInt32LE(BIN_CHUNK, binaryHeader + 4); binaryPadded.copy(output, binaryHeader + 8);
  return output;
}

function exactPolicy(input = KTX2_COMPOSITION_POLICY) {
  const keys = Object.keys(KTX2_COMPOSITION_POLICY);
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error("KTX2 policy must contain the exact supported fields");
  for (const key of ["schema", "extension", "fallback", "mipFilter", "residencyAccounting"]) if (input[key] !== KTX2_COMPOSITION_POLICY[key]) throw new Error(`unsupported KTX2 policy ${key}`);
  for (const key of ["expectedImages", "expectedWidth", "expectedHeight", "maxTextureObjects", "maxArtifactBytes", "maxGpuResidencyBytes"]) if (!Number.isSafeInteger(input[key]) || input[key] < 1) throw new Error(`KTX2 policy ${key} must be a positive safe integer`);
  if (input.maxTextureObjects > input.expectedImages) throw new Error("KTX2 policy permits more texture objects than unique images");
  return input;
}

function imageDimensions(bytes, mimeType) {
  if (mimeType === "image/png" && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if (new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]).has(marker)) return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
      offset += 2 + length;
    }
  }
  throw new Error(`cannot determine ${mimeType ?? "unknown"} source image dimensions`);
}

const MATERIAL_TEXTURE_SLOTS = Object.freeze([
  Object.freeze({ path: "pbrMetallicRoughness.baseColorTexture", kind: "albedo", colorSpace: "sRGB" }),
  Object.freeze({ path: "pbrMetallicRoughness.metallicRoughnessTexture", kind: "roughness", colorSpace: "linear" }),
  Object.freeze({ path: "normalTexture", kind: "normal", colorSpace: "linear" }),
  Object.freeze({ path: "occlusionTexture", kind: "occlusion", colorSpace: "linear" }),
  Object.freeze({ path: "emissiveTexture", kind: "emissive", colorSpace: "sRGB" }),
]);

function valueAt(object, path) { return path.split(".").reduce((value, key) => value?.[key], object); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function embeddedImageBytes(json, binary, imageIndex) {
  const image = json.images[imageIndex], view = json.bufferViews?.[image?.bufferView];
  if (!image || !Number.isSafeInteger(image.bufferView) || !view || view.buffer !== 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength < 1) throw new Error(`image ${imageIndex} must be embedded in GLB buffer 0`);
  const start = view.byteOffset ?? 0, end = start + view.byteLength;
  if (start < 0 || end > binary.length) throw new Error(`image ${imageIndex} buffer view is out of bounds`);
  return binary.subarray(start, end);
}

export function planGlbKtx2Compression(source, {
  expectedSourceSha256,
  policy = KTX2_COMPOSITION_POLICY,
  uastcAlbedoImageIndices = [],
} = {}) {
  const bytes = Buffer.from(source), lockedPolicy = exactPolicy(policy);
  if (!/^[0-9a-f]{64}$/.test(expectedSourceSha256 ?? "") || sha256(bytes) !== expectedSourceSha256) throw new Error("source authority hash mismatch");
  const { json, bin } = parseGlb(bytes);
  if (!Array.isArray(json.buffers) || json.buffers.length !== 1 || json.buffers[0].uri !== undefined) throw new Error("production KTX2 compressor requires one embedded GLB buffer");
  if ((json.images?.length ?? 0) !== lockedPolicy.expectedImages) throw new Error(`source must contain exactly ${lockedPolicy.expectedImages} images`);
  if (!Array.isArray(json.textures) || json.textures.length < 1 || !Array.isArray(json.materials)) throw new Error("source texture and material inventories are required");
  const selectedUastc = new Set(uastcAlbedoImageIndices);
  for (const image of selectedUastc) if (!Number.isSafeInteger(image) || image < 0 || image >= json.images.length) throw new Error("UASTC albedo image index is out of range");

  const bindings = [], knownInfos = new Set();
  for (let materialIndex = 0; materialIndex < json.materials.length; materialIndex++) {
    const material = json.materials[materialIndex];
    for (const slot of MATERIAL_TEXTURE_SLOTS) {
      const info = valueAt(material, slot.path);
      if (info === undefined) continue;
      if (info === null || typeof info !== "object" || !Number.isSafeInteger(info.index) || !json.textures[info.index]) throw new Error(`material ${materialIndex} ${slot.path} is invalid`);
      knownInfos.add(info);
      const texture = json.textures[info.index], image = texture.source;
      if (!Number.isSafeInteger(image) || !json.images[image]) throw new Error(`material ${materialIndex} ${slot.path} has no raster source`);
      bindings.push({ material: materialIndex, materialName: material.name ?? null, materialPack: material.extras?.limina_material_pack ?? null, slot: slot.path, kind: slot.kind, colorSpace: slot.colorSpace, texture: info.index, image });
    }
    const visit = (value) => {
      if (value === null || typeof value !== "object") return;
      if (!Array.isArray(value) && Number.isSafeInteger(value.index) && !knownInfos.has(value)) throw new Error(`material ${materialIndex} contains an unsupported texture-info slot`);
      for (const child of Object.values(value)) visit(child);
    };
    visit(material);
  }
  if (bindings.length === 0) throw new Error("source has no material texture bindings");
  const referencedTextures = new Set(bindings.map((binding) => binding.texture));
  if (referencedTextures.size !== json.textures.length) throw new Error("source contains texture objects outside exact material-slot usage");

  const imageBindings = Array.from({ length: json.images.length }, () => []);
  for (const binding of bindings) imageBindings[binding.image].push(binding);
  const sourceHashes = new Set(), images = [];
  for (let image = 0; image < json.images.length; image++) {
    const sourceImage = embeddedImageBytes(json, bin, image), descriptor = json.images[image];
    if (!new Set(["image/png", "image/jpeg"]).has(descriptor.mimeType)) throw new Error(`image ${image} must be PNG or JPEG source data`);
    const [width, height] = imageDimensions(sourceImage, descriptor.mimeType);
    if (width !== lockedPolicy.expectedWidth || height !== lockedPolicy.expectedHeight) throw new Error(`image ${image} must be ${lockedPolicy.expectedWidth}x${lockedPolicy.expectedHeight}`);
    const contentHash = sha256(sourceImage);
    if (sourceHashes.has(contentHash)) throw new Error("source image inventory contains byte-identical aliases");
    sourceHashes.add(contentHash);
    const uses = imageBindings[image], kinds = new Set(uses.map((use) => use.kind)), colorSpaces = new Set(uses.map((use) => use.colorSpace));
    if (uses.length === 0) throw new Error(`image ${image} is outside exact material-slot usage`);
    if (kinds.size !== 1 || colorSpaces.size !== 1) throw new Error(`image ${image} aliases incompatible material-slot semantics`);
    const kind = [...kinds][0], colorSpace = [...colorSpaces][0], uastc = kind === "normal" || (kind === "albedo" && selectedUastc.has(image));
    if (selectedUastc.has(image) && kind !== "albedo") throw new Error(`image ${image} was selected as UASTC albedo but is ${kind}`);
    const mode = uastc ? "UASTC+Zstd" : "ETC1S/BasisLZ";
    images.push({ image, name: descriptor.name ?? `image-${image}`, mimeType: descriptor.mimeType, width, height, sourceBytes: sourceImage.length, sourceSha256: contentHash, kind, colorSpace, mode, uses: uses.map((use) => ({ ...use })) });
  }

  const textureKey = (texture) => stable({ sampler: texture.sampler ?? null, source: texture.source, extensions: texture.extensions ?? null, extras: texture.extras ?? null });
  const textureByKey = new Map(), textureRemap = new Map(), textures = [];
  for (let index = 0; index < json.textures.length; index++) {
    const texture = json.textures[index], key = textureKey(texture);
    let target = textureByKey.get(key);
    if (target === undefined) { target = textures.length; textureByKey.set(key, target); textures.push({ sampler: texture.sampler, source: texture.source, extensions: texture.extensions, extras: texture.extras, sourceTextureIndices: [] }); }
    textures[target].sourceTextureIndices.push(index); textureRemap.set(index, target);
  }
  if (textures.length > lockedPolicy.maxTextureObjects) throw new Error(`deduplicated texture inventory exceeds ${lockedPolicy.maxTextureObjects}`);
  if (new Set(textures.map((texture) => texture.source)).size !== json.images.length) throw new Error("deduplicated textures do not close every source image");
  const rewrittenBindings = bindings.map((binding) => ({ ...binding, outputTexture: textureRemap.get(binding.texture) }));
  return { sourceBytes: bytes, sourceSha256: sha256(bytes), json, binary: bin, policy: lockedPolicy, images, bindings: rewrittenBindings, textures, textureRemap };
}

function ktx2Header(bytes) {
  if (bytes.length < 48 || !bytes.subarray(0, 12).equals(KTX2_MAGIC)) throw new Error("toktx output is not KTX2");
  return { width: bytes.readUInt32LE(20), height: bytes.readUInt32LE(24), depth: bytes.readUInt32LE(28), layers: bytes.readUInt32LE(32), faces: bytes.readUInt32LE(36), levels: bytes.readUInt32LE(40) };
}

function residencyLevels(width, height, levels, blockBytes) {
  const output = [];
  for (let level = 0; level < levels; level++) {
    const w = Math.max(1, width >> level), h = Math.max(1, height >> level), blocksX = Math.ceil(w / 4), blocksY = Math.ceil(h / 4);
    output.push({ level, width: w, height: h, blocksX, blocksY, bytes: blocksX * blocksY * blockBytes });
  }
  return output;
}

function rewriteDocument(plan, payloads) {
  const json = structuredClone(plan.json), oldViews = json.bufferViews ?? [], removedViews = new Set(json.images.map((image) => image.bufferView));
  const retained = [], viewRemap = new Map(), chunks = []; let offset = 0;
  for (let index = 0; index < oldViews.length; index++) {
    if (removedViews.has(index)) continue;
    const view = oldViews[index], start = view.byteOffset ?? 0, end = start + view.byteLength;
    if (view.buffer !== 0 || start < 0 || end > plan.binary.length) throw new Error(`buffer view ${index} is outside embedded buffer 0`);
    const aligned = pad4(offset), data = plan.binary.subarray(start, end); chunks.push(Buffer.alloc(aligned - offset), data);
    const next = { ...view, byteOffset: aligned }; retained.push(next); viewRemap.set(index, retained.length - 1); offset = aligned + data.length;
  }
  const remapViews = (value, key = null) => {
    if (value === null || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === "bufferViews" || childKey === "images") continue;
      if (childKey === "bufferView" && Number.isSafeInteger(child)) {
        if (!viewRemap.has(child)) throw new Error(`removed raster buffer view ${child} remains referenced outside images`);
        value[childKey] = viewRemap.get(child);
      } else remapViews(child, childKey);
    }
  };
  remapViews(json);
  json.bufferViews = retained;
  for (let image = 0; image < payloads.length; image++) {
    const payload = payloads[image], aligned = pad4(offset); chunks.push(Buffer.alloc(aligned - offset), payload);
    const bufferView = json.bufferViews.length; json.bufferViews.push({ buffer: 0, byteOffset: aligned, byteLength: payload.length });
    json.images[image] = { name: plan.images[image].name, bufferView, mimeType: "image/ktx2" }; offset = aligned + payload.length;
  }
  for (const binding of plan.bindings) valueAt(json.materials[binding.material], binding.slot).index = binding.outputTexture;
  json.textures = plan.textures.map((texture) => ({ ...(texture.sampler === undefined ? {} : { sampler: texture.sampler }), ...(texture.extras === undefined ? {} : { extras: texture.extras }), extensions: { ...(texture.extensions ?? {}), KHR_texture_basisu: { source: texture.source } } }));
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), "KHR_texture_basisu"])];
  json.extensionsRequired = [...new Set([...(json.extensionsRequired ?? []), "KHR_texture_basisu"])];
  const binary = Buffer.concat(chunks);
  return { json, binary, bytes: packGlb(json, binary) };
}

export function validateKtx2OnlyGlb(bytes, { policy = KTX2_COMPOSITION_POLICY } = {}) {
  const lockedPolicy = exactPolicy(policy), { json, bin } = parseGlb(bytes);
  if ((json.images?.length ?? 0) !== lockedPolicy.expectedImages || (json.textures?.length ?? 0) > lockedPolicy.maxTextureObjects) throw new Error("KTX2 output inventory exceeds or misses policy");
  if (!json.extensionsUsed?.includes("KHR_texture_basisu") || !json.extensionsRequired?.includes("KHR_texture_basisu")) throw new Error("KTX2 output does not require KHR_texture_basisu");
  if (json.images.some((image) => image.mimeType !== "image/ktx2" || !Number.isSafeInteger(image.bufferView) || !embeddedImageBytes(json, bin, json.images.indexOf(image)).subarray(0, 12).equals(KTX2_MAGIC))) throw new Error("KTX2 output contains a raster fallback or invalid payload");
  if (json.textures.some((texture) => texture.source !== undefined || !Number.isSafeInteger(texture.extensions?.KHR_texture_basisu?.source))) throw new Error("KTX2 output contains a fallback texture source");
  if (new Set(json.textures.map((texture) => texture.extensions.KHR_texture_basisu.source)).size !== json.images.length) throw new Error("KTX2 output does not close all images through Basis textures");
  return json;
}

async function publishExclusive(path, bytes) {
  const temporary = `${path}.partial-${process.pid}-${Date.now()}`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try { await copyFile(temporary, path, fsConstants.COPYFILE_EXCL); } finally { await rm(temporary, { force: true }); }
}

function containedWorkspacePath(workspaceRoot, value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} path is required`);
  if (isAbsolute(value)) throw new Error(`${label} must be workspace-relative`);
  const root = resolve(workspaceRoot), path = resolve(root, value), rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes the workspace`);
  return path;
}

export async function compressGlbTexturesKtx2({
  input,
  output,
  manifest,
  expectedSourceSha256,
  policy = KTX2_COMPOSITION_POLICY,
  uastcAlbedoImageIndices = [],
  toolPath = PINNED_TOKTX_PATH,
  workspaceRoot = process.cwd(),
} = {}) {
  if (![input, output, manifest].every((value) => typeof value === "string" && value.length > 0)) throw new Error("input, output, and manifest paths are required");
  if (toolPath !== PINNED_TOKTX_PATH) throw new Error(`toktx path must remain pinned to ${PINNED_TOKTX_PATH}`);
  const root = resolve(workspaceRoot);
  const inputPath = containedWorkspacePath(root, input, "input"), outputPath = containedWorkspacePath(root, output, "output"), manifestPath = containedWorkspacePath(root, manifest, "manifest");
  if (new Set([inputPath, outputPath, manifestPath]).size !== 3) throw new Error("input, output, and manifest paths must be distinct");
  for (const [path, label] of [[outputPath, "output"], [manifestPath, "manifest"]]) {
    try { await access(path); throw new Error(`KTX2 ${label} already exists; append-only publication refused`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const plan = planGlbKtx2Compression(await readFile(inputPath), { expectedSourceSha256, policy, uastcAlbedoImageIndices });
  const tool = containedWorkspacePath(root, toolPath, "toktx"), versionRun = spawnSync(tool, ["--version"], { encoding: "utf8" });
  const version = `${versionRun.stdout ?? ""}${versionRun.stderr ?? ""}`.trim();
  if (versionRun.status !== 0 || version !== `toktx v${KTX_SOFTWARE_VERSION}`) throw new Error(`pinned toktx ${KTX_SOFTWARE_VERSION} is unavailable`);
  const work = await mkdtemp(resolve(tmpdir(), "limina-general-ktx2-")), payloads = [], records = [];
  try {
    for (const image of plan.images) {
      const descriptor = plan.json.images[image.image], source = embeddedImageBytes(plan.json, plan.binary, image.image), extension = descriptor.mimeType === "image/jpeg" ? "jpg" : "png";
      const sourcePath = resolve(work, `${image.image}.${extension}`), targetPath = resolve(work, `${image.image}.ktx2`);
      await writeFile(sourcePath, source);
      const modeOptions = image.mode === "UASTC+Zstd" ? (image.kind === "normal" ? PINNED_TOKTX_OPTIONS.uastcNormal : PINNED_TOKTX_OPTIONS.uastcAlbedo) : PINNED_TOKTX_OPTIONS.etc1s;
      const options = [...modeOptions, "--genmipmap", "--filter", plan.policy.mipFilter, "--assign_oetf", image.colorSpace === "sRGB" ? "srgb" : "linear"];
      const run = spawnSync(tool, [...options, targetPath, sourcePath], { encoding: "utf8", maxBuffer: 10 << 20 });
      if (run.status !== 0) throw new Error(`toktx image ${image.image} failed: ${(run.stderr || run.stdout).slice(-800)}`);
      const payload = await readFile(targetPath), header = ktx2Header(payload), expectedLevels = Math.floor(Math.log2(Math.max(image.width, image.height))) + 1;
      if (header.width !== image.width || header.height !== image.height || header.depth !== 0 || header.layers !== 0 || header.faces !== 1 || header.levels !== expectedLevels) throw new Error(`KTX2 image ${image.image} dimensions or full mip chain drifted`);
      const blockBytes = image.mode === "UASTC+Zstd" ? 16 : 8, levels = residencyLevels(header.width, header.height, header.levels, blockBytes);
      payloads.push(payload); records.push({ ...image, options, ktx2Sha256: sha256(payload), ktx2Bytes: payload.length, ktx2Header: header, transcodeBlockBytes: blockBytes, residencyLevels: levels, gpuResidencyBytes: levels.reduce((sum, level) => sum + level.bytes, 0) });
    }
  } finally { await rm(work, { recursive: true, force: true }); }
  const rewritten = rewriteDocument(plan, payloads);
  validateKtx2OnlyGlb(rewritten.bytes, { policy: plan.policy });
  const residencyBytes = records.reduce((sum, record) => sum + record.gpuResidencyBytes, 0);
  if (rewritten.bytes.length > plan.policy.maxArtifactBytes) throw new Error("KTX2 output exceeds artifact byte budget");
  if (residencyBytes > plan.policy.maxGpuResidencyBytes) throw new Error("KTX2 output exceeds GPU residency budget");
  const record = {
    schema: "limina.glb-ktx2-production/v1",
    source: { path: input, sha256: plan.sourceSha256, bytes: plan.sourceBytes.length, images: plan.images.length, textures: plan.json.textures.length, materials: plan.json.materials.length },
    output: { path: output, sha256: sha256(rewritten.bytes), engineHash: portableAssetContentHash(rewritten.bytes), bytes: rewritten.bytes.length, images: rewritten.json.images.length, textures: rewritten.json.textures.length, materials: rewritten.json.materials.length },
    tool: { name: "Khronos KTX-Software toktx", version: KTX_SOFTWARE_VERSION, versionOutput: version, path: toolPath },
    policy: { ...plan.policy, uastcAlbedoImageIndices: [...uastcAlbedoImageIndices] },
    materialSlotBindings: plan.bindings,
    textureDeduplication: plan.textures.map((texture, outputTexture) => ({ outputTexture, image: texture.source, sourceTextureIndices: texture.sourceTextureIndices })),
    textures: records,
    gpuResidency: { model: plan.policy.residencyAccounting, bytes: residencyBytes, mib: residencyBytes / 1048576, limitBytes: plan.policy.maxGpuResidencyBytes },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  await Promise.all([mkdir(dirname(outputPath), { recursive: true, mode: 0o700 }), mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 })]);
  await publishExclusive(outputPath, rewritten.bytes);
  try { await publishExclusive(manifestPath, manifestBytes); } catch (error) { throw new AggregateError([error], `KTX2 GLB was published at ${outputPath}, but manifest publication failed; output was preserved`); }
  return record;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output, manifest, expectedSourceSha256, uastcCsv = ""] = process.argv.slice(2);
  const uastcAlbedoImageIndices = uastcCsv === "" ? [] : uastcCsv.split(",").map((value) => Number(value));
  console.log(JSON.stringify(await compressGlbTexturesKtx2({ input, output, manifest, expectedSourceSha256, uastcAlbedoImageIndices }), null, 2));
}
