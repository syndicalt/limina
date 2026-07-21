import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export const POLYHAVEN_MATERIAL_PACK_SCHEMA = "limina.material-pack/v1";
export const POLYHAVEN_API_VERSION = "v1";
export const POLYHAVEN_MAX_MAP_BYTES = 16 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9_]{0,95}$/;
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SLOTS = Object.freeze({ albedo: "Diffuse", normal: "nor_gl", roughness: "Rough", occlusion: "AO", displacement: "Displacement" });

const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("hex");
const sha256 = (bytes) => `sha256:${digest("sha256", bytes)}`;
const assetHash = (bytes) => `sha256:${createHash("sha256").update(Buffer.from(bytes).toString("hex"), "utf8").digest("hex")}`;
const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
function controlledPath(root, name) {
  const output = resolve(root, name), rel = relative(resolve(root), output);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("Poly Haven output escaped its material directory");
  return output;
}
async function boundedResponse(response, maximum, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new RangeError(`${label} exceeds ${maximum} bytes`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new RangeError(`${label} exceeds ${maximum} bytes`);
  return bytes;
}
function selectedFile(metadata, kind) {
  const file = metadata?.[kind]?.["1k"]?.jpg;
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > POLYHAVEN_MAX_MAP_BYTES || !/^[a-f0-9]{32}$/.test(file.md5 ?? "")) {
    throw new Error(`Poly Haven metadata lacks bounded 1k JPG ${kind}`);
  }
  const url = new URL(file.url);
  if (url.protocol !== "https:" || url.hostname !== "dl.polyhaven.org" || !url.pathname.startsWith("/file/ph-assets/Textures/jpg/1k/")) {
    throw new Error(`Poly Haven ${kind} URL is outside the pinned HTTPS endpoint`);
  }
  return { size: file.size, md5: file.md5, url: url.href };
}

/** Fetch and atomically publish one bounded, hash-verified CC0 Poly Haven PBR pack. */
export async function fetchPolyHavenMaterial(options) {
  const assetId = options?.assetId;
  const name = options?.name ?? assetId?.replaceAll("_", "-");
  if (typeof assetId !== "string" || !ID.test(assetId)) throw new TypeError("Poly Haven assetId is invalid");
  if (typeof name !== "string" || !NAME.test(name)) throw new TypeError("Poly Haven material name is invalid");
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("Poly Haven fetch implementation is unavailable");
  const outputRoot = resolve(options?.outputRoot ?? "assets/materials");
  const destination = controlledPath(outputRoot, name);
  const apiUrl = `https://api.polyhaven.com/files/${assetId}`;
  const metadataBytes = await boundedResponse(await fetchImpl(apiUrl, { redirect: "error" }), 4 * 1024 * 1024, "Poly Haven metadata request");
  let metadata;
  try { metadata = JSON.parse(new TextDecoder().decode(metadataBytes)); }
  catch (error) { throw new Error(`Poly Haven returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const files = Object.fromEntries(Object.entries(SLOTS).map(([slot, kind]) => [slot, selectedFile(metadata, kind)]));
  await mkdir(outputRoot, { recursive: true });
  const staging = await mkdtemp(join(outputRoot, `.${name}.tmp-`));
  try {
    const maps = {};
    for (const [slot, file] of Object.entries(files)) {
      const bytes = await boundedResponse(await fetchImpl(file.url, { redirect: "error" }), POLYHAVEN_MAX_MAP_BYTES, `Poly Haven ${slot} download`);
      if (bytes.byteLength !== file.size || digest("md5", bytes) !== file.md5) throw new Error(`Poly Haven ${slot} payload disagrees with API size/MD5`);
      const filename = `${slot}.jpg`;
      await writeFile(controlledPath(staging, filename), bytes, { flag: "wx", mode: 0o644 });
      maps[slot] = Object.freeze({ assetId: `materials/${name}/${filename}`, sha256: sha256(bytes), assetHash: assetHash(bytes), md5: file.md5, bytes: bytes.byteLength, sourceUrl: file.url });
    }
    const manifest = Object.freeze({
      schema: POLYHAVEN_MATERIAL_PACK_SCHEMA,
      id: name,
      source: Object.freeze({ provider: "Poly Haven", assetId, assetUrl: `https://polyhaven.com/a/${assetId}`, apiUrl, apiVersion: POLYHAVEN_API_VERSION, licenseSpdx: "CC0-1.0" }),
      download: Object.freeze({ resolution: "1k", format: "JPG", metadataSha256: sha256(metadataBytes) }),
      maps: Object.freeze(maps),
      materialImport: Object.freeze({ name, ...Object.fromEntries(Object.entries(maps).map(([slot, record]) => [slot, record.assetId])) }),
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
