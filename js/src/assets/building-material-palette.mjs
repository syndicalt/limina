export const BUILDING_MATERIAL_PALETTE_SCHEMA = "limina.building-material-palette/v1";

const HASH = /^sha256:[0-9a-f]{64}$/;
const MD5 = /^[0-9a-f]{32}$/;
const ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const PACK_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const POLY_HAVEN_ASSET_ID = /^[a-z0-9][a-z0-9_]{0,95}$/;
const MAP_SLOTS = Object.freeze(["albedo", "normal", "roughness", "occlusion", "displacement"]);
const MAP_CONTRACT = Object.freeze({
  albedo: Object.freeze({ colorSpace: "sRGB", channelSemantics: "rgb-color" }),
  normal: Object.freeze({ colorSpace: "linear", channelSemantics: "rgb-tangent-space" }),
  roughness: Object.freeze({ colorSpace: "linear", channelSemantics: "r-roughness" }),
  occlusion: Object.freeze({ colorSpace: "linear", channelSemantics: "r-occlusion" }),
  displacement: Object.freeze({ colorSpace: "linear", channelSemantics: "r-height-white-high" }),
});
const AO_POLICIES = new Set(["embedded-occlusion", "source-only", "omitted"]);
const DISPLACEMENT_POLICIES = new Set(["parallax", "geometry", "source-only", "omitted"]);
const TANGENT_BASES = new Set(["vertex-tangent", "uv-derivative"]);

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
function exactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in value)) throw new TypeError(`${label}.${key} is required`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${label}.${key} is unsupported`);
}
function text(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} is required`);
  return value;
}
function id(value, label, pattern = ID) {
  text(value, label);
  if (!pattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}
function hash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) throw new TypeError(`${label} must be lowercase sha256`);
  return value;
}
function finite(value, label, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`${label} must be within [${minimum}, ${maximum}]`);
  return value;
}
function positiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`${label} must be a positive bounded integer`);
  return value;
}
function https(value, label, host) {
  text(value, label);
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${label} must be an HTTPS URL`); }
  if (url.protocol !== "https:" || (host !== undefined && url.hostname !== host)) throw new TypeError(`${label} must use the approved HTTPS host`);
  return value;
}
function rgb(value, label) {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${label} must be RGB`);
  value.forEach((channel, index) => finite(channel, `${label}[${index}]`, 0, 1));
  return value;
}
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validateMap(raw, slot, packId, sourceAssetId) {
  const map = object(raw, `${packId}.${slot}`);
  exactKeys(map, ["assetId", "sha256", "assetHash", "sourceMd5", "bytes", "width", "height", "sourceUrl", "colorSpace", "channelSemantics"], [], `${packId}.${slot}`);
  if (map.assetId !== `materials/${packId}/${slot}.jpg`) throw new TypeError(`${packId}.${slot}.assetId must use the canonical material-pack path`);
  hash(map.sha256, `${packId}.${slot}.sha256`); hash(map.assetHash, `${packId}.${slot}.assetHash`);
  if (typeof map.sourceMd5 !== "string" || !MD5.test(map.sourceMd5)) throw new TypeError(`${packId}.${slot}.sourceMd5 must be lowercase md5`);
  positiveInteger(map.bytes, `${packId}.${slot}.bytes`, 16 * 1024 * 1024);
  positiveInteger(map.width, `${packId}.${slot}.width`, 8192); positiveInteger(map.height, `${packId}.${slot}.height`, 8192);
  if (map.width !== map.height) throw new RangeError(`${packId}.${slot} must be square`);
  https(map.sourceUrl, `${packId}.${slot}.sourceUrl`, "dl.polyhaven.org");
  if (!new URL(map.sourceUrl).pathname.startsWith(`/file/ph-assets/Textures/jpg/1k/${sourceAssetId}/`)) throw new TypeError(`${packId}.${slot}.sourceUrl does not match its Poly Haven pack identity`);
  const expected = MAP_CONTRACT[slot];
  if (map.colorSpace !== expected.colorSpace || map.channelSemantics !== expected.channelSemantics) throw new TypeError(`${packId}.${slot} has invalid color-space or channel semantics`);
  return map;
}

