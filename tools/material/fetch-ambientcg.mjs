import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { unzipSync } from "fflate";

export const AMBIENTCG_MATERIAL_PACK_SCHEMA = "limina.material-pack/v1";
export const AMBIENTCG_API_VERSION = "v3";
export const AMBIENTCG_MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const AMBIENTCG_MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SLOT_PATTERNS = Object.freeze({
  albedo: /_Color\.(?:jpe?g|png)$/i,
  normal: /_NormalGL\.(?:jpe?g|png)$/i,
  roughness: /_Roughness\.(?:jpe?g|png)$/i,
  occlusion: /_AmbientOcclusion\.(?:jpe?g|png)$/i,
  displacement: /_Displacement\.(?:jpe?g|png)$/i,
});

function sha256(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function engineAssetHash(bytes) {
  return `sha256:${createHash("sha256").update(Buffer.from(bytes).toString("hex"), "utf8").digest("hex")}`;
}
function canonicalJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function assertString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}
function plain(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}
function safeArchiveName(name) {
  if (typeof name !== "string" || name.length < 1 || name.length > 240 || name.includes("\\") || name.includes("\0")
      || name.startsWith("/") || name.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`ambientCG archive contains unsafe entry '${String(name)}'`);
  }
  return name;
}
function controlledPath(root, name) {
  const output = resolve(root, name);
  const rel = relative(resolve(root), output);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("ambientCG output escaped its material directory");
  return output;
}

async function responseBytes(response, maximum, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new RangeError(`${label} declares ${declared} bytes, exceeding ${maximum}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new RangeError(`${label} is ${bytes.byteLength} bytes, exceeding ${maximum}`);
  return bytes;
}

function selectDownload(asset, attributes) {
  if (asset.type !== "material" || !Array.isArray(asset.downloads) || !Array.isArray(asset.maps)) {
    throw new Error("ambientCG asset is not a downloadable material");
  }
  const download = asset.downloads.find((candidate) => candidate?.attributes === attributes && candidate?.extension === "zip");
  if (download === undefined || typeof download.url !== "string") throw new Error(`ambientCG material has no ${attributes} zip`);
  const url = new URL(download.url);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "ambientcg.com" || url.pathname !== "/get") {
    throw new Error("ambientCG download URL is outside the pinned HTTPS endpoint");
  }
  const file = url.searchParams.get("file");
  if (file === null || file !== `${asset.id}_${attributes}.zip`) throw new Error("ambientCG download URL does not match the requested asset/archive identity");
  if (!Number.isSafeInteger(download.size) || download.size < 1 || download.size > AMBIENTCG_MAX_ARCHIVE_BYTES) {
    throw new RangeError("ambientCG advertised archive size is outside the supported budget");
  }
  return { url: url.href, size: download.size };
}

/** Fetch and atomically publish one bounded CC0 ambientCG PBR pack. */
export async function fetchAmbientCgMaterial(options) {
  const assetId = assertString(options?.assetId, ASSET_ID, "ambientCG assetId");
  const name = assertString(options?.name ?? assetId.toLowerCase(), NAME, "material name");
  const resolution = options?.resolution ?? "1K";
  const format = options?.format ?? "JPG";
  if (resolution !== "1K" && resolution !== "2K") throw new RangeError("ambientCG resolution must be 1K or 2K");
  if (format !== "JPG" && format !== "PNG") throw new RangeError("ambientCG format must be JPG or PNG");
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("ambientCG fetch implementation is unavailable");
  const outputRoot = resolve(options?.outputRoot ?? "assets/materials");
  const destination = controlledPath(outputRoot, name);
  const attributes = `${resolution}-${format}`;
  const apiUrl = new URL("https://ambientcg.com/api/v3/assets");
  apiUrl.searchParams.set("id", assetId);
  apiUrl.searchParams.set("include", "type,title,url,maps,downloads");

  const apiResponse = await fetchImpl(apiUrl, { redirect: "error" });
  const apiBytes = await responseBytes(apiResponse, 2 * 1024 * 1024, "ambientCG metadata request");
  let payload;
  try { payload = plain(JSON.parse(new TextDecoder().decode(apiBytes)), "ambientCG response"); }
  catch (error) { throw new Error(`ambientCG returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(payload.assets) || payload.assets.length !== 1) throw new Error(`ambientCG returned ${Array.isArray(payload.assets) ? payload.assets.length : "invalid"} matching assets`);
  const asset = plain(payload.assets[0], "ambientCG asset");
  if (asset.id !== assetId) throw new Error("ambientCG response asset id does not match the request");
  const download = selectDownload(asset, attributes);
  const archiveResponse = await fetchImpl(download.url, { redirect: "follow" });
  const archiveBytes = await responseBytes(archiveResponse, AMBIENTCG_MAX_ARCHIVE_BYTES, "ambientCG material download");
  const extracted = unzipSync(archiveBytes);
  const selected = {};
  let extractedBytes = 0;
  for (const [rawName, bytes] of Object.entries(extracted)) {
    const entry = safeArchiveName(rawName);
    extractedBytes += bytes.byteLength;
    if (extractedBytes > AMBIENTCG_MAX_EXTRACTED_BYTES) throw new RangeError("ambientCG archive exceeds the extracted-byte budget");
    const filename = basename(entry);
    for (const [slot, pattern] of Object.entries(SLOT_PATTERNS)) {
      if (!pattern.test(filename)) continue;
      if (selected[slot] !== undefined) throw new Error(`ambientCG archive contains duplicate ${slot} maps`);
      selected[slot] = Object.freeze({ filename, bytes });
    }
  }
  for (const slot of ["albedo", "normal", "roughness", "occlusion"]) {
    if (selected[slot] === undefined) throw new Error(`ambientCG archive is missing required ${slot} map`);
  }

  await mkdir(outputRoot, { recursive: true });
  const staging = await mkdtemp(join(outputRoot, `.${name}.tmp-`));
  try {
    const maps = {};
    for (const slot of Object.keys(SLOT_PATTERNS)) {
      const source = selected[slot];
      if (source === undefined) continue;
      const outputName = `${slot}.${source.filename.toLowerCase().endsWith(".png") ? "png" : "jpg"}`;
      await writeFile(controlledPath(staging, outputName), source.bytes, { flag: "wx", mode: 0o644 });
      maps[slot] = Object.freeze({
        assetId: `materials/${name}/${outputName}`,
        sha256: sha256(source.bytes),
        assetHash: engineAssetHash(source.bytes),
        bytes: source.bytes.byteLength,
      });
    }
    const manifest = Object.freeze({
      schema: AMBIENTCG_MATERIAL_PACK_SCHEMA,
      id: name,
      source: Object.freeze({ provider: "ambientCG", assetId, assetUrl: asset.url, apiVersion: AMBIENTCG_API_VERSION, licenseSpdx: "CC0-1.0" }),
      download: Object.freeze({ attributes, url: download.url, archiveBytes: archiveBytes.byteLength, archiveSha256: sha256(archiveBytes) }),
      maps: Object.freeze(maps),
      materialImport: Object.freeze({
        name,
        albedo: maps.albedo.assetId,
        normal: maps.normal.assetId,
        roughness: maps.roughness.assetId,
        occlusion: maps.occlusion.assetId,
        ...(maps.displacement === undefined ? {} : { displacement: maps.displacement.assetId }),
      }),
    });
    await writeFile(join(staging, "material-pack.json"), canonicalJson(manifest), { flag: "wx", mode: 0o644 });
    try { await readFile(join(destination, "material-pack.json")); throw new Error(`material pack '${name}' already exists`); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    await rename(staging, destination);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
