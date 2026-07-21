import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "../../js/node_modules/sharp/lib/index.js";

export const MATERIAL_PACK_LAYER_SCHEMA = "limina.material-pack/v1";
const HASH = /^sha256:[0-9a-f]{64}$/;
const REQUIRED_MAPS = Object.freeze(["albedo", "normal", "roughness", "occlusion", "displacement"]);

function rawHash(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function assetHash(bytes) {
  return `sha256:${createHash("sha256").update(Buffer.from(bytes).toString("hex"), "utf8").digest("hex")}`;
}
function plain(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}
function mapEntry(value, label) {
  const entry = plain(value, label);
  if (typeof entry.assetId !== "string" || !entry.assetId.startsWith("materials/") || !HASH.test(entry.sha256)
      || !HASH.test(entry.assetHash) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) {
    throw new TypeError(`${label} identity is invalid`);
  }
  return entry;
}
async function verifiedBytes(root, entry, label) {
  const absolute = resolve(root, entry.assetId);
  if (!absolute.startsWith(resolve(root, "materials") + "/")) throw new Error(`${label} escapes the material root`);
  const bytes = await readFile(absolute);
  if (bytes.byteLength !== entry.bytes || rawHash(bytes) !== entry.sha256 || assetHash(bytes) !== entry.assetHash) {
    throw new Error(`${label} bytes do not match the material-pack identity`);
  }
  return bytes;
}
async function rgba(bytes, width) {
  const result = await sharp(bytes, { failOn: "error" }).resize(width, width, { fit: "fill", kernel: "lanczos3" })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (result.info.width !== width || result.info.height !== width || result.info.channels !== 4) throw new Error("decoded material map is not canonical RGBA8");
  return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
}
async function gray(bytes, width) {
  const result = await sharp(bytes, { failOn: "error" }).resize(width, width, { fit: "fill", kernel: "lanczos3" })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  if (result.info.width !== width || result.info.height !== width || result.info.channels !== 1) throw new Error("decoded material scalar map is not canonical R8");
  return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
}

export async function loadMaterialPackLayer({ root, manifestAssetId, expectedContentHash, width = 512, index = 0 }) {
  if (!Number.isSafeInteger(width) || width < 16 || width > 4096 || !Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("material pack layer dimensions or index are invalid");
  }
  const manifestPath = resolve(root, manifestAssetId);
  if (!manifestPath.startsWith(resolve(root, "materials") + "/") || dirname(manifestPath) === resolve(root, "materials")) {
    throw new Error("material pack manifest escapes or aliases the material root");
  }
  const manifestBytes = await readFile(manifestPath);
  const contentHash = assetHash(manifestBytes);
  if (expectedContentHash !== undefined && contentHash !== expectedContentHash) throw new Error("material pack manifest content hash mismatch");
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch (error) { throw new Error("material pack manifest JSON is invalid", { cause: error }); }
  plain(manifest, "material pack manifest");
  if (manifest.schema !== MATERIAL_PACK_LAYER_SCHEMA || typeof manifest.id !== "string" || manifest.source?.licenseSpdx !== "CC0-1.0") {
    throw new Error("material pack manifest schema or provenance is unsupported");
  }
  const entries = Object.fromEntries(REQUIRED_MAPS.map((slot) => [slot, mapEntry(manifest.maps?.[slot], `material pack ${slot}`)]));
  const [albedoBytes, normalBytes, roughnessBytes, occlusionBytes, displacementBytes] = await Promise.all([
    verifiedBytes(root, entries.albedo, "material pack albedo"),
    verifiedBytes(root, entries.normal, "material pack normal"),
    verifiedBytes(root, entries.roughness, "material pack roughness"),
    verifiedBytes(root, entries.occlusion, "material pack occlusion"),
    verifiedBytes(root, entries.displacement, "material pack displacement"),
  ]);
  const [albedo, normal, roughness, occlusion, displacement] = await Promise.all([
    rgba(albedoBytes, width), rgba(normalBytes, width), gray(roughnessBytes, width), gray(occlusionBytes, width),
    gray(displacementBytes, width),
  ]);
  const orm = new Uint8Array(width * width * 4);
  for (let pixel = 0; pixel < width * width; pixel++) {
    const offset = pixel * 4;
    orm[offset] = occlusion[pixel];
    orm[offset + 1] = roughness[pixel];
    orm[offset + 2] = 0;
    orm[offset + 3] = 255;
  }
  return Object.freeze({
    index,
    assetId: manifestAssetId,
    contentHash,
    width,
    height: width,
    albedo,
    normal,
    orm,
    displacement,
    provenance: Object.freeze({ provider: manifest.source.provider, sourceAssetId: manifest.source.assetId, licenseSpdx: manifest.source.licenseSpdx }),
  });
}