function validatePack(raw, index) {
  const pack = object(raw, `packs[${index}]`);
  exactKeys(pack, ["id", "provider", "assetId", "assetUrl", "apiUrl", "apiVersion", "licenseSpdx", "manifestSha256", "maps"], [], `packs[${index}]`);
  id(pack.id, `packs[${index}].id`, PACK_ID); id(pack.assetId, `${pack.id}.assetId`, POLY_HAVEN_ASSET_ID);
  if (pack.provider !== "Poly Haven" || pack.apiVersion !== "v1" || pack.licenseSpdx !== "CC0-1.0") throw new TypeError(`${pack.id} must be pinned Poly Haven v1 CC0`);
  if (pack.assetUrl !== `https://polyhaven.com/a/${pack.assetId}` || pack.apiUrl !== `https://api.polyhaven.com/files/${pack.assetId}`) throw new TypeError(`${pack.id} URLs do not match its source identity`);
  https(pack.assetUrl, `${pack.id}.assetUrl`, "polyhaven.com"); https(pack.apiUrl, `${pack.id}.apiUrl`, "api.polyhaven.com"); hash(pack.manifestSha256, `${pack.id}.manifestSha256`);
  const maps = object(pack.maps, `${pack.id}.maps`); exactKeys(maps, MAP_SLOTS, [], `${pack.id}.maps`);
  for (const slot of MAP_SLOTS) validateMap(maps[slot], slot, pack.id, pack.assetId);
  const dimensions = new Set(MAP_SLOTS.flatMap((slot) => [maps[slot].width, maps[slot].height]));
  if (dimensions.size !== 1) throw new RangeError(`${pack.id} map dimensions must agree`);
  return pack;
}

function validateTextureRole(raw, index, packById) {
  const role = object(raw, `roles[${index}]`);
  exactKeys(role, ["role", "materialName", "kind", "packId", "normal", "surface", "runtimePolicy"], [], `roles[${index}]`);
  id(role.role, `roles[${index}].role`); text(role.materialName, `roles[${index}].materialName`);
  if (role.kind !== "texture-pack") throw new TypeError(`roles[${index}].kind must be texture-pack`);
  id(role.packId, `${role.role}.packId`, PACK_ID);
  const pack = packById.get(role.packId);
  if (pack === undefined) throw new TypeError(`${role.role}.packId does not resolve to the locked pack inventory`);
  const normal = object(role.normal, `${role.role}.normal`);
  exactKeys(normal, ["convention", "scale", "tangentBasis"], [], `${role.role}.normal`);
  if (normal.convention !== "opengl-tangent-space" || !TANGENT_BASES.has(normal.tangentBasis)) throw new TypeError(`${role.role}.normal has an unsupported convention or tangent basis`);
  finite(normal.scale, `${role.role}.normal.scale`, 0.01, 2);
  const surface = object(role.surface, `${role.role}.surface`);
  exactKeys(surface, ["metresPerRepeat", "sourceTexelsPerMetre", "texelsPerMetreBand"], [], `${role.role}.surface`);
  finite(surface.metresPerRepeat, `${role.role}.surface.metresPerRepeat`, 0.05, 32);
  finite(surface.sourceTexelsPerMetre, `${role.role}.surface.sourceTexelsPerMetre`, 16, 8192);
  const band = object(surface.texelsPerMetreBand, `${role.role}.surface.texelsPerMetreBand`);
  exactKeys(band, ["min", "max"], [], `${role.role}.surface.texelsPerMetreBand`);
  finite(band.min, `${role.role}.surface.texelsPerMetreBand.min`, 16, 8192); finite(band.max, `${role.role}.surface.texelsPerMetreBand.max`, 16, 8192);
  if (band.min > band.max) throw new RangeError(`${role.role} texel-density band is inverted`);
  const derived = pack.maps.albedo.width / surface.metresPerRepeat;
  if (Math.abs(derived - surface.sourceTexelsPerMetre) > Math.max(0.01, derived * 1e-6)) throw new RangeError(`${role.role} sourceTexelsPerMetre disagrees with map width/metresPerRepeat`);
  if (derived < band.min || derived > band.max) throw new RangeError(`${role.role} texel density lies outside its declared band`);
  const runtime = object(role.runtimePolicy, `${role.role}.runtimePolicy`);
  exactKeys(runtime, ["occlusion", "displacement"], [], `${role.role}.runtimePolicy`);
  if (!AO_POLICIES.has(runtime.occlusion) || !DISPLACEMENT_POLICIES.has(runtime.displacement)) throw new TypeError(`${role.role} has an unsupported AO/displacement policy`);
  return role;
}

