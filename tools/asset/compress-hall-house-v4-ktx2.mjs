import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

export const SOURCE_SHA256 = "8fcb0c7df015d7681d078f3ec6619411f7ec368c87705f5bf963fbb528865493";
export const TOOL = "js/.tools/ktx/4.4.2/linux-arm64/root/usr/bin/toktx";
export const DEFAULT_KTX2_ENCODING_BUDGET = Object.freeze({
  container: "KTX2",
  gltfExtension: "KHR_texture_basisu",
  fallback: "none",
  mipmaps: true,
  mipFilter: "lanczos4",
  normalMode: "UASTC+Zstd",
  criticalAlbedoMode: "UASTC+Zstd",
  defaultMode: "ETC1S/BasisLZ",
  maxArtifactBytes: 24 * 1024 * 1024,
  maxGpuResidencyBytes: 72 * 1024 * 1024,
  maxTextureObjects: 32,
  maxUniqueImages: 24,
  residencyAccounting: "exact-4x4-blocks-full-mip-chain",
});
export const DEFAULT_KTX2_SOURCE_INVENTORY = Object.freeze({
  images: 18,
  packs: 6,
  runtimeSlotsPerPack: Object.freeze(["albedo", "normal", "roughness"]),
});
const MAGIC = 0x46546c67,
  JSON_CHUNK = 0x4e4f534a,
  BIN_CHUNK = 0x004e4942;
const hash = (b) => createHash("sha256").update(b).digest("hex"),
  pad = (n) => (n + 3) & ~3;

function parse(b) {
  if (b.readUInt32LE(0) !== MAGIC || b.readUInt32LE(4) !== 2) throw Error("GLB 2.0 required");
  const jl = b.readUInt32LE(12),
    o = 20 + jl;
  return {
    json: JSON.parse(b.subarray(20, o).toString().trimEnd()),
    bin: b.subarray(o + 8, o + 8 + b.readUInt32LE(o)),
  };
}
function pack(g, bin) {
  g.buffers[0].byteLength = bin.length;
  const j = Buffer.from(JSON.stringify(g)),
    jp = Buffer.concat([j, Buffer.alloc(pad(j.length) - j.length, 32)]),
    bp = Buffer.concat([bin, Buffer.alloc(pad(bin.length) - bin.length)]),
    out = Buffer.alloc(28 + jp.length + bp.length);
  out.writeUInt32LE(MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jp.length, 12);
  out.writeUInt32LE(JSON_CHUNK, 16);
  jp.copy(out, 20);
  const o = 20 + jp.length;
  out.writeUInt32LE(bp.length, o);
  out.writeUInt32LE(BIN_CHUNK, o + 4);
  bp.copy(out, o + 8);
  return out;
}
function mipBlocks(w, h, bpb) {
  let n = 0;
  for (;;) {
    n += Math.ceil(w / 4) * Math.ceil(h / 4) * bpb;
    if (w === 1 && h === 1) return n;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error(`${label} must be an object`);
  const expected = new Set(keys);
  for (const key of keys) if (!(key in value)) throw Error(`${label}.${key} is required`);
  for (const key of Object.keys(value)) if (!expected.has(key)) throw Error(`${label}.${key} is unsupported`);
  return value;
}
function boundedInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw Error(`${label} must be a positive bounded integer`);
  return value;
}

export function validateKtx2EncodingBudget(value = DEFAULT_KTX2_ENCODING_BUDGET) {
  const keys = Object.keys(DEFAULT_KTX2_ENCODING_BUDGET),
    budget = exactObject(value, keys, "KTX2 encoding budget");
  for (const key of [
    "container",
    "gltfExtension",
    "fallback",
    "mipFilter",
    "normalMode",
    "criticalAlbedoMode",
    "defaultMode",
    "residencyAccounting",
  ])
    if (budget[key] !== DEFAULT_KTX2_ENCODING_BUDGET[key]) throw Error(`KTX2 encoding budget ${key} is unsupported`);
  if (budget.mipmaps !== true) throw Error("KTX2 encoding budget must require mipmaps");
  boundedInteger(budget.maxArtifactBytes, "KTX2 encoding budget maxArtifactBytes", 512 * 1024 * 1024);
  boundedInteger(budget.maxGpuResidencyBytes, "KTX2 encoding budget maxGpuResidencyBytes", 1024 * 1024 * 1024);
  boundedInteger(budget.maxTextureObjects, "KTX2 encoding budget maxTextureObjects", 4096);
  boundedInteger(budget.maxUniqueImages, "KTX2 encoding budget maxUniqueImages", 4096);
  if (budget.maxUniqueImages > budget.maxTextureObjects)
    throw Error("KTX2 encoding budget unique images exceed texture objects");
  return budget;
}

export function validateKtx2SourceInventory(value = DEFAULT_KTX2_SOURCE_INVENTORY) {
  const inventory = exactObject(
    value,
    [
      "images",
      "packs",
      "runtimeSlotsPerPack",
      ...(value?.textures === undefined ? [] : ["textures"]),
      ...(value?.materials === undefined ? [] : ["materials"]),
    ],
    "KTX2 source inventory",
  );
  boundedInteger(inventory.images, "KTX2 source inventory images", 4096);
  boundedInteger(inventory.packs, "KTX2 source inventory packs", 64);
  if (inventory.textures !== undefined) boundedInteger(inventory.textures, "KTX2 source inventory textures", 4096);
  if (inventory.materials !== undefined) boundedInteger(inventory.materials, "KTX2 source inventory materials", 4096);
  if (
    !Array.isArray(inventory.runtimeSlotsPerPack) ||
    inventory.runtimeSlotsPerPack.length === 0 ||
    new Set(inventory.runtimeSlotsPerPack).size !== inventory.runtimeSlotsPerPack.length
  )
    throw Error("KTX2 source inventory runtimeSlotsPerPack must be unique and non-empty");
  const supported = new Set(["albedo", "normal", "roughness"]);
  for (const slot of inventory.runtimeSlotsPerPack)
    if (!supported.has(slot)) throw Error(`KTX2 source inventory slot ${slot} is unsupported`);
  return inventory;
}

function sourceUsage(g, inventory) {
  if ((g.images?.length ?? 0) !== inventory.images)
    throw Error(`embedded image inventory must contain exactly ${inventory.images} images`);
  if (inventory.textures !== undefined && (g.textures?.length ?? 0) !== inventory.textures)
    throw Error(`texture inventory must contain exactly ${inventory.textures} objects`);
  if (inventory.materials !== undefined && (g.materials?.length ?? 0) !== inventory.materials)
    throw Error(`material inventory must contain exactly ${inventory.materials} materials`);
  const packRecords = g.asset?.extras?.liminaMaterialSources?.packs;
  if (!Array.isArray(packRecords) || packRecords.length !== inventory.packs)
    throw Error(`expected ${inventory.packs} declared cottage material packs`);
  const declaredPacks = new Set(packRecords.map((record) => record.id));
  if (declaredPacks.size !== inventory.packs) throw Error("declared cottage material packs must be unique");
  const usage = Array.from({ length: g.images.length }, () => []),
    textureImage = (texture) => g.textures?.[texture.index]?.source;
  for (const material of g.materials ?? []) {
    const materialPack = material.extras?.limina_material_pack;
    if (materialPack === undefined) continue;
    if (!declaredPacks.has(materialPack)) throw Error(`material ${material.name} uses undeclared pack ${materialPack}`);
    for (const [kind, texture] of [
      ["albedo", material.pbrMetallicRoughness?.baseColorTexture],
      ["roughness", material.pbrMetallicRoughness?.metallicRoughnessTexture],
      ["normal", material.normalTexture],
    ])
      if (texture !== undefined) {
        const image = textureImage(texture);
        if (!Number.isInteger(image) || usage[image] === undefined)
          throw Error(`material ${material.name} has invalid ${kind} texture`);
        usage[image].push({ pack: materialPack, kind, material: material.name });
      }
  }
  if (usage.some((entries) => entries.length === 0))
    throw Error("embedded image inventory is not closed to declared runtime slots");
  for (const entries of usage)
    if (
      new Set(entries.map((entry) => entry.pack)).size !== 1 ||
      new Set(entries.map((entry) => entry.kind)).size !== 1
    )
      throw Error("embedded image aliases incompatible material packs or slots");
  const slotsByPack = new Map([...declaredPacks].map((packId) => [packId, new Map()]));
  for (const entries of usage) {
    const packSlots = slotsByPack.get(entries[0].pack),
      kind = entries[0].kind;
    packSlots.set(kind, (packSlots.get(kind) ?? 0) + 1);
  }
  const expectedSlots = [...inventory.runtimeSlotsPerPack].sort();
  for (const [packId, slots] of slotsByPack) {
    if (JSON.stringify([...slots.keys()].sort()) !== JSON.stringify(expectedSlots))
      throw Error(`material pack ${packId} does not provide the exact runtime slot set`);
    for (const kind of expectedSlots)
      if (slots.get(kind) !== 1) throw Error(`material pack ${packId} must have exactly one source image for ${kind}`);
  }
  return { declaredPacks, usage };
}