function validateSimpleRole(raw, index) {
  const role = object(raw, `roles[${index}]`);
  exactKeys(role, ["role", "materialName", "kind", "authoredBy", "parameters"], [], `roles[${index}]`);
  id(role.role, `roles[${index}].role`); text(role.materialName, `roles[${index}].materialName`);
  if (role.kind !== "authored-simple" || role.authoredBy !== "Limina Project") throw new TypeError(`${role.role} must identify its Limina-authored source`);
  const parameters = object(role.parameters, `${role.role}.parameters`);
  exactKeys(parameters, ["baseColorSrgb", "roughness", "metallic", "alpha", "emissionSrgb", "emissionStrength"], [], `${role.role}.parameters`);
  rgb(parameters.baseColorSrgb, `${role.role}.parameters.baseColorSrgb`); rgb(parameters.emissionSrgb, `${role.role}.parameters.emissionSrgb`);
  finite(parameters.roughness, `${role.role}.parameters.roughness`, 0, 1); finite(parameters.metallic, `${role.role}.parameters.metallic`, 0, 1);
  finite(parameters.alpha, `${role.role}.parameters.alpha`, 0, 1); finite(parameters.emissionStrength, `${role.role}.parameters.emissionStrength`, 0, 16);
  return role;
}

function validateInputShell(raw) {
  const shell = object(raw, "inputShell");
  exactKeys(shell, ["artifactId", "contractHash", "contentHash", "surfaceMappingFacetHash", "materialRoleSlotsFacetHash"], [], "inputShell");
  id(shell.artifactId, "inputShell.artifactId"); hash(shell.contractHash, "inputShell.contractHash"); hash(shell.contentHash, "inputShell.contentHash");
  hash(shell.surfaceMappingFacetHash, "inputShell.surfaceMappingFacetHash"); hash(shell.materialRoleSlotsFacetHash, "inputShell.materialRoleSlotsFacetHash");
  return shell;
}

function validateEncodingBudget(raw) {
  const encoding = object(raw, "encodingBudget");
  exactKeys(encoding, ["container", "gltfExtension", "fallback", "mipmaps", "mipFilter", "normalMode", "criticalAlbedoMode", "defaultMode", "maxArtifactBytes", "maxGpuResidencyBytes", "maxTextureObjects", "maxUniqueImages", "residencyAccounting"], [], "encodingBudget");
  if (encoding.container !== "KTX2" || encoding.gltfExtension !== "KHR_texture_basisu" || encoding.fallback !== "none" || encoding.mipmaps !== true || encoding.mipFilter !== "lanczos4") throw new TypeError("encodingBudget must require fallback-free mipmapped KTX2/BasisU");
  if (encoding.normalMode !== "UASTC+Zstd" || encoding.criticalAlbedoMode !== "UASTC+Zstd" || encoding.defaultMode !== "ETC1S/BasisLZ") throw new TypeError("encodingBudget uses unsupported production modes");
  positiveInteger(encoding.maxArtifactBytes, "encodingBudget.maxArtifactBytes", 512 * 1024 * 1024);
  positiveInteger(encoding.maxGpuResidencyBytes, "encodingBudget.maxGpuResidencyBytes", 1024 * 1024 * 1024);
  positiveInteger(encoding.maxTextureObjects, "encodingBudget.maxTextureObjects", 4096); positiveInteger(encoding.maxUniqueImages, "encodingBudget.maxUniqueImages", 4096);
  if (encoding.maxUniqueImages > encoding.maxTextureObjects) throw new RangeError("encodingBudget unique images cannot exceed texture objects");
  if (encoding.residencyAccounting !== "exact-4x4-blocks-full-mip-chain") throw new TypeError("encodingBudget residency accounting is unsupported");
  return encoding;
}