export function validateKtx2SourceDocument(g, expectedInventory = DEFAULT_KTX2_SOURCE_INVENTORY) {
  return sourceUsage(g, validateKtx2SourceInventory(expectedInventory));
}

export function ktx2ModeFieldFor(kind, uastc) {
  return kind === "normal" ? "normalMode" : uastc ? "criticalAlbedoMode" : "defaultMode";
}
export function ktx2ModeFor(kind, uastc, encodingBudget = DEFAULT_KTX2_ENCODING_BUDGET) {
  const budget = validateKtx2EncodingBudget(encodingBudget);
  return budget[ktx2ModeFieldFor(kind, uastc)];
}

export function preflightKtx2Source(
  source,
  {
    expectedSourceSha256,
    encodingBudget = DEFAULT_KTX2_ENCODING_BUDGET,
    expectedInventory = DEFAULT_KTX2_SOURCE_INVENTORY,
  } = {},
) {
  if (!Buffer.isBuffer(source) && !(source instanceof Uint8Array)) throw Error("KTX2 source bytes are required");
  if (!/^[0-9a-f]{64}$/.test(expectedSourceSha256 ?? ""))
    throw Error("expected source authority must be lowercase sha256");
  if (hash(source) !== expectedSourceSha256) throw Error("source authority hash mismatch");
  const budget = validateKtx2EncodingBudget(encodingBudget),
    inventory = validateKtx2SourceInventory(expectedInventory),
    parsed = parse(Buffer.from(source)),
    closure = sourceUsage(parsed.json, inventory);
  if (parsed.json.textures.length > budget.maxTextureObjects)
    throw Error("source texture objects exceed the declared encoding budget");
  if (parsed.json.images.length > budget.maxUniqueImages)
    throw Error("source unique images exceed the declared encoding budget");
  return { json: parsed.json, bin: parsed.bin, budget, inventory, ...closure };
}

export function validateKtx2OutputDocument(
  g,
  { encodingBudget = DEFAULT_KTX2_ENCODING_BUDGET, expectedInventory = DEFAULT_KTX2_SOURCE_INVENTORY } = {},
) {
  const budget = validateKtx2EncodingBudget(encodingBudget),
    inventory = validateKtx2SourceInventory(expectedInventory);
  if ((g.images?.length ?? 0) !== inventory.images) throw Error("derived KTX2 image inventory drifted");
  if (inventory.textures !== undefined && (g.textures?.length ?? 0) !== inventory.textures)
    throw Error("derived KTX2 texture inventory drifted");
  if (inventory.materials !== undefined && (g.materials?.length ?? 0) !== inventory.materials)
    throw Error("derived KTX2 material inventory drifted");
  if (g.images.some((image) => image.mimeType !== "image/ktx2" || !Number.isInteger(image.bufferView)))
    throw Error("derived artifact contains a fallback raster image");
  const basisSources = g.textures.map((texture) => texture.extensions?.KHR_texture_basisu?.source);
  if (
    g.textures.some(
      (texture, index) =>
        texture.source !== undefined ||
        !Number.isInteger(basisSources[index]) ||
        basisSources[index] < 0 ||
        basisSources[index] >= g.images.length,
    )
  )
    throw Error("derived artifact contains a fallback or invalid Basis texture source");
  if (new Set(basisSources).size !== g.images.length)
    throw Error("derived artifact does not close every KTX2 image to a Basis texture source");
  if (!g.extensionsUsed?.includes("KHR_texture_basisu") || !g.extensionsRequired?.includes("KHR_texture_basisu"))
    throw Error("derived artifact does not require KHR_texture_basisu");
  if (g.textures.length > budget.maxTextureObjects || g.images.length > budget.maxUniqueImages)
    throw Error("derived artifact exceeds declared texture/image budgets");
  return g;
}

function imageDimensions(bytes, mimeType) {
  if (
    mimeType === "image/png" &&
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if (new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]).has(marker))
        return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
      offset += 2 + length;
    }
  }
  throw Error(`cannot determine ${mimeType} source image dimensions`);
}