/** Strict, mutation-resistant M1 palette parser. Optional authority closes the generic schema to one shell and exact role set. */
export function validateBuildingMaterialPalette(value, authority = {}) {
  const palette = object(value, "building material palette");
  exactKeys(palette, ["schema", "paletteId", "revision", "inputShell", "packs", "roles", "encodingBudget"], [], "building material palette");
  if (palette.schema !== BUILDING_MATERIAL_PALETTE_SCHEMA) throw new TypeError("unsupported building material palette schema");
  id(palette.paletteId, "paletteId"); positiveInteger(palette.revision, "revision", 1_000_000);
  const shell = validateInputShell(palette.inputShell);
  if (!Array.isArray(palette.packs) || palette.packs.length < 1 || palette.packs.length > 32) throw new RangeError("packs must contain 1..32 identities");
  const packs = palette.packs.map(validatePack), packIds = packs.map((pack) => pack.id);
  if (new Set(packIds).size !== packIds.length) throw new TypeError("material palette packs must be unique");
  if (JSON.stringify(packIds) !== JSON.stringify([...packIds].sort())) throw new TypeError("material palette packs must be canonically sorted");
  const packById = new Map(packs.map((pack) => [pack.id, pack]));
  if (!Array.isArray(palette.roles) || palette.roles.length < 1 || palette.roles.length > 64) throw new RangeError("roles must contain 1..64 assignments");
  const roleNames = [], materialNames = [], referencedPacks = new Set();
  for (const [index, raw] of palette.roles.entries()) {
    const kind = object(raw, `roles[${index}]`).kind;
    const role = kind === "texture-pack" ? validateTextureRole(raw, index, packById) : kind === "authored-simple" ? validateSimpleRole(raw, index) : (() => { throw new TypeError(`roles[${index}].kind is unsupported`); })();
    if (kind === "texture-pack") referencedPacks.add(role.packId);
    roleNames.push(role.role); materialNames.push(role.materialName);
  }
  if (new Set(roleNames).size !== roleNames.length) throw new TypeError("material palette roles must be unique");
  if (new Set(materialNames).size !== materialNames.length) throw new TypeError("material palette material names must be unique");
  if (JSON.stringify(roleNames) !== JSON.stringify([...roleNames].sort())) throw new TypeError("material palette roles must be canonically sorted");
  if (JSON.stringify([...referencedPacks].sort()) !== JSON.stringify(packIds)) throw new TypeError("material palette contains an unused or unreferenced pack identity");
  validateEncodingBudget(palette.encodingBudget);
  if (authority.expectedRoles !== undefined) {
    if (!Array.isArray(authority.expectedRoles) || new Set(authority.expectedRoles).size !== authority.expectedRoles.length) throw new TypeError("expectedRoles authority is invalid");
    authority.expectedRoles.forEach((role, index) => id(role, `expectedRoles[${index}]`));
    const expected = [...authority.expectedRoles].sort();
    if (JSON.stringify(roleNames) !== JSON.stringify(expected)) throw new TypeError("material palette does not assign the exact authoritative role set");
  }
  if (authority.expectedPackIds !== undefined) {
    if (!Array.isArray(authority.expectedPackIds) || new Set(authority.expectedPackIds).size !== authority.expectedPackIds.length) throw new TypeError("expectedPackIds authority is invalid");
    authority.expectedPackIds.forEach((packId, index) => id(packId, `expectedPackIds[${index}]`, PACK_ID));
    if (JSON.stringify(packIds) !== JSON.stringify([...authority.expectedPackIds].sort())) throw new TypeError("material palette does not contain the exact authoritative pack set");
  }
  if (authority.inputShell !== undefined) {
    const expected = validateInputShell(authority.inputShell);
    for (const key of Object.keys(expected)) if (shell[key] !== expected[key]) throw new TypeError(`material palette inputShell.${key} does not match authority`);
  }
  return deepFreeze(palette);
}