export async function compressHallHouse({
  input = "assets/buildings/functional-hall-house-v4-lod.glb",
  output = "assets/buildings/functional-hall-house-v4-production.glb",
  manifest = "assets/buildings/functional-hall-house-v4-production.ktx2.json",
  expectedSourceSha256 = SOURCE_SHA256,
  encodingBudget = DEFAULT_KTX2_ENCODING_BUDGET,
  expectedInventory = DEFAULT_KTX2_SOURCE_INVENTORY,
} = {}) {
  const source = await readFile(resolve(input)),
    preflight = preflightKtx2Source(source, { expectedSourceSha256, encodingBudget, expectedInventory }),
    { json: g, bin, budget, inventory, declaredPacks, usage } = preflight;
  const tool = resolve(TOOL),
    version = spawnSync(tool, ["--version"], { encoding: "utf8" }).stdout.trim(),
    dir = await mkdtemp(resolve(tmpdir(), "limina-ktx2-"));
  const critical = new Set(["cottage-fieldstone", "cottage-structural-oak", "cottage-grey-roof"]),
    payloads = [],
    records = [];
  try {
    for (let i = 0; i < g.images.length; i++) {
      const im = g.images[i],
        v = g.bufferViews[im.bufferView],
        sourceImage = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength),
        entries = usage[i],
        pack = entries[0].pack,
        kind = entries[0].kind,
        uastc = kind === "normal" || (critical.has(pack) && kind === "albedo"),
        srgb = kind === "albedo",
        extension = im.mimeType === "image/jpeg" ? "jpg" : "png";
      const src = resolve(dir, `${i}.${extension}`),
        dst = resolve(dir, `${i}.ktx2`);
      await writeFile(src, sourceImage);
      const options = uastc
        ? [
            "--t2",
            "--encode",
            "uastc",
            "--uastc_quality",
            "3",
            "--uastc_rdo_l",
            kind === "normal" ? "0.5" : "0.75",
            "--uastc_rdo_m",
            "--zcmp",
            "18",
          ]
        : [
            "--t2",
            "--encode",
            "etc1s",
            "--qlevel",
            kind === "normal" ? "200" : "160",
            "--clevel",
            "5",
            "--threads",
            "1",
          ];
      options.push("--genmipmap", "--filter", budget.mipFilter, "--assign_oetf", srgb ? "srgb" : "linear");
      const run = spawnSync(tool, [...options, dst, src], { encoding: "utf8", maxBuffer: 10 << 20 });
      if (run.status !== 0)
        throw Error(
          `toktx ${i}: ${JSON.stringify({ stderr: run.stderr.slice(-500), stdout: run.stdout.slice(0, 500) })}`,
        );
      const ktx = await readFile(dst),
        [width, height] = imageDimensions(sourceImage, im.mimeType),
        mode = ktx2ModeFor(kind, uastc, budget);
      payloads.push(ktx);
      records.push({
        image: i,
        name: `${pack} ${kind}`,
        pack,
        kind,
        materials: entries.map((entry) => entry.material).sort(),
        sourceMimeType: im.mimeType,
        sourceMapSha256: hash(sourceImage),
        colorSpace: srgb ? "sRGB" : "linear",
        channelEncoding: kind === "normal" ? "rgb-tangent-space" : "rgb",
        mode,
        options,
        payloadBytes: ktx.length,
        payloadSha256: hash(ktx),
        width,
        height,
        gpuBlockBytes: mipBlocks(width, height, uastc ? 16 : 8),
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const oldImageViews = new Set(g.images.map((x) => x.bufferView)),
    chunks = [];
  let offset = 0;
  for (let i = 0; i < g.bufferViews.length; i++) {
    if (oldImageViews.has(i)) continue;
    const v = g.bufferViews[i],
      d = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength),
      o = pad(offset);
    chunks.push(Buffer.alloc(o - offset), d);
    v.byteOffset = o;
    offset = o + d.length;
  }
  for (let i = 0; i < payloads.length; i++) {
    const o = pad(offset),
      d = payloads[i];
    chunks.push(Buffer.alloc(o - offset), d);
    const vi = g.bufferViews.length;
    g.bufferViews.push({ buffer: 0, byteOffset: o, byteLength: d.length });
    g.images[i] = { bufferView: vi, mimeType: "image/ktx2", name: records[i].name };
    for (const texture of g.textures)
      if (texture.source === i) {
        texture.extensions = { KHR_texture_basisu: { source: i } };
        delete texture.source;
      }
    offset = o + d.length;
  }
  g.extensionsUsed = [...new Set([...(g.extensionsUsed ?? []), "KHR_texture_basisu"])];
  g.extensionsRequired = [...new Set([...(g.extensionsRequired ?? []), "KHR_texture_basisu"])];
  validateKtx2OutputDocument(g, { encodingBudget: budget, expectedInventory: inventory });
  const out = pack(g, Buffer.concat(chunks)),
    gpuBlockBytes = records.reduce((s, x) => s + x.gpuBlockBytes, 0);
  if (out.length > budget.maxArtifactBytes) throw Error(`output exceeds declared byte budget: ${out.length}`);
  if (gpuBlockBytes > budget.maxGpuResidencyBytes)
    throw Error(`residency exceeds declared byte budget: ${gpuBlockBytes}`);
  await writeFile(resolve(output), out);
  const man = {
    schema: "limina.ktx2-production/1",
    source: { path: input, sha256: hash(source), bytes: source.length },
    output: { path: output, sha256: hash(out), engineHash: portableAssetContentHash(out), bytes: out.length },
    tool: { path: TOOL, version },
    policy: { pngFallback: false, mipmaps: true, criticalRoles: [...critical], encodingBudget: { ...budget } },
    gpuResidency: {
      model:
        "exact 4x4 universal-transcode block allocation including full mip chains; UASTC=16 bytes/block, ETC1S=8 bytes/block",
      bytes: gpuBlockBytes,
      mib: gpuBlockBytes / 1048576,
      limitMiB: budget.maxGpuResidencyBytes / 1048576,
    },
    textures: records,
  };
  await writeFile(resolve(manifest), JSON.stringify(man, null, 2) + "\n");
  return man;
}
if (import.meta.url === `file://${process.argv[1]}`)
  console.log(
    JSON.stringify(
      await compressHallHouse({
        input: process.argv[2],
        output: process.argv[3],
        manifest: process.argv[4],
        expectedSourceSha256: process.argv[5] ?? SOURCE_SHA256,
      }),
      null,
      2,
    ),
  );
