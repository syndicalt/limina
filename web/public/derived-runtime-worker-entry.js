// src/world/sha256.mjs
function utf8ByteLength(str) {
  let length = 0;
  for (let i = 0; i < str.length; i++) {
    const cp = str.codePointAt(i);
    if (cp > 65535) i++;
    length += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
  }
  return length;
}
function utf8Bytes(str) {
  const out = new Uint8Array(utf8ByteLength(str));
  let offset = 0;
  for (let i = 0; i < str.length; i++) {
    const cp = str.codePointAt(i);
    if (cp > 65535) i++;
    if (cp < 128) {
      out[offset++] = cp;
    } else if (cp < 2048) {
      out[offset++] = 192 | cp >> 6;
      out[offset++] = 128 | cp & 63;
    } else if (cp < 65536) {
      out[offset++] = 224 | cp >> 12;
      out[offset++] = 128 | cp >> 6 & 63;
      out[offset++] = 128 | cp & 63;
    } else {
      out[offset++] = 240 | cp >> 18;
      out[offset++] = 128 | cp >> 12 & 63;
      out[offset++] = 128 | cp >> 6 & 63;
      out[offset++] = 128 | cp & 63;
    }
  }
  return out;
}
var K = [
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
];
function rotr(x, n) {
  return (x >>> n | x << 32 - n) >>> 0;
}
function toHex32(word) {
  return (word >>> 0).toString(16).padStart(8, "0");
}
function sha256(input) {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) {
    throw new TypeError("sha256 input must be a string or Uint8Array");
  }
  const msg = typeof input === "string" ? utf8Bytes(input) : input;
  const bitLenLo = msg.length * 8 >>> 0;
  const bitLenHi = Math.floor(msg.length * 8 / 4294967296) >>> 0;
  let h0 = 1779033703, h1 = 3144134277, h2 = 1013904242, h3 = 2773480762;
  let h4 = 1359893119, h5 = 2600822924, h6 = 528734635, h7 = 1541459225;
  const w = new Uint32Array(64);
  const processBlock = (bytes, block) => {
    for (let t = 0; t < 16; t++) {
      const o = block + t * 4;
      w[t] = (bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ w[t - 15] >>> 3;
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ w[t - 2] >>> 10;
      w[t] = w[t - 16] + s0 + w[t - 7] + s1 >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = e & f ^ ~e & g;
      const temp1 = h + S1 + ch + K[t] + w[t] >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = a & b ^ a & c ^ b & c;
      const temp2 = S0 + maj >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + temp1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2 >>> 0;
    }
    h0 = h0 + a >>> 0;
    h1 = h1 + b >>> 0;
    h2 = h2 + c >>> 0;
    h3 = h3 + d >>> 0;
    h4 = h4 + e >>> 0;
    h5 = h5 + f >>> 0;
    h6 = h6 + g >>> 0;
    h7 = h7 + h >>> 0;
  };
  const completeBytes = msg.length - msg.length % 64;
  for (let block = 0; block < completeBytes; block += 64) processBlock(msg, block);
  const remainingBytes = msg.length - completeBytes;
  const tail = new Uint8Array(remainingBytes < 56 ? 64 : 128);
  tail.set(msg.subarray(completeBytes));
  tail[remainingBytes] = 128;
  const lengthOffset = tail.length - 8;
  tail[lengthOffset] = bitLenHi >>> 24 & 255;
  tail[lengthOffset + 1] = bitLenHi >>> 16 & 255;
  tail[lengthOffset + 2] = bitLenHi >>> 8 & 255;
  tail[lengthOffset + 3] = bitLenHi & 255;
  tail[lengthOffset + 4] = bitLenLo >>> 24 & 255;
  tail[lengthOffset + 5] = bitLenLo >>> 16 & 255;
  tail[lengthOffset + 6] = bitLenLo >>> 8 & 255;
  tail[lengthOffset + 7] = bitLenLo & 255;
  for (let block = 0; block < tail.length; block += 64) processBlock(tail, block);
  return toHex32(h0) + toHex32(h1) + toHex32(h2) + toHex32(h3) + toHex32(h4) + toHex32(h5) + toHex32(h6) + toHex32(h7);
}

// src/terrain/grid.mjs
var TERRAIN_GRID_SCHEMA = "limina.terrain-grid/v1";
var MIN_TERRAIN_CHUNK_SAMPLES = 3;
var MAX_TERRAIN_CHUNK_SAMPLES = 257;
var MIN_TERRAIN_CHUNK_COORD = -2147483648;
var MAX_TERRAIN_CHUNK_COORD = 2147483647;
var GRID_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
function finite(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
  return value;
}
function positiveFinite(name, value) {
  finite(name, value);
  if (!(value > 0)) throw new Error(`${name} must be > 0`);
  return value;
}
function validateTerrainGridId(gridId) {
  if (typeof gridId !== "string" || !GRID_ID.test(gridId)) {
    throw new Error("terrain grid id must be 1-64 lowercase characters using a-z, 0-9, '.', '_' or '-'");
  }
  return gridId;
}
function validateTerrainChunkCoordinate(name, value) {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  if (value < MIN_TERRAIN_CHUNK_COORD || value > MAX_TERRAIN_CHUNK_COORD) {
    throw new Error(`${name} is outside the supported terrain chunk coordinate range`);
  }
  return value;
}
function validateTerrainLod(lod) {
  if (!Number.isSafeInteger(lod) || lod < 0 || lod > 31) {
    throw new Error("terrain lod must be an integer in [0, 31]");
  }
  return lod;
}
function validateTerrainChunkSamples(samples) {
  if (!Number.isSafeInteger(samples) || samples < MIN_TERRAIN_CHUNK_SAMPLES || samples > MAX_TERRAIN_CHUNK_SAMPLES) {
    throw new Error(`terrain chunk samples must be an integer in [${MIN_TERRAIN_CHUNK_SAMPLES}, ${MAX_TERRAIN_CHUNK_SAMPLES}]`);
  }
  const intervals = samples - 1;
  if ((intervals & intervals - 1) !== 0) {
    throw new Error("terrain chunk samples must be a power-of-two plus one");
  }
  return samples;
}
function createTerrainGridSpec(input) {
  const gridId = validateTerrainGridId(input?.gridId);
  const origin = input?.origin;
  if (!Array.isArray(origin) || origin.length !== 2) throw new Error("terrain grid origin must be [x, z]");
  const spec = {
    schema: TERRAIN_GRID_SCHEMA,
    gridId,
    origin: [finite("terrain grid origin x", origin[0]), finite("terrain grid origin z", origin[1])],
    chunkSizeM: positiveFinite("terrain grid chunkSizeM", input.chunkSizeM),
    defaultSamples: validateTerrainChunkSamples(input.defaultSamples)
  };
  return Object.freeze({ ...spec, origin: Object.freeze(spec.origin) });
}
function validateGridSpec(grid) {
  if (grid?.schema !== TERRAIN_GRID_SCHEMA) throw new Error(`terrain grid schema must be '${TERRAIN_GRID_SCHEMA}'`);
  validateTerrainGridId(grid.gridId);
  if (!Array.isArray(grid.origin) || grid.origin.length !== 2) throw new Error("terrain grid origin must be [x, z]");
  finite("terrain grid origin x", grid.origin[0]);
  finite("terrain grid origin z", grid.origin[1]);
  positiveFinite("terrain grid chunkSizeM", grid.chunkSizeM);
  validateTerrainChunkSamples(grid.defaultSamples);
  return grid;
}
function terrainChunkId(gridId, lod, tx, tz) {
  return `surface:${validateTerrainGridId(gridId)}:l${validateTerrainLod(lod)}:x${validateTerrainChunkCoordinate("tx", tx)}:z${validateTerrainChunkCoordinate("tz", tz)}`;
}
function terrainWorldToChunk(gridInput, x, z) {
  const grid = validateGridSpec(gridInput);
  const tx = Math.floor((finite("terrain world x", x) - grid.origin[0]) / grid.chunkSizeM);
  const tz = Math.floor((finite("terrain world z", z) - grid.origin[1]) / grid.chunkSizeM);
  return Object.freeze({
    tx: validateTerrainChunkCoordinate("tx", tx),
    tz: validateTerrainChunkCoordinate("tz", tz)
  });
}

// src/world/compiler/canonical.mjs
var CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
var DEFAULT_CANONICAL_MAX_BYTES = 1024 * 1024;
var DEFAULT_CANONICAL_MAX_DEPTH = 32;
var DEFAULT_CANONICAL_MAX_NODES = 1e5;
var DEFAULT_CANONICAL_MAX_PROPERTIES = 4096;
var DEFAULT_CANONICAL_MAX_ARRAY_LENGTH = 65536;
function compilerUtf8ByteLength(input) {
  if (typeof input !== "string") throw new Error("compiler UTF-8 byte length input must be a string");
  let bytes = 0;
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (code < 128) bytes += 1;
    else if (code < 2048) bytes += 2;
    else if (code >= 55296 && code <= 56319 && index + 1 < input.length) {
      const next = input.charCodeAt(index + 1);
      if (next >= 56320 && next <= 57343) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
function canonicalCompilerJson(value, limits = {}) {
  const maxBytes = limits.maxBytes ?? DEFAULT_CANONICAL_MAX_BYTES;
  const maxDepth = limits.maxDepth ?? DEFAULT_CANONICAL_MAX_DEPTH;
  const maxNodes = limits.maxNodes ?? DEFAULT_CANONICAL_MAX_NODES;
  const maxProperties = limits.maxProperties ?? DEFAULT_CANONICAL_MAX_PROPERTIES;
  const maxArrayLength = limits.maxArrayLength ?? DEFAULT_CANONICAL_MAX_ARRAY_LENGTH;
  for (const [name, limit] of Object.entries({ maxBytes, maxDepth, maxNodes, maxProperties, maxArrayLength })) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`compiler canonical ${name} must be a positive safe integer`);
  }
  const active = /* @__PURE__ */ new Set();
  let nodes = 0;
  const visit = (input, path, depth) => {
    if (++nodes > maxNodes) throw new Error(`compiler canonical value exceeds ${maxNodes} nodes`);
    if (depth > maxDepth) throw new Error(`compiler canonical value exceeds depth ${maxDepth} at ${path}`);
    if (input === null) return "null";
    switch (typeof input) {
      case "boolean":
        return input ? "true" : "false";
      case "string":
        return JSON.stringify(input);
      case "number":
        if (!Number.isFinite(input)) throw new Error(`compiler canonical number at ${path} must be finite`);
        return Object.is(input, -0) ? "0" : JSON.stringify(input);
      case "object":
        break;
      default:
        throw new Error(`compiler canonical value at ${path} is outside the JSON domain`);
    }
    if (active.has(input)) throw new Error(`compiler canonical value contains a cycle at ${path}`);
    active.add(input);
    try {
      if (Array.isArray(input)) {
        if (input.length > maxArrayLength) throw new Error(`compiler canonical array at ${path} exceeds ${maxArrayLength} entries`);
        const names2 = Object.getOwnPropertyNames(input);
        const expected = /* @__PURE__ */ new Set(["length", ...Array.from({ length: input.length }, (_, index) => String(index))]);
        if (names2.some((name) => !expected.has(name)) || Object.getOwnPropertySymbols(input).length > 0) {
          throw new Error(`compiler canonical array at ${path} has custom properties`);
        }
        const items = [];
        for (let index = 0; index < input.length; index++) {
          if (!Object.prototype.hasOwnProperty.call(input, index)) throw new Error(`compiler canonical array at ${path} is sparse`);
          const descriptor2 = Object.getOwnPropertyDescriptor(input, String(index));
          if (descriptor2?.get !== void 0 || descriptor2?.set !== void 0 || descriptor2?.enumerable !== true) {
            throw new Error(`compiler canonical array at ${path}[${index}] has an accessor or hidden entry`);
          }
          items.push(visit(input[index], `${path}[${index}]`, depth + 1));
        }
        return `[${items.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) throw new Error(`compiler canonical object at ${path} is not plain`);
      if (Object.getOwnPropertySymbols(input).length > 0) throw new Error(`compiler canonical object at ${path} has symbol keys`);
      const names = Object.getOwnPropertyNames(input).sort();
      if (names.length > maxProperties) throw new Error(`compiler canonical object at ${path} exceeds ${maxProperties} properties`);
      const fields = [];
      for (const name of names) {
        const descriptor2 = Object.getOwnPropertyDescriptor(input, name);
        if (descriptor2?.get !== void 0 || descriptor2?.set !== void 0 || descriptor2?.enumerable !== true) {
          throw new Error(`compiler canonical object at ${path}.${name} has an accessor or hidden field`);
        }
        fields.push(`${JSON.stringify(name)}:${visit(input[name], `${path}.${name}`, depth + 1)}`);
      }
      return `{${fields.join(",")}}`;
    } finally {
      active.delete(input);
    }
  };
  const canonical = visit(value, "$", 0);
  const byteLength2 = compilerUtf8ByteLength(canonical);
  if (byteLength2 > maxBytes) throw new Error(`compiler canonical value is ${byteLength2} bytes; maximum is ${maxBytes}`);
  return canonical;
}
function compilerContentHash(value, limits = {}) {
  return `sha256:${sha256(canonicalCompilerJson(value, limits))}`;
}
function validateCompilerContentHash(value, label = "compiler content hash") {
  if (typeof value !== "string" || !CONTENT_HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase sha256 content hash`);
  }
  return value;
}
function cloneCanonicalCompilerJson(value, limits = {}) {
  return JSON.parse(canonicalCompilerJson(value, limits));
}

// src/world/compiler/manifest.mjs
var DERIVED_REVISION_MANIFEST_SCHEMA_V1 = "limina.derived-revision-manifest/v1";
var DERIVED_REVISION_MANIFEST_SCHEMA_V2 = "limina.derived-revision-manifest/v2";
var DERIVED_REVISION_MANIFEST_SCHEMA_V3 = "limina.derived-revision-manifest/v3";
var MAX_DERIVED_MANIFEST_BYTES = 32 * 1024 * 1024;
var MAX_DERIVED_CHUNKS = 16384;
var MAX_SOURCE_CONTENT_REFS = 64;
var MAX_ARTIFACTS_PER_CHUNK = 16;
var MAX_GLOBAL_DERIVED_ARTIFACTS = 64;
var MAX_DERIVED_ARTIFACT_AUTHORITIES = 64;
var MAX_DERIVED_ARTIFACTS = 131072;
var MAX_DERIVED_ARTIFACT_BYTES = 256 * 1024 * 1024;
var MAX_DERIVED_TOTAL_ARTIFACT_BYTES = 1024 * 1024 * 1024;
var PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var BRANCH_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
var REF_ID = /^[a-z][a-z0-9._-]{0,95}$/;
var ASSET_ID_MAX_LENGTH = 256;
var VERSION = /^[0-9][A-Za-z0-9._+-]{0,63}$/;
var TYPED_ID = /^[a-z][a-z0-9._-]{0,95}\/v[1-9][0-9]*$/;
var MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
var MANIFEST_LIMITS = Object.freeze({
  maxBytes: MAX_DERIVED_MANIFEST_BYTES,
  maxDepth: 12,
  maxNodes: 15e5,
  maxProperties: 32,
  maxArrayLength: MAX_DERIVED_CHUNKS
});
var VERIFIED_DERIVED_MANIFESTS = /* @__PURE__ */ new WeakSet();
function codeUnitCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function plainObject(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}
function exactKeys(value, expected, label) {
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${label} has symbol fields`);
  const actual = Object.getOwnPropertyNames(value);
  const extras = actual.filter((key) => !expected.has(key));
  const missing = [...expected].filter((key) => !actual.includes(key));
  if (extras.length > 0 || missing.length > 0) {
    throw new Error(`${label} fields differ (missing: ${missing.join(", ") || "none"}; extra: ${extras.join(", ") || "none"})`);
  }
  for (const key of actual) {
    const descriptor2 = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor2?.get !== void 0 || descriptor2?.set !== void 0 || descriptor2?.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable data field`);
    }
  }
}
function identifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function assetIdentifier(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > ASSET_ID_MAX_LENGTH || value.includes("\\") || value.startsWith("/")) {
    throw new Error(`${label} is invalid`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an invalid path segment`);
  }
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) throw new Error(`${label} is invalid`);
  }
  return value;
}
function orderedUnique(entries, keyOf, label) {
  let previous;
  for (let index = 0; index < entries.length; index++) {
    const key = keyOf(entries[index]);
    if (previous !== void 0 && codeUnitCompare(previous, key) >= 0) {
      throw new Error(`${label} must be strictly ordered and unique`);
    }
    previous = key;
  }
}
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function parseGrid(input) {
  const grid = plainObject(input, "derived manifest grid");
  exactKeys(grid, /* @__PURE__ */ new Set(["schema", "gridId", "origin", "chunkSizeM", "defaultSamples"]), "derived manifest grid");
  const canonical = createTerrainGridSpec(grid);
  return {
    schema: canonical.schema,
    gridId: canonical.gridId,
    origin: [...canonical.origin],
    chunkSizeM: canonical.chunkSizeM,
    defaultSamples: canonical.defaultSamples
  };
}
function parseSource(input) {
  const source = plainObject(input, "derived manifest source");
  exactKeys(source, /* @__PURE__ */ new Set(["revision", "headHash", "contentRefs"]), "derived manifest source");
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) throw new Error("derived manifest source revision must be a non-negative safe integer");
  if (!Array.isArray(source.contentRefs) || source.contentRefs.length < 1 || source.contentRefs.length > MAX_SOURCE_CONTENT_REFS) {
    throw new Error(`derived manifest source contentRefs must contain 1-${MAX_SOURCE_CONTENT_REFS} entries`);
  }
  const contentRefs = source.contentRefs.map((entry, index) => {
    const ref = plainObject(entry, `derived manifest source ref ${index}`);
    exactKeys(ref, /* @__PURE__ */ new Set(["refId", "refType", "scope", "assetId", "contentHash"]), `derived manifest source ref ${index}`);
    if (ref.scope !== "global" && ref.scope !== "chunk") throw new Error(`derived manifest source ref ${index} scope must be global or chunk`);
    return {
      refId: identifier(ref.refId, REF_ID, `derived manifest source ref ${index} refId`),
      refType: identifier(ref.refType, TYPED_ID, `derived manifest source ref ${index} refType`),
      scope: ref.scope,
      assetId: assetIdentifier(ref.assetId, `derived manifest source ref ${index} assetId`),
      contentHash: validateCompilerContentHash(ref.contentHash, `derived manifest source ref '${ref.refId}' hash`)
    };
  });
  orderedUnique(contentRefs, (entry) => entry.refId, "derived manifest source refs");
  return {
    revision: source.revision,
    headHash: validateCompilerContentHash(source.headHash, "derived manifest source headHash"),
    contentRefs
  };
}
function parseCompiler(input) {
  const compiler = plainObject(input, "derived manifest compiler");
  exactKeys(compiler, /* @__PURE__ */ new Set(["version", "configHash", "graphHash", "snapshotHash"]), "derived manifest compiler");
  return {
    version: identifier(compiler.version, VERSION, "derived manifest compiler version"),
    configHash: validateCompilerContentHash(compiler.configHash, "derived manifest compiler configHash"),
    graphHash: validateCompilerContentHash(compiler.graphHash, "derived manifest compiler graphHash"),
    snapshotHash: validateCompilerContentHash(compiler.snapshotHash, "derived manifest compiler snapshotHash")
  };
}
function parseArtifactDescriptor(input, label, budget) {
  const artifact = plainObject(input, label);
  exactKeys(artifact, /* @__PURE__ */ new Set(["artifactType", "contentHash", "byteLength", "mediaType"]), label);
  if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0 || artifact.byteLength > MAX_DERIVED_ARTIFACT_BYTES) {
    throw new Error(`${label} byteLength is out of bounds`);
  }
  budget.artifactCount++;
  budget.totalArtifactBytes += artifact.byteLength;
  if (budget.artifactCount > MAX_DERIVED_ARTIFACTS || budget.totalArtifactBytes > MAX_DERIVED_TOTAL_ARTIFACT_BYTES) {
    throw new Error("derived manifest artifact resources exceed publication bounds");
  }
  return {
    artifactType: identifier(artifact.artifactType, TYPED_ID, `${label} type`),
    contentHash: validateCompilerContentHash(artifact.contentHash, `${label} hash`),
    byteLength: artifact.byteLength,
    mediaType: identifier(artifact.mediaType, MEDIA_TYPE, `${label} mediaType`)
  };
}
function parseGlobalArtifacts(input, budget) {
  if (!Array.isArray(input) || input.length > MAX_GLOBAL_DERIVED_ARTIFACTS) {
    throw new Error(`derived manifest globalArtifacts must contain at most ${MAX_GLOBAL_DERIVED_ARTIFACTS} entries`);
  }
  const artifacts = input.map((artifact, index) => parseArtifactDescriptor(artifact, `derived manifest global artifact ${index}`, budget));
  orderedUnique(artifacts, (artifact) => artifact.artifactType, "derived manifest global artifacts");
  return artifacts;
}
function parseArtifactAuthorities(input, artifactTypes) {
  if (!Array.isArray(input) || input.length > MAX_DERIVED_ARTIFACT_AUTHORITIES) {
    throw new Error(`derived manifest artifactAuthorities must contain at most ${MAX_DERIVED_ARTIFACT_AUTHORITIES} entries`);
  }
  const authorities = input.map((entry, index) => {
    const authority = plainObject(entry, `derived manifest artifact authority ${index}`);
    exactKeys(authority, /* @__PURE__ */ new Set(["artifactType", "compilerGraphHash"]), `derived manifest artifact authority ${index}`);
    const artifactType = identifier(authority.artifactType, TYPED_ID, `derived manifest artifact authority ${index} type`);
    if (!artifactTypes.has(artifactType)) throw new Error(`derived manifest artifact authority '${artifactType}' has no published artifact`);
    return {
      artifactType,
      compilerGraphHash: validateCompilerContentHash(
        authority.compilerGraphHash,
        `derived manifest artifact authority '${artifactType}' compiler graph hash`
      )
    };
  });
  orderedUnique(authorities, (authority) => authority.artifactType, "derived manifest artifact authorities");
  return authorities;
}
function parseChunks(input, grid, sourceRefs, budget) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_DERIVED_CHUNKS) {
    throw new Error(`derived manifest chunks must contain 1-${MAX_DERIVED_CHUNKS} entries`);
  }
  const requiredSlices = sourceRefs.filter((ref) => ref.scope === "chunk").map((ref) => ref.refId);
  const chunks = input.map((entry, index) => {
    const chunk = plainObject(entry, `derived manifest chunk ${index}`);
    exactKeys(chunk, /* @__PURE__ */ new Set(["chunkId", "gridId", "lod", "tx", "tz", "topologyHash", "sourceSliceHashes", "artifacts"]), `derived manifest chunk ${index}`);
    const canonicalId = terrainChunkId(chunk.gridId, chunk.lod, chunk.tx, chunk.tz);
    if (chunk.chunkId !== canonicalId) throw new Error(`derived manifest chunk ${index} has a non-canonical chunkId`);
    if (chunk.gridId !== grid.gridId) throw new Error(`derived manifest chunk '${chunk.chunkId}' belongs to another grid`);
    if (!Array.isArray(chunk.sourceSliceHashes) || chunk.sourceSliceHashes.length !== requiredSlices.length) {
      throw new Error(`derived manifest chunk '${chunk.chunkId}' sourceSliceHashes are dependency-incomplete`);
    }
    const sourceSliceHashes = chunk.sourceSliceHashes.map((slice, sliceIndex) => {
      const parsed = plainObject(slice, `derived manifest chunk '${chunk.chunkId}' source slice ${sliceIndex}`);
      exactKeys(parsed, /* @__PURE__ */ new Set(["refId", "contentHash"]), `derived manifest chunk '${chunk.chunkId}' source slice ${sliceIndex}`);
      return {
        refId: identifier(parsed.refId, REF_ID, `derived manifest chunk '${chunk.chunkId}' source slice refId`),
        contentHash: validateCompilerContentHash(parsed.contentHash, `derived manifest chunk '${chunk.chunkId}' source slice '${parsed.refId}' hash`)
      };
    });
    orderedUnique(sourceSliceHashes, (slice) => slice.refId, `derived manifest chunk '${chunk.chunkId}' source slices`);
    if (canonicalCompilerJson(sourceSliceHashes.map((slice) => slice.refId)) !== canonicalCompilerJson(requiredSlices)) {
      throw new Error(`derived manifest chunk '${chunk.chunkId}' sourceSliceHashes are dependency-incomplete`);
    }
    if (!Array.isArray(chunk.artifacts) || chunk.artifacts.length < 1 || chunk.artifacts.length > MAX_ARTIFACTS_PER_CHUNK) {
      throw new Error(`derived manifest chunk '${chunk.chunkId}' artifacts must contain 1-${MAX_ARTIFACTS_PER_CHUNK} entries`);
    }
    const artifacts = chunk.artifacts.map((artifact, artifactIndex) => parseArtifactDescriptor(artifact, `derived manifest chunk '${chunk.chunkId}' artifact ${artifactIndex}`, budget));
    orderedUnique(artifacts, (artifact) => artifact.artifactType, `derived manifest chunk '${chunk.chunkId}' artifacts`);
    return {
      chunkId: chunk.chunkId,
      gridId: chunk.gridId,
      lod: chunk.lod,
      tx: chunk.tx,
      tz: chunk.tz,
      topologyHash: validateCompilerContentHash(chunk.topologyHash, `derived manifest chunk '${chunk.chunkId}' topologyHash`),
      sourceSliceHashes,
      artifacts
    };
  });
  orderedUnique(chunks, (chunk) => chunk.chunkId, "derived manifest chunks");
  return chunks;
}
function parseCore(input, includeHash) {
  const value = plainObject(input, "derived revision manifest");
  const schemaDescriptor = Object.getOwnPropertyDescriptor(value, "schema");
  if (schemaDescriptor === void 0 || schemaDescriptor.get !== void 0 || schemaDescriptor.set !== void 0 || schemaDescriptor.enumerable !== true) {
    throw new Error("derived revision manifest.schema must be an enumerable data field");
  }
  const schema = schemaDescriptor.value;
  if (schema !== DERIVED_REVISION_MANIFEST_SCHEMA_V1 && schema !== DERIVED_REVISION_MANIFEST_SCHEMA_V2 && schema !== DERIVED_REVISION_MANIFEST_SCHEMA_V3) {
    throw new Error(
      `derived revision manifest schema must be '${DERIVED_REVISION_MANIFEST_SCHEMA_V1}', '${DERIVED_REVISION_MANIFEST_SCHEMA_V2}', or '${DERIVED_REVISION_MANIFEST_SCHEMA_V3}'`
    );
  }
  const isV2 = schema === DERIVED_REVISION_MANIFEST_SCHEMA_V2;
  const isV3 = schema === DERIVED_REVISION_MANIFEST_SCHEMA_V3;
  const keys = /* @__PURE__ */ new Set(["schema", "projectId", "branchId", "source", "compiler", "grid", "chunks"]);
  if (isV2 || isV3) keys.add("globalArtifacts");
  if (isV3) keys.add("artifactAuthorities");
  if (includeHash) keys.add("manifestHash");
  exactKeys(value, keys, "derived revision manifest");
  const projectId = identifier(value.projectId, PROJECT_ID, "derived manifest projectId");
  const branchId = identifier(value.branchId, BRANCH_ID, "derived manifest branchId");
  const source = parseSource(value.source);
  const compiler = parseCompiler(value.compiler);
  const grid = parseGrid(value.grid);
  const budget = { artifactCount: 0, totalArtifactBytes: 0 };
  const globalArtifacts = isV2 || isV3 ? parseGlobalArtifacts(value.globalArtifacts, budget) : void 0;
  const chunks = parseChunks(value.chunks, grid, source.contentRefs, budget);
  if (isV3) {
    const artifactTypes = /* @__PURE__ */ new Set([
      ...globalArtifacts.map((artifact) => artifact.artifactType),
      ...chunks.flatMap((chunk) => chunk.artifacts.map((artifact) => artifact.artifactType))
    ]);
    const artifactAuthorities = parseArtifactAuthorities(value.artifactAuthorities, artifactTypes);
    return {
      schema: DERIVED_REVISION_MANIFEST_SCHEMA_V3,
      projectId,
      branchId,
      source,
      compiler,
      grid,
      artifactAuthorities,
      globalArtifacts,
      chunks
    };
  }
  return isV2 ? { schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2, projectId, branchId, source, compiler, grid, globalArtifacts, chunks } : { schema: DERIVED_REVISION_MANIFEST_SCHEMA_V1, projectId, branchId, source, compiler, grid, chunks };
}
function parseDerivedRevisionManifest(input) {
  const cloned = cloneCanonicalCompilerJson(input, MANIFEST_LIMITS);
  const core = parseCore(cloned, true);
  const manifestHash = validateCompilerContentHash(cloned.manifestHash, "derived manifest manifestHash");
  if (compilerContentHash(core, MANIFEST_LIMITS) !== manifestHash) throw new Error("derived revision manifest hash mismatch");
  const verified = deepFreeze({ ...core, manifestHash });
  VERIFIED_DERIVED_MANIFESTS.add(verified);
  return verified;
}
var EMPTY_GLOBAL_DERIVED_ARTIFACTS = Object.freeze([]);
function derivedGlobalArtifacts(manifest) {
  if (!VERIFIED_DERIVED_MANIFESTS.has(manifest)) {
    throw new TypeError("derivedGlobalArtifacts requires a verified derived revision manifest");
  }
  return manifest.schema === DERIVED_REVISION_MANIFEST_SCHEMA_V2 || manifest.schema === DERIVED_REVISION_MANIFEST_SCHEMA_V3 ? manifest.globalArtifacts : EMPTY_GLOBAL_DERIVED_ARTIFACTS;
}
function derivedArtifactCompilerGraphHash(manifest, artifactType) {
  if (!VERIFIED_DERIVED_MANIFESTS.has(manifest)) {
    throw new TypeError("derivedArtifactCompilerGraphHash requires a verified derived revision manifest");
  }
  identifier(artifactType, TYPED_ID, "derived artifact authority type");
  if (manifest.schema !== DERIVED_REVISION_MANIFEST_SCHEMA_V3) return manifest.compiler.graphHash;
  return manifest.artifactAuthorities.find((authority) => authority.artifactType === artifactType)?.compilerGraphHash ?? manifest.compiler.graphHash;
}
function derivedArtifactContentHash(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("derived artifact bytes must be Uint8Array");
  if (bytes.byteLength > MAX_DERIVED_ARTIFACT_BYTES) throw new Error(`derived artifact exceeds ${MAX_DERIVED_ARTIFACT_BYTES} bytes`);
  return `sha256:${sha256(bytes)}`;
}

// src/world/asset-content-hash.mjs
var HEX = Object.freeze(Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0")));
function portableAssetContentHash(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("asset content hash requires Uint8Array bytes");
  let encoded = "";
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    const end = Math.min(bytes.length, offset + 16384);
    encoded = "";
    for (let index = offset; index < end; index++) encoded += HEX[bytes[index]];
    chunks.push(encoded);
  }
  return `sha256:${sha256(chunks.join(""))}`;
}

// src/browser/derived-runtime-transport.ts
var DERIVED_RUNTIME_CURRENT_SCHEMA = "limina.derived-runtime-current/v1";
var DERIVED_RUNTIME_ERROR_SCHEMA = "limina.derived-runtime-error/v1";
var MAX_DERIVED_RUNTIME_CURRENT_BYTES = MAX_DERIVED_MANIFEST_BYTES + 64 * 1024;
var PROJECT_ID2 = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var BRANCH_ID2 = /^[a-z0-9][a-z0-9._-]{0,95}$/;
var HASH = /^sha256:[0-9a-f]{64}$/;
var TOKEN = /^[A-Za-z0-9_-]{43}$/;
var BASE_URL = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
var MAX_ERROR_BYTES = 64 * 1024;
var DerivedRuntimeTransportError = class extends Error {
  code;
  classification;
  constructor(code, classification, message) {
    super(message);
    this.name = "DerivedRuntimeTransportError";
    this.code = code;
    this.classification = classification;
  }
};
function fatal(code, message) {
  return new DerivedRuntimeTransportError(code, "fatal", message);
}
function transient(code, message) {
  return new DerivedRuntimeTransportError(code, "transient", message);
}
function plainObject2(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw fatal("PROTOCOL_ERROR", `${label} must be a plain object`);
  }
  return value;
}
function exactKeys2(value, expected, label) {
  const actual = Object.getOwnPropertyNames(value).sort();
  const wanted = [...expected].sort();
  if (Object.getOwnPropertySymbols(value).length !== 0 || actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw fatal("PROTOCOL_ERROR", `${label} has unsupported or missing fields`);
  }
  for (const key of actual) {
    const descriptor2 = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor2?.enumerable !== true || descriptor2.get !== void 0 || descriptor2.set !== void 0) {
      throw fatal("PROTOCOL_ERROR", `${label}.${key} must be an enumerable data field`);
    }
  }
}
function strictConfig(input) {
  if (input === null || Array.isArray(input) || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("derived runtime transport config must be a plain object");
  }
  const value = input;
  const names = Object.getOwnPropertyNames(value);
  const keys = [...names].sort().join(",");
  if (Object.getOwnPropertySymbols(value).length !== 0 || keys !== "baseUrl,branchId,projectId,token") {
    throw new TypeError("derived runtime transport config must contain exactly baseUrl, token, projectId, and branchId");
  }
  if (names.some((name) => {
    const descriptor2 = Object.getOwnPropertyDescriptor(value, name);
    return descriptor2?.enumerable !== true || descriptor2.get !== void 0 || descriptor2.set !== void 0;
  })) throw new TypeError("derived runtime transport config fields must be enumerable data properties");
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : void 0;
  const match = baseUrl === void 0 ? null : BASE_URL.exec(baseUrl);
  if (match === null || Number(match[1]) > 65535) {
    throw new TypeError("derived runtime baseUrl must be canonical loopback HTTP with an explicit non-zero port");
  }
  if (typeof value.token !== "string" || !TOKEN.test(value.token) || base64urlValue(value.token.at(-1)) % 4 !== 0) {
    throw new TypeError("derived runtime token must be canonical base64url for exactly 32 bytes");
  }
  if (typeof value.projectId !== "string" || !PROJECT_ID2.test(value.projectId)) throw new TypeError("derived runtime projectId is invalid");
  if (typeof value.branchId !== "string" || !BRANCH_ID2.test(value.branchId)) throw new TypeError("derived runtime branchId is invalid");
  return Object.freeze({
    baseUrl,
    token: value.token,
    projectId: value.projectId,
    branchId: value.branchId
  });
}
function base64urlValue(character) {
  const code = character.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return character === "-" ? 62 : 63;
}
function strictDependencies(input) {
  const value = input ?? {};
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("derived runtime transport dependencies must be a plain object");
  }
  const keys = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || keys.some((key) => key !== "fetch" && key !== "crypto")) {
    throw new TypeError("derived runtime transport dependencies contain unsupported fields");
  }
  if (keys.some((key) => {
    const descriptor2 = Object.getOwnPropertyDescriptor(value, key);
    return descriptor2?.enumerable !== true || descriptor2.get !== void 0 || descriptor2.set !== void 0;
  })) throw new TypeError("derived runtime transport dependency fields must be enumerable data properties");
  const fetchImpl = value.fetch ?? globalThis.fetch;
  const cryptoImpl = value.crypto ?? globalThis.crypto;
  if (typeof fetchImpl !== "function") throw new TypeError("derived runtime transport requires fetch");
  if (cryptoImpl === void 0 || cryptoImpl === null || typeof cryptoImpl.subtle?.digest !== "function") {
    throw new TypeError("derived runtime transport requires WebCrypto SHA-256");
  }
  return { fetch: fetchImpl, crypto: cryptoImpl };
}
function parseLength(headers, maximum, label) {
  const raw = headers.get("content-length");
  if (raw === null || !/^(0|[1-9][0-9]*)$/.test(raw)) throw fatal("PROTOCOL_ERROR", `${label} Content-Length is missing or non-canonical`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw fatal("PROTOCOL_ERROR", `${label} Content-Length exceeds its resource bound`);
  return value;
}
function exactHeader(headers, name, expected, label) {
  if (headers.get(name) !== expected) throw fatal("PROTOCOL_ERROR", `${label} ${name} does not match the requested publication`);
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw transient("ABORTED", "derived runtime request was aborted");
}
async function cancelResponseBody(response) {
  if (response.body === null || response.body.locked) return;
  try {
    await response.body.cancel();
  } catch {
  }
}
async function readBounded(response, expectedLength, maximum, signal) {
  if (expectedLength > maximum) throw fatal("PROTOCOL_ERROR", "derived runtime response exceeds its resource bound");
  if (response.body === null) {
    if (expectedLength === 0) return new Uint8Array(0);
    throw fatal("PROTOCOL_ERROR", "derived runtime response body is missing");
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(expectedLength);
  let total = 0;
  try {
    for (; ; ) {
      throwIfAborted(signal);
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw fatal("PROTOCOL_ERROR", "derived runtime response yielded non-byte data");
      total += part.value.byteLength;
      if (total > expectedLength || total > maximum) {
        throw fatal("PROTOCOL_ERROR", "derived runtime response body exceeds declared Content-Length");
      }
      bytes.set(part.value, total - part.value.byteLength);
    }
  } catch (error) {
    await reader.cancel().catch(() => {
    });
    if (error instanceof DerivedRuntimeTransportError) throw error;
    if (signal?.aborted) throw transient("ABORTED", "derived runtime request was aborted");
    throw transient("NETWORK_ERROR", "derived runtime response body stream failed");
  } finally {
    reader.releaseLock();
  }
  if (total !== expectedLength) throw fatal("PROTOCOL_ERROR", "derived runtime response body does not match Content-Length");
  return bytes;
}
function decodeJson(bytes, label) {
  let text4;
  try {
    text4 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw fatal("PROTOCOL_ERROR", `${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text4);
  } catch {
    throw fatal("PROTOCOL_ERROR", `${label} is not valid JSON`);
  }
}
async function sha2562(cryptoImpl, bytes) {
  let digest;
  try {
    digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
  } catch {
    throw fatal("INTEGRITY_ERROR", "WebCrypto could not verify the derived artifact");
  }
  const values = new Uint8Array(digest);
  if (values.byteLength !== 32) throw fatal("INTEGRITY_ERROR", "WebCrypto returned an invalid SHA-256 digest");
  let hex = "";
  for (const value of values) hex += value.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}
function descriptorKey(descriptor2) {
  return `${descriptor2.artifactType}\0${descriptor2.contentHash}\0${descriptor2.byteLength}\0${descriptor2.mediaType}`;
}
function descriptorSet(manifest) {
  const descriptors = /* @__PURE__ */ new Set();
  for (const descriptor2 of derivedGlobalArtifacts(manifest)) descriptors.add(descriptorKey(descriptor2));
  for (const chunk of manifest.chunks) for (const descriptor2 of chunk.artifacts) descriptors.add(descriptorKey(descriptor2));
  return descriptors;
}
function contentEtag(contentHash2) {
  return `"${contentHash2}"`;
}
function currentPublicationEtag(generation, manifestHash) {
  return `"g${generation}-${manifestHash}"`;
}
function requireHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) throw fatal("PROTOCOL_ERROR", `${label} is invalid`);
  return value;
}
var DerivedRuntimeTransport = class {
  #config;
  #fetch;
  #crypto;
  #bindings = /* @__PURE__ */ new WeakMap();
  constructor(config, dependencies) {
    this.#config = strictConfig(config);
    const resolved = strictDependencies(dependencies);
    this.#fetch = resolved.fetch;
    this.#crypto = resolved.crypto;
  }
  async fetchCurrent(options = {}) {
    const previous = options.previous;
    if (previous !== void 0 && !this.#bindings.has(previous)) {
      throw fatal("PROTOCOL_ERROR", "previous derived current was not issued by this transport");
    }
    const response = await this.#request(`${this.#config.baseUrl}/v1/derived/current`, {
      signal: options.signal,
      headers: previous === void 0 ? void 0 : { "If-None-Match": previous.etag }
    });
    if (response.status === 304) {
      try {
        if (previous === void 0) throw fatal("PROTOCOL_ERROR", "derived current returned 304 without a bound previous publication");
        this.#validateCurrentIdentityHeaders(response, previous);
        if (parseLength(response.headers, 0, "derived current 304") !== 0) throw fatal("PROTOCOL_ERROR", "derived current 304 carried a body");
      } catch (error) {
        await cancelResponseBody(response);
        throw error;
      }
      return Object.freeze({ status: "not-modified", current: previous });
    }
    if (response.status !== 200) await this.#throwResponseError(response, options.signal);
    let length;
    try {
      if (response.headers.get("content-type") !== "application/json; charset=utf-8") {
        throw fatal("PROTOCOL_ERROR", "derived current Content-Type is invalid");
      }
      length = parseLength(response.headers, MAX_DERIVED_RUNTIME_CURRENT_BYTES, "derived current");
    } catch (error) {
      await cancelResponseBody(response);
      throw error;
    }
    const bytes = await readBounded(response, length, MAX_DERIVED_RUNTIME_CURRENT_BYTES, options.signal);
    const body = plainObject2(decodeJson(bytes, "derived current response"), "derived current response");
    exactKeys2(body, ["schema", "projectId", "branchId", "generation", "source", "manifest"], "derived current response");
    if (body.schema !== DERIVED_RUNTIME_CURRENT_SCHEMA) throw fatal("PROTOCOL_ERROR", "derived current schema is unsupported");
    if (body.projectId !== this.#config.projectId || body.branchId !== this.#config.branchId) {
      throw fatal("PROTOCOL_ERROR", "derived current project or branch does not match transport configuration");
    }
    if (!Number.isSafeInteger(body.generation) || body.generation < 1) throw fatal("PROTOCOL_ERROR", "derived current generation is invalid");
    const source = plainObject2(body.source, "derived current source");
    exactKeys2(source, ["revision", "headHash"], "derived current source");
    if (!Number.isSafeInteger(source.revision) || source.revision < 0) throw fatal("PROTOCOL_ERROR", "derived current source revision is invalid");
    const headHash = requireHash(source.headHash, "derived current source headHash");
    let manifest;
    try {
      manifest = parseDerivedRevisionManifest(body.manifest);
    } catch (error) {
      throw fatal("PROTOCOL_ERROR", `derived current manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (manifest.projectId !== this.#config.projectId || manifest.branchId !== this.#config.branchId || manifest.source.revision !== source.revision || manifest.source.headHash !== headHash) {
      throw fatal("PROTOCOL_ERROR", "derived current envelope and manifest identities disagree");
    }
    const current = Object.freeze({
      schema: DERIVED_RUNTIME_CURRENT_SCHEMA,
      projectId: this.#config.projectId,
      branchId: this.#config.branchId,
      generation: body.generation,
      source: Object.freeze({ revision: source.revision, headHash }),
      manifest,
      manifestHash: manifest.manifestHash,
      etag: currentPublicationEtag(body.generation, manifest.manifestHash)
    });
    this.#validateCurrentIdentityHeaders(response, current);
    this.#bindings.set(current, Object.freeze({ descriptorKeys: descriptorSet(manifest) }));
    return Object.freeze({ status: "current", current });
  }
  async fetchArtifact(current, descriptor2, options = {}) {
    const binding = this.#bindings.get(current);
    if (binding === void 0 || !binding.descriptorKeys.has(descriptorKey(descriptor2))) {
      throw fatal("PROTOCOL_ERROR", "derived artifact descriptor is not bound to this transport publication");
    }
    if (descriptor2.byteLength > MAX_DERIVED_ARTIFACT_BYTES) throw fatal("PROTOCOL_ERROR", "derived artifact descriptor exceeds the server cap");
    const manifestHex = current.manifestHash.slice(7);
    const contentHex = descriptor2.contentHash.slice(7);
    const response = await this.#request(
      `${this.#config.baseUrl}/v1/derived/manifests/${manifestHex}/artifacts/${contentHex}`,
      {
        signal: options.signal,
        headers: options.allowNotModified ? { "If-None-Match": contentEtag(descriptor2.contentHash) } : void 0
      }
    );
    if (response.status === 304) {
      try {
        if (!options.allowNotModified) throw fatal("PROTOCOL_ERROR", "derived artifact returned an unsolicited 304");
        this.#validateArtifactHeaders(response, current, descriptor2, true);
      } catch (error) {
        await cancelResponseBody(response);
        throw error;
      }
      return Object.freeze({ status: "not-modified", contentHash: descriptor2.contentHash });
    }
    if (response.status !== 200) await this.#throwResponseError(response, options.signal);
    try {
      this.#validateArtifactHeaders(response, current, descriptor2, false);
    } catch (error) {
      await cancelResponseBody(response);
      throw error;
    }
    const bytes = await readBounded(response, descriptor2.byteLength, MAX_DERIVED_ARTIFACT_BYTES, options.signal);
    throwIfAborted(options.signal);
    const actualHash = await sha2562(this.#crypto, bytes);
    throwIfAborted(options.signal);
    if (actualHash !== descriptor2.contentHash) throw fatal("INTEGRITY_ERROR", "derived artifact SHA-256 does not match its descriptor");
    return Object.freeze({ status: "artifact", contentHash: descriptor2.contentHash, bytes });
  }
  /**
   * Fetch one closure-authorized engine asset directly into the main realm. Unlike derived
   * artifacts, these bytes are intentionally never transferred through the worker. The server
   * binds authorization to `manifestHash`; the caller must source the descriptor from that
   * manifest's independently verified biome-content closure.
   */
  async fetchContent(manifestHashInput, descriptorInput, options = {}) {
    const manifestHash = requireHash(manifestHashInput, "derived content manifestHash");
    const descriptor2 = plainObject2(descriptorInput, "derived content descriptor");
    exactKeys2(descriptor2, ["contentHash", "byteLength"], "derived content descriptor");
    const contentHash2 = requireHash(descriptor2.contentHash, "derived content descriptor.contentHash");
    if (!Number.isSafeInteger(descriptor2.byteLength) || descriptor2.byteLength < 1 || descriptor2.byteLength > MAX_DERIVED_ARTIFACT_BYTES) {
      throw fatal("PROTOCOL_ERROR", "derived content descriptor.byteLength exceeds the server cap");
    }
    const response = await this.#request(
      `${this.#config.baseUrl}/v1/derived/manifests/${manifestHash.slice(7)}/content/${contentHash2.slice(7)}`,
      { signal: options.signal }
    );
    if (response.status !== 200) await this.#throwResponseError(response, options.signal);
    try {
      exactHeader(response.headers, "etag", contentEtag(contentHash2), "derived content");
      exactHeader(response.headers, "x-limina-content-hash", contentHash2, "derived content");
      exactHeader(response.headers, "x-limina-manifest-hash", manifestHash, "derived content");
      exactHeader(response.headers, "content-type", "application/octet-stream", "derived content");
      if (parseLength(response.headers, MAX_DERIVED_ARTIFACT_BYTES, "derived content") !== descriptor2.byteLength) {
        throw fatal("PROTOCOL_ERROR", "derived content Content-Length does not match its closure entry");
      }
      const generation = response.headers.get("x-limina-generation");
      if (generation === null || !/^[1-9][0-9]*$/.test(generation) || !Number.isSafeInteger(Number(generation))) {
        throw fatal("PROTOCOL_ERROR", "derived content X-Limina-Generation is invalid");
      }
    } catch (error) {
      await cancelResponseBody(response);
      throw error;
    }
    const bytes = await readBounded(
      response,
      descriptor2.byteLength,
      MAX_DERIVED_ARTIFACT_BYTES,
      options.signal
    );
    throwIfAborted(options.signal);
    if (portableAssetContentHash(bytes) !== contentHash2) {
      throw fatal("INTEGRITY_ERROR", "derived content portable engine hash does not match its closure entry");
    }
    throwIfAborted(options.signal);
    return Object.freeze({ contentHash: contentHash2, bytes });
  }
  async #request(url, options) {
    throwIfAborted(options.signal);
    const headers = { Authorization: `Bearer ${this.#config.token}`, ...options.headers };
    try {
      const fetchImpl = this.#fetch;
      return await fetchImpl(url, {
        method: "GET",
        headers,
        signal: options.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer"
      });
    } catch {
      if (options.signal?.aborted) throw transient("ABORTED", "derived runtime request was aborted");
      throw transient("NETWORK_ERROR", "derived runtime request failed before an HTTP response was received");
    }
  }
  #validateCurrentIdentityHeaders(response, current) {
    exactHeader(response.headers, "etag", current.etag, "derived current");
    exactHeader(response.headers, "x-limina-manifest-hash", current.manifestHash, "derived current");
    exactHeader(response.headers, "x-limina-revision", String(current.source.revision), "derived current");
    exactHeader(response.headers, "x-limina-head-hash", current.source.headHash, "derived current");
    exactHeader(response.headers, "x-limina-generation", String(current.generation), "derived current");
  }
  #validateArtifactHeaders(response, current, descriptor2, notModified) {
    exactHeader(response.headers, "etag", contentEtag(descriptor2.contentHash), "derived artifact");
    exactHeader(response.headers, "x-limina-content-hash", descriptor2.contentHash, "derived artifact");
    exactHeader(response.headers, "x-limina-manifest-hash", current.manifestHash, "derived artifact");
    exactHeader(response.headers, "content-type", descriptor2.mediaType, "derived artifact");
    const length = parseLength(response.headers, MAX_DERIVED_ARTIFACT_BYTES, "derived artifact");
    const expected = notModified ? 0 : descriptor2.byteLength;
    if (length !== expected) throw fatal("PROTOCOL_ERROR", "derived artifact Content-Length does not match its descriptor");
  }
  async #throwResponseError(response, signal) {
    const contentType = response.headers.get("content-type");
    if (contentType !== "application/json; charset=utf-8") {
      await cancelResponseBody(response);
      throw fatal("PROTOCOL_ERROR", `derived runtime returned unexpected HTTP ${response.status}`);
    }
    let length;
    try {
      length = parseLength(response.headers, MAX_ERROR_BYTES, "derived runtime error");
    } catch (error) {
      await cancelResponseBody(response);
      throw error;
    }
    const body = plainObject2(decodeJson(await readBounded(response, length, MAX_ERROR_BYTES, signal), "derived runtime error"), "derived runtime error");
    exactKeys2(body, ["schema", "code", "message"], "derived runtime error");
    if (body.schema !== DERIVED_RUNTIME_ERROR_SCHEMA || typeof body.code !== "string" || typeof body.message !== "string" || body.message.length < 1 || body.message.length > 256) {
      throw fatal("PROTOCOL_ERROR", "derived runtime error envelope is invalid");
    }
    const expectedStatus = {
      UNAUTHORIZED: 401,
      FORBIDDEN_HOST: 403,
      FORBIDDEN_ORIGIN: 403,
      NO_PUBLICATION: 404,
      NOT_FOUND: 404,
      NOT_CURRENT: 409,
      RATE_LIMITED: 429,
      STREAM_LIMIT: 429,
      PUBLICATION_UNAVAILABLE: 503,
      ARTIFACT_INVALID: 503,
      SERVER_STOPPING: 503
    };
    const statusMatches = body.code === "CURRENT_CHANGED" ? response.status === 409 || response.status === 412 : expectedStatus[body.code] === response.status;
    if (!statusMatches) throw fatal("PROTOCOL_ERROR", "derived runtime error code and HTTP status disagree");
    if (body.code === "NO_PUBLICATION") throw transient("NO_PUBLICATION", body.message);
    if (body.code === "NOT_CURRENT") throw transient("NOT_CURRENT", body.message);
    if (body.code === "CURRENT_CHANGED") throw transient("CURRENT_CHANGED", body.message);
    if (body.code === "RATE_LIMITED") throw transient("RATE_LIMITED", body.message);
    if (body.code === "STREAM_LIMIT") throw transient("STREAM_LIMIT", body.message);
    if (body.code === "PUBLICATION_UNAVAILABLE") throw transient("PUBLICATION_UNAVAILABLE", body.message);
    if (body.code === "SERVER_STOPPING") throw transient("SERVER_STOPPING", body.message);
    if (body.code === "UNAUTHORIZED") throw fatal("UNAUTHORIZED", body.message);
    if (body.code === "NOT_FOUND") throw fatal("NOT_FOUND", body.message);
    if (body.code === "FORBIDDEN_HOST" || body.code === "FORBIDDEN_ORIGIN") throw fatal("FORBIDDEN", body.message);
    if (body.code === "ARTIFACT_INVALID") throw fatal("INTEGRITY_ERROR", body.message);
    throw fatal("PROTOCOL_ERROR", "derived runtime returned an unsupported error code");
  }
};

// src/world/derived-runtime.mjs
var DERIVED_RUNTIME_DIAGNOSTICS_LIMIT = 64;
var MAX_DERIVED_RUNTIME_DIAGNOSTICS = 256;
var MAX_DERIVED_RUNTIME_ERROR_SUMMARIES = 32;
var PROJECT_ID3 = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var BRANCH_ID3 = /^[a-z0-9][a-z0-9._-]{0,95}$/;
var HASH2 = /^sha256:[0-9a-f]{64}$/;
var MAX_GLOBAL_DEPENDENCY_TYPES = 64;
var MAX_GLOBAL_DEPENDENCIES_PER_TYPE = 8;
var EMPTY_GLOBAL_DEPENDENCIES = Object.freeze([]);
var GLOBAL_DEPENDENCY_REGISTRY = Object.freeze({
  "world-overview-terrain/v1": EMPTY_GLOBAL_DEPENDENCIES,
  "navigation-index/v1": EMPTY_GLOBAL_DEPENDENCIES,
  "biome-field/v1": EMPTY_GLOBAL_DEPENDENCIES,
  "hydrology-field/v1": EMPTY_GLOBAL_DEPENDENCIES,
  "hydrology-water-topology/v1": Object.freeze(["hydrology-field/v1"])
});
function assertFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
  return value;
}
function assertIdentifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function assertOptions(value, allowed, label) {
  if (value === void 0) return {};
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length > 0) throw new Error(`${label} has unsupported fields: ${extras.join(", ")}`);
  return value;
}
function selectedManifestChunks(manifest, selectChunks) {
  const selected = selectChunks(manifest);
  if (!Array.isArray(selected) || Object.getPrototypeOf(selected) !== Array.prototype || !Object.isFrozen(selected) || Object.getOwnPropertySymbols(selected).length !== 0 || Object.getOwnPropertyNames(selected).length !== selected.length + 1 || selected.length > manifest.chunks.length) {
    throw new DerivedRevisionRuntimeError("INVALID_CHUNK_RESIDENCY", "selectChunks must return a frozen dense bounded array");
  }
  const canonicalIndices = new Map(manifest.chunks.map((chunk, index) => [chunk, index]));
  let previousIndex = -1;
  for (let index = 0; index < selected.length; index++) {
    const descriptor2 = Object.getOwnPropertyDescriptor(selected, String(index));
    const canonicalIndex = canonicalIndices.get(descriptor2?.value);
    if (descriptor2?.enumerable !== true || descriptor2.get !== void 0 || descriptor2.set !== void 0 || canonicalIndex === void 0 || canonicalIndex <= previousIndex) {
      throw new DerivedRevisionRuntimeError(
        "INVALID_CHUNK_RESIDENCY",
        "selectChunks must preserve unique canonical manifest chunk references in manifest order"
      );
    }
    previousIndex = canonicalIndex;
  }
  return selected;
}
function sameSelectedChunkOrder(left, right) {
  return left.length === right.length && left.every((chunk, index) => chunk.chunkId === right[index].chunkId);
}
function liveChunksMatchSelection(liveChunks, selected) {
  if (liveChunks.size !== selected.length) return false;
  let index = 0;
  for (const chunkId of liveChunks.keys()) {
    if (chunkId !== selected[index++].chunkId) return false;
  }
  return true;
}
function freezeArray(entries) {
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}
function errorSummary(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 240 ? message : `${message.slice(0, 237)}...`;
}
function elapsed(now, startedAt) {
  const duration = now() - startedAt;
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}
function cancellationError() {
  return new DerivedRevisionRuntimeError("DERIVED_REVISION_CANCELLED", "derived revision update was cancelled", "AbortError");
}
function throwIfCancelled(signal) {
  if (signal?.aborted === true) throw cancellationError();
}
function chunkRuntimeIdentity(chunk, grid) {
  return compilerContentHash({
    chunkId: chunk.chunkId,
    gridId: chunk.gridId,
    lod: chunk.lod,
    tx: chunk.tx,
    tz: chunk.tz,
    topologyHash: chunk.topologyHash,
    sourceSliceHashes: chunk.sourceSliceHashes,
    artifacts: chunk.artifacts,
    grid
  });
}
function validateGlobalDependencyRegistry(registry) {
  const artifactTypes = Object.keys(registry);
  if (artifactTypes.length > MAX_GLOBAL_DEPENDENCY_TYPES) throw new Error("global dependency registry exceeds its type bound");
  const registered = new Set(artifactTypes);
  for (const artifactType of artifactTypes) {
    const dependencies = registry[artifactType];
    if (!Array.isArray(dependencies) || dependencies.length > MAX_GLOBAL_DEPENDENCIES_PER_TYPE) {
      throw new Error(`global dependency registry entry '${artifactType}' is invalid`);
    }
    const unique = new Set(dependencies);
    if (unique.size !== dependencies.length) throw new Error(`global dependency registry entry '${artifactType}' contains duplicates`);
    for (const dependencyType of dependencies) {
      if (!registered.has(dependencyType)) {
        throw new Error(`global dependency registry entry '${artifactType}' references unknown type '${dependencyType}'`);
      }
    }
  }
  const states = /* @__PURE__ */ new Map();
  const visit = (artifactType) => {
    const state = states.get(artifactType);
    if (state === 2) return;
    if (state === 1) throw new Error(`global dependency registry contains a cycle at '${artifactType}'`);
    states.set(artifactType, 1);
    for (const dependencyType of registry[artifactType]) visit(dependencyType);
    states.set(artifactType, 2);
  };
  for (const artifactType of artifactTypes) visit(artifactType);
}
validateGlobalDependencyRegistry(GLOBAL_DEPENDENCY_REGISTRY);
function globalDependencies(artifactType) {
  return GLOBAL_DEPENDENCY_REGISTRY[artifactType] ?? EMPTY_GLOBAL_DEPENDENCIES;
}
function planGlobalArtifacts(manifestGlobals) {
  const byType = new Map(manifestGlobals.map((artifact) => [artifact.artifactType, artifact]));
  for (const artifact of manifestGlobals) {
    for (const dependencyType of globalDependencies(artifact.artifactType)) {
      if (!byType.has(dependencyType)) {
        throw new DerivedRevisionRuntimeError(
          "GLOBAL_DEPENDENCY_MISSING",
          `global artifact '${artifact.artifactType}' requires '${dependencyType}'`
        );
      }
    }
  }
  const ordered = [];
  const visited = /* @__PURE__ */ new Set();
  const visit = (artifact) => {
    if (visited.has(artifact.artifactType)) return;
    for (const dependencyType of globalDependencies(artifact.artifactType)) visit(byType.get(dependencyType));
    visited.add(artifact.artifactType);
    ordered.push(artifact);
  };
  for (const artifact of manifestGlobals) visit(artifact);
  return Object.freeze(ordered);
}
function globalRuntimeIdentity(artifact, dependencyIdentities) {
  if (dependencyIdentities.length === 0) return compilerContentHash(artifact);
  return compilerContentHash({ artifact, dependencies: dependencyIdentities });
}
function frozenReadonlyMap(entries) {
  const target = new Map(entries);
  let readonly;
  const rejectMutation = () => {
    throw new TypeError("dependency map is read-only");
  };
  readonly = new Proxy(target, {
    get(map, property) {
      if (property === "set" || property === "delete" || property === "clear") return rejectMutation;
      if (property === "valueOf") return () => readonly;
      if (property === "forEach") {
        return (callback, thisArg = void 0) => map.forEach((value2, key) => callback.call(thisArg, value2, key, readonly));
      }
      const value = Reflect.get(map, property, map);
      return typeof value === "function" ? value.bind(map) : value;
    }
  });
  return Object.freeze(readonly);
}
function stageGlobalDependencies(dependencyTypes, nextGlobals) {
  return frozenReadonlyMap(dependencyTypes.map((artifactType) => {
    const entry = nextGlobals.get(artifactType);
    if (entry === void 0) throw new Error(`global dependency '${artifactType}' was not staged`);
    return [artifactType, Object.freeze({ artifactType, artifact: entry.artifact, resource: entry.resource })];
  }));
}
function publicChunks(liveChunks) {
  return freezeArray([...liveChunks.values()].map((entry) => ({
    chunkId: entry.chunk.chunkId,
    chunk: entry.chunk,
    resource: entry.resource
  })));
}
function publicGlobals(liveGlobals) {
  return new Map([...liveGlobals].map(([artifactType, entry]) => [artifactType, Object.freeze({
    artifactType,
    artifact: entry.artifact,
    resource: entry.resource
  })]));
}
function assertAuthority(authority, projectId, branchId) {
  if (authority === null || Array.isArray(authority) || typeof authority !== "object" || Object.getPrototypeOf(authority) !== Object.prototype) {
    throw new DerivedRevisionRuntimeError("INVALID_AUTHORITY", "authoritative source lookup must return a plain object");
  }
  const actualKeys = Object.keys(authority).sort();
  const expectedKeys = ["branchId", "headHash", "projectId", "revision"];
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new DerivedRevisionRuntimeError("INVALID_AUTHORITY", "authoritative source lookup returned invalid fields");
  }
  if (authority.projectId !== projectId || authority.branchId !== branchId) {
    throw new DerivedRevisionRuntimeError("AUTHORITY_SCOPE_MISMATCH", "authoritative source lookup returned another project or branch");
  }
  if (!Number.isSafeInteger(authority.revision) || authority.revision < 0 || typeof authority.headHash !== "string" || !HASH2.test(authority.headHash)) {
    throw new DerivedRevisionRuntimeError("INVALID_AUTHORITY", "authoritative source lookup returned an invalid revision or headHash");
  }
  return authority;
}
var DerivedRevisionRuntimeError = class extends Error {
  constructor(code, message, name = "DerivedRevisionRuntimeError") {
    super(message);
    this.name = name;
    this.code = code;
  }
};
var DerivedRevisionManager = class {
  #projectId;
  #branchId;
  #getAuthoritativeSource;
  #loadArtifact;
  #selectChunks;
  #stageChunk;
  #stageGlobal;
  #activateRevision;
  #disposeChunk;
  #disposeGlobal;
  #now;
  #diagnosticsLimit;
  #diagnostics = [];
  #live = null;
  #running = false;
  #active = null;
  #pending = null;
  #closed = false;
  #closePromise = null;
  #idleWaiters = /* @__PURE__ */ new Set();
  constructor(input) {
    const options = assertOptions(input, /* @__PURE__ */ new Set([
      "projectId",
      "branchId",
      "getAuthoritativeSource",
      "loadArtifact",
      "stageChunk",
      "selectChunks",
      "stageGlobal",
      "activateRevision",
      "disposeChunk",
      "disposeGlobal",
      "diagnosticsLimit",
      "now"
    ]), "derived revision manager options");
    this.#projectId = assertIdentifier(options.projectId, PROJECT_ID3, "derived revision manager projectId");
    this.#branchId = assertIdentifier(options.branchId, BRANCH_ID3, "derived revision manager branchId");
    this.#getAuthoritativeSource = assertFunction(options.getAuthoritativeSource, "getAuthoritativeSource");
    this.#loadArtifact = assertFunction(options.loadArtifact, "loadArtifact");
    this.#selectChunks = options.selectChunks === void 0 ? (manifest) => manifest.chunks : assertFunction(options.selectChunks, "selectChunks");
    this.#stageChunk = assertFunction(options.stageChunk, "stageChunk");
    this.#stageGlobal = options.stageGlobal === void 0 ? void 0 : assertFunction(options.stageGlobal, "stageGlobal");
    this.#activateRevision = assertFunction(options.activateRevision, "activateRevision");
    this.#disposeChunk = assertFunction(options.disposeChunk, "disposeChunk");
    this.#disposeGlobal = options.disposeGlobal === void 0 ? void 0 : assertFunction(options.disposeGlobal, "disposeGlobal");
    if (typeof globalThis.AbortController !== "function") {
      throw new Error("DerivedRevisionManager requires the platform AbortController API");
    }
    const clock = options.now === void 0 ? () => globalThis.performance?.now?.() ?? Date.now() : assertFunction(options.now, "now");
    this.#now = () => {
      try {
        const timestamp = clock();
        return Number.isFinite(timestamp) ? timestamp : Date.now();
      } catch {
        return Date.now();
      }
    };
    this.#diagnosticsLimit = options.diagnosticsLimit ?? DERIVED_RUNTIME_DIAGNOSTICS_LIMIT;
    if (!Number.isSafeInteger(this.#diagnosticsLimit) || this.#diagnosticsLimit < 1 || this.#diagnosticsLimit > MAX_DERIVED_RUNTIME_DIAGNOSTICS) {
      throw new Error(`diagnosticsLimit must be an integer in [1, ${MAX_DERIVED_RUNTIME_DIAGNOSTICS}]`);
    }
  }
  get projectId() {
    return this.#projectId;
  }
  get branchId() {
    return this.#branchId;
  }
  get isUpdating() {
    return this.#running;
  }
  get current() {
    if (this.#live === null) return null;
    return Object.freeze({
      manifest: this.#live.manifest,
      chunks: publicChunks(this.#live.chunks),
      globals: publicGlobals(this.#live.globals)
    });
  }
  getDiagnostics() {
    return Object.freeze(this.#diagnostics.map((entry) => Object.freeze({
      ...entry,
      timingsMs: Object.freeze({ ...entry.timingsMs }),
      errors: Object.freeze([...entry.errors])
    })));
  }
  close() {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    const reason = cancellationError();
    this.#active?.cancellation.abort(reason);
    this.#pending?.cancellation.abort(reason);
    this.#closePromise = this.#closeWhenIdle();
    return this.#closePromise;
  }
  submit(manifestInput, submitInput = void 0) {
    let manifest;
    let submitOptions;
    let selectedChunks;
    try {
      submitOptions = assertOptions(submitInput, /* @__PURE__ */ new Set(["force", "signal"]), "derived revision submit options");
      if (this.#closed) throw new DerivedRevisionRuntimeError("DERIVED_RUNTIME_CLOSED", "derived revision manager is closed");
      if (submitOptions.force !== void 0 && typeof submitOptions.force !== "boolean") throw new TypeError("force must be boolean");
      const signal = submitOptions.signal;
      if (signal !== void 0 && (signal === null || typeof signal !== "object" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
        throw new TypeError("signal must be an AbortSignal");
      }
      manifest = parseDerivedRevisionManifest(manifestInput);
      if (manifest.projectId !== this.#projectId || manifest.branchId !== this.#branchId) {
        throw new DerivedRevisionRuntimeError("MANIFEST_SCOPE_MISMATCH", "derived manifest belongs to another project or branch");
      }
      throwIfCancelled(signal);
      selectedChunks = selectedManifestChunks(manifest, this.#selectChunks);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const force = submitOptions.force === true;
      if (this.#sameJob(this.#active, manifest, selectedChunks, force) && !this.#active.cancellation.signal.aborted) {
        this.#addWaiter(this.#active, submitOptions.signal, resolve, reject);
        return;
      }
      if (this.#sameJob(this.#pending, manifest, selectedChunks, force) && !this.#pending.cancellation.signal.aborted) {
        this.#addWaiter(this.#pending, submitOptions.signal, resolve, reject);
        return;
      }
      const request = {
        manifest,
        chunks: selectedChunks,
        force,
        signal: null,
        queuedAt: this.#now(),
        waiters: /* @__PURE__ */ new Set(),
        cancellation: new globalThis.AbortController(),
        activationStarted: false
      };
      request.signal = request.cancellation.signal;
      this.#addWaiter(request, submitOptions.signal, resolve, reject);
      if (!this.#running) {
        this.#running = true;
        this.#active = request;
        void this.#drain(request);
        return;
      }
      if (this.#pending !== null && !force && manifest.source.revision < this.#pending.manifest.source.revision) {
        this.#supersedeJob(request, this.#pending.manifest.manifestHash);
        return;
      }
      if (this.#pending !== null) this.#supersedeJob(this.#pending, manifest.manifestHash);
      this.#pending = request;
    });
  }
  #sameJob(request, manifest, selectedChunks, force) {
    return request !== null && request.manifest.manifestHash === manifest.manifestHash && request.force === force && sameSelectedChunkOrder(request.chunks, selectedChunks);
  }
  #addWaiter(request, signal, resolve, reject) {
    const waiter = { signal, resolve, reject, abortListener: null };
    waiter.abortListener = () => {
      if (!request.waiters.has(waiter) || request.activationStarted) return;
      if (request.waiters.size > 1) {
        request.waiters.delete(waiter);
        signal.removeEventListener("abort", waiter.abortListener);
        reject(cancellationError());
        return;
      }
      request.cancellation.abort(cancellationError());
      if (this.#pending === request) {
        this.#pending = null;
        request.waiters.delete(waiter);
        signal.removeEventListener("abort", waiter.abortListener);
        const error = cancellationError();
        this.#recordDiagnostic(request, "cancelled", { errors: [errorSummary(error)] });
        reject(error);
      }
    };
    signal?.addEventListener("abort", waiter.abortListener, { once: true });
    request.waiters.add(waiter);
  }
  #settleWaiters(request, method, value) {
    for (const waiter of request.waiters) {
      waiter.signal?.removeEventListener("abort", waiter.abortListener);
      waiter[method](value);
    }
    request.waiters.clear();
  }
  #supersedeJob(request, supersededByManifestHash) {
    request.cancellation.abort(cancellationError());
    this.#recordDiagnostic(request, "superseded", { errors: [] });
    this.#settleWaiters(request, "resolve", Object.freeze({
      status: "superseded",
      manifestHash: request.manifest.manifestHash,
      supersededByManifestHash,
      revision: request.manifest.source.revision
    }));
  }
  async #drain(initialRequest) {
    let request = initialRequest;
    while (request !== null) {
      try {
        this.#settleWaiters(request, "resolve", await this.#apply(request));
      } catch (error) {
        this.#settleWaiters(request, "reject", error);
      }
      request = this.#pending;
      this.#pending = null;
      this.#active = request;
    }
    this.#active = null;
    this.#running = false;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
  async #closeWhenIdle() {
    if (this.#running) await new Promise((resolve) => this.#idleWaiters.add(resolve));
    const live = this.#live;
    this.#live = null;
    if (live === null) return;
    const failures = [];
    let failureCount = 0;
    for (const entry of [...live.chunks.values()].reverse()) {
      try {
        await this.#disposeChunk(Object.freeze({
          chunkId: entry.chunk.chunkId,
          chunk: entry.chunk,
          resource: entry.resource,
          reason: "closed"
        }));
      } catch (error) {
        failureCount++;
        if (failures.length < MAX_DERIVED_RUNTIME_ERROR_SUMMARIES) failures.push(error);
      }
    }
    for (const entry of [...live.globals.values()].reverse()) {
      try {
        await this.#disposeGlobal(Object.freeze({
          artifactType: entry.artifact.artifactType,
          artifact: entry.artifact,
          resource: entry.resource,
          reason: "closed"
        }));
      } catch (error) {
        failureCount++;
        if (failures.length < MAX_DERIVED_RUNTIME_ERROR_SUMMARIES) failures.push(error);
      }
    }
    if (failureCount > 0) {
      throw new AggregateError(failures, `${failureCount} resource disposal operation(s) failed while closing derived revision manager`);
    }
  }
  async #authoritativeSource(manifest) {
    const authority = assertAuthority(await this.#getAuthoritativeSource(Object.freeze({
      projectId: this.#projectId,
      branchId: this.#branchId
    })), this.#projectId, this.#branchId);
    if (authority.revision !== manifest.source.revision || authority.headHash !== manifest.source.headHash) {
      throw new DerivedRevisionRuntimeError(
        "STALE_SOURCE_HEAD",
        `derived manifest source ${manifest.source.revision}/${manifest.source.headHash} is not the authoritative head ${authority.revision}/${authority.headHash}`
      );
    }
  }
  async #loadVerifiedArtifact(request, artifact, loaderInput, cache, timings, counts) {
    let pending = cache.get(artifact.contentHash);
    if (pending === void 0) {
      pending = (async () => {
        const phaseAt = this.#now();
        try {
          return await this.#loadArtifact(Object.freeze(loaderInput));
        } finally {
          timings.load += elapsed(this.#now, phaseAt);
        }
      })();
      cache.set(artifact.contentHash, pending);
    }
    const bytes = await pending;
    throwIfCancelled(request.signal);
    if (!(bytes instanceof Uint8Array)) {
      throw new DerivedRevisionRuntimeError("INVALID_ARTIFACT_BYTES", `artifact '${artifact.artifactType}' loader did not return Uint8Array`);
    }
    if (bytes.byteLength !== artifact.byteLength) {
      throw new DerivedRevisionRuntimeError("ARTIFACT_LENGTH_MISMATCH", `artifact '${artifact.artifactType}' byteLength mismatch`);
    }
    if (derivedArtifactContentHash(bytes) !== artifact.contentHash) {
      throw new DerivedRevisionRuntimeError("ARTIFACT_HASH_MISMATCH", `artifact '${artifact.artifactType}' content hash mismatch`);
    }
    counts.artifacts++;
    counts.artifactBytes += bytes.byteLength;
    return bytes;
  }
  async #apply(request) {
    const startedAt = this.#now();
    const timingsMs = { authority: 0, load: 0, stage: 0, activation: 0, retirement: 0, total: 0 };
    const counts = {
      changed: 0,
      unchanged: 0,
      removed: 0,
      changedGlobals: 0,
      unchangedGlobals: 0,
      removedGlobals: 0,
      artifacts: 0,
      artifactBytes: 0,
      retirementFailures: 0
    };
    const staged = [];
    const artifactCache = /* @__PURE__ */ new Map();
    let failurePhase = "validation";
    try {
      throwIfCancelled(request.signal);
      if (this.#live !== null && request.manifest.source.revision < this.#live.manifest.source.revision && !request.force) {
        throw new DerivedRevisionRuntimeError("OUT_OF_ORDER_REVISION", "derived revision rollback requires force: true");
      }
      failurePhase = "authority";
      let phaseAt = this.#now();
      await this.#authoritativeSource(request.manifest);
      timingsMs.authority += elapsed(this.#now, phaseAt);
      throwIfCancelled(request.signal);
      failurePhase = "validation";
      const manifestGlobals = derivedGlobalArtifacts(request.manifest);
      const plannedGlobals = planGlobalArtifacts(manifestGlobals);
      if (manifestGlobals.length > 0 && (this.#stageGlobal === void 0 || this.#disposeGlobal === void 0)) {
        throw new DerivedRevisionRuntimeError(
          "GLOBAL_LIFECYCLE_UNAVAILABLE",
          "derived manifest carries global artifacts but stageGlobal/disposeGlobal are unavailable"
        );
      }
      if (this.#live?.manifest.manifestHash === request.manifest.manifestHash && liveChunksMatchSelection(this.#live.chunks, request.chunks)) {
        timingsMs.total = elapsed(this.#now, startedAt);
        counts.unchanged = request.chunks.length;
        counts.unchangedGlobals = manifestGlobals.length;
        const outcome2 = this.#outcome("unchanged", request.manifest, counts);
        this.#recordDiagnostic(request, "unchanged", { timingsMs, counts, errors: [] });
        return outcome2;
      }
      const priorChunks = this.#live?.chunks ?? /* @__PURE__ */ new Map();
      const priorGlobals = this.#live?.globals ?? /* @__PURE__ */ new Map();
      const nextChunks = /* @__PURE__ */ new Map();
      const nextGlobals = /* @__PURE__ */ new Map();
      const changedChunks = [];
      const changedGlobals = [];
      const globalIdentities = /* @__PURE__ */ new Map();
      for (const artifact of plannedGlobals) {
        const dependencyTypes = globalDependencies(artifact.artifactType);
        const dependencyIdentities = dependencyTypes.map((artifactType) => Object.freeze({
          artifactType,
          identity: globalIdentities.get(artifactType)
        }));
        const identity = globalRuntimeIdentity(artifact, dependencyIdentities);
        globalIdentities.set(artifact.artifactType, identity);
        const prior = priorGlobals.get(artifact.artifactType);
        if (prior?.identity === identity) {
          nextGlobals.set(artifact.artifactType, prior);
          counts.unchangedGlobals++;
        } else {
          changedGlobals.push({ artifact, dependencyTypes, identity });
          counts.changedGlobals++;
        }
      }
      const changedGlobalTypes = new Set(changedGlobals.map((changed) => changed.artifact.artifactType));
      const removedGlobals = [...priorGlobals.values()].filter((entry) => !nextGlobals.has(entry.artifact.artifactType) && !changedGlobalTypes.has(entry.artifact.artifactType));
      counts.removedGlobals = removedGlobals.length;
      for (const chunk of request.chunks) {
        const identity = chunkRuntimeIdentity(chunk, request.manifest.grid);
        const prior = priorChunks.get(chunk.chunkId);
        if (prior?.identity === identity) {
          nextChunks.set(chunk.chunkId, prior);
          counts.unchanged++;
        } else {
          changedChunks.push({ chunk, identity });
          counts.changed++;
        }
      }
      const changedChunkIds = new Set(changedChunks.map((changed) => changed.chunk.chunkId));
      const removedChunks = [...priorChunks.values()].filter((entry) => !nextChunks.has(entry.chunk.chunkId) && !changedChunkIds.has(entry.chunk.chunkId));
      counts.removed = removedChunks.length;
      for (const changed of changedGlobals) {
        throwIfCancelled(request.signal);
        failurePhase = "load";
        const bytes = await this.#loadVerifiedArtifact(
          request,
          changed.artifact,
          {
            manifest: request.manifest,
            artifact: changed.artifact,
            globalArtifact: changed.artifact,
            signal: request.signal
          },
          artifactCache,
          timingsMs,
          counts
        );
        failurePhase = "stage";
        phaseAt = this.#now();
        const resource = await this.#stageGlobal(Object.freeze({
          manifest: request.manifest,
          artifact: changed.artifact,
          bytes,
          dependencies: stageGlobalDependencies(changed.dependencyTypes, nextGlobals),
          signal: request.signal
        }));
        timingsMs.stage += elapsed(this.#now, phaseAt);
        if (resource === void 0) {
          throw new DerivedRevisionRuntimeError("INVALID_STAGED_RESOURCE", `global '${changed.artifact.artifactType}' staging returned undefined`);
        }
        const liveEntry = Object.freeze({ artifact: changed.artifact, identity: changed.identity, resource });
        staged.push({ kind: "global", entry: liveEntry });
        nextGlobals.set(changed.artifact.artifactType, liveEntry);
        throwIfCancelled(request.signal);
      }
      for (const changed of changedChunks) {
        throwIfCancelled(request.signal);
        const artifactPayloads = [];
        for (const artifact of changed.chunk.artifacts) {
          failurePhase = "load";
          const bytes = await this.#loadVerifiedArtifact(
            request,
            artifact,
            { manifest: request.manifest, chunk: changed.chunk, artifact, signal: request.signal },
            artifactCache,
            timingsMs,
            counts
          );
          artifactPayloads.push(Object.freeze({ artifact, bytes }));
        }
        failurePhase = "stage";
        phaseAt = this.#now();
        const resource = await this.#stageChunk(Object.freeze({
          manifest: request.manifest,
          chunk: changed.chunk,
          artifacts: freezeArray(artifactPayloads),
          signal: request.signal
        }));
        timingsMs.stage += elapsed(this.#now, phaseAt);
        if (resource === void 0) throw new DerivedRevisionRuntimeError("INVALID_STAGED_RESOURCE", `chunk '${changed.chunk.chunkId}' staging returned undefined`);
        const liveEntry = Object.freeze({ chunk: changed.chunk, identity: changed.identity, resource });
        staged.push({ kind: "chunk", entry: liveEntry });
        nextChunks.set(changed.chunk.chunkId, liveEntry);
        throwIfCancelled(request.signal);
      }
      const orderedNextGlobals = new Map(plannedGlobals.map((artifact) => [artifact.artifactType, nextGlobals.get(artifact.artifactType)]));
      const orderedNextChunks = new Map(request.chunks.map((chunk) => [chunk.chunkId, nextChunks.get(chunk.chunkId)]));
      const replacedChunks = changedChunks.map((changed) => priorChunks.get(changed.chunk.chunkId)).filter((entry) => entry !== void 0);
      const replacedChunkIds = new Set(replacedChunks.map((entry) => entry.chunk.chunkId));
      const chunkRetirementQueue = [...replacedChunks, ...removedChunks].map((entry) => ({
        entry,
        reason: replacedChunkIds.has(entry.chunk.chunkId) ? "replaced" : "removed"
      }));
      const globalRetirementReasons = /* @__PURE__ */ new Map();
      for (const changed of changedGlobals) {
        if (priorGlobals.has(changed.artifact.artifactType)) globalRetirementReasons.set(changed.artifact.artifactType, "replaced");
      }
      for (const entry of removedGlobals) globalRetirementReasons.set(entry.artifact.artifactType, "removed");
      const globalRetirementQueue = [...priorGlobals.values()].reverse().filter((entry) => globalRetirementReasons.has(entry.artifact.artifactType)).map((entry) => ({ entry, reason: globalRetirementReasons.get(entry.artifact.artifactType) }));
      const nextLive = Object.freeze({ manifest: request.manifest, chunks: orderedNextChunks, globals: orderedNextGlobals });
      failurePhase = "authority";
      phaseAt = this.#now();
      await this.#authoritativeSource(request.manifest);
      timingsMs.authority += elapsed(this.#now, phaseAt);
      throwIfCancelled(request.signal);
      failurePhase = "activation";
      request.activationStarted = true;
      phaseAt = this.#now();
      await this.#activateRevision(Object.freeze({
        manifest: request.manifest,
        previousManifest: this.#live?.manifest ?? null,
        chunks: publicChunks(orderedNextChunks),
        previousChunks: this.#live === null ? Object.freeze([]) : publicChunks(this.#live.chunks),
        globals: publicGlobals(orderedNextGlobals),
        previousGlobals: this.#live === null ? /* @__PURE__ */ new Map() : publicGlobals(this.#live.globals),
        changedChunkIds: Object.freeze(changedChunks.map((entry) => entry.chunk.chunkId)),
        removedChunkIds: Object.freeze(removedChunks.map((entry) => entry.chunk.chunkId)),
        changedGlobalArtifactTypes: Object.freeze(changedGlobals.map((entry) => entry.artifact.artifactType)),
        removedGlobalArtifactTypes: Object.freeze(removedGlobals.map((entry) => entry.artifact.artifactType)),
        signal: request.signal
      }));
      this.#live = nextLive;
      staged.length = 0;
      timingsMs.activation = elapsed(this.#now, phaseAt);
      failurePhase = "retirement";
      phaseAt = this.#now();
      const retirementErrors = [];
      let retirementFailureCount = 0;
      for (const retirement of chunkRetirementQueue) {
        const { entry } = retirement;
        try {
          await this.#disposeChunk(Object.freeze({
            chunkId: entry.chunk.chunkId,
            chunk: entry.chunk,
            resource: entry.resource,
            reason: retirement.reason
          }));
        } catch (error) {
          retirementFailureCount++;
          if (retirementErrors.length < MAX_DERIVED_RUNTIME_ERROR_SUMMARIES) retirementErrors.push(errorSummary(error));
        }
      }
      for (const retirement of globalRetirementQueue) {
        const { entry } = retirement;
        try {
          await this.#disposeGlobal(Object.freeze({
            artifactType: entry.artifact.artifactType,
            artifact: entry.artifact,
            resource: entry.resource,
            reason: retirement.reason
          }));
        } catch (error) {
          retirementFailureCount++;
          if (retirementErrors.length < MAX_DERIVED_RUNTIME_ERROR_SUMMARIES) retirementErrors.push(errorSummary(error));
        }
      }
      timingsMs.retirement = elapsed(this.#now, phaseAt);
      counts.retirementFailures = retirementFailureCount;
      timingsMs.total = elapsed(this.#now, startedAt);
      const outcome = this.#outcome("activated", request.manifest, counts);
      this.#recordDiagnostic(request, "activated", { timingsMs, counts, errors: retirementErrors, errorCount: retirementFailureCount });
      return outcome;
    } catch (error) {
      const cleanup = await this.#disposeStaged(staged, failurePhase === "activation" ? "activation-failed" : error?.code === "DERIVED_REVISION_CANCELLED" ? "cancelled" : "staging-failed");
      timingsMs.total = elapsed(this.#now, startedAt);
      const errors = [errorSummary(error), ...cleanup.failures.map(errorSummary)].slice(0, MAX_DERIVED_RUNTIME_ERROR_SUMMARIES);
      this.#recordDiagnostic(request, error?.code === "DERIVED_REVISION_CANCELLED" ? "cancelled" : "failed", {
        phase: failurePhase,
        timingsMs,
        counts,
        errors,
        errorCount: 1 + cleanup.failureCount
      });
      if (cleanup.failureCount > 0) {
        throw new AggregateError(
          [error, ...cleanup.failures].slice(0, MAX_DERIVED_RUNTIME_ERROR_SUMMARIES),
          `${errorSummary(error)}; ${cleanup.failureCount} staged resource cleanup operation(s) also failed`
        );
      }
      throw error;
    }
  }
  async #disposeStaged(staged, reason) {
    const failures = [];
    let failureCount = 0;
    for (let index = staged.length - 1; index >= 0; index--) {
      const stagedEntry = staged[index];
      const entry = stagedEntry.entry;
      try {
        if (stagedEntry.kind === "chunk") {
          await this.#disposeChunk(Object.freeze({ chunkId: entry.chunk.chunkId, chunk: entry.chunk, resource: entry.resource, reason }));
        } else {
          await this.#disposeGlobal(Object.freeze({
            artifactType: entry.artifact.artifactType,
            artifact: entry.artifact,
            resource: entry.resource,
            reason
          }));
        }
      } catch (error) {
        failureCount++;
        if (failures.length < MAX_DERIVED_RUNTIME_ERROR_SUMMARIES - 1) failures.push(error);
      }
    }
    return { failures, failureCount };
  }
  #outcome(status, manifest, counts) {
    return Object.freeze({
      status,
      manifestHash: manifest.manifestHash,
      revision: manifest.source.revision,
      changedChunks: counts.changed,
      unchangedChunks: counts.unchanged,
      removedChunks: counts.removed,
      changedGlobals: counts.changedGlobals,
      unchangedGlobals: counts.unchangedGlobals,
      removedGlobals: counts.removedGlobals,
      retirementFailures: counts.retirementFailures
    });
  }
  #recordDiagnostic(request, status, details = {}) {
    const timingsMs = details.timingsMs ?? { authority: 0, load: 0, stage: 0, activation: 0, retirement: 0, total: elapsed(this.#now, request.queuedAt) };
    const counts = details.counts ?? {
      changed: 0,
      unchanged: 0,
      removed: 0,
      changedGlobals: 0,
      unchangedGlobals: 0,
      removedGlobals: 0,
      artifacts: 0,
      artifactBytes: 0,
      retirementFailures: 0
    };
    const errorCount = details.errorCount ?? details.errors?.length ?? 0;
    const retainedErrors = [...details.errors ?? []].slice(0, MAX_DERIVED_RUNTIME_ERROR_SUMMARIES);
    this.#diagnostics.push(Object.freeze({
      manifestHash: request.manifest.manifestHash,
      revision: request.manifest.source.revision,
      status,
      phase: details.phase ?? null,
      changedChunks: counts.changed,
      unchangedChunks: counts.unchanged,
      removedChunks: counts.removed,
      changedGlobals: counts.changedGlobals,
      unchangedGlobals: counts.unchangedGlobals,
      removedGlobals: counts.removedGlobals,
      artifactsLoaded: counts.artifacts,
      artifactBytesLoaded: counts.artifactBytes,
      retirementFailures: counts.retirementFailures,
      errorCount,
      errorsTruncated: errorCount > retainedErrors.length,
      timingsMs: Object.freeze({ ...timingsMs }),
      errors: Object.freeze(retainedErrors)
    }));
    if (this.#diagnostics.length > this.#diagnosticsLimit) this.#diagnostics.splice(0, this.#diagnostics.length - this.#diagnosticsLimit);
  }
};

// src/world/compiler/terrain-artifact.mjs
var TERRAIN_CHUNK_ARTIFACT_SCHEMA = "limina.terrain-chunk-artifact/v1";
var TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.terrain-chunk-v1";
var TERRAIN_CHUNK_ARTIFACT_VERSION = 1;
var TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES = 80;
var MIN_TERRAIN_ARTIFACT_ROWS = 2;
var MAX_TERRAIN_ARTIFACT_ROWS = 257;
var MIN_TERRAIN_ARTIFACT_COLS = 2;
var MAX_TERRAIN_ARTIFACT_COLS = 257;
var MAX_TERRAIN_ARTIFACT_CELLS = MAX_TERRAIN_ARTIFACT_ROWS * MAX_TERRAIN_ARTIFACT_COLS;
var TERRAIN_ARTIFACT_CLIMATE_CHANNELS = 3;
var MAX_TERRAIN_CHUNK_ARTIFACT_BYTES = 2 * 1024 * 1024;
var MAX_TERRAIN_ARTIFACT_ORIGIN_ABS_M = 1e7;
var MAX_TERRAIN_ARTIFACT_SCALE_M = 1e6;
var TERRAIN_ARTIFACT_FLAG_PAINT_MAT = 1 << 0;
var TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT = 1 << 1;
var TERRAIN_ARTIFACT_FLAG_CLIMATE = 1 << 2;
var TERRAIN_ARTIFACT_FLAG_BLIGHT = 1 << 3;
var KNOWN_FLAGS = TERRAIN_ARTIFACT_FLAG_PAINT_MAT | TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT | TERRAIN_ARTIFACT_FLAG_CLIMATE | TERRAIN_ARTIFACT_FLAG_BLIGHT;
var MAGIC = Object.freeze([76, 77, 84, 69, 82, 82, 78, 0]);
var REQUIRED_FIELDS = Object.freeze(["nrows", "ncols", "origin", "scale", "heights"]);
var ALLOWED_FIELDS = /* @__PURE__ */ new Set([...REQUIRED_FIELDS, "paintMat", "paintW", "climate", "climateChannels", "blight"]);
var BIOME_MIN = 0;
var BIOME_MAX = 6;
var PAINT_MATERIAL_MAX = 7;
function bufferIsShared(buffer) {
  return Object.prototype.toString.call(buffer) === "[object SharedArrayBuffer]";
}
function typedArray(value, tag, label) {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== `[object ${tag}]`) {
    throw new TypeError(`${label} must be ${tag}`);
  }
  if (bufferIsShared(value.buffer)) throw new TypeError(`${label} must not use SharedArrayBuffer storage`);
  return value;
}
function bytesInput(value) {
  return typedArray(value, "Uint8Array", "terrain artifact bytes");
}
function dimension(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}
function finiteCanonical(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  if (Object.is(value, -0)) throw new RangeError(`${label} must not be negative zero`);
  return value;
}
function normalized(value, label) {
  finiteCanonical(value, label);
  if (value < 0 || value > 1) throw new RangeError(`${label} must be in [0, 1]`);
  return value;
}
function positive(value, label) {
  finiteCanonical(value, label);
  if (!(value > 0)) throw new RangeError(`${label} must be > 0`);
  return value;
}
function boundedOrigin(value, label) {
  finiteCanonical(value, label);
  if (Math.abs(value) > MAX_TERRAIN_ARTIFACT_ORIGIN_ABS_M) {
    throw new RangeError(`${label} absolute value must be <= ${MAX_TERRAIN_ARTIFACT_ORIGIN_ABS_M} metres`);
  }
  return value;
}
function boundedScale(value, label) {
  positive(value, label);
  if (value > MAX_TERRAIN_ARTIFACT_SCALE_M) {
    throw new RangeError(`${label} must be <= ${MAX_TERRAIN_ARTIFACT_SCALE_M} metres`);
  }
  return value;
}
function align4(value) {
  return value + 3 & ~3;
}
function checkedByteLength(cells, flags, climateChannels) {
  let length = TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES + cells * 4;
  if ((flags & TERRAIN_ARTIFACT_FLAG_PAINT_MAT) !== 0) length = align4(length + cells);
  if ((flags & TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT) !== 0) length += cells * 4;
  if ((flags & TERRAIN_ARTIFACT_FLAG_CLIMATE) !== 0) length += cells * climateChannels * 4;
  if ((flags & TERRAIN_ARTIFACT_FLAG_BLIGHT) !== 0) length += cells * 4;
  if (!Number.isSafeInteger(length) || length > MAX_TERRAIN_CHUNK_ARTIFACT_BYTES) {
    throw new RangeError(`terrain artifact exceeds ${MAX_TERRAIN_CHUNK_ARTIFACT_BYTES} bytes`);
  }
  return length;
}
function payloadLayout(cells, flags, climateChannels) {
  let offset = TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES;
  const heights = offset;
  offset += cells * 4;
  let paintMat = null;
  let paintMatPadding = null;
  if ((flags & TERRAIN_ARTIFACT_FLAG_PAINT_MAT) !== 0) {
    paintMat = offset;
    offset += cells;
    paintMatPadding = Object.freeze({ offset, byteLength: align4(offset) - offset });
    offset = align4(offset);
  }
  let paintW = null;
  if ((flags & TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT) !== 0) {
    paintW = offset;
    offset += cells * 4;
  }
  let climate = null;
  if ((flags & TERRAIN_ARTIFACT_FLAG_CLIMATE) !== 0) {
    climate = offset;
    offset += cells * climateChannels * 4;
  }
  let blight = null;
  if ((flags & TERRAIN_ARTIFACT_FLAG_BLIGHT) !== 0) {
    blight = offset;
    offset += cells * 4;
  }
  return Object.freeze({ heights, paintMat, paintMatPadding, paintW, climate, blight, end: offset });
}
function validateFloatChannel(values, label, validator) {
  for (let index = 0; index < values.length; index++) validator(values[index], `${label}[${index}]`);
}
function validateClimate(values, cells) {
  if (values.length !== cells * TERRAIN_ARTIFACT_CLIMATE_CHANNELS) {
    throw new Error(`terrain tile climate length ${values.length} != ${cells * TERRAIN_ARTIFACT_CLIMATE_CHANNELS}`);
  }
  for (let cell = 0; cell < cells; cell++) {
    const base = cell * TERRAIN_ARTIFACT_CLIMATE_CHANNELS;
    finiteCanonical(values[base], `terrain tile climate[${base}]`);
    finiteCanonical(values[base + 1], `terrain tile climate[${base + 1}]`);
    const biome = finiteCanonical(values[base + 2], `terrain tile climate[${base + 2}]`);
    if (!Number.isInteger(biome) || biome < BIOME_MIN || biome > BIOME_MAX) {
      throw new RangeError(`terrain tile climate[${base + 2}] biome must be an integer in [${BIOME_MIN}, ${BIOME_MAX}]`);
    }
  }
}
function readFloat32Channel(view, offset, count) {
  const values = new Float32Array(count);
  for (let index = 0; index < count; index++) values[index] = view.getFloat32(offset + index * 4, true);
  return values;
}
function verifyMagic(bytes) {
  for (let index = 0; index < MAGIC.length; index++) {
    if (bytes[index] !== MAGIC[index]) throw new Error("terrain artifact magic mismatch");
  }
}
function channelFlags(flags) {
  return Object.freeze({
    paintMat: (flags & TERRAIN_ARTIFACT_FLAG_PAINT_MAT) !== 0,
    paintW: (flags & TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT) !== 0,
    climate: (flags & TERRAIN_ARTIFACT_FLAG_CLIMATE) !== 0,
    blight: (flags & TERRAIN_ARTIFACT_FLAG_BLIGHT) !== 0
  });
}
function decodeTerrainChunkArtifact(bytesInputValue) {
  const bytes = bytesInput(bytesInputValue);
  if (bytes.byteLength < TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES) throw new Error("terrain artifact is truncated before its fixed header");
  if (bytes.byteLength > MAX_TERRAIN_CHUNK_ARTIFACT_BYTES) throw new RangeError(`terrain artifact exceeds ${MAX_TERRAIN_CHUNK_ARTIFACT_BYTES} bytes`);
  verifyMagic(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(8, true);
  if (version !== TERRAIN_CHUNK_ARTIFACT_VERSION) throw new Error(`unsupported terrain artifact version ${version}`);
  const flags = view.getUint16(10, true);
  if ((flags & ~KNOWN_FLAGS) !== 0) throw new Error("terrain artifact contains unknown flags");
  if (view.getUint16(12, true) !== TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES) throw new Error("terrain artifact header length mismatch");
  const climateChannels = view.getUint16(14, true);
  const hasClimate = (flags & TERRAIN_ARTIFACT_FLAG_CLIMATE) !== 0;
  if (climateChannels !== (hasClimate ? TERRAIN_ARTIFACT_CLIMATE_CHANNELS : 0)) {
    throw new Error("terrain artifact climate flag/channel-count mismatch");
  }
  const declaredLength = view.getUint32(16, true);
  if (declaredLength !== bytes.byteLength) {
    throw new Error(`terrain artifact byte length mismatch: header ${declaredLength}, actual ${bytes.byteLength}`);
  }
  const nrows = dimension(view.getUint16(20, true), MIN_TERRAIN_ARTIFACT_ROWS, MAX_TERRAIN_ARTIFACT_ROWS, "terrain artifact nrows");
  const ncols = dimension(view.getUint16(22, true), MIN_TERRAIN_ARTIFACT_COLS, MAX_TERRAIN_ARTIFACT_COLS, "terrain artifact ncols");
  const cells = nrows * ncols;
  if (view.getUint32(24, true) !== cells) throw new Error("terrain artifact cell count does not match dimensions");
  if (view.getUint32(28, true) !== 0) throw new Error("terrain artifact reserved header bytes must be zero");
  const expectedLength = checkedByteLength(cells, flags, climateChannels);
  if (declaredLength !== expectedLength) throw new Error(`terrain artifact canonical byte length must be ${expectedLength}`);
  const layout2 = payloadLayout(cells, flags, climateChannels);
  if (layout2.paintMatPadding !== null) {
    for (let offset = layout2.paintMatPadding.offset; offset < layout2.paintMatPadding.offset + layout2.paintMatPadding.byteLength; offset++) {
      if (bytes[offset] !== 0) throw new Error("terrain artifact paintMat alignment padding must be zero");
    }
  }
  const origin = new Array(3);
  const scale = new Array(3);
  for (let axis = 0; axis < 3; axis++) {
    origin[axis] = boundedOrigin(view.getFloat64(32 + axis * 8, true), `terrain artifact origin[${axis}]`);
    scale[axis] = boundedScale(view.getFloat64(56 + axis * 8, true), `terrain artifact scale[${axis}]`);
  }
  const heights = readFloat32Channel(view, layout2.heights, cells);
  validateFloatChannel(heights, "terrain artifact heights", normalized);
  let paintMat;
  if (layout2.paintMat !== null) {
    paintMat = new Uint8Array(cells);
    paintMat.set(bytes.subarray(layout2.paintMat, layout2.paintMat + cells));
    for (let index = 0; index < paintMat.length; index++) {
      if (paintMat[index] > PAINT_MATERIAL_MAX) throw new RangeError(`terrain artifact paintMat[${index}] must be in [0, ${PAINT_MATERIAL_MAX}]`);
    }
  }
  let paintW;
  if (layout2.paintW !== null) {
    paintW = readFloat32Channel(view, layout2.paintW, cells);
    validateFloatChannel(paintW, "terrain artifact paintW", normalized);
  }
  let climate;
  if (layout2.climate !== null) {
    climate = readFloat32Channel(view, layout2.climate, cells * climateChannels);
    validateClimate(climate, cells);
  }
  let blight;
  if (layout2.blight !== null) {
    blight = readFloat32Channel(view, layout2.blight, cells);
    validateFloatChannel(blight, "terrain artifact blight", normalized);
  }
  const tile = { nrows, ncols, origin: Object.freeze(origin), scale: Object.freeze(scale), heights };
  if (paintMat !== void 0) tile.paintMat = paintMat;
  if (paintW !== void 0) tile.paintW = paintW;
  if (climate !== void 0) {
    tile.climate = climate;
    tile.climateChannels = climateChannels;
  }
  if (blight !== void 0) tile.blight = blight;
  Object.freeze(tile);
  const metadata = Object.freeze({
    schema: TERRAIN_CHUNK_ARTIFACT_SCHEMA,
    mediaType: TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
    version,
    byteLength: declaredLength,
    headerBytes: TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES,
    nrows,
    ncols,
    cells,
    climateChannels,
    channels: channelFlags(flags),
    offsets: layout2,
    storage: "owned-channel-copies"
  });
  return Object.freeze({ metadata, tile });
}

// src/world/biome-surface-plan.mjs
var BIOME_SURFACE_PLAN_LIMITS = Object.freeze({ rows: 1025, cols: 1025, cells: 1050625, roles: 32, slots: 16, bytes: 64 * 1024 * 1024 });

// src/world/surface-composite-tile.mjs
var SURFACE_COMPOSITE_TILE_SCHEMA = "limina.surface-composite-tile/v1";
var SURFACE_COMPOSITE_POLICY_VERSION = 3;
var SURFACE_COMPOSITE_LIMITS = Object.freeze({ interior: 256, gutter: 4, roles: 32, sourceDimension: 4096, outputBytes: 4 * 1024 * 1024 });

// src/world/compiler/surface-composite-artifact.mjs
var SURFACE_COMPOSITE_ARTIFACT_TYPE = "surface-composite-tile/v1";
var SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.surface-composite-qoi-v1";
var SURFACE_COMPOSITE_ARTIFACT_VERSION = 1;
var MAX_SURFACE_COMPOSITE_ARTIFACT_BYTES = 4 * 1024 * 1024;
var MAX_SURFACE_COMPOSITE_DECODED_BYTES = 4 * 1024 * 1024;
var MAGIC2 = Object.freeze([76, 77, 83, 85, 82, 70, 1, 0]);
var HEADER_BYTES = 32;
var MAX_METADATA_BYTES = 16 * 1024;
var HASH3 = /^sha256:[0-9a-f]{64}$/;
var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder("utf-8", { fatal: true });
function checkpoint(control, index = 0) {
  if ((index & 4095) === 0 && control?.shouldCancel?.() === true) {
    const error = new Error("surface composite artifact operation cancelled");
    error.name = "AbortError";
    throw error;
  }
}
function plain(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}
function exact(value, keys, label) {
  const names = Object.getOwnPropertyNames(value), expected = new Set(keys);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== expected.size || names.some((name) => !expected.has(name))) {
    throw new TypeError(`${label} fields are invalid`);
  }
  for (const name of names) {
    const descriptor2 = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor2?.enumerable !== true || descriptor2.get !== void 0 || descriptor2.set !== void 0) {
      throw new TypeError(`${label}.${name} must be an enumerable data field`);
    }
  }
  return value;
}
function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} is out of bounds`);
  return value;
}
function finite2(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) throw new RangeError(`${label} must be a canonical finite number`);
  return value;
}
function hash(value, label) {
  if (typeof value !== "string" || !HASH3.test(value)) throw new TypeError(`${label} must be a canonical content hash`);
  return value;
}
function tuple2(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2) throw new TypeError(`${label} must be a two-number array`);
  return Object.freeze([finite2(value[0], `${label}[0]`), finite2(value[1], `${label}[1]`)]);
}
function canonicalMetadata(input, verifyPixels = true) {
  const root = exact(plain(input, "surface composite"), ["schema", "source", "coord", "placement", "resolution", "maps", "edgeHashes", "diagnostics"], "surface composite");
  if (root.schema !== SURFACE_COMPOSITE_TILE_SCHEMA) throw new TypeError("surface composite schema is unsupported");
  const sourceInput = plain(root.source, "surface composite source");
  const source = exact(sourceInput, Object.hasOwn(sourceInput, "environmentHash") ? ["biomeFieldHash", "biomePackHash", "terrainChunkHash", "environmentHash", "policyVersion"] : ["biomeFieldHash", "biomePackHash", "terrainChunkHash", "policyVersion"], "surface composite source");
  const coord = exact(plain(root.coord, "surface composite coord"), ["tx", "tz", "lod"], "surface composite coord");
  const placement = exact(plain(root.placement, "surface composite placement"), ["origin", "sizeM", "featureOrigin"], "surface composite placement");
  const resolution = exact(plain(root.resolution, "surface composite resolution"), ["interior", "gutter", "total"], "surface composite resolution");
  const maps = exact(plain(root.maps, "surface composite maps"), ["albedo", "normal", "orm"], "surface composite maps");
  const edges = exact(plain(root.edgeHashes, "surface composite edge hashes"), ["north", "east", "south", "west"], "surface composite edge hashes");
  const diagnostics = exact(plain(root.diagnostics, "surface composite diagnostics"), ["roles", "runtimeTextureSamples", "outputBytes"], "surface composite diagnostics");
  const interior = integer(resolution.interior, 2, 256, "surface composite interior");
  const gutter = integer(resolution.gutter, 0, 4, "surface composite gutter");
  const total = integer(resolution.total, 2, 264, "surface composite total");
  if (total !== interior + gutter * 2) throw new Error("surface composite resolution is inconsistent");
  const decodedMapBytes = total * total * 4;
  if (decodedMapBytes * 3 > MAX_SURFACE_COMPOSITE_DECODED_BYTES) throw new RangeError("surface composite decoded maps exceed budget");
  const mapMeta = {};
  for (const name of ["albedo", "normal", "orm"]) {
    const entry = plain(maps[name], `surface composite ${name}`);
    const required = name === "albedo" ? ["data", "contentHash", "colorSpace"] : name === "normal" ? ["data", "contentHash", "colorSpace", "convention"] : ["data", "contentHash", "colorSpace", "channels"];
    exact(entry, required, `surface composite ${name}`);
    if (!(entry.data instanceof Uint8Array) || !(entry.data.buffer instanceof ArrayBuffer) || entry.data.length !== decodedMapBytes || entry.data.byteOffset !== 0 || entry.data.byteLength !== entry.data.buffer.byteLength) {
      throw new TypeError(`surface composite ${name} must be owned exact RGBA8 data`);
    }
    const contentHash2 = hash(entry.contentHash, `surface composite ${name} hash`);
    if (verifyPixels && `sha256:${sha256(entry.data)}` !== contentHash2) throw new Error(`surface composite ${name} content hash mismatch`);
    if (entry.colorSpace !== (name === "albedo" ? "srgb" : "none")) throw new Error(`surface composite ${name} color space is invalid`);
    if (name === "normal" && entry.convention !== "opengl-y-plus") throw new Error("surface composite normal convention is invalid");
    if (name === "orm" && entry.channels !== "ao-roughness-metalness") throw new Error("surface composite ORM channels are invalid");
    mapMeta[name] = Object.freeze({
      contentHash: contentHash2,
      colorSpace: entry.colorSpace,
      ...name === "normal" ? { convention: entry.convention } : {},
      ...name === "orm" ? { channels: entry.channels } : {}
    });
  }
  const outputBytes = integer(diagnostics.outputBytes, 1, MAX_SURFACE_COMPOSITE_DECODED_BYTES, "surface composite output bytes");
  if (outputBytes !== decodedMapBytes * 3 || diagnostics.runtimeTextureSamples !== 3) throw new Error("surface composite diagnostics are inconsistent");
  return Object.freeze({
    schema: SURFACE_COMPOSITE_TILE_SCHEMA,
    source: Object.freeze({
      biomeFieldHash: hash(source.biomeFieldHash, "surface composite biome field hash"),
      biomePackHash: hash(source.biomePackHash, "surface composite biome pack hash"),
      terrainChunkHash: hash(source.terrainChunkHash, "surface composite terrain chunk hash"),
      environmentHash: hash(source.environmentHash ?? source.terrainChunkHash, "surface composite environment hash"),
      policyVersion: integer(source.policyVersion, SURFACE_COMPOSITE_POLICY_VERSION, SURFACE_COMPOSITE_POLICY_VERSION, "surface composite policy version")
    }),
    coord: Object.freeze({ tx: integer(coord.tx, -1e6, 1e6, "surface composite tx"), tz: integer(coord.tz, -1e6, 1e6, "surface composite tz"), lod: integer(coord.lod, 0, 16, "surface composite lod") }),
    placement: Object.freeze({ origin: tuple2(placement.origin, "surface composite origin"), sizeM: (() => {
      const size = finite2(placement.sizeM, "surface composite size");
      if (!(size > 0) || size > 1e6) throw new RangeError("surface composite size is out of bounds");
      return size;
    })(), featureOrigin: tuple2(placement.featureOrigin, "surface composite feature origin") }),
    resolution: Object.freeze({ interior, gutter, total }),
    maps: Object.freeze(mapMeta),
    edgeHashes: Object.freeze({ north: hash(edges.north, "surface composite north edge"), east: hash(edges.east, "surface composite east edge"), south: hash(edges.south, "surface composite south edge"), west: hash(edges.west, "surface composite west edge") }),
    diagnostics: Object.freeze({ roles: integer(diagnostics.roles, 1, 32, "surface composite roles"), runtimeTextureSamples: 3, outputBytes }),
    codec: "qoi-rgba-v1"
  });
}
function pixelHash(r, g, b, a) {
  return r * 3 + g * 5 + b * 7 + a * 11 & 63;
}
function qoiEncode(data, control) {
  const output = [], index = new Uint8Array(64 * 4);
  let pr = 0, pg = 0, pb = 0, pa = 255, run = 0;
  const flush = () => {
    if (run > 0) {
      output.push(192 | run - 1);
      run = 0;
    }
  };
  for (let offset = 0, pixel = 0; offset < data.length; offset += 4, pixel++) {
    checkpoint(control, pixel);
    const r = data[offset], g = data[offset + 1], b = data[offset + 2], a = data[offset + 3];
    if (r === pr && g === pg && b === pb && a === pa) {
      run++;
      if (run === 62 || offset + 4 === data.length) flush();
      continue;
    }
    flush();
    const slot = pixelHash(r, g, b, a) * 4;
    if (index[slot] === r && index[slot + 1] === g && index[slot + 2] === b && index[slot + 3] === a) output.push(slot / 4);
    else {
      index[slot] = r;
      index[slot + 1] = g;
      index[slot + 2] = b;
      index[slot + 3] = a;
      const dr = r - pr, dg = g - pg, db = b - pb;
      if (a === pa && dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) output.push(64 | dr + 2 << 4 | dg + 2 << 2 | db + 2);
      else if (a === pa && dg >= -32 && dg <= 31 && dr - dg >= -8 && dr - dg <= 7 && db - dg >= -8 && db - dg <= 7) output.push(128 | dg + 32, dr - dg + 8 << 4 | db - dg + 8);
      else if (a === pa) output.push(254, r, g, b);
      else output.push(255, r, g, b, a);
    }
    pr = r;
    pg = g;
    pb = b;
    pa = a;
  }
  return Uint8Array.from(output);
}
function qoiDecode(bytes, pixels, control) {
  const output = new Uint8Array(pixels * 4), index = new Uint8Array(64 * 4);
  let at = 0, out = 0, pr = 0, pg = 0, pb = 0, pa = 255;
  while (out < output.length) {
    checkpoint(control, out >>> 2);
    if (at >= bytes.length) throw new Error("surface composite QOI stream is truncated");
    const tag = bytes[at++];
    let run = 1, updateIndex = true;
    if (tag === 254) {
      if (at + 3 > bytes.length) throw new Error("surface composite QOI RGB is truncated");
      pr = bytes[at++];
      pg = bytes[at++];
      pb = bytes[at++];
    } else if (tag === 255) {
      if (at + 4 > bytes.length) throw new Error("surface composite QOI RGBA is truncated");
      pr = bytes[at++];
      pg = bytes[at++];
      pb = bytes[at++];
      pa = bytes[at++];
    } else if ((tag & 192) === 0) {
      const slot = (tag & 63) * 4;
      pr = index[slot];
      pg = index[slot + 1];
      pb = index[slot + 2];
      pa = index[slot + 3];
    } else if ((tag & 192) === 64) {
      pr = pr + ((tag >> 4 & 3) - 2) & 255;
      pg = pg + ((tag >> 2 & 3) - 2) & 255;
      pb = pb + ((tag & 3) - 2) & 255;
    } else if ((tag & 192) === 128) {
      if (at >= bytes.length) throw new Error("surface composite QOI luma is truncated");
      const next = bytes[at++], dg = (tag & 63) - 32;
      pr = pr + dg + (next >> 4) - 8 & 255;
      pg = pg + dg & 255;
      pb = pb + dg + (next & 15) - 8 & 255;
    } else {
      run = (tag & 63) + 1;
      updateIndex = false;
    }
    if (out + run * 4 > output.length) throw new Error("surface composite QOI run exceeds decoded size");
    if (updateIndex) {
      const slot = pixelHash(pr, pg, pb, pa) * 4;
      index[slot] = pr;
      index[slot + 1] = pg;
      index[slot + 2] = pb;
      index[slot + 3] = pa;
    }
    for (let count = 0; count < run; count++) {
      output[out++] = pr;
      output[out++] = pg;
      output[out++] = pb;
      output[out++] = pa;
    }
  }
  if (at !== bytes.length) throw new Error("surface composite QOI stream has trailing bytes");
  return output;
}
function parseEnvelope(bytes) {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteLength < HEADER_BYTES || bytes.byteLength > MAX_SURFACE_COMPOSITE_ARTIFACT_BYTES) throw new TypeError("surface composite artifact bytes are invalid");
  for (let index = 0; index < MAGIC2.length; index++) if (bytes[index] !== MAGIC2[index]) throw new Error("surface composite artifact magic is invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(8, true) !== SURFACE_COMPOSITE_ARTIFACT_VERSION || view.getUint16(10, true) !== HEADER_BYTES || view.getUint32(12, true) !== bytes.byteLength) throw new Error("surface composite artifact header is invalid");
  const metadataLength = view.getUint32(16, true), lengths = [view.getUint32(20, true), view.getUint32(24, true), view.getUint32(28, true)];
  if (metadataLength < 2 || metadataLength > MAX_METADATA_BYTES || HEADER_BYTES + metadataLength + lengths.reduce((a, b) => a + b, 0) !== bytes.byteLength || lengths.some((length) => length < 1)) throw new Error("surface composite artifact lengths are invalid");
  const metadataBytes = bytes.subarray(HEADER_BYTES, HEADER_BYTES + metadataLength);
  let parsed;
  try {
    parsed = JSON.parse(textDecoder.decode(metadataBytes));
  } catch (error) {
    throw new Error("surface composite artifact metadata is invalid", { cause: error });
  }
  const metadata = canonicalMetadataForDecode(parsed);
  const canonical = textEncoder.encode(JSON.stringify(metadata));
  if (canonical.length !== metadataBytes.length || !canonical.every((byte, index) => byte === metadataBytes[index])) throw new Error("surface composite artifact metadata is not canonical");
  let offset = HEADER_BYTES + metadataLength;
  const streams = lengths.map((length) => {
    const stream = bytes.subarray(offset, offset + length);
    offset += length;
    return stream;
  });
  return { metadata, streams };
}
function canonicalMetadataForDecode(input) {
  const root = exact(plain(input, "surface composite metadata"), ["schema", "source", "coord", "placement", "resolution", "maps", "edgeHashes", "diagnostics", "codec"], "surface composite metadata");
  if (root.codec !== "qoi-rgba-v1") throw new Error("surface composite artifact codec is unsupported");
  const total = root.resolution?.total;
  if (!Number.isSafeInteger(total) || total < 2 || total > 264) throw new RangeError("surface composite metadata total is out of bounds");
  const mapBytes = total * total * 4;
  const dummy = new Uint8Array(mapBytes);
  const maps = Object.fromEntries(["albedo", "normal", "orm"].map((name) => [name, { ...root.maps[name], data: dummy }]));
  const { codec: _codec, ...withoutCodec } = root;
  const validated = canonicalMetadata({ ...withoutCodec, maps }, false);
  return Object.freeze({ ...validated, maps: validated.maps, codec: "qoi-rgba-v1" });
}
function decodeSurfaceCompositeArtifact(bytes, control = {}) {
  checkpoint(control);
  const { metadata, streams } = parseEnvelope(bytes), pixels = metadata.resolution.total ** 2;
  const decoded = streams.map((stream) => qoiDecode(stream, pixels, control));
  for (let index = 0; index < decoded.length; index++) {
    const name = ["albedo", "normal", "orm"][index], actual = `sha256:${sha256(decoded[index])}`;
    if (actual !== metadata.maps[name].contentHash) throw new Error(`surface composite decoded ${name} map hash mismatch (${actual})`);
    const canonical = qoiEncode(decoded[index], control);
    if (canonical.length !== streams[index].length || !canonical.every((byte, offset) => byte === streams[index][offset])) {
      throw new Error(`surface composite ${name} QOI stream is not canonical`);
    }
  }
  return Object.freeze({
    schema: metadata.schema,
    source: metadata.source,
    coord: metadata.coord,
    placement: metadata.placement,
    resolution: metadata.resolution,
    maps: Object.freeze({ albedo: Object.freeze({ ...metadata.maps.albedo, data: decoded[0] }), normal: Object.freeze({ ...metadata.maps.normal, data: decoded[1] }), orm: Object.freeze({ ...metadata.maps.orm, data: decoded[2] }) }),
    edgeHashes: metadata.edgeHashes,
    diagnostics: metadata.diagnostics
  });
}

// src/world/hydrology-ir.mjs
var HYDROLOGY_LIMITS = Object.freeze({
  precipitationMmPerYear: 1e5,
  catchmentAreaM2: 1e12,
  basinAreaM2: 1e12,
  basinDepthM: 2e4,
  waterfallDropM: 2e4
});

// src/world/hydrology-topology.mjs
var HYDROLOGY_TOPOLOGY_SCHEMA = "limina.hydrology-topology/v1";
var HYDROLOGY_TOPOLOGY_VERSION = 1;
var MAX_HYDROLOGY_DIMENSION = 1025;
var MAX_HYDROLOGY_CELLS = MAX_HYDROLOGY_DIMENSION * MAX_HYDROLOGY_DIMENSION;
var MAX_HYDROLOGY_ABS_HEIGHT_M = 1e9;
var MAX_HYDROLOGY_CELL_SIZE_M = 1e6;
var MAX_HYDROLOGY_PRECIPITATION_MM_PER_YEAR = HYDROLOGY_LIMITS.precipitationMmPerYear;

// src/world/hydrology-artifact.mjs
var HYDROLOGY_FIELD_ARTIFACT_TYPE = "hydrology-field/v1";
var HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.hydrology-field";
var HYDROLOGY_FIELD_ARTIFACT_VERSION = 1;
var HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES = 112;
var MAGIC3 = new Uint8Array([76, 72, 89, 68, 70, 76, 68, 49]);
var CONTROL_KEYS = /* @__PURE__ */ new Set(["shouldCancel"]);
var MAX_ORIGIN_M = 1e12;
var align = (value, alignment) => Math.ceil(value / alignment) * alignment;
function layoutForCells(cells) {
  const receiver = HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES;
  const drainageRank = align(receiver + cells * 4, 4);
  const filledHeightM = align(drainageRank + cells * 4, 8);
  const catchmentAreaM2 = align(filledHeightM + cells * 8, 8);
  const streamOrder = catchmentAreaM2 + cells * 8;
  const oceanMask = streamOrder + cells;
  const dataEnd = oceanMask + cells;
  return Object.freeze({
    receiver,
    drainageRank,
    filledHeightM,
    catchmentAreaM2,
    streamOrder,
    oceanMask,
    dataEnd,
    byteLength: align(dataEnd, 8)
  });
}
var MAX_HYDROLOGY_FIELD_ARTIFACT_BYTES = layoutForCells(MAX_HYDROLOGY_CELLS).byteLength;
var HydrologyArtifactValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "HydrologyArtifactValidationError";
    this.code = "hydrology_artifact_invalid";
  }
};
var HydrologyArtifactCancelledError = class extends Error {
  constructor() {
    super("hydrology artifact operation cancelled");
    this.name = "HydrologyArtifactCancelledError";
    this.code = "hydrology_artifact_cancelled";
  }
};
function fail(message) {
  throw new HydrologyArtifactValidationError(message);
}
function exactRecord(value, keys, label, optional = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor2] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor2) || descriptor2.enumerable !== true) fail(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!optional.has(key) && !Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
  return descriptors;
}
function canonicalNumber(value, label, minimum, maximum, positive2 = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || (positive2 ? value <= minimum : value < minimum) || value > maximum) {
    fail(`${label} must be a finite canonical number in ${positive2 ? "(" : "["}${minimum}, ${maximum}]`);
  }
  return value;
}
function dimension2(value, label) {
  if (!Number.isSafeInteger(value) || value < 2 || value > MAX_HYDROLOGY_DIMENSION) {
    fail(`${label} must be an integer in [2, ${MAX_HYDROLOGY_DIMENSION}]`);
  }
  return value;
}
function parseControl(input, label) {
  if (input === void 0) return void 0;
  const descriptors = exactRecord(input, CONTROL_KEYS, label);
  const shouldCancel = descriptors.shouldCancel.value;
  if (typeof shouldCancel !== "function") fail(`${label}.shouldCancel must be a function`);
  return shouldCancel;
}
function createMeter(shouldCancel, maximum) {
  let workUnits = 0;
  let cancellationChecks = 0;
  const check = () => {
    cancellationChecks++;
    if (shouldCancel?.()) throw new HydrologyArtifactCancelledError();
  };
  const work = () => {
    workUnits++;
    if (workUnits > maximum) fail(`hydrology artifact exceeded bounded validation work ${maximum}`);
    if ((workUnits & 1023) === 0) check();
  };
  return Object.freeze({ work, check, snapshot: () => Object.freeze({ workUnits, workLimit: maximum, cancellationChecks }) });
}
function toleranceFor(expected, actual, terms = 1) {
  return Number.EPSILON * 64 * Math.max(1, Math.abs(expected), Math.abs(actual)) * Math.max(1, Math.ceil(Math.log2(terms + 1)));
}
function validateChannels(field, meter, validateDischarge) {
  const cells = field.cellCount;
  const rankToCell = new Uint32Array(cells);
  const seenRanks = new Uint8Array(cells);
  let outletCount = 0;
  let oceanCellCount = 0;
  let outletCatchmentAreaM2 = 0;
  let maximumStreamOrder = 1;
  for (let index = 0; index < cells; index++) {
    meter.work();
    const rank = field.drainageRank[index];
    if (rank >= cells || seenRanks[rank] !== 0) fail(`hydrology artifact drainageRank[${index}] is not a permutation`);
    seenRanks[rank] = 1;
    rankToCell[rank] = index;
    const receiver = field.receiver[index];
    if (receiver < -1 || receiver >= cells) fail(`hydrology artifact receiver[${index}] is out of range`);
    const filled = field.filledHeightM[index];
    if (!Number.isFinite(filled) || Object.is(filled, -0) || Math.abs(filled) > MAX_HYDROLOGY_ABS_HEIGHT_M) {
      fail(`hydrology artifact filledHeightM[${index}] is not finite canonical terrain data`);
    }
    const catchment = field.catchmentAreaM2[index];
    if (!Number.isFinite(catchment) || Object.is(catchment, -0) || !(catchment > 0)) {
      fail(`hydrology artifact catchmentAreaM2[${index}] must be finite and positive`);
    }
    const order = field.streamOrder[index];
    if (order < 1) fail(`hydrology artifact streamOrder[${index}] must be positive`);
    if (order > maximumStreamOrder) maximumStreamOrder = order;
    const ocean = field.oceanMask[index];
    if (ocean !== 0 && ocean !== 1) fail(`hydrology artifact oceanMask[${index}] must be 0 or 1`);
    if (ocean === 1) oceanCellCount++;
    const row = Math.floor(index / field.cols);
    const col = index - row * field.cols;
    const terminal = row === 0 || row === field.rows - 1 || col === 0 || col === field.cols - 1 || ocean === 1;
    if (receiver === -1 !== terminal) fail(`hydrology artifact receiver[${index}] violates perimeter/ocean outlet policy`);
    if (receiver === -1) {
      outletCount++;
      outletCatchmentAreaM2 += catchment;
    }
    if (validateDischarge) {
      const discharge = field.dischargeM3PerYear[index];
      const expected = catchment * field.precipitationMPerYear;
      if (!Number.isFinite(discharge) || Object.is(discharge, -0) || discharge < 0 || Math.abs(discharge - expected) > toleranceFor(expected, discharge, cells)) {
        fail(`hydrology artifact dischargeM3PerYear[${index}] is inconsistent with catchment and precipitation`);
      }
    }
  }
  const expectedCatchment = new Float64Array(cells);
  expectedCatchment.fill(field.cellAreaM2);
  const maxChildOrder = new Uint8Array(cells);
  const maxChildCount = new Uint8Array(cells);
  for (let rank = cells - 1; rank >= 0; rank--) {
    meter.work();
    const index = rankToCell[rank];
    const receiver = field.receiver[index];
    const expectedOrder = maxChildOrder[index] === 0 ? 1 : maxChildOrder[index] + (maxChildCount[index] >= 2 ? 1 : 0);
    if (field.streamOrder[index] !== expectedOrder) fail(`hydrology artifact streamOrder[${index}] violates Strahler topology`);
    const catchment = field.catchmentAreaM2[index];
    if (Math.abs(catchment - expectedCatchment[index]) > toleranceFor(expectedCatchment[index], catchment, cells)) {
      fail(`hydrology artifact catchmentAreaM2[${index}] violates receiver accumulation`);
    }
    if (receiver < 0) continue;
    if (field.drainageRank[receiver] >= field.drainageRank[index]) fail(`hydrology artifact receiver[${index}] does not have an earlier rank`);
    if (field.filledHeightM[receiver] > field.filledHeightM[index]) fail(`hydrology artifact filled surface rises downstream from cell ${index}`);
    expectedCatchment[receiver] += expectedCatchment[index];
    const order = field.streamOrder[index];
    if (order > maxChildOrder[receiver]) {
      maxChildOrder[receiver] = order;
      maxChildCount[receiver] = 1;
    } else if (order === maxChildOrder[receiver]) {
      maxChildCount[receiver]++;
    }
  }
  const expectedTotal = field.cellAreaM2 * cells;
  if (Math.abs(outletCatchmentAreaM2 - expectedTotal) > toleranceFor(expectedTotal, outletCatchmentAreaM2, cells)) {
    fail("hydrology artifact outlet catchment does not conserve total grid area");
  }
  return Object.freeze({ outletCount, oceanCellCount, maximumStreamOrder, outletCatchmentAreaM2 });
}
function ownedBytes(input) {
  if (!ArrayBuffer.isView(input) || Object.getPrototypeOf(input) !== Uint8Array.prototype) {
    fail("hydrology artifact bytes must be a Uint8Array");
  }
  if (!(input.buffer instanceof ArrayBuffer)) fail("hydrology artifact bytes must use a non-shared ArrayBuffer");
  if (input.byteLength < HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES || input.byteLength > MAX_HYDROLOGY_FIELD_ARTIFACT_BYTES) {
    fail("hydrology artifact byte length is outside supported bounds");
  }
  return Uint8Array.from(input);
}
function readArtifact(input, controlInput, includeTopology) {
  const shouldCancel = parseControl(controlInput, "hydrology artifact decode control");
  const bytes = ownedBytes(input);
  const meter = createMeter(shouldCancel, MAX_HYDROLOGY_CELLS * 48 + 4096);
  meter.check();
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC3.length; index++) if (view.getUint8(index) !== MAGIC3[index]) fail("hydrology artifact magic mismatch");
  if (view.getUint16(8, true) !== HYDROLOGY_FIELD_ARTIFACT_VERSION) fail("hydrology artifact version is unsupported");
  if (view.getUint16(10, true) !== 0) fail("hydrology artifact flags must be zero");
  if (view.getUint16(12, true) !== HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES) fail("hydrology artifact header length mismatch");
  if (view.getUint16(14, true) !== 0) fail("hydrology artifact reserved header field must be zero");
  for (let index = 96; index < HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES; index++) if (view.getUint8(index) !== 0) fail("hydrology artifact reserved header bytes must be zero");
  const rows = dimension2(view.getUint32(16, true), "hydrology artifact rows");
  const cols = dimension2(view.getUint32(20, true), "hydrology artifact cols");
  const cells = rows * cols;
  if (cells > MAX_HYDROLOGY_CELLS || view.getUint32(24, true) !== cells) fail("hydrology artifact cell count does not match dimensions");
  const layout2 = layoutForCells(cells);
  if (view.getUint32(28, true) !== bytes.byteLength || bytes.byteLength !== layout2.byteLength) fail("hydrology artifact byte length is non-canonical");
  const placement = Object.freeze({
    originX: canonicalNumber(view.getFloat64(32, true), "hydrology artifact originX", -MAX_ORIGIN_M, MAX_ORIGIN_M),
    originZ: canonicalNumber(view.getFloat64(40, true), "hydrology artifact originZ", -MAX_ORIGIN_M, MAX_ORIGIN_M)
  });
  const cellSizeM = canonicalNumber(view.getFloat64(48, true), "hydrology artifact cellSizeM", 0, MAX_HYDROLOGY_CELL_SIZE_M, true);
  const seaLevelM = canonicalNumber(view.getFloat64(56, true), "hydrology artifact seaLevelM", -MAX_HYDROLOGY_ABS_HEIGHT_M, MAX_HYDROLOGY_ABS_HEIGHT_M);
  const precipitationMmPerYear = canonicalNumber(
    view.getFloat64(64, true),
    "hydrology artifact precipitationMmPerYear",
    0,
    MAX_HYDROLOGY_PRECIPITATION_MM_PER_YEAR
  );
  for (const [offset, expected, label] of [
    [72, layout2.receiver, "receiver"],
    [76, layout2.drainageRank, "drainageRank"],
    [80, layout2.filledHeightM, "filledHeightM"],
    [84, layout2.catchmentAreaM2, "catchmentAreaM2"],
    [88, layout2.streamOrder, "streamOrder"],
    [92, layout2.oceanMask, "oceanMask"]
  ]) if (view.getUint32(offset, true) !== expected) fail(`hydrology artifact ${label} offset is non-canonical`);
  for (let index = layout2.dataEnd; index < layout2.byteLength; index++) if (view.getUint8(index) !== 0) fail("hydrology artifact alignment padding must be zero");
  const receiver = new Int32Array(cells);
  const drainageRank = new Uint32Array(cells);
  const filledHeightM = new Float64Array(cells);
  const catchmentAreaM2 = new Float64Array(cells);
  const streamOrder = new Uint8Array(cells);
  const oceanMask = new Uint8Array(cells);
  for (let index = 0; index < cells; index++) {
    meter.work();
    receiver[index] = view.getInt32(layout2.receiver + index * 4, true);
    drainageRank[index] = view.getUint32(layout2.drainageRank + index * 4, true);
    filledHeightM[index] = view.getFloat64(layout2.filledHeightM + index * 8, true);
    catchmentAreaM2[index] = view.getFloat64(layout2.catchmentAreaM2 + index * 8, true);
    streamOrder[index] = view.getUint8(layout2.streamOrder + index);
    oceanMask[index] = view.getUint8(layout2.oceanMask + index);
  }
  const precipitationMPerYear = precipitationMmPerYear / 1e3;
  const dischargeM3PerYear = new Float64Array(cells);
  for (let index = 0; index < cells; index++) dischargeM3PerYear[index] = catchmentAreaM2[index] * precipitationMPerYear;
  const field = {
    rows,
    cols,
    cellCount: cells,
    cellSizeM,
    cellAreaM2: cellSizeM * cellSizeM,
    seaLevelM,
    precipitationMmPerYear,
    precipitationMPerYear,
    receiver,
    drainageRank,
    filledHeightM,
    catchmentAreaM2,
    dischargeM3PerYear,
    streamOrder,
    oceanMask
  };
  const invariants = validateChannels(field, meter, false);
  meter.check();
  const validation = meter.snapshot();
  const artifact = Object.freeze({
    artifactType: HYDROLOGY_FIELD_ARTIFACT_TYPE,
    mediaType: HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
    byteLength: bytes.byteLength,
    offsets: layout2,
    invariants,
    validation
  });
  if (!includeTopology) return Object.freeze({ placement, artifact });
  const topology = Object.freeze({
    schema: HYDROLOGY_TOPOLOGY_SCHEMA,
    version: HYDROLOGY_TOPOLOGY_VERSION,
    ...field,
    diagnostics: Object.freeze({
      source: "hydrology-field/v1",
      outletCount: invariants.outletCount,
      oceanCellCount: invariants.oceanCellCount,
      maximumStreamOrder: invariants.maximumStreamOrder,
      totalAreaM2: field.cellAreaM2 * cells,
      totalDischargeM3PerYear: field.cellAreaM2 * cells * precipitationMPerYear,
      validationWorkUnits: validation.workUnits
    })
  });
  return Object.freeze({ placement, topology, artifact });
}
function decodeHydrologyFieldArtifact(bytes, control = void 0) {
  return readArtifact(bytes, control, true);
}

// src/world/water-ir.mjs
var WATERWAY_CLASSES = Object.freeze(["river", "stream"]);
var WATER_BODY_KINDS = Object.freeze(["lake", "pond", "reservoir", "lagoon", "marsh", "swamp", "bog", "estuary"]);
var WATER_LIMITS = Object.freeze({
  bodies: 4096,
  waterways: 4096,
  ringPoints: 512,
  holes: 32,
  depthZones: 64,
  waterwayPoints: 8192,
  bodyPoints: 4096,
  totalBodyPoints: 65536,
  totalWaterwayPoints: 262144,
  // Ten million metres supports continental authoring while keeping determinant error bounded.
  absCoordinateM: 1e7,
  absLevelM: 1e5,
  depthM: 2e4,
  shoreDistanceM: 1e6,
  widthM: 1e5,
  streamOrder: 12,
  // Simple-polygon validation is quadratic. This hard budget bounds hostile aggregate work even
  // when every individual ring remains below its point cap.
  topologyWorkUnits: 2e6
});
var WATERWAY_CLASS_SET = new Set(WATERWAY_CLASSES);
var WATER_BODY_KIND_SET = new Set(WATER_BODY_KINDS);
var WaterIrValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "WaterIrValidationError";
  }
};
function fail2(message) {
  throw new WaterIrValidationError(message);
}
function orientationSign(a, b, c) {
  const x1 = b[0] - a[0], y1 = b[1] - a[1], x2 = c[0] - a[0], y2 = c[1] - a[1];
  const determinant = x1 * y2 - y1 * x2;
  const tolerance = Number.EPSILON * 32 * (Math.abs(x1 * y2) + Math.abs(y1 * x2) + 1);
  return determinant > tolerance ? 1 : determinant < -tolerance ? -1 : 0;
}
function onSegment(a, b, point) {
  if (orientationSign(a, b, point) !== 0) return false;
  const tolerance = Number.EPSILON * 32 * Math.max(1, Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]), Math.abs(point[0]), Math.abs(point[1]));
  return point[0] >= Math.min(a[0], b[0]) - tolerance && point[0] <= Math.max(a[0], b[0]) + tolerance && point[1] >= Math.min(a[1], b[1]) - tolerance && point[1] <= Math.max(a[1], b[1]) + tolerance;
}
function compare(budget) {
  budget.workUnits++;
  if (budget.workUnits > WATER_LIMITS.topologyWorkUnits) fail2(`water topology exceeds ${WATER_LIMITS.topologyWorkUnits} bounded work units`);
}
function segmentsIntersect(a, b, c, d, budget) {
  compare(budget);
  const abC = orientationSign(a, b, c), abD = orientationSign(a, b, d);
  const cdA = orientationSign(c, d, a), cdB = orientationSign(c, d, b);
  if (abC !== 0 && abD !== 0 && cdA !== 0 && cdB !== 0) return abC !== abD && cdA !== cdB;
  return abC === 0 && onSegment(a, b, c) || abD === 0 && onSegment(a, b, d) || cdA === 0 && onSegment(c, d, a) || cdB === 0 && onSegment(c, d, b);
}
function ringAreaSign(ring, budget) {
  const origin = ring[0];
  let twiceArea2 = 0;
  let magnitude = 0;
  for (let index = 1; index < ring.length - 1; index++) {
    compare(budget);
    const point = ring[index], next = ring[index + 1];
    const px = point[0] - origin[0], py = point[1] - origin[1];
    const nx = next[0] - origin[0], ny = next[1] - origin[1];
    const term = px * ny - nx * py;
    twiceArea2 += term;
    magnitude += Math.abs(px * ny) + Math.abs(nx * py);
  }
  const tolerance = Number.EPSILON * 32 * (magnitude + 1);
  return twiceArea2 > tolerance ? 1 : twiceArea2 < -tolerance ? -1 : 0;
}
function validateRing(ring, path, budget) {
  const seen = /* @__PURE__ */ new Set();
  for (let index = 0; index < ring.length; index++) {
    compare(budget);
    const point = ring[index], next = ring[(index + 1) % ring.length];
    const key = `${point[0]}\0${point[1]}`;
    if (seen.has(key) || point[0] === next[0] && point[1] === next[1]) fail2(`${path} must not repeat vertices`);
    seen.add(key);
  }
  if (ringAreaSign(ring, budget) === 0) fail2(`${path} must enclose numerically stable non-zero area`);
  for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) {
    if (j === i + 1 || i === 0 && j === ring.length - 1) continue;
    if (segmentsIntersect(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length], budget)) fail2(`${path} must not self-intersect`);
  }
}
function pointInRing(point, ring, budget) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    compare(budget);
    const a = ring[j], b = ring[i];
    if (onSegment(a, b, point)) return 0;
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? 1 : -1;
}
function ringsIntersect(a, b, budget) {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length], budget)) return true;
  }
  return false;
}
function validateFootprint(footprint, path, budget) {
  validateRing(footprint.points, `${path}.points`, budget);
  const holes = footprint.holes ?? [];
  for (let index = 0; index < holes.length; index++) {
    const hole = holes[index];
    validateRing(hole, `${path}.holes[${index}]`, budget);
    if (pointInRing(hole[0], footprint.points, budget) !== 1 || ringsIntersect(hole, footprint.points, budget)) fail2(`${path}.holes[${index}] must be strictly inside the footprint`);
    for (let previous = 0; previous < index; previous++) {
      if (ringsIntersect(hole, holes[previous], budget) || pointInRing(hole[0], holes[previous], budget) !== -1 || pointInRing(holes[previous][0], hole, budget) !== -1) {
        fail2(`${path}.holes[${index}] must not overlap or contain another hole`);
      }
    }
  }
}
function inspectWaterBodyTopology(bodies) {
  const budget = { workUnits: 0 };
  try {
    for (let index = 0; index < bodies.length; index++) validateFootprint(bodies[index].footprint, `waterBodies[${index}].footprint`, budget);
    return { ok: true, workUnits: budget.workUnits };
  } catch (error) {
    if (!(error instanceof WaterIrValidationError)) throw error;
    return { ok: false, workUnits: budget.workUnits, message: error.message };
  }
}

// src/world/hydrology-water-topology.mjs
var HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA = "limina.hydrology-generated-water/v1";
var HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION = 1;
var CARDINAL_OFFSETS = Object.freeze([[-1, 0], [0, -1], [0, 1], [1, 0]]);
var CASE_SEGMENTS = Object.freeze([
  [],
  [[0, 3]],
  [[0, 1]],
  [[3, 1]],
  [[1, 2]],
  [[0, 3], [1, 2]],
  [[0, 2]],
  [[3, 2]],
  [[3, 2]],
  [[0, 2]],
  [[0, 1], [3, 2]],
  [[1, 2]],
  [[3, 1]],
  [[0, 1]],
  [[0, 3]],
  []
]);

// src/world/hydrology-water-artifact.mjs
var HYDROLOGY_WATER_ARTIFACT_TYPE = "hydrology-water-topology/v1";
var HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.hydrology-water-topology";
var HYDROLOGY_WATER_ARTIFACT_VERSION = 1;
var HYDROLOGY_WATER_ARTIFACT_HEADER_BYTES = 256;
var MAGIC4 = new Uint8Array([76, 72, 89, 87, 65, 84, 49, 0]);
var ROOT_KEYS = /* @__PURE__ */ new Set(["schema", "version", "placement", "rows", "cols", "cellSizeM", "basins", "reaches", "diagnostics"]);
var PLACEMENT_KEYS = /* @__PURE__ */ new Set(["originX", "originZ"]);
var BASIN_KEYS = /* @__PURE__ */ new Set([
  "id",
  "kind",
  "spillLevelM",
  "maxDepthM",
  "areaM2",
  "cellCount",
  "seedCell",
  "spillInsideCell",
  "spillOutsideCell",
  "spillOutsideDrainageRank",
  "footprint"
]);
var FOOTPRINT_KEYS = /* @__PURE__ */ new Set(["points", "holes"]);
var REACH_KEYS = /* @__PURE__ */ new Set([
  "id",
  "class",
  "order",
  "startCell",
  "endCell",
  "points",
  "widths",
  "terrainElevationsM",
  "surfaceElevationsM",
  "waterfalls"
]);
var WATERFALL_KEYS = /* @__PURE__ */ new Set(["startSegment", "endSegmentExclusive", "startCell", "endCell", "totalDropM", "maxEdgeDropM"]);
var BINDING_KEYS = Object.freeze(["hydrologyFieldContentHash", "recipeHash", "erosionStageKey", "compilerGraphHash"]);
var BINDING_KEY_SET = new Set(BINDING_KEYS);
var CONTROL_KEYS2 = /* @__PURE__ */ new Set(["shouldCancel"]);
var HASH_RE = /^sha256:[0-9a-f]{64}$/;
var BASIN_RECORD_BYTES = 64;
var RING_RECORD_BYTES = 16;
var BASIN_POINT_BYTES = 16;
var REACH_RECORD_BYTES = 32;
var REACH_POINT_BYTES = 48;
var WATERFALL_RECORD_BYTES = 40;
var MAX_RING_COUNT = Math.min(WATER_LIMITS.bodies * (WATER_LIMITS.holes + 1), Math.floor(WATER_LIMITS.totalBodyPoints / 3));
var MAX_ORIGIN_M2 = WATER_LIMITS.absCoordinateM;
var align8 = (value) => Math.ceil(value / 8) * 8;
function layoutForCounts(basins, rings, basinPoints, reaches, reachPoints, waterfalls) {
  const basinRecords = HYDROLOGY_WATER_ARTIFACT_HEADER_BYTES;
  const ringRecords = align8(basinRecords + basins * BASIN_RECORD_BYTES);
  const basinPointRecords = align8(ringRecords + rings * RING_RECORD_BYTES);
  const reachRecords = align8(basinPointRecords + basinPoints * BASIN_POINT_BYTES);
  const reachPointRecords = align8(reachRecords + reaches * REACH_RECORD_BYTES);
  const waterfallRecords = align8(reachPointRecords + reachPoints * REACH_POINT_BYTES);
  const dataEnd = waterfallRecords + waterfalls * WATERFALL_RECORD_BYTES;
  return Object.freeze({
    basinRecords,
    ringRecords,
    basinPointRecords,
    reachRecords,
    reachPointRecords,
    waterfallRecords,
    dataEnd,
    byteLength: align8(dataEnd)
  });
}
var MAX_HYDROLOGY_WATER_ARTIFACT_BYTES = layoutForCounts(
  WATER_LIMITS.bodies,
  MAX_RING_COUNT,
  WATER_LIMITS.totalBodyPoints,
  WATER_LIMITS.waterways,
  WATER_LIMITS.totalWaterwayPoints,
  WATER_LIMITS.totalWaterwayPoints
).byteLength;
if (MAX_HYDROLOGY_WATER_ARTIFACT_BYTES > 256 * 1024 * 1024) {
  throw new Error("hydrology water artifact maximum exceeds the compiler artifact cap");
}
var HydrologyWaterArtifactValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "HydrologyWaterArtifactValidationError";
    this.code = "hydrology_water_artifact_invalid";
  }
};
var HydrologyWaterArtifactCancelledError = class extends Error {
  constructor() {
    super("hydrology water artifact operation cancelled");
    this.name = "HydrologyWaterArtifactCancelledError";
    this.code = "hydrology_water_artifact_cancelled";
  }
};
function fail3(message) {
  throw new HydrologyWaterArtifactValidationError(message);
}
function claim(seen, value, label) {
  if (seen.has(value)) fail3(`${label} must not alias another object or array`);
  seen.add(value);
}
function exactRecord2(value, keys, label, seen, optional = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail3(`${label} must be a plain object`);
  }
  claim(seen, value, label);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail3(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor2] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail3(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor2) || descriptor2.enumerable !== true) fail3(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!optional.has(key) && !Object.hasOwn(value, key)) fail3(`${label} is missing '${key}'`);
  return descriptors;
}
function denseArray(value, minimum, maximum, label, seen) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum) {
    fail3(`${label} must contain ${minimum}..${maximum} entries`);
  }
  claim(seen, value, label);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail3(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) fail3(`${label} has a non-index field '${key}'`);
  }
  const values = new Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const descriptor2 = descriptors[String(index)];
    if (!descriptor2 || !("value" in descriptor2) || descriptor2.enumerable !== true) fail3(`${label} must be dense enumerable data`);
    values[index] = descriptor2.value;
  }
  return values;
}
function canonicalNumber2(value, label, minimum, maximum, positive2 = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || (positive2 ? value <= minimum : value < minimum) || value > maximum) {
    fail3(`${label} must be a finite canonical number in ${positive2 ? "(" : "["}${minimum}, ${maximum}]`);
  }
  return value;
}
function integer2(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail3(`${label} must be an integer in [${minimum}, ${maximum}]`);
  return value;
}
function parseControl2(value) {
  if (value === void 0) return void 0;
  const seen = /* @__PURE__ */ new Set();
  const descriptors = exactRecord2(value, CONTROL_KEYS2, "hydrology water artifact control", seen);
  if (typeof descriptors.shouldCancel.value !== "function") fail3("hydrology water artifact control.shouldCancel must be a function");
  return descriptors.shouldCancel.value;
}
function createMeter2(shouldCancel, maximum) {
  let workUnits = 0, cancellationChecks = 0;
  const check = () => {
    cancellationChecks++;
    if (shouldCancel?.()) throw new HydrologyWaterArtifactCancelledError();
  };
  const work = () => {
    workUnits++;
    if (workUnits > maximum) fail3(`hydrology water artifact exceeds ${maximum} bounded work units`);
    if ((workUnits & 1023) === 0) check();
  };
  return { work, check, snapshot: () => Object.freeze({ workUnits, workLimit: maximum, cancellationChecks }) };
}
function parseBindings(value, label = "hydrology water artifact bindings") {
  const seen = /* @__PURE__ */ new Set();
  const descriptors = exactRecord2(value, BINDING_KEY_SET, label, seen);
  const parsed = {};
  for (const key of BINDING_KEYS) {
    const hash2 = descriptors[key].value;
    if (typeof hash2 !== "string" || !HASH_RE.test(hash2)) fail3(`${label}.${key} must be a lowercase sha256 content hash`);
    parsed[key] = hash2;
  }
  return Object.freeze(parsed);
}
function parsePlacement(value, seen) {
  const descriptors = exactRecord2(value, PLACEMENT_KEYS, "hydrology water topology placement", seen);
  return Object.freeze({
    originX: canonicalNumber2(descriptors.originX.value, "hydrology water topology placement.originX", -MAX_ORIGIN_M2, MAX_ORIGIN_M2),
    originZ: canonicalNumber2(descriptors.originZ.value, "hydrology water topology placement.originZ", -MAX_ORIGIN_M2, MAX_ORIGIN_M2)
  });
}
function parsePoint(value, label, seen) {
  const point = denseArray(value, 2, 2, label, seen);
  return Object.freeze([
    canonicalNumber2(point[0], `${label}[0]`, -WATER_LIMITS.absCoordinateM, WATER_LIMITS.absCoordinateM),
    canonicalNumber2(point[1], `${label}[1]`, -WATER_LIMITS.absCoordinateM, WATER_LIMITS.absCoordinateM)
  ]);
}
function twiceArea(ring) {
  const origin = ring[0];
  let area = 0;
  for (let index = 1; index < ring.length - 1; index++) {
    area += (ring[index][0] - origin[0]) * (ring[index + 1][1] - origin[1]) - (ring[index + 1][0] - origin[0]) * (ring[index][1] - origin[1]);
  }
  return area;
}
function comparePoint(left, right) {
  return left[0] - right[0] || left[1] - right[1];
}
function parseRing(value, label, seen) {
  const source = denseArray(value, 3, WATER_LIMITS.ringPoints, label, seen);
  const ring = Object.freeze(source.map((point, index) => parsePoint(point, `${label}[${index}]`, seen)));
  for (let index = 1; index < ring.length; index++) if (comparePoint(ring[index], ring[0]) < 0) fail3(`${label} must start at its lexicographically smallest point`);
  return ring;
}
function cellForPoint(point, placement, cellSizeM, rows, cols, label) {
  const col = Math.round((point[0] - placement.originX) / cellSizeM);
  const row = Math.round((point[1] - placement.originZ) / cellSizeM);
  if (row < 0 || row >= rows || col < 0 || col >= cols || placement.originX + col * cellSizeM !== point[0] || placement.originZ + row * cellSizeM !== point[1]) {
    fail3(`${label} must be an exact hydrology cell center`);
  }
  return row * cols + col;
}
function validateDiagnostics(value, seen, budget = { properties: 0 }, label = "hydrology water topology diagnostics") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail3(`${label} numbers must be finite and canonical`);
    return;
  }
  if (value === null || typeof value !== "object") fail3(`${label} must contain only plain data`);
  if (Array.isArray(value)) {
    const values = denseArray(value, 0, 4096, label, seen);
    budget.properties += values.length;
    if (budget.properties > 4096) fail3("hydrology water topology diagnostics exceed 4096 bounded properties");
    for (let index = 0; index < values.length; index++) validateDiagnostics(values[index], seen, budget, `${label}[${index}]`);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) fail3(`${label} must be a plain object`);
  claim(seen, value, label);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail3(`${label} must not contain symbols`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  budget.properties += Object.keys(descriptors).length;
  if (budget.properties > 4096) fail3("hydrology water topology diagnostics exceed 4096 bounded properties");
  for (const [key, descriptor2] of Object.entries(descriptors)) {
    if (!("value" in descriptor2) || descriptor2.enumerable !== true) fail3(`${label}.${key} must be an enumerable data field`);
    validateDiagnostics(descriptor2.value, seen, budget, `${label}.${key}`);
  }
}
function parseTopology(value) {
  const seen = /* @__PURE__ */ new Set();
  const descriptors = exactRecord2(value, ROOT_KEYS, "hydrology water topology", seen);
  if (descriptors.schema.value !== HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA || descriptors.version.value !== HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION) fail3("hydrology water topology schema/version is unsupported");
  const rows = integer2(descriptors.rows.value, 2, MAX_HYDROLOGY_DIMENSION, "hydrology water topology rows");
  const cols = integer2(descriptors.cols.value, 2, MAX_HYDROLOGY_DIMENSION, "hydrology water topology cols");
  const cells = rows * cols;
  if (cells > MAX_HYDROLOGY_CELLS) fail3("hydrology water topology grid exceeds supported cells");
  const cellSizeM = canonicalNumber2(descriptors.cellSizeM.value, "hydrology water topology cellSizeM", 0, 1e6, true);
  const placement = parsePlacement(descriptors.placement.value, seen);
  validateDiagnostics(descriptors.diagnostics.value, seen);
  const basinSource = denseArray(descriptors.basins.value, 0, WATER_LIMITS.bodies, "hydrology water topology basins", seen);
  const basinIds = /* @__PURE__ */ new Set();
  let totalBasinPoints = 0, totalRings = 0, priorBasinId = "";
  const basins = basinSource.map((candidate, basinIndex) => {
    const path = `hydrology water topology basins[${basinIndex}]`;
    const record4 = exactRecord2(candidate, BASIN_KEYS, path, seen);
    const seedCell = integer2(record4.seedCell.value, 0, cells - 1, `${path}.seedCell`);
    const spillOutsideCell = integer2(record4.spillOutsideCell.value, 0, cells - 1, `${path}.spillOutsideCell`);
    const id = `gen-b-${spillOutsideCell.toString(36)}-${seedCell.toString(36)}`;
    if (record4.id.value !== id) fail3(`${path}.id must equal '${id}'`);
    if (basinIds.has(id)) fail3(`hydrology water topology has duplicate basin id '${id}'`);
    if (basinIndex > 0 && id <= priorBasinId) fail3("hydrology water topology basins must be strictly ordered by id");
    priorBasinId = id;
    basinIds.add(id);
    if (record4.kind.value !== "lake") fail3(`${path}.kind must be 'lake'`);
    const footprintRecord = exactRecord2(record4.footprint.value, FOOTPRINT_KEYS, `${path}.footprint`, seen, /* @__PURE__ */ new Set(["holes"]));
    const points = parseRing(footprintRecord.points.value, `${path}.footprint.points`, seen);
    const holes = footprintRecord.holes === void 0 ? [] : denseArray(footprintRecord.holes.value, 0, WATER_LIMITS.holes, `${path}.footprint.holes`, seen).map((ring, index) => parseRing(ring, `${path}.footprint.holes[${index}]`, seen));
    if (!(twiceArea(points) > 0)) fail3(`${path}.footprint.points must be counter-clockwise`);
    for (const hole of holes) if (!(twiceArea(hole) < 0)) fail3(`${path}.footprint holes must be clockwise`);
    for (let index = 1; index < holes.length; index++) if (comparePoint(holes[index - 1][0], holes[index][0]) >= 0) fail3(`${path}.footprint holes must be strictly ordered`);
    const pointCount = points.length + holes.reduce((sum, hole) => sum + hole.length, 0);
    if (pointCount > WATER_LIMITS.bodyPoints) fail3(`${path}.footprint exceeds ${WATER_LIMITS.bodyPoints} points`);
    totalBasinPoints += pointCount;
    totalRings += 1 + holes.length;
    if (totalBasinPoints > WATER_LIMITS.totalBodyPoints || totalRings > MAX_RING_COUNT) fail3("hydrology water topology basin geometry exceeds aggregate limits");
    return Object.freeze({
      id,
      kind: "lake",
      spillLevelM: canonicalNumber2(record4.spillLevelM.value, `${path}.spillLevelM`, -WATER_LIMITS.absLevelM, WATER_LIMITS.absLevelM),
      maxDepthM: canonicalNumber2(record4.maxDepthM.value, `${path}.maxDepthM`, 0, WATER_LIMITS.depthM, true),
      areaM2: canonicalNumber2(record4.areaM2.value, `${path}.areaM2`, 0, 1e12, true),
      cellCount: integer2(record4.cellCount.value, 1, cells, `${path}.cellCount`),
      seedCell,
      spillInsideCell: integer2(record4.spillInsideCell.value, 0, cells - 1, `${path}.spillInsideCell`),
      spillOutsideCell,
      spillOutsideDrainageRank: integer2(record4.spillOutsideDrainageRank.value, 0, cells - 1, `${path}.spillOutsideDrainageRank`),
      footprint: Object.freeze({ points, ...holes.length > 0 ? { holes: Object.freeze(holes) } : {} })
    });
  });
  const basinTopology = inspectWaterBodyTopology(basins.map((basin) => ({ footprint: basin.footprint })));
  if (!basinTopology.ok) fail3(basinTopology.message);
  const reachSource = denseArray(descriptors.reaches.value, 0, WATER_LIMITS.waterways, "hydrology water topology reaches", seen);
  const reachIds = /* @__PURE__ */ new Set();
  let totalReachPoints = 0, totalWaterfalls = 0, priorReachStart = -1;
  const reaches = reachSource.map((candidate, reachIndex) => {
    const path = `hydrology water topology reaches[${reachIndex}]`;
    const record4 = exactRecord2(candidate, REACH_KEYS, path, seen);
    const startCell = integer2(record4.startCell.value, 0, cells - 1, `${path}.startCell`);
    const endCell = integer2(record4.endCell.value, 0, cells - 1, `${path}.endCell`);
    const id = `gen-r-${startCell.toString(36)}-${endCell.toString(36)}`;
    if (record4.id.value !== id) fail3(`${path}.id must equal '${id}'`);
    if (reachIds.has(id)) fail3(`hydrology water topology has duplicate reach id '${id}'`);
    if (startCell <= priorReachStart) fail3("hydrology water topology reaches must be strictly ordered by startCell");
    priorReachStart = startCell;
    reachIds.add(id);
    const order = integer2(record4.order.value, 1, WATER_LIMITS.streamOrder, `${path}.order`);
    const className = order <= 2 ? "stream" : "river";
    if (record4.class.value !== className) fail3(`${path}.class is inconsistent with order`);
    const points = Object.freeze(denseArray(record4.points.value, 2, WATER_LIMITS.waterwayPoints, `${path}.points`, seen).map((point, index) => parsePoint(point, `${path}.points[${index}]`, seen)));
    const widthsSource = denseArray(record4.widths.value, points.length, points.length, `${path}.widths`, seen);
    const terrainSource = denseArray(record4.terrainElevationsM.value, points.length, points.length, `${path}.terrainElevationsM`, seen);
    const surfaceSource = denseArray(record4.surfaceElevationsM.value, points.length, points.length, `${path}.surfaceElevationsM`, seen);
    const widths = Object.freeze(widthsSource.map((entry, index) => canonicalNumber2(entry, `${path}.widths[${index}]`, 0, WATER_LIMITS.widthM, true)));
    const terrainElevationsM = Object.freeze(terrainSource.map((entry, index) => canonicalNumber2(entry, `${path}.terrainElevationsM[${index}]`, -MAX_HYDROLOGY_ABS_HEIGHT_M, MAX_HYDROLOGY_ABS_HEIGHT_M)));
    const surfaceElevationsM = Object.freeze(surfaceSource.map((entry, index) => canonicalNumber2(entry, `${path}.surfaceElevationsM[${index}]`, -MAX_HYDROLOGY_ABS_HEIGHT_M, MAX_HYDROLOGY_ABS_HEIGHT_M)));
    for (let index = 0; index < points.length; index++) {
      if (surfaceElevationsM[index] < terrainElevationsM[index]) fail3(`${path}.surfaceElevationsM[${index}] must not be below terrain`);
    }
    const cellIndexes = points.map((point, index) => cellForPoint(point, placement, cellSizeM, rows, cols, `${path}.points[${index}]`));
    if (cellIndexes[0] !== startCell || cellIndexes[cellIndexes.length - 1] !== endCell) fail3(`${path} endpoints do not match point cells`);
    for (let index = 1; index < cellIndexes.length; index++) {
      const priorRow = Math.floor(cellIndexes[index - 1] / cols), priorCol = cellIndexes[index - 1] - priorRow * cols;
      const row = Math.floor(cellIndexes[index] / cols), col = cellIndexes[index] - row * cols;
      if (Math.abs(row - priorRow) > 1 || Math.abs(col - priorCol) > 1 || row === priorRow && col === priorCol) fail3(`${path} contains a non-D8 point edge`);
      if (surfaceElevationsM[index] > surfaceElevationsM[index - 1]) fail3(`${path}.surfaceElevationsM rises downstream`);
    }
    totalReachPoints += points.length;
    if (totalReachPoints > WATER_LIMITS.totalWaterwayPoints) fail3("hydrology water topology reach points exceed aggregate limits");
    const waterfallSource = denseArray(record4.waterfalls.value, 0, points.length - 1, `${path}.waterfalls`, seen);
    let priorEnd = 0;
    const waterfalls = waterfallSource.map((candidateSpan, waterfallIndex) => {
      const spanPath = `${path}.waterfalls[${waterfallIndex}]`;
      const span = exactRecord2(candidateSpan, WATERFALL_KEYS, spanPath, seen);
      const startSegment = integer2(span.startSegment.value, 0, points.length - 2, `${spanPath}.startSegment`);
      const endSegmentExclusive = integer2(span.endSegmentExclusive.value, startSegment + 1, points.length - 1, `${spanPath}.endSegmentExclusive`);
      if (startSegment < priorEnd) fail3(`${path}.waterfalls must be ordered and non-overlapping`);
      priorEnd = endSegmentExclusive;
      let totalDropM = 0, maxEdgeDropM = 0;
      for (let segment = startSegment; segment < endSegmentExclusive; segment++) {
        const drop = terrainElevationsM[segment] - terrainElevationsM[segment + 1];
        if (!(drop > 0)) fail3(`${spanPath} contains a non-dropping terrain edge`);
        totalDropM += drop;
        if (drop > maxEdgeDropM) maxEdgeDropM = drop;
      }
      if (span.startCell.value !== cellIndexes[startSegment] || span.endCell.value !== cellIndexes[endSegmentExclusive]) fail3(`${spanPath} cell endpoints do not match segments`);
      if (!Object.is(span.totalDropM.value, totalDropM) || !Object.is(span.maxEdgeDropM.value, maxEdgeDropM)) fail3(`${spanPath} drop metrics do not match terrain elevations`);
      return Object.freeze({ startSegment, endSegmentExclusive, startCell: cellIndexes[startSegment], endCell: cellIndexes[endSegmentExclusive], totalDropM, maxEdgeDropM });
    });
    totalWaterfalls += waterfalls.length;
    if (totalWaterfalls > WATER_LIMITS.totalWaterwayPoints) fail3("hydrology water topology waterfall metadata exceeds aggregate limits");
    return Object.freeze({
      id,
      class: className,
      order,
      startCell,
      endCell,
      points,
      widths,
      terrainElevationsM,
      surfaceElevationsM,
      waterfalls: Object.freeze(waterfalls),
      cellIndexes: Object.freeze(cellIndexes)
    });
  });
  return {
    topology: Object.freeze({
      schema: HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
      version: HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION,
      placement,
      rows,
      cols,
      cellSizeM,
      basins: Object.freeze(basins),
      reaches: Object.freeze(reaches.map(({ cellIndexes: _cells, ...reach }) => Object.freeze(reach))),
      diagnostics: Object.freeze({
        source: HYDROLOGY_WATER_ARTIFACT_TYPE,
        basinCount: basins.length,
        reachCount: reaches.length,
        basinPointCount: totalBasinPoints,
        reachPointCount: totalReachPoints,
        waterfallCount: totalWaterfalls,
        topologyWorkUnits: basinTopology.workUnits
      })
    }),
    internalReaches: reaches,
    counts: Object.freeze({
      basins: basins.length,
      rings: totalRings,
      basinPoints: totalBasinPoints,
      reaches: reaches.length,
      reachPoints: totalReachPoints,
      waterfalls: totalWaterfalls
    })
  };
}
function bytesToHex(bytes, offset) {
  let hex = "";
  for (let index = 0; index < 32; index++) hex += bytes[offset + index].toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}
function ownedByteView(value) {
  if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype) fail3("hydrology water artifact bytes must be a Uint8Array");
  if (!(value.buffer instanceof ArrayBuffer) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    fail3("hydrology water artifact bytes must own its complete non-shared ArrayBuffer");
  }
  if (value.byteLength < HYDROLOGY_WATER_ARTIFACT_HEADER_BYTES || value.byteLength > MAX_HYDROLOGY_WATER_ARTIFACT_BYTES) {
    fail3("hydrology water artifact byte length is outside supported bounds");
  }
  return value;
}
function verifyZero(bytes, start, end, label) {
  for (let index = start; index < end; index++) if (bytes[index] !== 0) fail3(`${label} must be zero`);
}
function inspectHeader(bytes) {
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC4.length; index++) if (view.getUint8(index) !== MAGIC4[index]) fail3("hydrology water artifact magic mismatch");
  if (view.getUint16(8, true) !== HYDROLOGY_WATER_ARTIFACT_VERSION) fail3("hydrology water artifact version is unsupported");
  if (view.getUint16(10, true) !== 0) fail3("hydrology water artifact flags must be zero");
  if (view.getUint16(12, true) !== HYDROLOGY_WATER_ARTIFACT_HEADER_BYTES) fail3("hydrology water artifact header length mismatch");
  if (view.getUint16(14, true) !== 0 || view.getUint32(52, true) !== 0 || view.getUint32(108, true) !== 0) fail3("hydrology water artifact reserved header fields must be zero");
  verifyZero(bytes, 240, 256, "hydrology water artifact reserved header bytes");
  const rows = integer2(view.getUint32(20, true), 2, MAX_HYDROLOGY_DIMENSION, "hydrology water artifact rows");
  const cols = integer2(view.getUint32(24, true), 2, MAX_HYDROLOGY_DIMENSION, "hydrology water artifact cols");
  const cells = rows * cols;
  if (cells > MAX_HYDROLOGY_CELLS) fail3("hydrology water artifact grid exceeds supported cells");
  const counts = Object.freeze({
    basins: integer2(view.getUint32(28, true), 0, WATER_LIMITS.bodies, "hydrology water artifact basin count"),
    rings: integer2(view.getUint32(32, true), 0, MAX_RING_COUNT, "hydrology water artifact ring count"),
    basinPoints: integer2(view.getUint32(36, true), 0, WATER_LIMITS.totalBodyPoints, "hydrology water artifact basin point count"),
    reaches: integer2(view.getUint32(40, true), 0, WATER_LIMITS.waterways, "hydrology water artifact reach count"),
    reachPoints: integer2(view.getUint32(44, true), 0, WATER_LIMITS.totalWaterwayPoints, "hydrology water artifact reach point count"),
    waterfalls: integer2(view.getUint32(48, true), 0, WATER_LIMITS.totalWaterwayPoints, "hydrology water artifact waterfall count")
  });
  if (counts.basins === 0 !== (counts.rings === 0 && counts.basinPoints === 0)) fail3("hydrology water artifact basin section counts are inconsistent");
  if (counts.reaches === 0 !== (counts.reachPoints === 0 && counts.waterfalls === 0)) fail3("hydrology water artifact reach section counts are inconsistent");
  if (counts.rings < counts.basins || counts.basinPoints < counts.rings * 3 || counts.reachPoints < counts.reaches * 2) fail3("hydrology water artifact section counts are structurally impossible");
  const layout2 = layoutForCounts(counts.basins, counts.rings, counts.basinPoints, counts.reaches, counts.reachPoints, counts.waterfalls);
  if (view.getUint32(16, true) !== bytes.byteLength || bytes.byteLength !== layout2.byteLength) fail3("hydrology water artifact byte length is non-canonical");
  for (const [offset, expected, label] of [
    [80, layout2.basinRecords, "basin"],
    [84, layout2.ringRecords, "ring"],
    [88, layout2.basinPointRecords, "basin point"],
    [92, layout2.reachRecords, "reach"],
    [96, layout2.reachPointRecords, "reach point"],
    [100, layout2.waterfallRecords, "waterfall"],
    [104, layout2.dataEnd, "data end"]
  ]) {
    if (view.getUint32(offset, true) !== expected) fail3(`hydrology water artifact ${label} offset is non-canonical`);
  }
  verifyZero(bytes, layout2.dataEnd, layout2.byteLength, "hydrology water artifact trailing padding");
  const bindings = {};
  for (let binding = 0; binding < BINDING_KEYS.length; binding++) bindings[BINDING_KEYS[binding]] = bytesToHex(bytes, 112 + binding * 32);
  return Object.freeze({
    view,
    rows,
    cols,
    counts,
    layout: layout2,
    bindings: Object.freeze(bindings),
    placement: Object.freeze({
      originX: canonicalNumber2(view.getFloat64(56, true), "hydrology water artifact originX", -MAX_ORIGIN_M2, MAX_ORIGIN_M2),
      originZ: canonicalNumber2(view.getFloat64(64, true), "hydrology water artifact originZ", -MAX_ORIGIN_M2, MAX_ORIGIN_M2)
    }),
    cellSizeM: canonicalNumber2(view.getFloat64(72, true), "hydrology water artifact cellSizeM", 0, 1e6, true)
  });
}
function inspectHydrologyWaterArtifactBindings(bytesInput2) {
  return inspectHeader(ownedByteView(bytesInput2)).bindings;
}
function decodeHydrologyWaterArtifact(bytesInput2, expectedBindingsInput = void 0, controlInput = void 0) {
  const bytes = Uint8Array.from(ownedByteView(bytesInput2));
  const expectedBindings = expectedBindingsInput === void 0 ? void 0 : parseBindings(expectedBindingsInput, "expected hydrology water artifact bindings");
  const shouldCancel = parseControl2(controlInput);
  const meter = createMeter2(shouldCancel, bytes.byteLength + 8192);
  meter.check();
  const header = inspectHeader(bytes);
  const { view, rows, cols, counts, layout: layout2, bindings: frozenBindings, placement, cellSizeM } = header;
  if (expectedBindings !== void 0) for (const key of BINDING_KEYS) {
    if (expectedBindings[key] !== frozenBindings[key]) fail3(`hydrology water artifact binding '${key}' does not match expected value`);
  }
  const allBasinPoints = new Array(counts.basinPoints);
  for (let index = 0; index < counts.basinPoints; index++) {
    meter.work();
    const offset = layout2.basinPointRecords + index * BASIN_POINT_BYTES;
    allBasinPoints[index] = Object.freeze([
      canonicalNumber2(view.getFloat64(offset, true), `hydrology water artifact basin point ${index}.x`, -WATER_LIMITS.absCoordinateM, WATER_LIMITS.absCoordinateM),
      canonicalNumber2(view.getFloat64(offset + 8, true), `hydrology water artifact basin point ${index}.z`, -WATER_LIMITS.absCoordinateM, WATER_LIMITS.absCoordinateM)
    ]);
  }
  const ringRecords = new Array(counts.rings);
  let expectedBasinPoint = 0;
  for (let index = 0; index < counts.rings; index++) {
    meter.work();
    const offset = layout2.ringRecords + index * RING_RECORD_BYTES;
    verifyZero(bytes, offset + 5, offset + 8, `hydrology water artifact ring ${index} reserved bytes`);
    const pointStart = view.getUint32(offset + 8, true), pointCount = view.getUint32(offset + 12, true);
    if (pointStart !== expectedBasinPoint || pointCount < 3 || pointCount > WATER_LIMITS.ringPoints || pointStart + pointCount > counts.basinPoints) fail3(`hydrology water artifact ring ${index} point range is non-canonical`);
    expectedBasinPoint += pointCount;
    ringRecords[index] = { basinIndex: view.getUint32(offset, true), role: view.getUint8(offset + 4), pointStart, pointCount };
  }
  if (expectedBasinPoint !== counts.basinPoints) fail3("hydrology water artifact basin points are not completely referenced");
  const basins = new Array(counts.basins);
  let expectedRing = 0;
  for (let index = 0; index < counts.basins; index++) {
    meter.work();
    const offset = layout2.basinRecords + index * BASIN_RECORD_BYTES;
    verifyZero(bytes, offset + 28, offset + 32, `hydrology water artifact basin ${index} reserved bytes`);
    verifyZero(bytes, offset + 60, offset + 64, `hydrology water artifact basin ${index} trailing reserved bytes`);
    const ringStart = view.getUint32(offset + 16, true), ringCount = view.getUint32(offset + 20, true);
    if (ringStart !== expectedRing || ringCount < 1 || ringCount > WATER_LIMITS.holes + 1 || ringStart + ringCount > counts.rings) fail3(`hydrology water artifact basin ${index} ring range is non-canonical`);
    expectedRing += ringCount;
    let pointCount = 0;
    const rings = [];
    for (let ring = ringStart; ring < ringStart + ringCount; ring++) {
      const record4 = ringRecords[ring];
      if (record4.basinIndex !== index || record4.role !== (ring === ringStart ? 0 : 1)) fail3(`hydrology water artifact basin ${index} ring ownership/role is inconsistent`);
      rings.push(Object.freeze(allBasinPoints.slice(record4.pointStart, record4.pointStart + record4.pointCount)));
      pointCount += record4.pointCount;
    }
    if (view.getUint32(offset + 24, true) !== pointCount) fail3(`hydrology water artifact basin ${index} point count is inconsistent`);
    const seedCell = view.getUint32(offset, true), spillOutsideCell = view.getUint32(offset + 8, true);
    basins[index] = Object.freeze({
      id: `gen-b-${spillOutsideCell.toString(36)}-${seedCell.toString(36)}`,
      kind: "lake",
      spillLevelM: view.getFloat64(offset + 32, true),
      maxDepthM: view.getFloat64(offset + 40, true),
      areaM2: view.getFloat64(offset + 48, true),
      cellCount: view.getUint32(offset + 56, true),
      seedCell,
      spillInsideCell: view.getUint32(offset + 4, true),
      spillOutsideCell,
      spillOutsideDrainageRank: view.getUint32(offset + 12, true),
      footprint: Object.freeze({ points: rings[0], holes: Object.freeze(rings.slice(1)) })
    });
  }
  if (expectedRing !== counts.rings) fail3("hydrology water artifact rings are not completely referenced");
  const allReachPoints = new Array(counts.reachPoints);
  const allReachCells = new Uint32Array(counts.reachPoints);
  for (let index = 0; index < counts.reachPoints; index++) {
    meter.work();
    const offset = layout2.reachPointRecords + index * REACH_POINT_BYTES;
    verifyZero(bytes, offset + 4, offset + 8, `hydrology water artifact reach point ${index} reserved bytes`);
    allReachCells[index] = view.getUint32(offset, true);
    allReachPoints[index] = {
      point: Object.freeze([view.getFloat64(offset + 8, true), view.getFloat64(offset + 16, true)]),
      width: view.getFloat64(offset + 24, true),
      terrain: view.getFloat64(offset + 32, true),
      surface: view.getFloat64(offset + 40, true)
    };
  }
  const waterfallRecords = new Array(counts.waterfalls);
  for (let index = 0; index < counts.waterfalls; index++) {
    meter.work();
    const offset = layout2.waterfallRecords + index * WATERFALL_RECORD_BYTES;
    verifyZero(bytes, offset + 20, offset + 24, `hydrology water artifact waterfall ${index} reserved bytes`);
    waterfallRecords[index] = {
      reachIndex: view.getUint32(offset, true),
      startSegment: view.getUint32(offset + 4, true),
      endSegmentExclusive: view.getUint32(offset + 8, true),
      startCell: view.getUint32(offset + 12, true),
      endCell: view.getUint32(offset + 16, true),
      totalDropM: view.getFloat64(offset + 24, true),
      maxEdgeDropM: view.getFloat64(offset + 32, true)
    };
  }
  const reaches = new Array(counts.reaches);
  let expectedReachPoint = 0, expectedWaterfall = 0;
  for (let index = 0; index < counts.reaches; index++) {
    meter.work();
    const offset = layout2.reachRecords + index * REACH_RECORD_BYTES;
    verifyZero(bytes, offset + 26, offset + 32, `hydrology water artifact reach ${index} reserved bytes`);
    const pointStart = view.getUint32(offset + 8, true), pointCount = view.getUint32(offset + 12, true);
    const waterfallStart = view.getUint32(offset + 16, true), waterfallCount = view.getUint32(offset + 20, true);
    if (pointStart !== expectedReachPoint || pointCount < 2 || pointCount > WATER_LIMITS.waterwayPoints || pointStart + pointCount > counts.reachPoints) fail3(`hydrology water artifact reach ${index} point range is non-canonical`);
    if (waterfallStart !== expectedWaterfall || waterfallStart + waterfallCount > counts.waterfalls) fail3(`hydrology water artifact reach ${index} waterfall range is non-canonical`);
    expectedReachPoint += pointCount;
    expectedWaterfall += waterfallCount;
    const source = allReachPoints.slice(pointStart, pointStart + pointCount);
    const startCell = view.getUint32(offset, true), endCell = view.getUint32(offset + 4, true), order = view.getUint8(offset + 24), classCode = view.getUint8(offset + 25);
    if (classCode > 1) fail3(`hydrology water artifact reach ${index} class code is invalid`);
    for (let point = 0; point < source.length; point++) {
      const expectedCell = cellForPoint(source[point].point, placement, cellSizeM, rows, cols, `hydrology water artifact reach ${index} point ${point}`);
      if (allReachCells[pointStart + point] !== expectedCell) fail3(`hydrology water artifact reach ${index} point ${point} cell index is inconsistent`);
    }
    const spans = waterfallRecords.slice(waterfallStart, waterfallStart + waterfallCount);
    for (const span of spans) if (span.reachIndex !== index) fail3(`hydrology water artifact waterfall ownership is inconsistent at reach ${index}`);
    reaches[index] = Object.freeze({
      id: `gen-r-${startCell.toString(36)}-${endCell.toString(36)}`,
      class: classCode === 1 ? "river" : "stream",
      order,
      startCell,
      endCell,
      points: Object.freeze(source.map((entry) => entry.point)),
      widths: Object.freeze(source.map((entry) => entry.width)),
      terrainElevationsM: Object.freeze(source.map((entry) => entry.terrain)),
      surfaceElevationsM: Object.freeze(source.map((entry) => entry.surface)),
      waterfalls: Object.freeze(spans.map(({ reachIndex: _reach, ...span }) => Object.freeze(span)))
    });
  }
  if (expectedReachPoint !== counts.reachPoints || expectedWaterfall !== counts.waterfalls) fail3("hydrology water artifact reach sections are not completely referenced");
  const candidate = {
    schema: HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
    version: HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION,
    placement,
    rows,
    cols,
    cellSizeM,
    basins,
    reaches,
    diagnostics: { source: HYDROLOGY_WATER_ARTIFACT_TYPE }
  };
  const parsed = parseTopology(candidate);
  meter.check();
  return Object.freeze({
    bindings: frozenBindings,
    topology: parsed.topology,
    artifact: Object.freeze({
      artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE,
      mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
      byteLength: bytes.byteLength,
      offsets: layout2,
      counts: Object.freeze(counts),
      validation: meter.snapshot()
    })
  });
}

// src/world/water-field.mjs
var MAX_WATER_FIELD_ROWS = 257;
var MAX_WATER_FIELD_COLS = 257;
var MAX_WATER_FIELD_SAMPLES = MAX_WATER_FIELD_ROWS * MAX_WATER_FIELD_COLS;
var MAX_WATER_FIELD_BVH_NODES = WATER_LIMITS.bodies * 2 - 1;
var MAX_WATER_FIELD_EDGE_BVH_NODES = WATER_LIMITS.totalBodyPoints * 4 + WATER_LIMITS.bodies * 2;
var WATER_SAMPLE_CLASS_DRY = 0;
var WATER_SAMPLE_CLASS_OCEAN = 1;
var WATER_SAMPLE_CLASS_BASIN = 2;
var WATER_SAMPLE_SUBMERGED_NO = 0;
var WATER_SAMPLE_SUBMERGED_YES = 1;
var WATER_SAMPLE_SUBMERGED_UNKNOWN = 255;
var WATER_SAMPLE_RECORD_BYTES = 48;
var WATER_SAMPLE_LAYOUT = Object.freeze({
  recordBytes: WATER_SAMPLE_RECORD_BYTES,
  class: Object.freeze({ offset: 0, type: "u8", dry: WATER_SAMPLE_CLASS_DRY, ocean: WATER_SAMPLE_CLASS_OCEAN, basin: WATER_SAMPLE_CLASS_BASIN }),
  submerged: Object.freeze({ offset: 1, type: "u8", no: WATER_SAMPLE_SUBMERGED_NO, yes: WATER_SAMPLE_SUBMERGED_YES, unknown: WATER_SAMPLE_SUBMERGED_UNKNOWN }),
  flags: Object.freeze({ offset: 2, type: "u8", reservedValue: 0 }),
  reserved: Object.freeze({ offset: 3, type: "u8", value: 0 }),
  bodyIndex: Object.freeze({ offset: 4, type: "i32", none: -1 }),
  surfaceLevelM: Object.freeze({ offset: 8, type: "f64" }),
  authoredTargetDepthM: Object.freeze({ offset: 16, type: "f64" }),
  targetFloorLevelM: Object.freeze({ offset: 24, type: "f64" }),
  actualSubmergedDepthM: Object.freeze({ offset: 32, type: "f64" }),
  oceanSurfaceCandidateM: Object.freeze({ offset: 40, type: "f64" })
});
var DERIVED_CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;
var GENERATED_INPUT_KEYS = /* @__PURE__ */ new Set(["bytes", "descriptor", "expectedBindings"]);
var GENERATED_DESCRIPTOR_KEYS = /* @__PURE__ */ new Set(["artifactType", "mediaType", "contentHash", "byteLength"]);
var GENERATED_BINDING_KEYS = /* @__PURE__ */ new Set(["hydrologyFieldContentHash", "recipeHash", "erosionStageKey", "compilerGraphHash"]);
var verifiedGeneratedInputs = /* @__PURE__ */ new WeakSet();
var WaterFieldValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "WaterFieldValidationError";
    this.code = "water_field_invalid";
  }
};
var WaterFieldCancelledError = class extends Error {
  constructor() {
    super("water field operation cancelled");
    this.name = "WaterFieldCancelledError";
    this.code = "water_field_cancelled";
  }
};
function fail4(message) {
  throw new WaterFieldValidationError(message);
}
function exactDataRecord(value, keys, label, optional = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail4(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) fail4(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor2] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail4(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor2) || descriptor2.enumerable !== true) fail4(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!optional.has(key) && !Object.hasOwn(value, key)) fail4(`${label} is missing '${key}'`);
  return descriptors;
}
function parseBindingHashes(value, label) {
  const descriptors = exactDataRecord(value, GENERATED_BINDING_KEYS, label);
  const parsed = {};
  for (const key of GENERATED_BINDING_KEYS) {
    const hash2 = descriptors[key].value;
    if (typeof hash2 !== "string" || !DERIVED_CONTENT_HASH_RE.test(hash2)) fail4(`${label}.${key} must be a lowercase sha256 content hash`);
    parsed[key] = hash2;
  }
  return Object.freeze(parsed);
}
function prepareGeneratedWaterFieldInput(input, options = {}) {
  const descriptors = exactDataRecord(input, GENERATED_INPUT_KEYS, "generated water field input");
  const optionDescriptors = options === void 0 ? {} : exactDataRecord(options, /* @__PURE__ */ new Set(["shouldCancel"]), "generated water field options", /* @__PURE__ */ new Set(["shouldCancel"]));
  const shouldCancel = optionDescriptors.shouldCancel?.value;
  if (shouldCancel !== void 0 && typeof shouldCancel !== "function") fail4("generated water field options.shouldCancel must be a function");
  const descriptor2 = exactDataRecord(descriptors.descriptor.value, GENERATED_DESCRIPTOR_KEYS, "generated water artifact descriptor");
  if (descriptor2.artifactType.value !== HYDROLOGY_WATER_ARTIFACT_TYPE) fail4(`generated water artifact type must be '${HYDROLOGY_WATER_ARTIFACT_TYPE}'`);
  if (descriptor2.mediaType.value !== HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE) fail4(`generated water artifact media type must be '${HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE}'`);
  const contentHash2 = descriptor2.contentHash.value;
  if (typeof contentHash2 !== "string" || !DERIVED_CONTENT_HASH_RE.test(contentHash2)) fail4("generated water artifact contentHash must be a lowercase sha256 content hash");
  const byteLength2 = descriptor2.byteLength.value;
  if (!Number.isSafeInteger(byteLength2) || byteLength2 < 256 || byteLength2 > MAX_HYDROLOGY_WATER_ARTIFACT_BYTES) {
    fail4(`generated water artifact byteLength must be an integer in [256, ${MAX_HYDROLOGY_WATER_ARTIFACT_BYTES}]`);
  }
  const expectedBindings = parseBindingHashes(descriptors.expectedBindings.value, "expected generated water bindings");
  const bytes = descriptors.bytes.value;
  let decoded;
  try {
    if (!ArrayBuffer.isView(bytes) || Object.getPrototypeOf(bytes) !== Uint8Array.prototype || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) {
      fail4("generated water artifact bytes must own a complete non-shared Uint8Array");
    }
    if (bytes.byteLength !== byteLength2) fail4(`generated water artifact byteLength mismatch: descriptor ${byteLength2}, actual ${bytes.byteLength}`);
    const actualHash = `sha256:${sha256(bytes)}`;
    if (actualHash !== contentHash2) fail4(`generated water artifact content hash mismatch: expected ${contentHash2}, actual ${actualHash}`);
    decoded = decodeHydrologyWaterArtifact(
      bytes,
      expectedBindings,
      shouldCancel === void 0 ? void 0 : { shouldCancel }
    );
  } catch (error) {
    if (error instanceof WaterFieldValidationError || error instanceof WaterFieldCancelledError) throw error;
    if (error instanceof HydrologyWaterArtifactCancelledError) throw new WaterFieldCancelledError();
    fail4(`generated water artifact verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const prepared = Object.freeze({
    artifactContentHash: contentHash2,
    bindings: decoded.bindings,
    topology: decoded.topology
  });
  verifiedGeneratedInputs.add(prepared);
  return prepared;
}

// src/world/compiler/world-overview-artifact.mjs
var WORLD_OVERVIEW_ARTIFACT_TYPE = "world-overview-terrain/v1";
var WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.world-overview-terrain-v1";
var WORLD_OVERVIEW_ARTIFACT_VERSION = 1;
var WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES = 64;
var WORLD_OVERVIEW_MIN_DIMENSION = 2;
var WORLD_OVERVIEW_MAX_DIMENSION = 257;
var WORLD_OVERVIEW_MAX_CELLS = WORLD_OVERVIEW_MAX_DIMENSION ** 2;
var WORLD_OVERVIEW_MAX_ORIGIN_ABS_M = 1e7;
var WORLD_OVERVIEW_MAX_STEP_M = 1e6;
var WORLD_OVERVIEW_MAX_HEIGHT_ABS_M = 1e5;
var WORLD_OVERVIEW_MAX_PAINT_MATERIAL = 7;
var WORLD_OVERVIEW_MAX_ARTIFACT_BYTES = WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES + WORLD_OVERVIEW_MAX_CELLS * 6;
var MAGIC5 = Object.freeze([76, 77, 87, 79, 86, 82, 49, 0]);
var GRID_KEYS = /* @__PURE__ */ new Set(["rows", "cols", "origin", "stepM", "heights", "paintMaterial", "paintWeight"]);
var CONTROL_KEYS3 = /* @__PURE__ */ new Set(["shouldCancel"]);
var WorldOverviewArtifactValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "WorldOverviewArtifactValidationError";
    this.code = "world_overview_artifact_invalid";
  }
};
var WorldOverviewArtifactCancelledError = class extends Error {
  constructor() {
    super("world overview artifact operation cancelled");
    this.name = "WorldOverviewArtifactCancelledError";
    this.code = "world_overview_artifact_cancelled";
  }
};
function fail5(message) {
  throw new WorldOverviewArtifactValidationError(message);
}
function exactRecord3(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail5(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) fail5(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor2] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail5(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor2) || descriptor2.enumerable !== true) fail5(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail5(`${label} is missing '${key}'`);
  return descriptors;
}
function parseControl3(value) {
  if (value === void 0) return void 0;
  const descriptors = exactRecord3(value, CONTROL_KEYS3, "world overview artifact control");
  if (typeof descriptors.shouldCancel.value !== "function") fail5("world overview artifact control.shouldCancel must be a function");
  return descriptors.shouldCancel.value;
}
function createMeter3(shouldCancel, limit) {
  let work = 0;
  const check = () => {
    if (shouldCancel?.()) throw new WorldOverviewArtifactCancelledError();
  };
  return Object.freeze({
    start: check,
    work() {
      if (++work > limit) fail5(`world overview artifact exceeded bounded validation work ${limit}`);
      if ((work & 1023) === 0) check();
    },
    finish: check
  });
}
function dimension3(value, label) {
  if (!Number.isSafeInteger(value) || value < WORLD_OVERVIEW_MIN_DIMENSION || value > WORLD_OVERVIEW_MAX_DIMENSION) {
    fail5(`${label} must be an integer in [${WORLD_OVERVIEW_MIN_DIMENSION}, ${WORLD_OVERVIEW_MAX_DIMENSION}]`);
  }
  return value;
}
function canonicalFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) fail5(`${label} must be a finite canonical number`);
  return value;
}
function originTuple(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2 || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== 3) {
    fail5("world overview origin must be a dense two-number tuple");
  }
  const result = new Array(2);
  for (let index = 0; index < 2; index++) {
    const descriptor2 = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor2 || !("value" in descriptor2) || descriptor2.enumerable !== true) fail5(`world overview origin[${index}] must be an enumerable data field`);
    const coordinate = canonicalFinite(descriptor2.value, `world overview origin[${index}]`);
    if (Math.abs(coordinate) > WORLD_OVERVIEW_MAX_ORIGIN_ABS_M) fail5(`world overview origin[${index}] exceeds the supported world range`);
    result[index] = coordinate;
  }
  return Object.freeze(result);
}
function isShared(buffer) {
  return Object.prototype.toString.call(buffer) === "[object SharedArrayBuffer]";
}
function ownedTypedArray(value, prototype, cells, label) {
  if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== prototype) fail5(`${label} has the wrong typed-array representation`);
  if (!(value.buffer instanceof ArrayBuffer) || isShared(value.buffer) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    fail5(`${label} must own its complete non-shared ArrayBuffer`);
  }
  if (value.length !== cells) fail5(`${label} length ${value.length} does not match ${cells} cells`);
  return value;
}
function layout(cells) {
  const heights = WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES;
  const paintMaterial = heights + cells * 4;
  const paintWeight = paintMaterial + cells;
  return Object.freeze({ heights, paintMaterial, paintWeight, byteLength: paintWeight + cells });
}
function parseGrid2(input, meter) {
  const descriptors = exactRecord3(input, GRID_KEYS, "world overview grid");
  const rows = dimension3(descriptors.rows.value, "world overview rows");
  const cols = dimension3(descriptors.cols.value, "world overview cols");
  const cells = rows * cols;
  const origin = originTuple(descriptors.origin.value);
  const stepM = canonicalFinite(descriptors.stepM.value, "world overview stepM");
  if (!(stepM > 0) || stepM > WORLD_OVERVIEW_MAX_STEP_M) fail5(`world overview stepM must be in (0, ${WORLD_OVERVIEW_MAX_STEP_M}]`);
  const maxX = canonicalFinite(origin[0] + (cols - 1) * stepM, "world overview maximum x");
  const maxZ = canonicalFinite(origin[1] + (rows - 1) * stepM, "world overview maximum z");
  if (Math.abs(maxX) > WORLD_OVERVIEW_MAX_ORIGIN_ABS_M || Math.abs(maxZ) > WORLD_OVERVIEW_MAX_ORIGIN_ABS_M) {
    fail5("world overview grid extent exceeds the supported world range");
  }
  const heights = ownedTypedArray(descriptors.heights.value, Float32Array.prototype, cells, "world overview heights");
  const paintMaterial = ownedTypedArray(descriptors.paintMaterial.value, Uint8Array.prototype, cells, "world overview paintMaterial");
  const paintWeight = ownedTypedArray(descriptors.paintWeight.value, Uint8Array.prototype, cells, "world overview paintWeight");
  for (let index = 0; index < cells; index++) {
    meter.work();
    const height = heights[index];
    if (!Number.isFinite(height) || Object.is(height, -0) || Math.abs(height) > WORLD_OVERVIEW_MAX_HEIGHT_ABS_M) {
      fail5(`world overview heights[${index}] must be finite canonical metres within the supported range`);
    }
    if (paintMaterial[index] > WORLD_OVERVIEW_MAX_PAINT_MATERIAL) {
      fail5(`world overview paintMaterial[${index}] exceeds ${WORLD_OVERVIEW_MAX_PAINT_MATERIAL}`);
    }
  }
  return Object.freeze({ rows, cols, cells, origin, stepM, heights, paintMaterial, paintWeight });
}
function artifactBytes(input) {
  if (!ArrayBuffer.isView(input) || Object.getPrototypeOf(input) !== Uint8Array.prototype || !(input.buffer instanceof ArrayBuffer) || isShared(input.buffer) || input.byteOffset !== 0 || input.byteLength !== input.buffer.byteLength) {
    fail5("world overview artifact bytes must be an owned Uint8Array over a non-shared ArrayBuffer");
  }
  if (input.byteLength < WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES || input.byteLength > WORLD_OVERVIEW_MAX_ARTIFACT_BYTES) {
    fail5("world overview artifact byte length is outside the supported range");
  }
  return input;
}
function decodeWorldOverviewArtifact(input, controlInput) {
  const bytes = artifactBytes(input);
  const meter = createMeter3(parseControl3(controlInput), WORLD_OVERVIEW_MAX_CELLS * 2 + 4096);
  meter.start();
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC5.length; index++) if (view.getUint8(index) !== MAGIC5[index]) fail5("world overview artifact magic mismatch");
  if (view.getUint16(8, true) !== WORLD_OVERVIEW_ARTIFACT_VERSION) fail5("world overview artifact version is unsupported");
  if (view.getUint16(10, true) !== WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES) fail5("world overview artifact header length mismatch");
  const rows = dimension3(view.getUint16(16, true), "world overview rows");
  const cols = dimension3(view.getUint16(18, true), "world overview cols");
  const cells = rows * cols;
  if (view.getUint32(20, true) !== cells) fail5("world overview artifact cell count mismatch");
  const offsets = layout(cells);
  if (view.getUint32(12, true) !== bytes.byteLength || bytes.byteLength !== offsets.byteLength) fail5("world overview artifact byte length is non-canonical");
  if (view.getUint32(48, true) !== offsets.heights || view.getUint32(52, true) !== offsets.paintMaterial || view.getUint32(56, true) !== offsets.paintWeight) fail5("world overview artifact channel offsets are non-canonical");
  if (view.getUint32(60, true) !== 0) fail5("world overview artifact reserved header bytes must be zero");
  const origin = originTuple([view.getFloat64(24, true), view.getFloat64(32, true)]);
  const stepM = canonicalFinite(view.getFloat64(40, true), "world overview stepM");
  const heights = new Float32Array(cells);
  const paintMaterial = new Uint8Array(cells);
  const paintWeight = new Uint8Array(cells);
  for (let index = 0; index < cells; index++) {
    meter.work();
    heights[index] = view.getFloat32(offsets.heights + index * 4, true);
  }
  paintMaterial.set(bytes.subarray(offsets.paintMaterial, offsets.paintWeight));
  paintWeight.set(bytes.subarray(offsets.paintWeight));
  parseGrid2({ rows, cols, origin, stepM, heights, paintMaterial, paintWeight }, meter);
  meter.finish();
  const grid = Object.freeze({ rows, cols, origin, stepM, heights, paintMaterial, paintWeight });
  const metadata = Object.freeze({
    artifactType: WORLD_OVERVIEW_ARTIFACT_TYPE,
    mediaType: WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE,
    version: WORLD_OVERVIEW_ARTIFACT_VERSION,
    byteLength: bytes.byteLength,
    cells,
    offsets,
    storage: "owned-transferable-channel-copies"
  });
  return Object.freeze({ grid, metadata });
}

// src/world/design-ref.mjs
var ATLAS_DESIGN_REF_KINDS = Object.freeze(["feature", "marker", "place", "stamp"]);
var KIND_SET = new Set(ATLAS_DESIGN_REF_KINDS);

// src/world/compiler/navigation-index-artifact.mjs
var NAVIGATION_INDEX_ARTIFACT_SCHEMA = "limina.navigation-index-artifact/v1";
var NAVIGATION_INDEX_ARTIFACT_VERSION = 1;
var NAVIGATION_INDEX_ARTIFACT_TYPE = "navigation-index/v1";
var NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.navigation-index";
var MAX_NAVIGATION_INDEX_ENTRIES = 1e5;
var MAX_NAVIGATION_INDEX_SEARCH_KEYS_PER_ENTRY = 16;
var MAX_NAVIGATION_INDEX_SEARCH_KEYS = MAX_NAVIGATION_INDEX_ENTRIES * 4;
var MAX_NAVIGATION_INDEX_STRING_CHARS = 256;
var MAX_NAVIGATION_INDEX_ARTIFACT_BYTES = 12 * 1024 * 1024;
var MAGIC6 = Uint8Array.of(76, 78, 65, 86, 73, 68, 88, 49);
var HEADER_BYTES2 = 96;
var ENTRY_BYTES = 56;
var KEY_BYTES = 8;
var STRING_DESCRIPTOR_BYTES = 8;
var MAX_COORDINATE_M = 1e7;
var MAX_SEARCH_KEY_CHARS = 128;
var MAX_UTF8_STRING_BYTES = MAX_NAVIGATION_INDEX_STRING_CHARS * 4;
var KIND = /^[a-z][a-z0-9._-]{0,63}$/;
var CONTROL = /[\u0000-\u001f\u007f]/;
var decoder = new TextDecoder("utf-8", { fatal: true });
var encoder = new TextEncoder();
var decodedState = /* @__PURE__ */ new WeakMap();
var STRING_USE = Object.freeze({ IDENTIFIER: 1, REF_KIND: 2, LABEL: 4, KIND: 8, SEARCH_KEY: 16 });
var NavigationIndexArtifactValidationError = class extends Error {
  constructor(message, code = "navigation_index_artifact_invalid") {
    super(message);
    this.name = "NavigationIndexArtifactValidationError";
    this.code = code;
  }
};
function fail6(message) {
  throw new NavigationIndexArtifactValidationError(message);
}
function cancelled() {
  throw new NavigationIndexArtifactValidationError(
    "navigation index operation was cancelled",
    "navigation_index_artifact_cancelled"
  );
}
function exactRecord4(value, required, optional, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) fail6(`${label} must be a plain object`);
  const names = Object.getOwnPropertyNames(value);
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.some((name) => !allowed.has(name)) || required.some((name) => !names.includes(name))) fail6(`${label} fields are invalid`);
  const fields = /* @__PURE__ */ Object.create(null);
  for (const name of names) {
    const descriptor2 = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor2?.enumerable !== true || !Object.hasOwn(descriptor2, "value")) {
      fail6(`${label}.${name} must be an enumerable data field`);
    }
    fields[name] = descriptor2.value;
  }
  return fields;
}
function parseCancellationOptions(options) {
  const fields = exactRecord4(options, [], ["cancellationFlag", "shouldCancel"], "navigation index options");
  const hasFlag = Object.hasOwn(fields, "cancellationFlag");
  const hasCallback = Object.hasOwn(fields, "shouldCancel");
  if (hasFlag && hasCallback) fail6("navigation index options must choose one cancellation mechanism");
  if (hasCallback) {
    if (typeof fields.shouldCancel !== "function") fail6("navigation index shouldCancel must be a function");
    return fields.shouldCancel;
  }
  if (!hasFlag) return null;
  const flag = fields.cancellationFlag;
  if (!(flag instanceof Int32Array) || flag.length !== 1 || typeof SharedArrayBuffer !== "function" || !(flag.buffer instanceof SharedArrayBuffer)) {
    fail6("navigation index cancellationFlag must be a one-element shared Int32Array");
  }
  return () => Atomics.load(flag, 0) !== 0;
}
function checkCancellation(shouldCancel, index = 0) {
  if (shouldCancel !== null && (index & 4095) === 0 && shouldCancel()) cancelled();
}
function finiteCoordinate(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE_M) {
    fail6(`${label} must be a finite coordinate within ${MAX_COORDINATE_M} meters`);
  }
  return Object.is(value, -0) ? 0 : value;
}
function printable(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim().length < 1 || CONTROL.test(value)) {
    fail6(`${label} must contain 1-${maximum} printable characters`);
  }
  return value;
}
function canonicalSearchKey(value, label) {
  const input = printable(value, MAX_NAVIGATION_INDEX_STRING_CHARS, label);
  const key = input.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
  if (key.length < 1 || key.length > MAX_SEARCH_KEY_CHARS || CONTROL.test(key)) {
    fail6(`${label} exceeds the canonical search-key limit`);
  }
  return key;
}
function parseBounds(input) {
  const fields = exactRecord4(input, ["minX", "minZ", "maxX", "maxZ"], [], "navigation world bounds");
  const bounds = {
    minX: finiteCoordinate(fields.minX, "navigation world bounds.minX"),
    minZ: finiteCoordinate(fields.minZ, "navigation world bounds.minZ"),
    maxX: finiteCoordinate(fields.maxX, "navigation world bounds.maxX"),
    maxZ: finiteCoordinate(fields.maxZ, "navigation world bounds.maxZ")
  };
  if (!(bounds.maxX > bounds.minX) || !(bounds.maxZ > bounds.minZ)) {
    fail6("navigation world bounds must have positive width and depth");
  }
  return Object.freeze(bounds);
}
function checkedSectionEnd(offset, count, stride, label) {
  const end = offset + count * stride;
  if (!Number.isSafeInteger(end) || end > MAX_NAVIGATION_INDEX_ARTIFACT_BYTES) {
    fail6(`${label} exceeds the navigation artifact size budget`);
  }
  return end;
}
function hasMagic(bytes) {
  for (let index = 0; index < MAGIC6.length; index++) if (bytes[index] !== MAGIC6[index]) return false;
  return true;
}
function readHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_BYTES2 || bytes.byteLength > MAX_NAVIGATION_INDEX_ARTIFACT_BYTES) {
    fail6(`navigation index artifact must contain ${HEADER_BYTES2}-${MAX_NAVIGATION_INDEX_ARTIFACT_BYTES} bytes`);
  }
  const ownedBytes3 = Uint8Array.from(bytes);
  if (!hasMagic(ownedBytes3)) fail6("navigation index artifact magic is invalid");
  const view = new DataView(ownedBytes3.buffer);
  if (view.getUint16(8, true) !== NAVIGATION_INDEX_ARTIFACT_VERSION || view.getUint16(10, true) !== HEADER_BYTES2) fail6("navigation index artifact version is unsupported");
  if (view.getUint32(12, true) !== 0 || view.getUint32(28, true) !== 0 || view.getUint32(88, true) !== 0 || view.getUint32(92, true) !== 0) {
    fail6("navigation index artifact reserved header fields must be zero");
  }
  const header = {
    ownedBytes: ownedBytes3,
    view,
    entryCount: view.getUint32(16, true),
    keyCount: view.getUint32(20, true),
    stringCount: view.getUint32(24, true),
    entryOffset: view.getUint32(32, true),
    keyOffset: view.getUint32(36, true),
    orderOffset: view.getUint32(40, true),
    descriptorOffset: view.getUint32(44, true),
    blobOffset: view.getUint32(48, true),
    totalBytes: view.getUint32(52, true)
  };
  if (header.entryCount > MAX_NAVIGATION_INDEX_ENTRIES || header.keyCount > MAX_NAVIGATION_INDEX_SEARCH_KEYS || header.stringCount > header.entryCount * 5 + header.keyCount) {
    fail6("navigation index artifact counts exceed their production budgets");
  }
  const expectedKeyOffset = checkedSectionEnd(HEADER_BYTES2, header.entryCount, ENTRY_BYTES, "navigation entry table");
  const expectedOrderOffset = checkedSectionEnd(expectedKeyOffset, header.keyCount, KEY_BYTES, "navigation key table");
  const expectedDescriptorOffset = checkedSectionEnd(expectedOrderOffset, header.keyCount, 4, "navigation key order");
  const expectedBlobOffset = checkedSectionEnd(expectedDescriptorOffset, header.stringCount, STRING_DESCRIPTOR_BYTES, "navigation string table");
  if (header.entryOffset !== HEADER_BYTES2 || header.keyOffset !== expectedKeyOffset || header.orderOffset !== expectedOrderOffset || header.descriptorOffset !== expectedDescriptorOffset || header.blobOffset !== expectedBlobOffset || header.totalBytes !== ownedBytes3.byteLength) {
    fail6("navigation index artifact section layout is invalid");
  }
  return header;
}
function descriptor(state, stringId) {
  if (stringId >= state.stringCount) fail6("navigation index string reference is out of bounds");
  const offset = state.descriptorOffset + stringId * STRING_DESCRIPTOR_BYTES;
  return [state.view.getUint32(offset, true), state.view.getUint32(offset + 4, true)];
}
function stringBytes(state, stringId) {
  const [offset, length] = descriptor(state, stringId);
  return state.ownedBytes.subarray(state.blobOffset + offset, state.blobOffset + offset + length);
}
function decodeString(state, stringId) {
  try {
    return decoder.decode(stringBytes(state, stringId));
  } catch {
    fail6("navigation index string is not valid UTF-8");
  }
}
function validatePrintableString(state, stringId, maximum, label) {
  const descriptorOffset = state.descriptorOffset + stringId * STRING_DESCRIPTOR_BYTES;
  const relativeOffset = state.view.getUint32(descriptorOffset, true);
  const length = state.view.getUint32(descriptorOffset + 4, true);
  const start = state.blobOffset + relativeOffset;
  let ascii = true;
  let onlySpaces = true;
  for (let index = 0; index < length; index++) {
    const byte = state.ownedBytes[start + index];
    if (byte >= 128) {
      ascii = false;
      break;
    }
    if (byte < 32 || byte === 127) fail6(`${label} contains control characters`);
    if (byte !== 32) onlySpaces = false;
  }
  if (ascii) {
    if (length < 1 || length > maximum || onlySpaces) fail6(`${label} is not a bounded printable string`);
    return;
  }
  const value = decodeString(state, stringId);
  printable(value, maximum, label);
}
function validateUsedString(state, stringId, use) {
  if (stringId >= state.stringCount) fail6("navigation index string reference is out of bounds");
  if ((state.stringUses[stringId] & use) !== 0) return;
  if (state.stringUses[stringId] === 0) {
    if (stringId !== state.nextStringId) fail6("navigation index string table is not in canonical first-use order");
    state.nextStringId++;
  }
  state.stringUses[stringId] |= use;
  if (use === STRING_USE.IDENTIFIER) validatePrintableString(state, stringId, 128, "navigation design identifier");
  else if (use === STRING_USE.LABEL) validatePrintableString(state, stringId, MAX_NAVIGATION_INDEX_STRING_CHARS, "navigation label");
  else if (use === STRING_USE.REF_KIND) {
    const value = decodeString(state, stringId);
    if (value !== "feature" && value !== "marker" && value !== "place" && value !== "stamp") {
      fail6("navigation designRef kind is invalid");
    }
  } else if (use === STRING_USE.KIND) {
    const value = decodeString(state, stringId);
    if (!KIND.test(value)) fail6("navigation entry kind is invalid");
  } else if (use === STRING_USE.SEARCH_KEY) {
    const descriptorOffset = state.descriptorOffset + stringId * STRING_DESCRIPTOR_BYTES;
    const relativeOffset = state.view.getUint32(descriptorOffset, true);
    const length = state.view.getUint32(descriptorOffset + 4, true);
    const start = state.blobOffset + relativeOffset;
    let ascii = true;
    for (let index = 0; index < length; index++) {
      const byte = state.ownedBytes[start + index];
      if (byte >= 128) {
        ascii = false;
        break;
      }
      if (byte < 32 || byte === 127 || byte >= 65 && byte <= 90 || byte === 32 && (index === 0 || index === length - 1 || state.ownedBytes[start + index - 1] === 32)) {
        fail6("navigation search key is not canonical");
      }
    }
    if (ascii) {
      if (length < 1 || length > MAX_SEARCH_KEY_CHARS) fail6("navigation search key is not canonical");
    } else {
      const value = decodeString(state, stringId);
      if (canonicalSearchKey(value, "navigation search key") !== value) fail6("navigation search key is not canonical");
    }
  }
}
function compareStringIds(state, leftId, rightId) {
  const leftDescriptor = state.descriptorOffset + leftId * STRING_DESCRIPTOR_BYTES;
  const rightDescriptor = state.descriptorOffset + rightId * STRING_DESCRIPTOR_BYTES;
  const leftStart = state.blobOffset + state.view.getUint32(leftDescriptor, true);
  const rightStart = state.blobOffset + state.view.getUint32(rightDescriptor, true);
  const leftLength = state.view.getUint32(leftDescriptor + 4, true);
  const rightLength = state.view.getUint32(rightDescriptor + 4, true);
  const length = Math.min(leftLength, rightLength);
  for (let index = 0; index < length; index++) {
    const difference = state.ownedBytes[leftStart + index] - state.ownedBytes[rightStart + index];
    if (difference !== 0) return difference;
  }
  return leftLength - rightLength;
}
function validateStringDescriptors(state, cancellationCheck) {
  let expectedOffset = 0;
  for (let index = 0; index < state.stringCount; index++) {
    checkCancellation(cancellationCheck, index);
    const descriptorOffset = state.descriptorOffset + index * STRING_DESCRIPTOR_BYTES;
    const offset = state.view.getUint32(descriptorOffset, true);
    const length = state.view.getUint32(descriptorOffset + 4, true);
    if (offset !== expectedOffset || length < 1 || length > MAX_UTF8_STRING_BYTES || offset + length > state.ownedBytes.length - state.blobOffset) {
      fail6("navigation index string descriptor is invalid");
    }
    const startByte = state.ownedBytes[state.blobOffset + offset];
    const after = state.blobOffset + offset + length;
    if ((startByte & 192) === 128 || after < state.ownedBytes.length && (state.ownedBytes[after] & 192) === 128) {
      fail6("navigation index string descriptor splits a UTF-8 sequence");
    }
    expectedOffset += length;
  }
  if (expectedOffset !== state.ownedBytes.length - state.blobOffset) {
    fail6("navigation index string blob contains unreferenced bytes");
  }
  try {
    decoder.decode(state.ownedBytes.subarray(state.blobOffset));
  } catch {
    fail6("navigation index string blob is not valid UTF-8");
  }
}
function validateEntries(state, bounds, cancellationCheck) {
  let expectedFirstKey = 0;
  let previousMapId = -1;
  let previousKindId = -1;
  let previousRefId = -1;
  for (let index = 0; index < state.entryCount; index++) {
    checkCancellation(cancellationCheck, index);
    const offset = state.entryOffset + index * ENTRY_BYTES;
    const mapId = state.view.getUint32(offset, true);
    const refKindId = state.view.getUint32(offset + 4, true);
    const refId = state.view.getUint32(offset + 8, true);
    const labelId = state.view.getUint32(offset + 12, true);
    const kindId = state.view.getUint32(offset + 16, true);
    validateUsedString(state, mapId, STRING_USE.IDENTIFIER);
    validateUsedString(state, refKindId, STRING_USE.REF_KIND);
    validateUsedString(state, refId, STRING_USE.IDENTIFIER);
    validateUsedString(state, labelId, STRING_USE.LABEL);
    validateUsedString(state, kindId, STRING_USE.KIND);
    if (previousMapId !== -1) {
      const order = compareStringIds(state, previousMapId, mapId) || compareStringIds(state, previousKindId, refKindId) || compareStringIds(state, previousRefId, refId);
      if (order >= 0) fail6(order === 0 ? "navigation entries contain duplicate designRef" : "navigation entries are not canonical");
    }
    previousMapId = mapId;
    previousKindId = refKindId;
    previousRefId = refId;
    const firstKey = state.view.getUint32(offset + 20, true);
    const keyCount = state.view.getUint16(offset + 24, true);
    const flags = state.view.getUint16(offset + 26, true);
    const reserved = state.view.getUint32(offset + 28, true);
    const x = state.view.getFloat64(offset + 32, true);
    const z = state.view.getFloat64(offset + 40, true);
    const radius = state.view.getFloat64(offset + 48, true);
    if (firstKey !== expectedFirstKey || keyCount < 1 || keyCount > MAX_NAVIGATION_INDEX_SEARCH_KEYS_PER_ENTRY || firstKey + keyCount > state.keyCount) fail6("navigation entry key range is invalid");
    if (flags !== 0 && flags !== 1 || reserved !== 0 || !Number.isFinite(x) || !Number.isFinite(z) || x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ || (flags === 0 ? radius !== 0 : !Number.isFinite(radius) || radius <= 0 || radius > MAX_COORDINATE_M)) {
      fail6("navigation entry numeric record is invalid");
    }
    expectedFirstKey += keyCount;
  }
  if (expectedFirstKey !== state.keyCount) fail6("navigation key table is incomplete");
}
function validateKeys(state, cancellationCheck) {
  let expectedEntry = 0;
  let previousStringId = null;
  for (let index = 0; index < state.keyCount; index++) {
    checkCancellation(cancellationCheck, index);
    while (expectedEntry < state.entryCount) {
      const entryOffset = state.entryOffset + expectedEntry * ENTRY_BYTES;
      const first = state.view.getUint32(entryOffset + 20, true);
      const count = state.view.getUint16(entryOffset + 24, true);
      if (index < first + count) break;
      expectedEntry++;
      previousStringId = null;
    }
    const offset = state.keyOffset + index * KEY_BYTES;
    const stringId = state.view.getUint32(offset, true);
    const entryIndex = state.view.getUint32(offset + 4, true);
    if (entryIndex !== expectedEntry) fail6("navigation key entry reference is not canonical");
    validateUsedString(state, stringId, STRING_USE.SEARCH_KEY);
    if (previousStringId !== null && compareStringIds(state, previousStringId, stringId) >= 0) {
      fail6("navigation entry search keys are not strictly sorted");
    }
    previousStringId = stringId;
  }
  if (state.nextStringId !== state.stringCount) fail6("navigation string table contains unused records");
  const seen = new Uint8Array(state.keyCount);
  let previousKey = null;
  let previousEntry = -1;
  for (let index = 0; index < state.keyCount; index++) {
    checkCancellation(cancellationCheck, index);
    const keyIndex = state.view.getUint32(state.orderOffset + index * 4, true);
    if (keyIndex >= state.keyCount || seen[keyIndex] !== 0) fail6("navigation sorted-key table is not a permutation");
    seen[keyIndex] = 1;
    const keyOffset = state.keyOffset + keyIndex * KEY_BYTES;
    const stringId = state.view.getUint32(keyOffset, true);
    const entryIndex = state.view.getUint32(keyOffset + 4, true);
    if (previousKey !== null) {
      const order = compareStringIds(state, previousKey, stringId);
      if (order > 0 || order === 0 && entryIndex <= previousEntry) {
        fail6("navigation sorted-key table is not canonical");
      }
    }
    previousKey = stringId;
    previousEntry = entryIndex;
  }
}
function decodeNavigationIndexArtifact(bytes, options = {}) {
  const cancellationCheck = parseCancellationOptions(options);
  checkCancellation(cancellationCheck);
  const state = readHeader(bytes);
  const bounds = parseBounds({
    minX: state.view.getFloat64(56, true),
    minZ: state.view.getFloat64(64, true),
    maxX: state.view.getFloat64(72, true),
    maxZ: state.view.getFloat64(80, true)
  });
  state.stringUses = new Uint8Array(state.stringCount);
  state.nextStringId = 0;
  validateStringDescriptors(state, cancellationCheck);
  validateEntries(state, bounds, cancellationCheck);
  validateKeys(state, cancellationCheck);
  const artifact = Object.freeze({
    schema: NAVIGATION_INDEX_ARTIFACT_SCHEMA,
    version: NAVIGATION_INDEX_ARTIFACT_VERSION,
    worldBounds: bounds,
    entryCount: state.entryCount,
    keyCount: state.keyCount,
    byteLength: state.ownedBytes.byteLength
  });
  delete state.stringUses;
  delete state.nextStringId;
  decodedState.set(artifact, state);
  return artifact;
}

// src/world/biome-ir.mjs
var BIOME_DEF_SCHEMA = "limina.biome-def/v1";
var BIOME_PACK_SCHEMA = "limina.biome-pack/v1";
var BIOME_CATEGORIES = Object.freeze(["terrestrial", "aquatic", "wetland", "geological", "fantasy", "sci-fi"]);
var BIOME_BINDING_KINDS = Object.freeze(["surface-material", "vegetation", "resource-table", "spawn-table", "ambient-audio"]);
var BIOME_FULFILLMENT_STATES = Object.freeze(["metadata-only", "partial", "fulfilled"]);
var LEGACY_BIOME_KINDS = Object.freeze(["grass", "forest", "mountain", "desert", "tundra", "swamp", "water", "blight"]);
var BIOME_LIMITS = Object.freeze({
  definitions: 64,
  tags: 16,
  surfaceMaterials: 16,
  vegetationRoles: 32,
  tableRefs: 32,
  ambientAudioRefs: 16,
  bindings: 128,
  legacyAliases: 8,
  idChars: 64,
  labelChars: 96,
  refChars: 160,
  uriChars: 512
});
var ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
var REF = /^[a-z][a-z0-9._/-]*$/;
var SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
var HASH4 = /^sha256:[0-9a-f]{64}$/;
var BiomeIrValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "BiomeIrValidationError";
  }
};
function fail7(message) {
  throw new BiomeIrValidationError(message);
}
function record(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail7(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail7(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail7(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor2] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail7(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor2) || descriptor2.enumerable !== true) fail7(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail7(`${label} is missing '${key}'`);
  return descriptors;
}
function dense(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    fail7(`${label} must be a standard array with at most ${maximum} entries`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail7(`${label} must be dense and field-free`);
  }
  return value;
}
function string(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail7(`${label} is invalid`);
  return value;
}
function text(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) fail7(`${label} is invalid`);
  return value;
}
function number(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum) fail7(`${label} must be a canonical number in [${minimum}, ${maximum}]`);
  return value;
}
function integer3(value, minimum, maximum, label) {
  const parsed = number(value, minimum, maximum, label);
  if (!Number.isSafeInteger(parsed)) fail7(`${label} must be an integer`);
  return parsed;
}
function sortedUniqueStrings(value, maximum, label) {
  const source = dense(value, maximum, label);
  const result = source.map((entry, index) => string(entry, REF, BIOME_LIMITS.refChars, `${label}[${index}]`));
  for (let index = 1; index < result.length; index++) if (result[index - 1] >= result[index]) fail7(`${label} must be strictly sorted and unique`);
  return Object.freeze(result);
}
function provenance(value, label) {
  const d = record(value, /* @__PURE__ */ new Set(["sourceUri", "licenseId", "authoredBy"]), label);
  return Object.freeze({
    sourceUri: text(d.sourceUri.value, BIOME_LIMITS.uriChars, `${label}.sourceUri`),
    licenseId: text(d.licenseId.value, BIOME_LIMITS.labelChars, `${label}.licenseId`),
    authoredBy: text(d.authoredBy.value, BIOME_LIMITS.labelChars, `${label}.authoredBy`)
  });
}
function band(value, minimum, maximum, label) {
  const d = record(value, /* @__PURE__ */ new Set(["min", "max"]), label);
  const min = number(d.min.value, minimum, maximum, `${label}.min`);
  const max = number(d.max.value, minimum, maximum, `${label}.max`);
  if (max < min) fail7(`${label}.max must be at least min`);
  return Object.freeze({ min, max });
}
function parseDefinition(value, label) {
  const d = record(value, /* @__PURE__ */ new Set([
    "schema",
    "id",
    "version",
    "displayName",
    "taxonomy",
    "climate",
    "surfaceMaterials",
    "vegetationPalette",
    "resourceTableRefs",
    "spawnTableRefs",
    "waterTintSrgb",
    "ambientAudioRefs",
    "fulfillment",
    "provenance"
  ]), label);
  if (d.schema.value !== BIOME_DEF_SCHEMA) fail7(`${label}.schema must be '${BIOME_DEF_SCHEMA}'`);
  const id = string(d.id.value, ID, BIOME_LIMITS.idChars, `${label}.id`);
  const version = string(d.version.value, SEMVER, 64, `${label}.version`);
  const taxonomyInput = record(d.taxonomy.value, /* @__PURE__ */ new Set(["category", "tags"]), `${label}.taxonomy`);
  if (!BIOME_CATEGORIES.includes(taxonomyInput.category.value)) fail7(`${label}.taxonomy.category is unsupported`);
  const tags = sortedUniqueStrings(taxonomyInput.tags.value, BIOME_LIMITS.tags, `${label}.taxonomy.tags`);
  const climateInput = record(d.climate.value, /* @__PURE__ */ new Set(["temperatureC", "moisture01"]), `${label}.climate`);
  const climate = Object.freeze({
    temperatureC: band(climateInput.temperatureC.value, -100, 100, `${label}.climate.temperatureC`),
    moisture01: band(climateInput.moisture01.value, 0, 1, `${label}.climate.moisture01`)
  });
  const surfaceInput = dense(d.surfaceMaterials.value, BIOME_LIMITS.surfaceMaterials, `${label}.surfaceMaterials`);
  if (surfaceInput.length < 1) fail7(`${label}.surfaceMaterials must not be empty`);
  const surfaceSeen = /* @__PURE__ */ new Set();
  const surfaceMaterials = Object.freeze(surfaceInput.map((entry, index) => {
    const e = record(entry, /* @__PURE__ */ new Set(["role"]), `${label}.surfaceMaterials[${index}]`);
    const role = string(e.role.value, REF, BIOME_LIMITS.refChars, `${label}.surfaceMaterials[${index}].role`);
    if (surfaceSeen.has(role)) fail7(`${label}.surfaceMaterials duplicates role '${role}'`);
    surfaceSeen.add(role);
    return Object.freeze({ role });
  }));
  const vegetationInput = dense(d.vegetationPalette.value, BIOME_LIMITS.vegetationRoles, `${label}.vegetationPalette`);
  const vegetationPalette = Object.freeze(vegetationInput.map((entry, index) => {
    const e = record(entry, /* @__PURE__ */ new Set(["role", "weight"]), `${label}.vegetationPalette[${index}]`);
    return Object.freeze({
      role: string(e.role.value, REF, BIOME_LIMITS.refChars, `${label}.vegetationPalette[${index}].role`),
      weight: number(e.weight.value, Number.MIN_VALUE, 1e6, `${label}.vegetationPalette[${index}].weight`)
    });
  }));
  for (let index = 1; index < vegetationPalette.length; index++) if (vegetationPalette[index - 1].role >= vegetationPalette[index].role) fail7(`${label}.vegetationPalette must be strictly role-sorted and unique`);
  const resourceTableRefs = sortedUniqueStrings(d.resourceTableRefs.value, BIOME_LIMITS.tableRefs, `${label}.resourceTableRefs`);
  const spawnTableRefs = sortedUniqueStrings(d.spawnTableRefs.value, BIOME_LIMITS.tableRefs, `${label}.spawnTableRefs`);
  const ambientAudioRefs = sortedUniqueStrings(d.ambientAudioRefs.value, BIOME_LIMITS.ambientAudioRefs, `${label}.ambientAudioRefs`);
  const tintInput = dense(d.waterTintSrgb.value, 3, `${label}.waterTintSrgb`);
  if (tintInput.length !== 3) fail7(`${label}.waterTintSrgb must contain exactly 3 channels`);
  const waterTintSrgb = Object.freeze(tintInput.map((entry, index) => integer3(entry, 0, 255, `${label}.waterTintSrgb[${index}]`)));
  const fulfillmentInput = record(d.fulfillment.value, /* @__PURE__ */ new Set(["status", "bindings"]), `${label}.fulfillment`);
  if (!BIOME_FULFILLMENT_STATES.includes(fulfillmentInput.status.value)) fail7(`${label}.fulfillment.status is unsupported`);
  const declared = /* @__PURE__ */ new Set([
    ...surfaceMaterials.map((entry) => `surface-material:${entry.role}`),
    ...vegetationPalette.map((entry) => `vegetation:${entry.role}`),
    ...resourceTableRefs.map((ref) => `resource-table:${ref}`),
    ...spawnTableRefs.map((ref) => `spawn-table:${ref}`),
    ...ambientAudioRefs.map((ref) => `ambient-audio:${ref}`)
  ]);
  const bindingsInput = dense(fulfillmentInput.bindings.value, BIOME_LIMITS.bindings, `${label}.fulfillment.bindings`);
  const bindingKeys = /* @__PURE__ */ new Set();
  const bindings = Object.freeze(bindingsInput.map((entry, index) => {
    const e = record(entry, /* @__PURE__ */ new Set(["kind", "ref", "assetId", "contentHash", "licenseId", "sourceUri"]), `${label}.fulfillment.bindings[${index}]`);
    if (!BIOME_BINDING_KINDS.includes(e.kind.value)) fail7(`${label}.fulfillment.bindings[${index}].kind is unsupported`);
    const ref = string(e.ref.value, REF, BIOME_LIMITS.refChars, `${label}.fulfillment.bindings[${index}].ref`);
    const key = `${e.kind.value}:${ref}`;
    if (!declared.has(key)) fail7(`${label}.fulfillment binding '${key}' is not declared by the definition`);
    if (bindingKeys.has(key)) fail7(`${label}.fulfillment duplicates binding '${key}'`);
    bindingKeys.add(key);
    return Object.freeze({
      kind: e.kind.value,
      ref,
      assetId: string(e.assetId.value, REF, BIOME_LIMITS.refChars, `${label}.fulfillment.bindings[${index}].assetId`),
      contentHash: string(e.contentHash.value, HASH4, 71, `${label}.fulfillment.bindings[${index}].contentHash`),
      licenseId: text(e.licenseId.value, BIOME_LIMITS.labelChars, `${label}.fulfillment.bindings[${index}].licenseId`),
      sourceUri: text(e.sourceUri.value, BIOME_LIMITS.uriChars, `${label}.fulfillment.bindings[${index}].sourceUri`)
    });
  }));
  for (let index = 1; index < bindings.length; index++) {
    const prior = `${bindings[index - 1].kind}:${bindings[index - 1].ref}`, current = `${bindings[index].kind}:${bindings[index].ref}`;
    if (prior >= current) fail7(`${label}.fulfillment.bindings must be strictly kind/ref-sorted`);
  }
  const expectedStatus = bindings.length === 0 ? "metadata-only" : bindings.length === declared.size ? "fulfilled" : "partial";
  if (fulfillmentInput.status.value !== expectedStatus) fail7(`${label}.fulfillment.status must be '${expectedStatus}' for its declared bindings`);
  return Object.freeze({
    schema: BIOME_DEF_SCHEMA,
    id,
    version,
    displayName: text(d.displayName.value, BIOME_LIMITS.labelChars, `${label}.displayName`),
    taxonomy: Object.freeze({ category: taxonomyInput.category.value, tags }),
    climate,
    surfaceMaterials,
    vegetationPalette,
    resourceTableRefs,
    spawnTableRefs,
    waterTintSrgb,
    ambientAudioRefs,
    fulfillment: Object.freeze({ status: expectedStatus, bindings }),
    provenance: provenance(d.provenance.value, `${label}.provenance`)
  });
}
function parseBiomePack(value) {
  const d = record(value, /* @__PURE__ */ new Set(["schema", "id", "version", "definitions", "legacyAliases", "provenance"]), "biome pack");
  if (d.schema.value !== BIOME_PACK_SCHEMA) fail7(`biome pack.schema must be '${BIOME_PACK_SCHEMA}'`);
  const definitionsInput = dense(d.definitions.value, BIOME_LIMITS.definitions, "biome pack.definitions");
  if (definitionsInput.length < 1) fail7("biome pack.definitions must not be empty");
  const definitions2 = Object.freeze(definitionsInput.map((entry, index) => parseDefinition(entry, `biome pack.definitions[${index}]`)));
  for (let index = 1; index < definitions2.length; index++) if (definitions2[index - 1].id >= definitions2[index].id) fail7("biome pack.definitions must be strictly id-sorted and unique");
  const ids = new Set(definitions2.map((definition2) => definition2.id));
  const aliasesInput = dense(d.legacyAliases.value, BIOME_LIMITS.legacyAliases, "biome pack.legacyAliases");
  const legacyAliases = Object.freeze(aliasesInput.map((entry, index) => {
    const e = record(entry, /* @__PURE__ */ new Set(["legacyKind", "biomeId"]), `biome pack.legacyAliases[${index}]`);
    if (!LEGACY_BIOME_KINDS.includes(e.legacyKind.value)) fail7(`biome pack.legacyAliases[${index}].legacyKind is unsupported`);
    const biomeId = string(e.biomeId.value, ID, BIOME_LIMITS.idChars, `biome pack.legacyAliases[${index}].biomeId`);
    if (!ids.has(biomeId)) fail7(`biome pack legacy alias targets unknown biome '${biomeId}'`);
    return Object.freeze({ legacyKind: e.legacyKind.value, biomeId });
  }));
  for (let index = 1; index < legacyAliases.length; index++) if (legacyAliases[index - 1].legacyKind >= legacyAliases[index].legacyKind) fail7("biome pack.legacyAliases must be strictly legacyKind-sorted and unique");
  return Object.freeze({
    schema: BIOME_PACK_SCHEMA,
    id: string(d.id.value, ID, BIOME_LIMITS.idChars, "biome pack.id"),
    version: string(d.version.value, SEMVER, 64, "biome pack.version"),
    definitions: definitions2,
    legacyAliases,
    provenance: provenance(d.provenance.value, "biome pack.provenance")
  });
}
function stableStringifyBiomePack(value) {
  return JSON.stringify(parseBiomePack(value));
}
function biomePackContentHash(value) {
  return `sha256:${sha256(stableStringifyBiomePack(value))}`;
}

// src/world/biome-field.mjs
var BIOME_FIELD_SCHEMA = "limina.biome-field/v1";
var BIOME_FIELD_VERSION = 1;
var BIOME_FIELD_NONE = 65535;
var BIOME_FIELD_WEIGHT_TOTAL = 65535;
var BIOME_FIELD_LIMITS = Object.freeze({
  rows: 1025,
  cols: 1025,
  cells: 1050625,
  topN: 8,
  influences: 128,
  polygonPoints: 256,
  totalPolygonPoints: 4096,
  modifiers: 256,
  workUnits: 5e7,
  outputBytes: 64 * 1024 * 1024,
  idChars: 64
});

// src/world/compiler/biome-field-artifact.mjs
var BIOME_FIELD_ARTIFACT_SCHEMA = "limina.biome-field-artifact/v1";
var BIOME_FIELD_ARTIFACT_VERSION = 1;
var BIOME_FIELD_ARTIFACT_TYPE = "biome-field/v1";
var BIOME_FIELD_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.biome-field-v1";
var BIOME_FIELD_ARTIFACT_HEADER_BYTES = 112;
var BIOME_FIELD_ARTIFACT_MAX_BYTES = BIOME_FIELD_LIMITS.outputBytes + 64 * 1024;
var MAGIC7 = Object.freeze([76, 77, 66, 73, 79, 77, 69, 0]);
var ID2 = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
var SEMVER2 = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
var FIELD_KEYS = /* @__PURE__ */ new Set(["schema", "version", "pack", "grid", "topN", "biomeIds", "indices", "weights", "diagnostics"]);
var PACK_KEYS = /* @__PURE__ */ new Set(["id", "version"]);
var GRID_KEYS2 = /* @__PURE__ */ new Set(["origin", "rows", "cols", "cellSizeM"]);
var DIAGNOSTIC_KEYS = /* @__PURE__ */ new Set(["cells", "workUnits", "outputBytes", "influences", "modifiers"]);
var CONTROL_KEYS4 = /* @__PURE__ */ new Set(["shouldCancel"]);
var encoder2 = new TextEncoder();
var decoder2 = new TextDecoder("utf-8", { fatal: true });
var BiomeFieldArtifactValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "BiomeFieldArtifactValidationError";
    this.code = "biome_field_artifact_invalid";
  }
};
var BiomeFieldArtifactCancelledError = class extends Error {
  constructor() {
    super("biome field artifact operation cancelled");
    this.name = "BiomeFieldArtifactCancelledError";
    this.code = "biome_field_artifact_cancelled";
  }
};
function fail8(message) {
  throw new BiomeFieldArtifactValidationError(message);
}
function exactRecord5(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail8(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail8(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor2] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail8(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor2) || descriptor2.enumerable !== true) fail8(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail8(`${label} is missing '${key}'`);
  return descriptors;
}
function parseControl4(value) {
  if (value === void 0) return null;
  const d = exactRecord5(value, CONTROL_KEYS4, "biome field artifact control");
  if (typeof d.shouldCancel.value !== "function") fail8("biome field artifact control.shouldCancel must be a function");
  return d.shouldCancel.value;
}
function createMeter4(shouldCancel, limit) {
  let work = 0;
  const check = () => {
    if (shouldCancel?.()) throw new BiomeFieldArtifactCancelledError();
  };
  return Object.freeze({
    start: check,
    work() {
      if (++work > limit) fail8(`biome field artifact exceeded bounded validation work ${limit}`);
      if ((work & 1023) === 0) check();
    },
    finish: check
  });
}
function canonicalNumber3(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum) fail8(`${label} must be a canonical number in [${minimum}, ${maximum}]`);
  return value;
}
function integer4(value, minimum, maximum, label) {
  const result = canonicalNumber3(value, minimum, maximum, label);
  if (!Number.isSafeInteger(result)) fail8(`${label} must be an integer`);
  return result;
}
function string2(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail8(`${label} is invalid`);
  return value;
}
function denseStrings(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 2 || value.length > 64 || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail8(`${label} must be a dense standard array with 2-64 entries`);
  }
  const result = value.map((entry, index) => string2(entry, ID2, 64, `${label}[${index}]`));
  for (let index = 1; index < result.length; index++) if (result[index - 1] >= result[index]) fail8(`${label} must be strictly sorted and unique`);
  return Object.freeze(result);
}
function originTuple2(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2 || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== 3) fail8("biome field grid.origin must be a dense tuple");
  return Object.freeze([
    canonicalNumber3(value[0], -1e7, 1e7, "biome field grid.origin[0]"),
    canonicalNumber3(value[1], -1e7, 1e7, "biome field grid.origin[1]")
  ]);
}
function isShared2(buffer) {
  return Object.prototype.toString.call(buffer) === "[object SharedArrayBuffer]";
}
function ownedUint16(value, length, label) {
  if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== Uint16Array.prototype || !(value.buffer instanceof ArrayBuffer) || isShared2(value.buffer) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength || value.length !== length) {
    fail8(`${label} must own a complete non-shared Uint16Array of length ${length}`);
  }
  return value;
}
function parseField(input, meter) {
  const d = exactRecord5(input, FIELD_KEYS, "biome field");
  if (d.schema.value !== BIOME_FIELD_SCHEMA || d.version.value !== BIOME_FIELD_VERSION) fail8("biome field schema/version is unsupported");
  const packInput = exactRecord5(d.pack.value, PACK_KEYS, "biome field pack");
  const pack = Object.freeze({
    id: string2(packInput.id.value, ID2, 64, "biome field pack.id"),
    version: string2(packInput.version.value, SEMVER2, 64, "biome field pack.version")
  });
  const gridInput = exactRecord5(d.grid.value, GRID_KEYS2, "biome field grid");
  const rows = integer4(gridInput.rows.value, 1, BIOME_FIELD_LIMITS.rows, "biome field grid.rows");
  const cols = integer4(gridInput.cols.value, 1, BIOME_FIELD_LIMITS.cols, "biome field grid.cols");
  const cells = rows * cols;
  if (!Number.isSafeInteger(cells) || cells > BIOME_FIELD_LIMITS.cells) fail8("biome field cell count exceeds the supported limit");
  const grid = Object.freeze({
    origin: originTuple2(gridInput.origin.value),
    rows,
    cols,
    cellSizeM: canonicalNumber3(gridInput.cellSizeM.value, 0.01, 1e6, "biome field grid.cellSizeM")
  });
  const biomeIds = denseStrings(d.biomeIds.value, "biome field biomeIds");
  const topN = integer4(d.topN.value, 2, Math.min(BIOME_FIELD_LIMITS.topN, biomeIds.length), "biome field topN");
  const length = cells * topN;
  const indices = ownedUint16(d.indices.value, length, "biome field indices");
  const weights = ownedUint16(d.weights.value, length, "biome field weights");
  const diagnosticInput = exactRecord5(d.diagnostics.value, DIAGNOSTIC_KEYS, "biome field diagnostics");
  const outputBytes = cells * topN * 4;
  const diagnostics = Object.freeze({
    cells: integer4(diagnosticInput.cells.value, cells, cells, "biome field diagnostics.cells"),
    workUnits: integer4(diagnosticInput.workUnits.value, 0, BIOME_FIELD_LIMITS.workUnits, "biome field diagnostics.workUnits"),
    outputBytes: integer4(diagnosticInput.outputBytes.value, outputBytes, outputBytes, "biome field diagnostics.outputBytes"),
    influences: integer4(diagnosticInput.influences.value, 0, BIOME_FIELD_LIMITS.influences, "biome field diagnostics.influences"),
    modifiers: integer4(diagnosticInput.modifiers.value, 0, BIOME_FIELD_LIMITS.modifiers, "biome field diagnostics.modifiers")
  });
  for (let cell = 0; cell < cells; cell++) {
    let sum = 0;
    let priorWeight = Infinity;
    let empty = false;
    const seen = /* @__PURE__ */ new Set();
    for (let rank = 0; rank < topN; rank++) {
      meter.work();
      const offset = cell * topN + rank;
      const index = indices[offset], weight = weights[offset];
      if (index === BIOME_FIELD_NONE) {
        if (weight !== 0) fail8(`biome field cell ${cell} empty rank has nonzero weight`);
        empty = true;
        continue;
      }
      if (empty || index >= biomeIds.length || weight === 0 || weight > priorWeight || seen.has(index)) fail8(`biome field cell ${cell} rank ${rank} is non-canonical`);
      seen.add(index);
      priorWeight = weight;
      sum += weight;
    }
    if (sum !== BIOME_FIELD_WEIGHT_TOTAL) fail8(`biome field cell ${cell} weights do not normalize exactly`);
  }
  return Object.freeze({ schema: BIOME_FIELD_SCHEMA, version: BIOME_FIELD_VERSION, pack, grid, topN, biomeIds, indices, weights, diagnostics });
}
function align42(value) {
  return value + 3 & ~3;
}
function artifactBytes2(input) {
  if (!ArrayBuffer.isView(input) || Object.getPrototypeOf(input) !== Uint8Array.prototype || !(input.buffer instanceof ArrayBuffer) || isShared2(input.buffer) || input.byteOffset !== 0 || input.byteLength !== input.buffer.byteLength) fail8("biome field artifact bytes must be an owned Uint8Array over a non-shared ArrayBuffer");
  if (input.byteLength < BIOME_FIELD_ARTIFACT_HEADER_BYTES || input.byteLength > BIOME_FIELD_ARTIFACT_MAX_BYTES) fail8("biome field artifact byte length is outside the supported range");
  return input;
}
function decodeString2(bytes, start, length, label) {
  try {
    const value = decoder2.decode(bytes.subarray(start, start + length));
    if (encoder2.encode(value).length !== length) fail8(`${label} is not canonical UTF-8`);
    return value;
  } catch (error) {
    if (error instanceof BiomeFieldArtifactValidationError) throw error;
    fail8(`${label} is invalid UTF-8`);
  }
}
function decodeBiomeFieldArtifact(input, controlInput) {
  const bytes = artifactBytes2(input);
  const meter = createMeter4(parseControl4(controlInput), BIOME_FIELD_LIMITS.cells * BIOME_FIELD_LIMITS.topN * 4 + 8192);
  meter.start();
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC7.length; index++) if (view.getUint8(index) !== MAGIC7[index]) fail8("biome field artifact magic mismatch");
  if (view.getUint16(8, true) !== BIOME_FIELD_ARTIFACT_VERSION) fail8("biome field artifact version is unsupported");
  if (view.getUint16(10, true) !== BIOME_FIELD_ARTIFACT_HEADER_BYTES) fail8("biome field artifact header length mismatch");
  if (view.getUint32(12, true) !== bytes.byteLength) fail8("biome field artifact byte length is non-canonical");
  for (let offset = 84; offset < BIOME_FIELD_ARTIFACT_HEADER_BYTES; offset++) if (bytes[offset] !== 0) fail8("biome field artifact reserved header bytes must be zero");
  const rows = view.getUint32(16, true), cols = view.getUint32(20, true), cells = rows * cols;
  if (!Number.isSafeInteger(cells) || cells !== view.getUint32(24, true) || cells < 1 || cells > BIOME_FIELD_LIMITS.cells) fail8("biome field artifact cell count is invalid");
  const topN = view.getUint16(28, true), biomeCount = view.getUint16(30, true);
  if (biomeCount < 2 || biomeCount > 64 || topN < 2 || topN > Math.min(BIOME_FIELD_LIMITS.topN, biomeCount)) fail8("biome field artifact rank/biome count is invalid");
  const packIdLength = view.getUint16(56, true), packVersionLength = view.getUint16(58, true), stringTableBytes = view.getUint32(60, true);
  let cursor = BIOME_FIELD_ARTIFACT_HEADER_BYTES;
  if (cursor + stringTableBytes > bytes.byteLength || stringTableBytes < packIdLength + packVersionLength + biomeCount * 3) fail8("biome field artifact string table is invalid");
  const packId = decodeString2(bytes, cursor, packIdLength, "biome field pack id");
  cursor += packIdLength;
  const packVersion = decodeString2(bytes, cursor, packVersionLength, "biome field pack version");
  cursor += packVersionLength;
  const biomeIds = [];
  for (let index = 0; index < biomeCount; index++) {
    if (cursor + 2 > BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes) fail8("biome field artifact biome string descriptor is truncated");
    const length = view.getUint16(cursor, true);
    cursor += 2;
    if (length < 1 || cursor + length > BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes) fail8("biome field artifact biome string is truncated");
    biomeIds.push(decodeString2(bytes, cursor, length, `biome field id ${index}`));
    cursor += length;
  }
  if (cursor !== BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes) fail8("biome field artifact string table has trailing bytes");
  const shell = {
    indices: { byteLength: cells * topN * 2 },
    weights: { byteLength: cells * topN * 2 }
  };
  const expectedIndices = align42(BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes);
  const expectedWeights = expectedIndices + shell.indices.byteLength;
  const expectedLength = expectedWeights + shell.weights.byteLength;
  if (view.getUint32(64, true) !== expectedIndices || view.getUint32(68, true) !== expectedWeights || bytes.byteLength !== expectedLength) fail8("biome field artifact channel layout is non-canonical");
  for (let offset = BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes; offset < expectedIndices; offset++) if (bytes[offset] !== 0) fail8("biome field artifact alignment padding must be zero");
  const indices = new Uint16Array(cells * topN);
  const weights = new Uint16Array(cells * topN);
  for (let index = 0; index < indices.length; index++) {
    meter.work();
    indices[index] = view.getUint16(expectedIndices + index * 2, true);
  }
  for (let index = 0; index < weights.length; index++) {
    meter.work();
    weights[index] = view.getUint16(expectedWeights + index * 2, true);
  }
  const field = {
    schema: BIOME_FIELD_SCHEMA,
    version: BIOME_FIELD_VERSION,
    pack: { id: packId, version: packVersion },
    grid: { origin: [view.getFloat64(32, true), view.getFloat64(40, true)], rows, cols, cellSizeM: view.getFloat64(48, true) },
    topN,
    biomeIds,
    indices,
    weights,
    diagnostics: {
      cells,
      workUnits: view.getUint32(72, true),
      outputBytes: view.getUint32(76, true),
      influences: view.getUint16(80, true),
      modifiers: view.getUint16(82, true)
    }
  };
  const parsed = parseField(field, meter);
  meter.finish();
  return Object.freeze({
    field: parsed,
    metadata: Object.freeze({
      schema: BIOME_FIELD_ARTIFACT_SCHEMA,
      artifactType: BIOME_FIELD_ARTIFACT_TYPE,
      mediaType: BIOME_FIELD_ARTIFACT_MEDIA_TYPE,
      version: BIOME_FIELD_ARTIFACT_VERSION,
      byteLength: bytes.byteLength,
      contentHash: `sha256:${sha256(bytes)}`,
      storage: "owned-transferable-channel-copies"
    })
  });
}

// src/world/biome-population-asset.mjs
var BIOME_POPULATION_ASSET_BACKENDS = Object.freeze([
  "continuous-grass-field",
  "grass-field",
  "tree-population",
  "instanced-asset"
]);
var BIOME_POPULATION_CLIMATES = Object.freeze(["summer", "autumn", "winter", "dry"]);
var BIOME_POPULATION_TREE_CAPS = Object.freeze({
  species: 12,
  active: 24576,
  activeAndPending: 30720,
  hysteresisMaximum: 0.49
});
var BIOME_POPULATION_ASSET_LIMITS = Object.freeze({
  idChars: 64,
  refChars: 160,
  versionChars: 64,
  labelChars: 96,
  uriChars: 512,
  densityScale: 100,
  bladeScale: 100,
  distance: 1e6
});

// src/world/compiler/biome-population-artifact.mjs
var BIOME_POPULATION_ARTIFACT_SCHEMA = "limina.biome-population-artifact/v1";
var BIOME_POPULATION_ARTIFACT_TYPE = "biome-population-plan/v1";
var BIOME_POPULATION_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.biome-population-plan-v1";
var BIOME_POPULATION_ARTIFACT_VERSION = 1;
var BIOME_POPULATION_ARTIFACT_HEADER_BYTES = 160;
var BIOME_POPULATION_ARTIFACT_PLACEMENT_BYTES = 56;
var MAX_BIOME_POPULATION_ARTIFACT_PLACEMENTS = 24576;
var MAX_BIOME_POPULATION_ARTIFACT_BYTES = 12 * 1024 * 1024;
var MAGIC8 = Object.freeze([76, 77, 80, 79, 80, 85, 76, 0]);
var HASH5 = /^sha256:[0-9a-f]{64}$/;
var REF2 = /^[a-z][a-z0-9._/-]*$/;
var ROOT_KEYS2 = /* @__PURE__ */ new Set(["schema", "coord", "identity", "placements"]);
var COORD_KEYS = /* @__PURE__ */ new Set(["tx", "tz", "lod"]);
var IDENTITY_KEYS = /* @__PURE__ */ new Set(["fieldContentHash", "runtimePackContentHash"]);
var PLACEMENT_KEYS2 = /* @__PURE__ */ new Set(["role", "assetId", "contentHash", "x", "y", "z", "yaw", "scale", "pageX", "pageZ"]);
var CONTROL_KEYS5 = /* @__PURE__ */ new Set(["shouldCancel"]);
var encoder3 = new TextEncoder();
var decoder3 = new TextDecoder("utf-8", { fatal: true });
var MAX_COORD = 1e6;
var MAX_WORLD_METRES = 1e7;
var MAX_SCALE = 100;
var BiomePopulationArtifactValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "BiomePopulationArtifactValidationError";
    this.code = "biome_population_artifact_invalid";
  }
};
var BiomePopulationArtifactCancelledError = class extends Error {
  constructor() {
    super("biome population artifact operation cancelled");
    this.name = "BiomePopulationArtifactCancelledError";
    this.code = "biome_population_artifact_cancelled";
  }
};
function fail9(message) {
  throw new BiomePopulationArtifactValidationError(message);
}
function isShared3(buffer) {
  return Object.prototype.toString.call(buffer) === "[object SharedArrayBuffer]";
}
function align82(value) {
  return value + 7 & ~7;
}
function exactRecord6(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail9(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) fail9(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor2] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail9(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor2) || descriptor2.enumerable !== true) fail9(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail9(`${label} is missing '${key}'`);
  return descriptors;
}
function denseArray2(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail9(`${label} must be a dense standard array with at most ${maximum} entries`);
  }
  return value;
}
function parseControl5(value) {
  if (value === void 0) return null;
  const d = exactRecord6(value, CONTROL_KEYS5, "biome population artifact control");
  if (typeof d.shouldCancel.value !== "function") fail9("biome population artifact control.shouldCancel must be a function");
  return d.shouldCancel.value;
}
function createMeter5(shouldCancel) {
  let work = 0;
  const check = () => {
    if (shouldCancel?.() === true) throw new BiomePopulationArtifactCancelledError();
  };
  return Object.freeze({
    start: check,
    work() {
      work++;
      if (work > MAX_BIOME_POPULATION_ARTIFACT_PLACEMENTS * 8 + 65536) fail9("biome population artifact validation work exceeded its bound");
      if ((work & 1023) === 0) check();
    },
    finish: check
  });
}
function canonicalNumber4(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum) {
    fail9(`${label} must be a canonical number in [${minimum}, ${maximum}]`);
  }
  return value;
}
function integer5(value, minimum, maximum, label) {
  const result = canonicalNumber4(value, minimum, maximum, label);
  if (!Number.isSafeInteger(result)) fail9(`${label} must be an integer`);
  return result;
}
function reference(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > BIOME_POPULATION_ASSET_LIMITS.refChars || !REF2.test(value)) {
    fail9(`${label} is invalid`);
  }
  const bytes = encoder3.encode(value);
  if (bytes.length > BIOME_POPULATION_ASSET_LIMITS.refChars) fail9(`${label} UTF-8 encoding is too long`);
  return Object.freeze({ value, bytes });
}
function contentHash(value, label) {
  if (typeof value !== "string" || !HASH5.test(value)) fail9(`${label} must be a canonical content hash`);
  return value;
}
function readHex(bytes, offset) {
  let result = "";
  for (let index = 0; index < 32; index++) result += bytes[offset + index].toString(16).padStart(2, "0");
  return result;
}
function descriptorKey2(role, assetId2, hash2) {
  return `${role}\0${assetId2}\0${hash2}`;
}
function parsePlan(input, meter) {
  const root = exactRecord6(input, ROOT_KEYS2, "biome population artifact plan");
  if (root.schema.value !== BIOME_POPULATION_ARTIFACT_SCHEMA) fail9("biome population artifact plan schema is unsupported");
  const coordInput = exactRecord6(root.coord.value, COORD_KEYS, "biome population artifact coord");
  const coord = Object.freeze({
    tx: integer5(coordInput.tx.value, -MAX_COORD, MAX_COORD, "biome population artifact coord.tx"),
    tz: integer5(coordInput.tz.value, -MAX_COORD, MAX_COORD, "biome population artifact coord.tz"),
    lod: integer5(coordInput.lod.value, 0, 16, "biome population artifact coord.lod")
  });
  const identityInput = exactRecord6(root.identity.value, IDENTITY_KEYS, "biome population artifact identity");
  const identity = Object.freeze({
    fieldContentHash: contentHash(identityInput.fieldContentHash.value, "biome population artifact identity.fieldContentHash"),
    runtimePackContentHash: contentHash(identityInput.runtimePackContentHash.value, "biome population artifact identity.runtimePackContentHash")
  });
  const source = denseArray2(root.placements.value, MAX_BIOME_POPULATION_ARTIFACT_PLACEMENTS, "biome population artifact placements");
  const placements = new Array(source.length);
  for (let index = 0; index < source.length; index++) {
    meter.work();
    const d = exactRecord6(source[index], PLACEMENT_KEYS2, `biome population artifact placements[${index}]`);
    const role = reference(d.role.value, `biome population artifact placements[${index}].role`).value;
    const assetId2 = reference(d.assetId.value, `biome population artifact placements[${index}].assetId`).value;
    const hash2 = contentHash(d.contentHash.value, `biome population artifact placements[${index}].contentHash`);
    const scale = canonicalNumber4(d.scale.value, Number.MIN_VALUE, MAX_SCALE, `biome population artifact placements[${index}].scale`);
    if (scale === 0) fail9(`biome population artifact placements[${index}].scale must be positive`);
    placements[index] = Object.freeze({
      role,
      assetId: assetId2,
      contentHash: hash2,
      x: canonicalNumber4(d.x.value, -MAX_WORLD_METRES, MAX_WORLD_METRES, `biome population artifact placements[${index}].x`),
      y: canonicalNumber4(d.y.value, -MAX_WORLD_METRES, MAX_WORLD_METRES, `biome population artifact placements[${index}].y`),
      z: canonicalNumber4(d.z.value, -MAX_WORLD_METRES, MAX_WORLD_METRES, `biome population artifact placements[${index}].z`),
      yaw: canonicalNumber4(d.yaw.value, -Math.PI * 2, Math.PI * 2, `biome population artifact placements[${index}].yaw`),
      scale,
      pageX: integer5(d.pageX.value, -MAX_COORD, MAX_COORD, `biome population artifact placements[${index}].pageX`),
      pageZ: integer5(d.pageZ.value, -MAX_COORD, MAX_COORD, `biome population artifact placements[${index}].pageZ`)
    });
  }
  return Object.freeze({ schema: BIOME_POPULATION_ARTIFACT_SCHEMA, coord, identity, placements: Object.freeze(placements) });
}
function integrityBytes(bytes) {
  const material = new Uint8Array(bytes);
  material.fill(0, 112, 144);
  return material;
}
function artifactBytes3(input) {
  if (!ArrayBuffer.isView(input) || Object.getPrototypeOf(input) !== Uint8Array.prototype || !(input.buffer instanceof ArrayBuffer) || isShared3(input.buffer) || input.byteOffset !== 0 || input.byteLength !== input.buffer.byteLength) {
    fail9("biome population artifact bytes must be an owned Uint8Array over a non-shared ArrayBuffer");
  }
  if (input.length < BIOME_POPULATION_ARTIFACT_HEADER_BYTES || input.length > MAX_BIOME_POPULATION_ARTIFACT_BYTES) {
    fail9("biome population artifact byte length is outside the supported range");
  }
  return input;
}
function decodeString3(bytes, start, length, label) {
  try {
    const value = decoder3.decode(bytes.subarray(start, start + length));
    if (encoder3.encode(value).length !== length) fail9(`${label} is not canonical UTF-8`);
    return value;
  } catch (error) {
    if (error instanceof BiomePopulationArtifactValidationError) throw error;
    fail9(`${label} is invalid UTF-8`);
  }
}
function decodeBiomePopulationArtifact(input, controlInput) {
  const bytes = artifactBytes3(input);
  const meter = createMeter5(parseControl5(controlInput));
  meter.start();
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC8.length; index++) if (bytes[index] !== MAGIC8[index]) fail9("biome population artifact magic mismatch");
  if (view.getUint16(8, true) !== BIOME_POPULATION_ARTIFACT_VERSION) fail9("biome population artifact version is unsupported");
  if (view.getUint16(10, true) !== BIOME_POPULATION_ARTIFACT_HEADER_BYTES) fail9("biome population artifact header length mismatch");
  if (view.getUint32(12, true) !== bytes.length) fail9("biome population artifact byte length is non-canonical");
  if (view.getUint16(26, true) !== 0) fail9("biome population artifact reserved header bytes must be zero");
  for (let offset = 144; offset < BIOME_POPULATION_ARTIFACT_HEADER_BYTES; offset++) if (bytes[offset] !== 0) fail9("biome population artifact reserved header bytes must be zero");
  const expectedIntegrity = readHex(bytes, 112), actualIntegrity = sha256(integrityBytes(bytes));
  meter.finish();
  if (expectedIntegrity !== actualIntegrity) fail9("biome population artifact integrity hash mismatch");
  const placementCount = view.getUint32(28, true), descriptorCount = view.getUint32(32, true);
  if (placementCount > MAX_BIOME_POPULATION_ARTIFACT_PLACEMENTS || descriptorCount > placementCount) fail9("biome population artifact count is out of bounds");
  const descriptorOffset = view.getUint32(36, true), descriptorBytes = view.getUint32(40, true), placementOffset = view.getUint32(44, true);
  const expectedPlacementOffset = align82(BIOME_POPULATION_ARTIFACT_HEADER_BYTES + descriptorBytes);
  const expectedLength = expectedPlacementOffset + placementCount * BIOME_POPULATION_ARTIFACT_PLACEMENT_BYTES;
  if (descriptorOffset !== BIOME_POPULATION_ARTIFACT_HEADER_BYTES || placementOffset !== expectedPlacementOffset || expectedLength !== bytes.length) {
    fail9("biome population artifact table layout is non-canonical");
  }
  for (let offset = descriptorOffset + descriptorBytes; offset < placementOffset; offset++) if (bytes[offset] !== 0) fail9("biome population artifact alignment padding must be zero");
  const descriptors = new Array(descriptorCount);
  let cursor = descriptorOffset, priorKey = null;
  for (let index = 0; index < descriptorCount; index++) {
    meter.work();
    if (cursor + 36 > descriptorOffset + descriptorBytes) fail9("biome population artifact descriptor is truncated");
    const roleLength = view.getUint16(cursor, true), assetIdLength = view.getUint16(cursor + 2, true);
    if (roleLength < 1 || assetIdLength < 1 || roleLength > BIOME_POPULATION_ASSET_LIMITS.refChars || assetIdLength > BIOME_POPULATION_ASSET_LIMITS.refChars || cursor + 36 + roleLength + assetIdLength > descriptorOffset + descriptorBytes) {
      fail9("biome population artifact descriptor string length is invalid");
    }
    const hash2 = `sha256:${readHex(bytes, cursor + 4)}`;
    cursor += 36;
    const role = decodeString3(bytes, cursor, roleLength, `biome population artifact descriptor ${index} role`);
    cursor += roleLength;
    const assetId2 = decodeString3(bytes, cursor, assetIdLength, `biome population artifact descriptor ${index} assetId`);
    cursor += assetIdLength;
    const checkedRole = reference(role, `biome population artifact descriptor ${index} role`).value;
    const checkedAssetId = reference(assetId2, `biome population artifact descriptor ${index} assetId`).value;
    contentHash(hash2, `biome population artifact descriptor ${index} hash`);
    const key = descriptorKey2(checkedRole, checkedAssetId, hash2);
    if (priorKey !== null && priorKey >= key) fail9("biome population artifact descriptors are not strictly sorted and unique");
    priorKey = key;
    descriptors[index] = Object.freeze({ role: checkedRole, assetId: checkedAssetId, contentHash: hash2 });
  }
  if (cursor !== descriptorOffset + descriptorBytes) fail9("biome population artifact descriptor table has trailing bytes");
  const placements = new Array(placementCount);
  for (let index = 0; index < placementCount; index++) {
    meter.work();
    const offset = placementOffset + index * BIOME_POPULATION_ARTIFACT_PLACEMENT_BYTES;
    const descriptorIndex = view.getUint32(offset, true);
    if (descriptorIndex >= descriptors.length) fail9(`biome population artifact placement ${index} descriptor index is invalid`);
    if (view.getUint32(offset + 12, true) !== 0) fail9(`biome population artifact placement ${index} reserved bytes must be zero`);
    const descriptor2 = descriptors[descriptorIndex];
    placements[index] = {
      ...descriptor2,
      x: view.getFloat64(offset + 16, true),
      y: view.getFloat64(offset + 24, true),
      z: view.getFloat64(offset + 32, true),
      yaw: view.getFloat64(offset + 40, true),
      scale: view.getFloat64(offset + 48, true),
      pageX: view.getInt32(offset + 4, true),
      pageZ: view.getInt32(offset + 8, true)
    };
  }
  const shell = {
    schema: BIOME_POPULATION_ARTIFACT_SCHEMA,
    coord: { tx: view.getInt32(16, true), tz: view.getInt32(20, true), lod: view.getUint16(24, true) },
    identity: { fieldContentHash: `sha256:${readHex(bytes, 48)}`, runtimePackContentHash: `sha256:${readHex(bytes, 80)}` },
    placements
  };
  const plan = parsePlan(shell, meter);
  meter.finish();
  return Object.freeze({
    plan,
    metadata: Object.freeze({
      schema: BIOME_POPULATION_ARTIFACT_SCHEMA,
      artifactType: BIOME_POPULATION_ARTIFACT_TYPE,
      mediaType: BIOME_POPULATION_ARTIFACT_MEDIA_TYPE,
      version: BIOME_POPULATION_ARTIFACT_VERSION,
      byteLength: bytes.length,
      contentHash: `sha256:${sha256(bytes)}`,
      storage: "owned-object-and-array-copies"
    })
  });
}

// src/world/biome-content-bundle.mjs
var BIOME_CONTENT_BUNDLE_SCHEMA = "limina.biome-content-bundle/v1";
var BIOME_CONTENT_BUNDLE_STATUSES = Object.freeze(["candidate", "accepted"]);
var BIOME_CONTENT_BUNDLE_KINDS = Object.freeze([
  "surface-wrapper",
  "authoring-recipe",
  "material-pack",
  "texture",
  "population-descriptor",
  "model-source",
  "model-lod",
  "impostor",
  "mechanical-evidence",
  "human-visual-evidence"
]);
var BIOME_CONTENT_BUNDLE_LICENSES = Object.freeze({
  tierA: Object.freeze(["CC0-1.0", "MIT", "Apache-2.0"]),
  tierB: Object.freeze(["CC-BY-3.0", "CC-BY-4.0"])
});
var BIOME_CONTENT_BUNDLE_LIMITS = Object.freeze({
  entries: 4096,
  idChars: 160,
  versionChars: 64,
  labelChars: 256,
  uriChars: 1024,
  entryBytes: 512 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024 * 1024,
  canonicalBytes: 4 * 1024 * 1024
});
var ID3 = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
var REF3 = /^[A-Za-z0-9._/-]+$/;
var SEMVER3 = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
var HASH6 = /^sha256:[0-9a-f]{64}$/;
var HTTPS = /^https:\/\/[^\s]+$/;
var PRODUCTION_WRAPPER_KINDS = /* @__PURE__ */ new Set(["surface-wrapper", "population-descriptor"]);
var BiomeContentBundleValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "BiomeContentBundleValidationError";
  }
};
function fail10(message) {
  throw new BiomeContentBundleValidationError(message);
}
function record2(value, required, optional, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail10(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail10(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail10(`${label} must not contain symbol fields`);
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor2] of Object.entries(descriptors)) {
    if (!allowed.has(key)) fail10(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor2) || descriptor2.enumerable !== true) {
      fail10(`${label}.${key} must be an enumerable data field`);
    }
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail10(`${label} is missing '${key}'`);
  return descriptors;
}
function dense2(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail10(`${label} must be a dense, field-free standard array with at most ${maximum} entries`);
  }
  return value;
}
function string3(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) {
    fail10(`${label} is invalid`);
  }
  return value;
}
function text2(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) fail10(`${label} is invalid`);
  return value;
}
function assetId(value, label) {
  const parsed = string3(value, REF3, BIOME_CONTENT_BUNDLE_LIMITS.idChars, label);
  if (parsed.startsWith("/") || parsed.includes("\\") || parsed.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail10(`${label} contains an unsafe path segment`);
  }
  return parsed;
}
function https(value, label) {
  return string3(value, HTTPS, BIOME_CONTENT_BUNDLE_LIMITS.uriChars, label);
}
function byteLength(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 1 || value > BIOME_CONTENT_BUNDLE_LIMITS.entryBytes) {
    fail10(`${label} must be a positive canonical integer no greater than ${BIOME_CONTENT_BUNDLE_LIMITS.entryBytes}`);
  }
  return value;
}
function parseIdentity(value, label) {
  const d = record2(value, /* @__PURE__ */ new Set(["assetId", "contentHash"]), /* @__PURE__ */ new Set(), label);
  return Object.freeze({
    assetId: assetId(d.assetId.value, `${label}.assetId`),
    contentHash: string3(d.contentHash.value, HASH6, 71, `${label}.contentHash`)
  });
}
function parseAttribution(value, label) {
  const d = record2(value, /* @__PURE__ */ new Set(["author", "title", "sourceUrl", "licenseUrl", "modified"]), /* @__PURE__ */ new Set(), label);
  if (typeof d.modified.value !== "boolean") fail10(`${label}.modified must be a boolean`);
  return Object.freeze({
    author: text2(d.author.value, BIOME_CONTENT_BUNDLE_LIMITS.labelChars, `${label}.author`),
    title: text2(d.title.value, BIOME_CONTENT_BUNDLE_LIMITS.labelChars, `${label}.title`),
    sourceUrl: https(d.sourceUrl.value, `${label}.sourceUrl`),
    licenseUrl: https(d.licenseUrl.value, `${label}.licenseUrl`),
    modified: d.modified.value
  });
}
function parseProvenance(value, label) {
  const d = record2(value, /* @__PURE__ */ new Set(["licenseSpdx", "sourceUri"]), /* @__PURE__ */ new Set(["attribution"]), label);
  const licenseSpdx = text2(d.licenseSpdx.value, 32, `${label}.licenseSpdx`);
  const tierA = BIOME_CONTENT_BUNDLE_LICENSES.tierA.includes(licenseSpdx);
  const tierB = BIOME_CONTENT_BUNDLE_LICENSES.tierB.includes(licenseSpdx);
  if (!tierA && !tierB) fail10(`${label}.licenseSpdx '${licenseSpdx}' is not an allowed Tier A or Tier B license`);
  if (tierB && d.attribution === void 0) fail10(`${label}.attribution is required for ${licenseSpdx}`);
  const attribution = d.attribution === void 0 ? void 0 : parseAttribution(d.attribution.value, `${label}.attribution`);
  return Object.freeze({
    licenseSpdx,
    sourceUri: text2(d.sourceUri.value, BIOME_CONTENT_BUNDLE_LIMITS.uriChars, `${label}.sourceUri`),
    ...attribution === void 0 ? {} : { attribution }
  });
}
function parseAcceptance(value, status, label) {
  const d = record2(value, /* @__PURE__ */ new Set(["mechanicalEvidence"]), /* @__PURE__ */ new Set(["humanVisualEvidence"]), label);
  if (status === "accepted" && d.humanVisualEvidence === void 0) {
    fail10(`${label}.humanVisualEvidence is required for an accepted bundle`);
  }
  if (status === "candidate" && d.humanVisualEvidence !== void 0) {
    fail10(`${label}.humanVisualEvidence cannot be claimed by a candidate bundle`);
  }
  return Object.freeze({
    mechanicalEvidence: parseIdentity(d.mechanicalEvidence.value, `${label}.mechanicalEvidence`),
    ...d.humanVisualEvidence === void 0 ? {} : {
      humanVisualEvidence: parseIdentity(d.humanVisualEvidence.value, `${label}.humanVisualEvidence`)
    }
  });
}
function parseEntry(value, index, status) {
  const label = `biome content bundle.entries[${index}]`;
  const d = record2(
    value,
    /* @__PURE__ */ new Set(["assetId", "contentHash", "kind", "byteLength", "provenance"]),
    /* @__PURE__ */ new Set(["acceptance"]),
    label
  );
  if (!BIOME_CONTENT_BUNDLE_KINDS.includes(d.kind.value)) fail10(`${label}.kind is unsupported`);
  const productionRequired = PRODUCTION_WRAPPER_KINDS.has(d.kind.value);
  if (productionRequired && d.acceptance === void 0) fail10(`${label}.acceptance is required for production wrapper kind '${d.kind.value}'`);
  if (!productionRequired && d.acceptance !== void 0) fail10(`${label}.acceptance is only valid on production wrapper entries`);
  return Object.freeze({
    assetId: assetId(d.assetId.value, `${label}.assetId`),
    contentHash: string3(d.contentHash.value, HASH6, 71, `${label}.contentHash`),
    kind: d.kind.value,
    byteLength: byteLength(d.byteLength.value, `${label}.byteLength`),
    provenance: parseProvenance(d.provenance.value, `${label}.provenance`),
    ...d.acceptance === void 0 ? {} : { acceptance: parseAcceptance(d.acceptance.value, status, `${label}.acceptance`) }
  });
}
function utf8ByteLength2(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const codePoint = value.codePointAt(index);
    if (codePoint > 65535) index++;
    bytes += codePoint < 128 ? 1 : codePoint < 2048 ? 2 : codePoint < 65536 ? 3 : 4;
  }
  return bytes;
}
function parseCore2(value, withClosureHash) {
  const required = /* @__PURE__ */ new Set(["schema", "id", "version", "status", "runtimePack", "entries"]);
  if (withClosureHash) required.add("closureHash");
  const d = record2(value, required, /* @__PURE__ */ new Set(), "biome content bundle");
  if (d.schema.value !== BIOME_CONTENT_BUNDLE_SCHEMA) {
    fail10(`biome content bundle.schema must be '${BIOME_CONTENT_BUNDLE_SCHEMA}'`);
  }
  if (!BIOME_CONTENT_BUNDLE_STATUSES.includes(d.status.value)) fail10("biome content bundle.status is unsupported");
  const status = d.status.value;
  const runtimePack = parseIdentity(d.runtimePack.value, "biome content bundle.runtimePack");
  const sourceEntries = dense2(d.entries.value, BIOME_CONTENT_BUNDLE_LIMITS.entries, "biome content bundle.entries");
  if (sourceEntries.length < 1) fail10("biome content bundle.entries must not be empty");
  const entries = Object.freeze(sourceEntries.map((entry, index) => parseEntry(entry, index, status)));
  for (let index = 1; index < entries.length; index++) {
    if (entries[index - 1].assetId >= entries[index].assetId) {
      fail10("biome content bundle.entries must be strictly assetId-sorted and unique");
    }
  }
  if (entries.some((entry) => entry.assetId === runtimePack.assetId)) {
    fail10("biome content bundle runtime-pack assetId must not collide with a leaf entry");
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > BIOME_CONTENT_BUNDLE_LIMITS.totalBytes) {
    fail10(`biome content bundle entry bytes exceed ${BIOME_CONTENT_BUNDLE_LIMITS.totalBytes}`);
  }
  const byId = new Map(entries.map((entry) => [entry.assetId, entry]));
  for (const entry of entries) {
    if (entry.acceptance === void 0) continue;
    for (const [field, expectedKind] of [
      ["mechanicalEvidence", "mechanical-evidence"],
      ["humanVisualEvidence", "human-visual-evidence"]
    ]) {
      const identity = entry.acceptance[field];
      if (identity === void 0) continue;
      const evidence = byId.get(identity.assetId);
      if (evidence === void 0) fail10(`${entry.assetId} ${field} does not resolve inside the bundle closure`);
      if (evidence.kind !== expectedKind) fail10(`${entry.assetId} ${field} must resolve to kind '${expectedKind}'`);
      if (evidence.contentHash !== identity.contentHash) fail10(`${entry.assetId} ${field} contentHash does not match its closure entry`);
    }
  }
  const core = Object.freeze({
    schema: BIOME_CONTENT_BUNDLE_SCHEMA,
    id: string3(d.id.value, ID3, 64, "biome content bundle.id"),
    version: string3(d.version.value, SEMVER3, BIOME_CONTENT_BUNDLE_LIMITS.versionChars, "biome content bundle.version"),
    status,
    runtimePack,
    entries
  });
  const closureBytes = JSON.stringify({ status, runtimePack, entries });
  if (utf8ByteLength2(closureBytes) > BIOME_CONTENT_BUNDLE_LIMITS.canonicalBytes) {
    fail10(`biome content bundle canonical closure exceeds ${BIOME_CONTENT_BUNDLE_LIMITS.canonicalBytes} bytes`);
  }
  const derivedClosureHash = `sha256:${sha256(closureBytes)}`;
  if (!withClosureHash) return Object.freeze({ core, derivedClosureHash });
  const supplied = string3(d.closureHash.value, HASH6, 71, "biome content bundle.closureHash");
  if (supplied !== derivedClosureHash) fail10("biome content bundle.closureHash does not match its runtime pack and entries");
  return Object.freeze({ core, derivedClosureHash });
}
function parseBiomeContentBundle(value) {
  const parsed = parseCore2(value, true);
  return Object.freeze({ ...parsed.core, closureHash: parsed.derivedClosureHash });
}
function stableStringifyBiomeContentBundle(value) {
  return JSON.stringify(parseBiomeContentBundle(value));
}

// src/world/compiler/biome-content-closure-artifact.mjs
var BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE = "biome-content-closure/v1";
var BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.biome-content-bundle-v1+json";
var MAX_BIOME_CONTENT_CLOSURE_ARTIFACT_BYTES = BIOME_CONTENT_BUNDLE_LIMITS.canonicalBytes + 1;
var BiomeContentClosureArtifactError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "BiomeContentClosureArtifactError";
  }
};
var BiomeContentClosureArtifactCancelledError = class extends Error {
  constructor() {
    super("biome content closure artifact operation cancelled");
    this.name = "BiomeContentClosureArtifactCancelledError";
  }
};
var encoder4 = new TextEncoder();
var decoder4 = new TextDecoder("utf-8", { fatal: true });
function cancel(control) {
  if (control !== void 0 && (control === null || typeof control !== "object" || Array.isArray(control) || Object.getPrototypeOf(control) !== Object.prototype || Object.keys(control).join() !== "shouldCancel" || typeof control.shouldCancel !== "function")) {
    throw new BiomeContentClosureArtifactError("biome content closure artifact control must contain exactly shouldCancel");
  }
  if (control?.shouldCancel() === true) throw new BiomeContentClosureArtifactCancelledError();
}
function ownedBytes2(value) {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    throw new BiomeContentClosureArtifactError("biome content closure artifact bytes must be an owned complete Uint8Array");
  }
  if (value.byteLength < 2 || value.byteLength > MAX_BIOME_CONTENT_CLOSURE_ARTIFACT_BYTES) {
    throw new BiomeContentClosureArtifactError("biome content closure artifact byte length is outside its bounded range");
  }
  return value;
}
function encodeBiomeContentClosureArtifact(bundle, control) {
  cancel(control);
  const bytes = encoder4.encode(`${stableStringifyBiomeContentBundle(bundle)}
`);
  if (bytes.byteLength > MAX_BIOME_CONTENT_CLOSURE_ARTIFACT_BYTES) {
    throw new BiomeContentClosureArtifactError("biome content closure artifact exceeds its byte cap");
  }
  cancel(control);
  return bytes;
}
function decodeBiomeContentClosureArtifact(input, control) {
  const bytes = ownedBytes2(input);
  cancel(control);
  let text4;
  try {
    text4 = decoder4.decode(bytes);
  } catch (error) {
    throw new BiomeContentClosureArtifactError(`biome content closure artifact is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!text4.endsWith("\n") || text4.slice(0, -1).includes("\n")) {
    throw new BiomeContentClosureArtifactError("biome content closure artifact must be one canonical JSON line");
  }
  let source;
  try {
    source = JSON.parse(text4.slice(0, -1));
  } catch (error) {
    throw new BiomeContentClosureArtifactError(`biome content closure artifact JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  let bundle;
  try {
    bundle = parseBiomeContentBundle(source);
  } catch (error) {
    throw new BiomeContentClosureArtifactError(`biome content closure artifact bundle is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const canonical = encodeBiomeContentClosureArtifact(bundle, control);
  if (canonical.byteLength !== bytes.byteLength || !canonical.every((value, index) => value === bytes[index])) {
    throw new BiomeContentClosureArtifactError("biome content closure artifact is not canonical");
  }
  cancel(control);
  return Object.freeze({ bundle, metadata: Object.freeze({
    artifactType: BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
    mediaType: BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE,
    contentHash: derivedArtifactContentHash(bytes),
    byteLength: bytes.byteLength
  }) });
}

// src/world/biome-library-v1.mjs
var VERSION2 = "1.0.1";
var provenance2 = (id) => ({ sourceUri: `limina://biomes/v1/${id}`, licenseId: "CC0-1.0", authoredBy: "Limina Project" });
var definition = (id, displayName, category, tags, temperatureC, moisture01, surfaceRoles, vegetation, waterTintSrgb) => ({
  schema: BIOME_DEF_SCHEMA,
  id,
  version: VERSION2,
  displayName,
  taxonomy: { category, tags: [...tags].sort() },
  climate: { temperatureC: { min: temperatureC[0], max: temperatureC[1] }, moisture01: { min: moisture01[0], max: moisture01[1] } },
  surfaceMaterials: surfaceRoles.map((role) => ({ role })),
  vegetationPalette: vegetation.map(([role, weight]) => ({ role, weight })).sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : 0),
  resourceTableRefs: [`tables/resources/${id}`],
  spawnTableRefs: [`tables/spawns/${id}`],
  waterTintSrgb,
  ambientAudioRefs: [`audio/ambient/${id}`],
  fulfillment: { status: "metadata-only", bindings: [] },
  provenance: provenance2(id)
});
var definitions = [
  definition("alpine", "Alpine", "terrestrial", ["cold", "highland"], [-18, 8], [0.2, 0.8], ["ground/alpine-turf", "rock/granite", "ground/snow"], [["flora/alpine-grass", 3], ["flora/lichen", 1]], [96, 151, 177]),
  definition("atoll", "Atoll", "aquatic", ["coastal", "tropical"], [22, 38], [0.55, 1], ["ground/coral-sand", "ground/reef-limestone"], [["flora/coconut-palm", 3], ["flora/tropical-scrub", 1]], [54, 190, 205]),
  definition("badlands", "Badlands", "geological", ["arid", "eroded"], [4, 42], [0, 0.28], ["rock/banded-sediment", "ground/dry-clay"], [["flora/desert-scrub", 1]], [109, 142, 139]),
  definition("blighted-waste", "Blighted Waste", "fantasy", ["corruption", "hostile"], [-5, 36], [0, 0.65], ["ground/blighted-soil", "rock/blighted"], [["flora/blight-thorn", 3], ["flora/deadwood", 2]], [79, 76, 94]),
  definition("bog", "Bog", "wetland", ["acidic", "peat"], [-2, 22], [0.75, 1], ["ground/peat", "ground/sphagnum"], [["flora/bog-shrub", 1], ["flora/sphagnum", 4]], [79, 103, 82]),
  definition("boreal-forest", "Boreal Forest", "terrestrial", ["cold", "coniferous"], [-25, 16], [0.35, 0.9], ["ground/forest-duff", "ground/moss", "rock/granite"], [["flora/fir", 3], ["flora/spruce", 5]], [66, 109, 124]),
  definition("canyon", "Canyon", "geological", ["cliff", "river-cut"], [-4, 42], [0.05, 0.55], ["rock/canyon-sandstone", "ground/scree"], [["flora/riparian-shrub", 1]], [82, 136, 142]),
  definition("coral-reef", "Coral Reef", "aquatic", ["marine", "tropical"], [18, 34], [1, 1], ["ground/coral-rubble", "ground/reef-sand"], [["flora/coral-branch", 5], ["flora/sea-fan", 2]], [32, 157, 188]),
  definition("crystal", "Crystal Expanse", "fantasy", ["arcane", "mineral"], [-20, 45], [0, 0.7], ["rock/crystal-bed", "ground/crystal-dust"], [["flora/crystal-growth", 4]], [99, 125, 201]),
  definition("deep-ocean", "Deep Ocean", "aquatic", ["abyssal", "marine"], [-2, 12], [1, 1], ["ground/abyssal-silt", "rock/basalt"], [["flora/deep-kelp", 1]], [12, 37, 76]),
  definition("desert", "Hot Desert", "terrestrial", ["arid", "hot"], [16, 50], [0, 0.2], ["ground/desert-sand", "rock/desert-varnish"], [["flora/cactus", 2], ["flora/desert-scrub", 1]], [79, 139, 155]),
  definition("enchanted-forest", "Enchanted Forest", "fantasy", ["arcane", "forest"], [2, 28], [0.55, 1], ["ground/enchanted-duff", "ground/luminous-moss"], [["flora/ancient-broadleaf", 4], ["flora/luminous-fern", 2]], [78, 131, 153]),
  definition("estuary", "Estuary", "wetland", ["brackish", "coastal"], [2, 32], [0.7, 1], ["ground/estuary-mud", "ground/tidal-sand"], [["flora/saltmarsh-grass", 4], ["flora/tidal-reed", 2]], [87, 142, 144]),
  definition("floating-island", "Floating Island", "fantasy", ["aerial", "highland"], [-8, 30], [0.2, 0.9], ["ground/aerial-turf", "rock/floating-island"], [["flora/aerial-grass", 3], ["flora/wind-tree", 1]], [111, 170, 195]),
  definition("fungal", "Fungal Wilds", "fantasy", ["fungal", "humid"], [2, 30], [0.7, 1], ["ground/fungal-loam", "ground/mycelium"], [["flora/giant-fungus", 3], ["flora/spore-cap", 4]], [91, 88, 134]),
  definition("glacier", "Glacier", "geological", ["ice", "polar"], [-60, 2], [0.1, 0.8], ["ground/glacial-ice", "ground/snow", "rock/glacial-till"], [["flora/ice-lichen", 1]], [100, 169, 202]),
  definition("grassland", "Temperate Grassland", "terrestrial", ["grassland", "temperate"], [-8, 30], [0.2, 0.7], ["ground/grass-turf", "ground/loam"], [["flora/meadow-grass", 5], ["flora/wildflower", 1]], [75, 133, 151]),
  definition("kelp-forest", "Kelp Forest", "aquatic", ["coastal", "marine"], [2, 22], [1, 1], ["ground/coastal-rock", "ground/marine-sand"], [["flora/giant-kelp", 5], ["flora/sea-grass", 2]], [31, 111, 126]),
  definition("lava-field", "Lava Field", "geological", ["igneous", "volcanic"], [10, 80], [0, 0.4], ["rock/basalt", "rock/lava-crust"], [["flora/fire-lichen", 1]], [97, 72, 55]),
  definition("mangrove", "Mangrove", "wetland", ["coastal", "tropical"], [18, 40], [0.8, 1], ["ground/mangrove-mud", "ground/tidal-silt"], [["flora/mangrove-tree", 5], ["flora/tidal-root", 3]], [74, 130, 117]),
  definition("marsh", "Marsh", "wetland", ["freshwater", "reeds"], [-2, 30], [0.75, 1], ["ground/marsh-mud", "ground/wet-grass"], [["flora/cattail", 3], ["flora/marsh-reed", 5]], [93, 137, 126]),
  definition("mediterranean-shrubland", "Mediterranean Shrubland", "terrestrial", ["dry-summer", "shrubland"], [4, 38], [0.15, 0.6], ["ground/dry-loam", "rock/limestone"], [["flora/aromatic-shrub", 3], ["flora/olive-tree", 1]], [77, 135, 153]),
  definition("mesa", "Mesa", "geological", ["arid", "plateau"], [2, 44], [0, 0.3], ["rock/mesa-sandstone", "ground/desert-gravel"], [["flora/desert-scrub", 1]], [91, 139, 148]),
  definition("montane-forest", "Montane Forest", "terrestrial", ["forest", "highland"], [-12, 22], [0.35, 0.9], ["ground/montane-duff", "rock/granite", "ground/snow"], [["flora/fir", 3], ["flora/montane-pine", 5]], [73, 127, 149]),
  definition("nether", "Nether", "fantasy", ["infernal", "hostile"], [25, 100], [0, 0.5], ["rock/infernal", "ground/ash"], [["flora/ember-fungus", 2], ["flora/infernal-thorn", 3]], [117, 47, 35]),
  definition("ocean", "Ocean", "aquatic", ["marine", "pelagic"], [-2, 32], [1, 1], ["ground/marine-sand", "ground/marine-silt"], [["flora/sea-grass", 1]], [24, 108, 148]),
  definition("polar-desert", "Polar Desert", "terrestrial", ["arid", "polar"], [-70, 4], [0, 0.2], ["ground/polar-gravel", "ground/snow"], [["flora/polar-lichen", 1]], [86, 139, 163]),
  definition("prairie", "Prairie", "terrestrial", ["grassland", "temperate"], [-12, 34], [0.25, 0.7], ["ground/prairie-turf", "ground/black-soil"], [["flora/prairie-grass", 5], ["flora/prairie-wildflower", 2]], [74, 131, 148]),
  definition("rainforest", "Tropical Rainforest", "terrestrial", ["forest", "tropical"], [18, 40], [0.75, 1], ["ground/rainforest-duff", "ground/wet-loam"], [["flora/rainforest-canopy", 5], ["flora/tropical-fern", 3]], [62, 124, 129]),
  // The generated water footprint is narrower than the river biome's riparian corridor. Declare
  // ground grass explicitly so dry banks do not become an artificial vegetation void; runtime
  // water coverage remains the authoritative exclusion mask for submerged blades.
  definition("river", "River", "aquatic", ["flowing", "freshwater"], [-2, 34], [0.7, 1], ["ground/river-gravel", "ground/river-silt"], [["flora/forest-grass", 4], ["flora/riparian-reed", 2], ["flora/waterweed", 1]], [52, 132, 157]),
  definition("salt-flat", "Salt Flat", "geological", ["arid", "saline"], [-4, 48], [0, 0.2], ["ground/salt-crust", "ground/saline-mud"], [["flora/saltbush", 1]], [126, 153, 158]),
  definition("savanna", "Savanna", "terrestrial", ["grassland", "tropical"], [14, 44], [0.15, 0.65], ["ground/savanna-grass", "ground/red-loam"], [["flora/acacia", 1], ["flora/savanna-grass", 5]], [75, 132, 146]),
  definition("scrubland", "Scrubland", "terrestrial", ["semi-arid", "shrubland"], [-2, 38], [0.1, 0.5], ["ground/scrub-soil", "rock/weathered"], [["flora/scrub-grass", 2], ["flora/scrub-shrub", 4]], [80, 132, 143]),
  definition("swamp", "Swamp", "wetland", ["forest", "freshwater"], [4, 36], [0.8, 1], ["ground/swamp-mud", "ground/wet-duff"], [["flora/bald-cypress", 3], ["flora/swamp-reed", 2]], [66, 115, 105]),
  definition("taiga", "Taiga", "terrestrial", ["cold", "forest"], [-35, 14], [0.25, 0.8], ["ground/taiga-duff", "ground/snow"], [["flora/larch", 2], ["flora/spruce", 5]], [72, 122, 142]),
  definition(
    "temperate-deciduous-forest",
    "Temperate Deciduous Forest",
    "terrestrial",
    ["deciduous", "forest"],
    [-10, 32],
    [0.4, 0.9],
    ["ground/leaf-litter", "ground/forest-loam"],
    [["flora/ash", 2], ["flora/fern", 2], ["flora/forest-grass", 6], ["flora/oak", 4], ["flora/shrub", 1]],
    [69, 126, 143]
  ),
  definition("temperate-rainforest", "Temperate Rainforest", "terrestrial", ["forest", "wet"], [0, 24], [0.7, 1], ["ground/mossy-duff", "rock/mossy"], [["flora/cedar", 3], ["flora/giant-fern", 2]], [62, 121, 134]),
  definition("tropical-seasonal-forest", "Tropical Seasonal Forest", "terrestrial", ["forest", "seasonal"], [16, 42], [0.35, 0.85], ["ground/seasonal-duff", "ground/red-loam"], [["flora/dry-tropical-tree", 4], ["flora/tropical-grass", 2]], [72, 130, 141]),
  definition("tundra", "Tundra", "terrestrial", ["cold", "treeless"], [-45, 10], [0.1, 0.65], ["ground/permafrost", "ground/tundra-moss", "ground/snow"], [["flora/dwarf-shrub", 2], ["flora/tundra-moss", 5]], [86, 142, 162]),
  definition("volcanic", "Volcanic Highlands", "geological", ["igneous", "mountain"], [-5, 55], [0, 0.75], ["rock/basalt", "ground/volcanic-ash"], [["flora/volcanic-fern", 1]], [91, 111, 112])
];
var BIOME_LIBRARY_V1 = parseBiomePack({
  schema: BIOME_PACK_SCHEMA,
  id: "limina-biomes-core",
  version: VERSION2,
  definitions,
  legacyAliases: [
    { legacyKind: "blight", biomeId: "blighted-waste" },
    { legacyKind: "desert", biomeId: "desert" },
    { legacyKind: "forest", biomeId: "temperate-deciduous-forest" },
    { legacyKind: "grass", biomeId: "grassland" },
    { legacyKind: "mountain", biomeId: "alpine" },
    { legacyKind: "swamp", biomeId: "swamp" },
    { legacyKind: "tundra", biomeId: "tundra" },
    { legacyKind: "water", biomeId: "ocean" }
  ],
  provenance: { sourceUri: "limina://biomes/v1", licenseId: "CC0-1.0", authoredBy: "Limina Project" }
});

// src/world/biome-runtime-pack.mjs
var BIOME_RUNTIME_PACK_SCHEMA = "limina.biome-runtime-pack/v1";
var BIOME_RUNTIME_FULFILLMENT_STATES = Object.freeze(["metadata-only", "partial", "fulfilled"]);
var BIOME_RUNTIME_BINDING_KINDS = Object.freeze(["surface", "vegetation"]);
var BIOME_RUNTIME_PACK_LIMITS = Object.freeze({
  biomes: 64,
  surfaceRules: 4,
  vegetationRules: 8,
  bindingsPerBiome: 12,
  idChars: 160,
  radiusM: 1e4,
  elevationM: 1e6,
  waterDistanceM: 1e6,
  scale: 100,
  weight: 1e6,
  tileScaleM: 1e4,
  displacementScaleM: 10,
  labelChars: 96,
  uriChars: 512
});
var ID4 = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
var REF4 = /^[a-z][a-z0-9._/-]*$/;
var SEMVER4 = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
var HASH7 = /^sha256:[0-9a-f]{64}$/;
var BiomeRuntimePackValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "BiomeRuntimePackValidationError";
  }
};
function fail11(message) {
  throw new BiomeRuntimePackValidationError(message);
}
function record3(value, required, optional, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail11(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail11(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail11(`${label} must not contain symbol fields`);
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor2] of Object.entries(descriptors)) {
    if (!allowed.has(key)) fail11(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor2) || descriptor2.enumerable !== true) fail11(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail11(`${label} is missing '${key}'`);
  return descriptors;
}
function dense3(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    fail11(`${label} must be a standard array with at most ${maximum} entries`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail11(`${label} must be dense and field-free`);
  }
  return value;
}
function string4(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail11(`${label} is invalid`);
  return value;
}
function text3(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) fail11(`${label} is invalid`);
  return value;
}
function number2(value, minimum, maximum, label, positive2 = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum || positive2 && value === 0) {
    fail11(`${label} must be a finite canonical number in ${positive2 ? "(" : "["}${minimum}, ${maximum}]`);
  }
  return value;
}
function integer6(value, minimum, maximum, label) {
  const parsed = number2(value, minimum, maximum, label);
  if (!Number.isSafeInteger(parsed)) fail11(`${label} must be an integer`);
  return parsed;
}
function tupleBand(value, minimum, maximum, label, positive2 = false) {
  const source = dense3(value, 2, label);
  if (source.length !== 2) fail11(`${label} must contain exactly [min, max]`);
  const min = number2(source[0], minimum, maximum, `${label}[0]`, positive2);
  const max = number2(source[1], minimum, maximum, `${label}[1]`, positive2);
  if (max < min) fail11(`${label}[1] must be at least ${label}[0]`);
  return Object.freeze([min, max]);
}
function tuple3(value, minimum, maximum, label, positive2 = false) {
  const source = dense3(value, 3, label);
  if (source.length !== 3) fail11(`${label} must contain exactly three values`);
  return Object.freeze(source.map((entry, index) => number2(entry, minimum, maximum, `${label}[${index}]`, positive2)));
}
function surfaceCalibration(value, label) {
  const d = record3(value, /* @__PURE__ */ new Set(["albedoLinearGain", "normalStrength", "displacementScaleM"]), /* @__PURE__ */ new Set(), label);
  return Object.freeze({
    albedoLinearGain: tuple3(d.albedoLinearGain.value, Number.MIN_VALUE, 4, `${label}.albedoLinearGain`, true),
    normalStrength: number2(d.normalStrength.value, 0, 4, `${label}.normalStrength`),
    displacementScaleM: number2(
      d.displacementScaleM.value,
      0,
      BIOME_RUNTIME_PACK_LIMITS.displacementScaleM,
      `${label}.displacementScaleM`
    )
  });
}
function surfaceEnvironment(value, label) {
  const d = record3(value, /* @__PURE__ */ new Set(["overlayWeight"]), /* @__PURE__ */ new Set(["slope01", "elevationM", "waterDistanceM"]), label);
  const band2 = (descriptor2, minimum, maximum, path) => {
    if (descriptor2 === void 0) return void 0;
    const source = dense3(descriptor2.value, 3, path);
    if (source.length !== 3) fail11(`${path} must contain exactly [min, max, feather]`);
    const min = number2(source[0], minimum, maximum, `${path}[0]`);
    const max = number2(source[1], minimum, maximum, `${path}[1]`);
    const feather = number2(source[2], 0, maximum - minimum, `${path}[2]`);
    if (max < min) fail11(`${path}[1] must be at least ${path}[0]`);
    return Object.freeze([min, max, feather]);
  };
  return Object.freeze({
    overlayWeight: number2(d.overlayWeight.value, 0, BIOME_RUNTIME_PACK_LIMITS.weight, `${label}.overlayWeight`),
    ...d.slope01 === void 0 ? {} : { slope01: band2(d.slope01, 0, 1, `${label}.slope01`) },
    ...d.elevationM === void 0 ? {} : { elevationM: band2(
      d.elevationM,
      -BIOME_RUNTIME_PACK_LIMITS.elevationM,
      BIOME_RUNTIME_PACK_LIMITS.elevationM,
      `${label}.elevationM`
    ) },
    ...d.waterDistanceM === void 0 ? {} : { waterDistanceM: band2(
      d.waterDistanceM,
      0,
      BIOME_RUNTIME_PACK_LIMITS.waterDistanceM,
      `${label}.waterDistanceM`
    ) }
  });
}
function assertStrictRoleOrder(rules, label) {
  for (let index = 1; index < rules.length; index++) {
    if (rules[index - 1].role >= rules[index].role) fail11(`${label} must be strictly role-sorted and unique`);
  }
}
function parseSurfaceRules(value, definition2, label) {
  const declared = new Set(definition2.surfaceMaterials.map((entry) => entry.role));
  const rules = dense3(value, BIOME_RUNTIME_PACK_LIMITS.surfaceRules, label).map((entry, index) => {
    const path = `${label}[${index}]`;
    const d = record3(entry, /* @__PURE__ */ new Set(["role", "weight", "tileScaleM"]), /* @__PURE__ */ new Set(["calibration", "environment"]), path);
    const role = string4(d.role.value, REF4, BIOME_RUNTIME_PACK_LIMITS.idChars, `${path}.role`);
    if (!declared.has(role)) fail11(`${path}.role '${role}' is not declared by biome '${definition2.id}'`);
    return Object.freeze({
      role,
      weight: number2(d.weight.value, 0, BIOME_RUNTIME_PACK_LIMITS.weight, `${path}.weight`, true),
      tileScaleM: number2(d.tileScaleM.value, 0, BIOME_RUNTIME_PACK_LIMITS.tileScaleM, `${path}.tileScaleM`, true),
      ...d.calibration === void 0 ? {} : { calibration: surfaceCalibration(d.calibration.value, `${path}.calibration`) },
      ...d.environment === void 0 ? {} : { environment: surfaceEnvironment(d.environment.value, `${path}.environment`) }
    });
  });
  if (rules.length < 1) fail11(`${label} must not be empty`);
  assertStrictRoleOrder(rules, label);
  if (rules.length !== declared.size) fail11(`${label} must cover every surface role declared by biome '${definition2.id}'`);
  return Object.freeze(rules);
}
function parseVegetationRules(value, definition2, label) {
  const declared = new Set(definition2.vegetationPalette.map((entry) => entry.role));
  const required = /* @__PURE__ */ new Set(["role", "weight", "radiusM", "density01", "scale", "tintSrgb"]);
  const optional = /* @__PURE__ */ new Set(["slope01", "elevationM", "moisture01", "waterDistanceM"]);
  const rules = dense3(value, BIOME_RUNTIME_PACK_LIMITS.vegetationRules, label).map((entry, index) => {
    const path = `${label}[${index}]`;
    const d = record3(entry, required, optional, path);
    const role = string4(d.role.value, REF4, BIOME_RUNTIME_PACK_LIMITS.idChars, `${path}.role`);
    if (!declared.has(role)) fail11(`${path}.role '${role}' is not declared by biome '${definition2.id}'`);
    const tint = dense3(d.tintSrgb.value, 3, `${path}.tintSrgb`);
    if (tint.length !== 3) fail11(`${path}.tintSrgb must contain exactly 3 channels`);
    const parsed = {
      role,
      weight: number2(d.weight.value, 0, BIOME_RUNTIME_PACK_LIMITS.weight, `${path}.weight`, true),
      radiusM: number2(d.radiusM.value, 0, BIOME_RUNTIME_PACK_LIMITS.radiusM, `${path}.radiusM`, true),
      density01: number2(d.density01.value, 0, 1, `${path}.density01`),
      scale: tupleBand(d.scale.value, Number.MIN_VALUE, BIOME_RUNTIME_PACK_LIMITS.scale, `${path}.scale`, true),
      ...d.slope01 === void 0 ? {} : { slope01: tupleBand(d.slope01.value, 0, 1, `${path}.slope01`) },
      ...d.elevationM === void 0 ? {} : { elevationM: tupleBand(d.elevationM.value, -BIOME_RUNTIME_PACK_LIMITS.elevationM, BIOME_RUNTIME_PACK_LIMITS.elevationM, `${path}.elevationM`) },
      ...d.moisture01 === void 0 ? {} : { moisture01: tupleBand(d.moisture01.value, 0, 1, `${path}.moisture01`) },
      ...d.waterDistanceM === void 0 ? {} : { waterDistanceM: tupleBand(d.waterDistanceM.value, 0, BIOME_RUNTIME_PACK_LIMITS.waterDistanceM, `${path}.waterDistanceM`) },
      tintSrgb: Object.freeze(tint.map((channel, channelIndex) => integer6(channel, 0, 255, `${path}.tintSrgb[${channelIndex}]`)))
    };
    return Object.freeze(parsed);
  });
  assertStrictRoleOrder(rules, label);
  if (rules.length !== declared.size) fail11(`${label} must cover every vegetation role declared by biome '${definition2.id}'`);
  return Object.freeze(rules);
}
function parseBindings2(value, declaredKeys, label) {
  const bindings = dense3(value, BIOME_RUNTIME_PACK_LIMITS.bindingsPerBiome, label).map((entry, index) => {
    const path = `${label}[${index}]`;
    const d = record3(entry, /* @__PURE__ */ new Set(["kind", "role", "assetId", "contentHash", "licenseId", "sourceUri"]), /* @__PURE__ */ new Set(), path);
    if (!BIOME_RUNTIME_BINDING_KINDS.includes(d.kind.value)) fail11(`${path}.kind is unsupported`);
    const role = string4(d.role.value, REF4, BIOME_RUNTIME_PACK_LIMITS.idChars, `${path}.role`);
    const key = `${d.kind.value}:${role}`;
    if (!declaredKeys.has(key)) fail11(`${path} targets undeclared runtime rule '${key}'`);
    return Object.freeze({
      kind: d.kind.value,
      role,
      assetId: string4(d.assetId.value, REF4, BIOME_RUNTIME_PACK_LIMITS.idChars, `${path}.assetId`),
      contentHash: string4(d.contentHash.value, HASH7, 71, `${path}.contentHash`),
      licenseId: text3(d.licenseId.value, BIOME_RUNTIME_PACK_LIMITS.labelChars, `${path}.licenseId`),
      sourceUri: text3(d.sourceUri.value, BIOME_RUNTIME_PACK_LIMITS.uriChars, `${path}.sourceUri`)
    });
  });
  for (let index = 1; index < bindings.length; index++) {
    const previous = `${bindings[index - 1].kind}:${bindings[index - 1].role}`;
    const current = `${bindings[index].kind}:${bindings[index].role}`;
    if (previous >= current) fail11(`${label} must be strictly kind/role-sorted and unique`);
  }
  return Object.freeze(bindings);
}
function fulfillmentStatus(bound, required) {
  if (bound === 0) return "metadata-only";
  return bound === required ? "fulfilled" : "partial";
}
function parseBiomeEntry(value, definition2, label) {
  const d = record3(value, /* @__PURE__ */ new Set(["biomeId", "status", "surfaceRules", "vegetationRules", "bindings"]), /* @__PURE__ */ new Set(), label);
  const biomeId = string4(d.biomeId.value, ID4, 64, `${label}.biomeId`);
  if (biomeId !== definition2.id) fail11(`${label}.biomeId does not match its metadata definition`);
  const surfaceRules = parseSurfaceRules(d.surfaceRules.value, definition2, `${label}.surfaceRules`);
  const vegetationRules = parseVegetationRules(d.vegetationRules.value, definition2, `${label}.vegetationRules`);
  const declaredKeys = /* @__PURE__ */ new Set([
    ...surfaceRules.map((entry) => `surface:${entry.role}`),
    ...vegetationRules.map((entry) => `vegetation:${entry.role}`)
  ]);
  const bindings = parseBindings2(d.bindings.value, declaredKeys, `${label}.bindings`);
  const status = fulfillmentStatus(bindings.length, declaredKeys.size);
  if (!BIOME_RUNTIME_FULFILLMENT_STATES.includes(d.status.value)) fail11(`${label}.status is unsupported`);
  if (d.status.value !== status) fail11(`${label}.status must be '${status}' for its declared bindings`);
  return Object.freeze({ biomeId, status, surfaceRules, vegetationRules, bindings });
}
function parseBiomeRuntimePack(value, metadataPackValue) {
  const metadataPack = parseBiomePack(metadataPackValue);
  const metadataPackHash = biomePackContentHash(metadataPack);
  const d = record3(value, /* @__PURE__ */ new Set(["schema", "id", "version", "metadataPackContentHash", "status", "biomes"]), /* @__PURE__ */ new Set(), "biome runtime pack");
  if (d.schema.value !== BIOME_RUNTIME_PACK_SCHEMA) fail11(`biome runtime pack.schema must be '${BIOME_RUNTIME_PACK_SCHEMA}'`);
  if (d.metadataPackContentHash.value !== metadataPackHash) fail11("biome runtime pack.metadataPackContentHash does not match the provided metadata pack");
  const definitions2 = new Map(metadataPack.definitions.map((definition2) => [definition2.id, definition2]));
  const source = dense3(d.biomes.value, BIOME_RUNTIME_PACK_LIMITS.biomes, "biome runtime pack.biomes");
  if (source.length < 1) fail11("biome runtime pack.biomes must not be empty");
  const biomes = Object.freeze(source.map((entry, index) => {
    const entryRecord = record3(entry, /* @__PURE__ */ new Set(["biomeId", "status", "surfaceRules", "vegetationRules", "bindings"]), /* @__PURE__ */ new Set(), `biome runtime pack.biomes[${index}]`);
    const biomeId = string4(entryRecord.biomeId.value, ID4, 64, `biome runtime pack.biomes[${index}].biomeId`);
    const definition2 = definitions2.get(biomeId);
    if (definition2 === void 0) fail11(`biome runtime pack references unknown biome '${biomeId}'`);
    return parseBiomeEntry(entry, definition2, `biome runtime pack.biomes[${index}]`);
  }));
  for (let index = 1; index < biomes.length; index++) {
    if (biomes[index - 1].biomeId >= biomes[index].biomeId) fail11("biome runtime pack.biomes must be strictly biomeId-sorted and unique");
  }
  const required = biomes.reduce((sum, biome) => sum + biome.surfaceRules.length + biome.vegetationRules.length, 0);
  const bound = biomes.reduce((sum, biome) => sum + biome.bindings.length, 0);
  const status = fulfillmentStatus(bound, required);
  if (!BIOME_RUNTIME_FULFILLMENT_STATES.includes(d.status.value)) fail11("biome runtime pack.status is unsupported");
  if (d.status.value !== status) fail11(`biome runtime pack.status must be '${status}' for its declared bindings`);
  return Object.freeze({
    schema: BIOME_RUNTIME_PACK_SCHEMA,
    id: string4(d.id.value, ID4, 64, "biome runtime pack.id"),
    version: string4(d.version.value, SEMVER4, 64, "biome runtime pack.version"),
    metadataPackContentHash: metadataPackHash,
    status,
    biomes
  });
}
function stableStringifyBiomeRuntimePack(value, metadataPack) {
  return JSON.stringify(parseBiomeRuntimePack(value, metadataPack));
}
function biomeRuntimePackContentHash(value, metadataPack) {
  return `sha256:${sha256(stableStringifyBiomeRuntimePack(value, metadataPack))}`;
}

// src/world/compiler/biome-runtime-pack-artifact.mjs
var BIOME_RUNTIME_PACK_ARTIFACT_TYPE = "biome-runtime-pack/v1";
var BIOME_RUNTIME_PACK_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.biome-runtime-pack+json";
var MAX_BIOME_RUNTIME_PACK_ARTIFACT_BYTES = 4 * 1024 * 1024;
function decodeBiomeRuntimePackArtifact(bytes) {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength || bytes.byteLength < 2 || bytes.byteLength > MAX_BIOME_RUNTIME_PACK_ARTIFACT_BYTES) {
    throw new TypeError("biome runtime-pack artifact must be an owned bounded Uint8Array");
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`biome runtime-pack artifact JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const runtimePack = parseBiomeRuntimePack(parsed, BIOME_LIBRARY_V1);
  return Object.freeze({ runtimePack, semanticContentHash: biomeRuntimePackContentHash(runtimePack, BIOME_LIBRARY_V1) });
}

// src/browser/derived-terrain-residency.ts
var DERIVED_TERRAIN_RESIDENCY_SCHEMA = "limina.derived-terrain-residency/v1";
var MAX_DERIVED_TERRAIN_RESIDENCY_RADIUS = 7;
var MAX_DERIVED_TERRAIN_RESIDENCY_CHUNKS = (MAX_DERIVED_TERRAIN_RESIDENCY_RADIUS * 2 + 1) ** 2;
function plain2(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}
function exact2(value, keys, label) {
  const names = Object.getOwnPropertyNames(value);
  const expected = new Set(keys);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== expected.size || names.some((name) => !expected.has(name))) {
    throw new TypeError(`${label} fields are invalid`);
  }
  for (const name of names) {
    const descriptor2 = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor2?.enumerable !== true || descriptor2.get !== void 0 || descriptor2.set !== void 0) {
      throw new TypeError(`${label}.${name} must be an enumerable data field`);
    }
  }
}
function centerTuple(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2 || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== 3) {
    throw new TypeError("derived terrain residency center must be a dense two-element array");
  }
  for (let index = 0; index < 2; index++) {
    const descriptor2 = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor2?.enumerable !== true || descriptor2.get !== void 0 || descriptor2.set !== void 0 || !Number.isFinite(descriptor2.value)) {
      throw new TypeError("derived terrain residency center must contain finite data values");
    }
  }
  return Object.freeze([
    Object.is(value[0], -0) ? 0 : value[0],
    Object.is(value[1], -0) ? 0 : value[1]
  ]);
}
function parseDerivedTerrainResidency(input) {
  const value = plain2(input, "derived terrain residency");
  exact2(value, ["schema", "center", "lod", "radius"], "derived terrain residency");
  if (value.schema !== DERIVED_TERRAIN_RESIDENCY_SCHEMA || value.lod !== 0 || !Number.isSafeInteger(value.radius) || value.radius < 0 || value.radius > MAX_DERIVED_TERRAIN_RESIDENCY_RADIUS) {
    throw new TypeError("derived terrain residency is invalid");
  }
  return Object.freeze({
    schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA,
    center: centerTuple(value.center),
    lod: 0,
    radius: value.radius
  });
}
function derivedTerrainResidencyKey(input) {
  const residency = parseDerivedTerrainResidency(input);
  return `${residency.lod}:${residency.center[0]}:${residency.center[1]}:${residency.radius}`;
}
function selectDerivedTerrainChunks(manifest, residencyInput) {
  const residency = parseDerivedTerrainResidency(residencyInput);
  const anchor = terrainWorldToChunk(manifest.grid, residency.center[0], residency.center[1]);
  const chunks = manifest.chunks.filter((chunk) => chunk.lod === residency.lod && Math.abs(chunk.tx - anchor.tx) <= residency.radius && Math.abs(chunk.tz - anchor.tz) <= residency.radius);
  if (chunks.length < 1) throw new RangeError("derived terrain residency contains no manifest chunks");
  if (chunks.length > MAX_DERIVED_TERRAIN_RESIDENCY_CHUNKS) {
    throw new RangeError("derived terrain residency exceeds its 225-chunk bound");
  }
  return Object.freeze([...chunks]);
}

// src/browser/derived-runtime-worker.ts
var DERIVED_RUNTIME_WORKER_SCHEMA = "limina.derived-runtime-worker/v4";
var DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA = "limina.derived-runtime-resource-snapshot/v2";
var DERIVED_RUNTIME_POLL_DELAYS_MS = Object.freeze([250, 500, 1e3, 2e3, 4e3, 8e3]);
var DERIVED_RUNTIME_ACTIVATION_ACK_TIMEOUT_MS = 15e3;
var HASH8 = /^sha256:[0-9a-f]{64}$/;
var TERRAIN_CHUNK_ARTIFACT_TYPE = "terrain-chunk/v1";
var REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var ACTIVATION_ID = /^derived-activation-[1-9][0-9]{0,15}$/;
var MAX_WORKER_ERROR_MESSAGE_LENGTH = 512;
var DerivedRuntimeWorkerError = class extends Error {
  code;
  classification;
  constructor(code, classification, message) {
    super(message);
    this.name = "DerivedRuntimeWorkerError";
    this.code = code;
    this.classification = classification;
  }
};
function fatal2(code, message) {
  return new DerivedRuntimeWorkerError(code, "fatal", message);
}
function transient2(code, message) {
  return new DerivedRuntimeWorkerError(code, "transient", message);
}
function plainRecord(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw fatal2("INVALID_MESSAGE", `${label} must be a plain object`);
  }
  return value;
}
function exactDataKeys(value, required, optional, label) {
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || required.some((key) => !names.includes(key)) || names.some((key) => !allowed.has(key))) {
    throw fatal2("INVALID_MESSAGE", `${label} has unsupported or missing fields`);
  }
  for (const name of names) {
    const descriptor2 = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor2?.enumerable !== true || descriptor2.get !== void 0 || descriptor2.set !== void 0) {
      throw fatal2("INVALID_MESSAGE", `${label}.${name} must be an enumerable data field`);
    }
  }
}
function requestId(value, label) {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) throw fatal2("INVALID_MESSAGE", `${label} is invalid`);
  return value;
}
function parsePinnedSource(value) {
  const record4 = plainRecord(value, "derived runtime pinnedSource");
  exactDataKeys(record4, ["revision", "headHash"], ["manifestHash"], "derived runtime pinnedSource");
  if (!Number.isSafeInteger(record4.revision) || record4.revision < 0 || typeof record4.headHash !== "string" || !HASH8.test(record4.headHash) || record4.manifestHash !== void 0 && (typeof record4.manifestHash !== "string" || !HASH8.test(record4.manifestHash))) {
    throw fatal2("INVALID_MESSAGE", "derived runtime pinnedSource is invalid");
  }
  return Object.freeze({
    revision: record4.revision,
    headHash: record4.headHash,
    ...record4.manifestHash === void 0 ? {} : { manifestHash: record4.manifestHash }
  });
}
function parseInit(value) {
  exactDataKeys(value, ["schema", "type", "requestId", "config", "mode", "residency"], ["pinnedSource"], "derived runtime init");
  if (value.schema !== DERIVED_RUNTIME_WORKER_SCHEMA || value.type !== "init") throw fatal2("INVALID_MESSAGE", "derived runtime init schema/type is invalid");
  const mode = value.mode;
  if (mode !== "watch" && mode !== "pinned") throw fatal2("INVALID_MESSAGE", "derived runtime init mode must be watch or pinned");
  const configRecord = plainRecord(value.config, "derived runtime init config");
  exactDataKeys(configRecord, ["baseUrl", "token", "projectId", "branchId"], [], "derived runtime init config");
  const config = configRecord;
  const pinnedSource = value.pinnedSource === void 0 ? void 0 : parsePinnedSource(value.pinnedSource);
  let residency;
  try {
    residency = parseDerivedTerrainResidency(value.residency);
  } catch (error) {
    throw fatal2("INVALID_MESSAGE", error instanceof Error ? error.message : "derived runtime residency is invalid");
  }
  if (mode === "pinned" !== (pinnedSource !== void 0)) {
    throw fatal2("INVALID_MESSAGE", "pinned mode requires pinnedSource and watch mode forbids it");
  }
  return Object.freeze({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "init",
    requestId: requestId(value.requestId, "derived runtime init requestId"),
    config,
    mode,
    ...pinnedSource === void 0 ? {} : { pinnedSource },
    residency
  });
}
function parseAck(value) {
  exactDataKeys(value, ["schema", "type", "activationId", "accepted"], ["requestId", "errorCode"], "derived runtime activation ack");
  if (value.schema !== DERIVED_RUNTIME_WORKER_SCHEMA || value.type !== "activation-ack" || typeof value.activationId !== "string" || !ACTIVATION_ID.test(value.activationId) || typeof value.accepted !== "boolean") {
    throw fatal2("INVALID_MESSAGE", "derived runtime activation ack is invalid");
  }
  if (value.accepted === true && value.errorCode !== void 0 || value.accepted === false && (typeof value.errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.errorCode))) {
    throw fatal2("INVALID_MESSAGE", "derived runtime activation ack errorCode is invalid");
  }
  return Object.freeze({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: value.activationId,
    ...value.requestId === void 0 ? {} : { requestId: requestId(value.requestId, "derived runtime activation ack requestId") },
    accepted: value.accepted,
    ...value.errorCode === void 0 ? {} : { errorCode: value.errorCode }
  });
}
function parseSetResidency(value) {
  exactDataKeys(value, ["schema", "type", "requestId", "residency"], [], "derived runtime set-residency");
  if (value.schema !== DERIVED_RUNTIME_WORKER_SCHEMA || value.type !== "set-residency") {
    throw fatal2("INVALID_MESSAGE", "derived runtime set-residency schema/type is invalid");
  }
  let residency;
  try {
    residency = parseDerivedTerrainResidency(value.residency);
  } catch (error) {
    throw fatal2("INVALID_MESSAGE", error instanceof Error ? error.message : "derived runtime residency is invalid");
  }
  return Object.freeze({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "set-residency",
    requestId: requestId(value.requestId, "derived runtime set-residency requestId"),
    residency
  });
}
function parseReconcileResidency(value) {
  exactDataKeys(value, ["schema", "type", "requestId", "residency"], [], "derived runtime reconcile-residency");
  if (value.schema !== DERIVED_RUNTIME_WORKER_SCHEMA || value.type !== "reconcile-residency") {
    throw fatal2("INVALID_MESSAGE", "derived runtime reconcile-residency schema/type is invalid");
  }
  let residency;
  try {
    residency = parseDerivedTerrainResidency(value.residency);
  } catch (error) {
    throw fatal2("INVALID_MESSAGE", error instanceof Error ? error.message : "derived runtime residency is invalid");
  }
  return Object.freeze({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "reconcile-residency",
    requestId: requestId(value.requestId, "derived runtime reconcile-residency requestId"),
    residency
  });
}
function parseClose(value) {
  exactDataKeys(value, ["schema", "type", "requestId"], [], "derived runtime close");
  if (value.schema !== DERIVED_RUNTIME_WORKER_SCHEMA || value.type !== "close") throw fatal2("INVALID_MESSAGE", "derived runtime close schema/type is invalid");
  return Object.freeze({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "close",
    requestId: requestId(value.requestId, "derived runtime close requestId")
  });
}
function parseDerivedRuntimeWorkerInput(value) {
  const record4 = plainRecord(value, "derived runtime worker message");
  const type = Object.getOwnPropertyDescriptor(record4, "type")?.value;
  if (type === "init") return parseInit(record4);
  if (type === "set-residency") return parseSetResidency(record4);
  if (type === "reconcile-residency") return parseReconcileResidency(record4);
  if (type === "activation-ack") return parseAck(record4);
  if (type === "close") return parseClose(record4);
  throw fatal2("INVALID_MESSAGE", "derived runtime worker message type is unsupported");
}
function validateDescriptor(descriptor2, artifactType, mediaType, label) {
  if (descriptor2.artifactType !== artifactType || descriptor2.mediaType !== mediaType) {
    throw fatal2("ARTIFACT_CONTRACT_MISMATCH", `${label} descriptor type or media type is invalid`);
  }
}
function stageDerivedRuntimeChunk(input) {
  if (input.signal.aborted) throw input.signal.reason;
  if (input.artifacts.length < 1 || input.artifacts.length > 3) {
    throw fatal2("UNSUPPORTED_CHUNK_ARTIFACTS", "derived terrain chunk must contain terrain and at most one surface and population artifact");
  }
  const byType = /* @__PURE__ */ new Map();
  for (const payload of input.artifacts) {
    const artifactType = payload.artifact.artifactType;
    if (byType.has(artifactType)) {
      throw fatal2("DUPLICATE_CHUNK_ARTIFACT", `derived terrain chunk contains duplicate artifact type '${artifactType}'`);
    }
    if (artifactType !== TERRAIN_CHUNK_ARTIFACT_TYPE && artifactType !== SURFACE_COMPOSITE_ARTIFACT_TYPE && artifactType !== BIOME_POPULATION_ARTIFACT_TYPE) {
      throw fatal2("UNSUPPORTED_CHUNK_ARTIFACT", `derived terrain chunk contains unsupported artifact '${artifactType}'`);
    }
    byType.set(artifactType, payload);
  }
  const terrainPayload = byType.get(TERRAIN_CHUNK_ARTIFACT_TYPE);
  if (terrainPayload === void 0) {
    throw fatal2("MISSING_TERRAIN_ARTIFACT", "derived terrain chunk is missing its terrain artifact");
  }
  validateDescriptor(terrainPayload.artifact, TERRAIN_CHUNK_ARTIFACT_TYPE, TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE, "terrain chunk");
  const decoded = decodeTerrainChunkArtifact(terrainPayload.bytes);
  if (input.signal.aborted) throw input.signal.reason;
  const surfacePayload = byType.get(SURFACE_COMPOSITE_ARTIFACT_TYPE);
  const populationPayload = byType.get(BIOME_POPULATION_ARTIFACT_TYPE);
  if (surfacePayload === void 0 && populationPayload === void 0) {
    return Object.freeze({ kind: TERRAIN_CHUNK_ARTIFACT_TYPE, decoded });
  }
  if (surfacePayload === void 0) {
    throw fatal2("POPULATION_BINDING_CONTEXT_MISSING", "biome population artifact requires its surface composite identity context");
  }
  if (input.artifacts.length !== (populationPayload === void 0 ? 2 : 3)) {
    throw fatal2("UNSUPPORTED_CHUNK_ARTIFACTS", "surface-enabled terrain chunk must contain exactly two artifacts");
  }
  validateDescriptor(
    surfacePayload.artifact,
    SURFACE_COMPOSITE_ARTIFACT_TYPE,
    SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE,
    "surface composite"
  );
  const surface = decodeSurfaceCompositeArtifact(surfacePayload.bytes, {
    shouldCancel: () => input.signal.aborted
  });
  if (input.signal.aborted) throw input.signal.reason;
  if (surface.coord.tx !== input.chunk.tx || surface.coord.tz !== input.chunk.tz || surface.coord.lod !== input.chunk.lod) {
    throw fatal2("SURFACE_COORD_BINDING_MISMATCH", "surface composite coordinates do not match their manifest chunk");
  }
  if (surface.source.terrainChunkHash !== terrainPayload.artifact.contentHash) {
    throw fatal2("SURFACE_TERRAIN_BINDING_MISMATCH", "surface composite is bound to another terrain artifact");
  }
  if (populationPayload === void 0) {
    return Object.freeze({
      kind: TERRAIN_CHUNK_ARTIFACT_TYPE,
      decoded,
      surface,
      artifacts: Object.freeze({ terrain: terrainPayload.artifact, surface: surfacePayload.artifact })
    });
  }
  validateDescriptor(
    populationPayload.artifact,
    BIOME_POPULATION_ARTIFACT_TYPE,
    BIOME_POPULATION_ARTIFACT_MEDIA_TYPE,
    "biome population plan"
  );
  const population = decodeBiomePopulationArtifact(populationPayload.bytes, {
    shouldCancel: () => input.signal.aborted
  });
  if (input.signal.aborted) throw input.signal.reason;
  if (population.metadata.contentHash !== populationPayload.artifact.contentHash || population.metadata.byteLength !== populationPayload.artifact.byteLength) {
    throw fatal2("POPULATION_DESCRIPTOR_BINDING_MISMATCH", "biome population bytes do not match their manifest descriptor");
  }
  if (population.plan.coord.tx !== input.chunk.tx || population.plan.coord.tz !== input.chunk.tz || population.plan.coord.lod !== input.chunk.lod) {
    throw fatal2("POPULATION_COORD_BINDING_MISMATCH", "biome population coordinates do not match their manifest chunk");
  }
  const biomeFields = input.manifest?.globalArtifacts?.filter((artifact) => artifact.artifactType === BIOME_FIELD_ARTIFACT_TYPE) ?? [];
  if (biomeFields.length !== 1) {
    throw fatal2("POPULATION_BINDING_CONTEXT_MISSING", "biome population artifact requires exactly one global biome field descriptor");
  }
  if (population.plan.identity.fieldContentHash !== biomeFields[0].contentHash || population.plan.identity.fieldContentHash !== surface.source.biomeFieldHash) {
    throw fatal2("POPULATION_FIELD_BINDING_MISMATCH", "biome population artifact is bound to another biome field");
  }
  if (population.plan.identity.runtimePackContentHash !== surface.source.biomePackHash) {
    throw fatal2("POPULATION_PACK_BINDING_MISMATCH", "biome population artifact is bound to another runtime pack");
  }
  return Object.freeze({
    kind: TERRAIN_CHUNK_ARTIFACT_TYPE,
    decoded,
    surface,
    population,
    artifacts: Object.freeze({
      terrain: terrainPayload.artifact,
      surface: surfacePayload.artifact,
      population: populationPayload.artifact
    })
  });
}
function shortError(error) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.length <= MAX_WORKER_ERROR_MESSAGE_LENGTH ? rawMessage : `${rawMessage.slice(0, MAX_WORKER_ERROR_MESSAGE_LENGTH - 3)}...`;
  if (error instanceof DerivedRuntimeWorkerError || error instanceof DerivedRuntimeTransportError) {
    return { code: error.code, classification: error.classification, message };
  }
  if (error instanceof DerivedRevisionRuntimeError) {
    const transientCodes = /* @__PURE__ */ new Set(["STALE_SOURCE_HEAD", "DERIVED_REVISION_CANCELLED"]);
    return { code: error.code, classification: transientCodes.has(error.code) ? "transient" : "fatal", message };
  }
  if (error instanceof RangeError && error.message === "derived terrain residency contains no manifest chunks") {
    return { code: "RESIDENCY_OUTSIDE_DOMAIN", classification: "transient", message };
  }
  return { code: "INTERNAL_ERROR", classification: "fatal", message };
}
function cloneForTransfer(value, transfers, seen = /* @__PURE__ */ new Map()) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") throw fatal2("RESOURCE_NOT_SERIALIZABLE", "derived runtime resource contains unsupported data");
  const prior = seen.get(value);
  if (prior !== void 0) return prior;
  if (value instanceof ArrayBuffer) {
    const copy2 = value.slice(0);
    transfers.push(copy2);
    seen.set(value, copy2);
    return copy2;
  }
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      const copyBuffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      transfers.push(copyBuffer);
      const copy3 = new DataView(copyBuffer);
      seen.set(value, copy3);
      return copy3;
    }
    const source = value;
    const Constructor = source.constructor;
    const copy2 = new Constructor(source);
    transfers.push(copy2.buffer);
    seen.set(value, copy2);
    return copy2;
  }
  if (Array.isArray(value)) {
    const copy2 = [];
    seen.set(value, copy2);
    for (const entry of value) copy2.push(cloneForTransfer(entry, transfers, seen));
    return copy2;
  }
  if (value instanceof Map) {
    const copy2 = /* @__PURE__ */ new Map();
    seen.set(value, copy2);
    for (const [key, entry] of value) copy2.set(cloneForTransfer(key, transfers, seen), cloneForTransfer(entry, transfers, seen));
    return copy2;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw fatal2("RESOURCE_NOT_SERIALIZABLE", "derived runtime resource contains a non-plain object");
  }
  const copy = {};
  seen.set(value, copy);
  for (const [key, descriptor2] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor2) || descriptor2.enumerable !== true) {
      throw fatal2("RESOURCE_NOT_SERIALIZABLE", `derived runtime resource field '${key}' is not plain data`);
    }
    copy[key] = cloneForTransfer(descriptor2.value, transfers, seen);
  }
  return copy;
}
function sourceMatches(source, pinned) {
  return source.revision === pinned.revision && source.headHash === pinned.headHash;
}
var DerivedRuntimeWorkerController = class {
  #postMessage;
  #createTransport;
  #timers;
  #ackTimeoutMs;
  #lifecycle = new AbortController();
  #transport = null;
  #manager = null;
  #projectId = "";
  #branchId = "";
  #mode = null;
  #pinnedSource = null;
  #pinnedManifestHash = null;
  #desiredResidency;
  #submissionResidency = null;
  #appliedResidencyKey = null;
  #pendingResidency = null;
  #activeReconcileRequestId = null;
  #submissionReconcileRequestId = null;
  #observed;
  #submissionCurrent = null;
  #pollTimer = null;
  #pollTimerExplicit = false;
  #polling = false;
  #backoffIndex = 0;
  #activationSequence = 0;
  #pendingActivation = null;
  #initialized = false;
  #closed = false;
  #closePromise = null;
  constructor(dependencies) {
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      throw new TypeError("derived runtime worker dependencies must be an object");
    }
    if (typeof dependencies.postMessage !== "function") throw new TypeError("derived runtime worker postMessage must be a function");
    this.#postMessage = dependencies.postMessage;
    this.#createTransport = dependencies.createTransport ?? ((config) => new DerivedRuntimeTransport(config));
    this.#timers = dependencies.timers ?? {
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle) => globalThis.clearTimeout(handle)
    };
    this.#ackTimeoutMs = dependencies.activationAckTimeoutMs ?? DERIVED_RUNTIME_ACTIVATION_ACK_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#ackTimeoutMs) || this.#ackTimeoutMs < 100 || this.#ackTimeoutMs > 12e4) {
      throw new RangeError("derived runtime worker activationAckTimeoutMs must be an integer in [100, 120000]");
    }
  }
  get isInitialized() {
    return this.#initialized;
  }
  get isClosed() {
    return this.#closed;
  }
  get isPolling() {
    return this.#polling;
  }
  async handleMessage(input) {
    let message;
    try {
      message = parseDerivedRuntimeWorkerInput(input);
      if (message.type === "init") {
        this.#initialize(message);
        return;
      }
      if (message.type === "set-residency") {
        this.#setResidency(message, "set");
        return;
      }
      if (message.type === "reconcile-residency") {
        this.#setResidency(message, "reconcile");
        return;
      }
      if (message.type === "activation-ack") {
        this.#acknowledge(message);
        return;
      }
      await this.close(message.requestId);
    } catch (error) {
      this.#emitError(error);
    }
  }
  #initialize(message) {
    if (this.#closed) throw fatal2("DERIVED_RUNTIME_CLOSED", "derived runtime worker is closed");
    if (this.#initialized) throw fatal2("ALREADY_INITIALIZED", "derived runtime worker is already initialized");
    const transport = this.#createTransport(message.config);
    this.#projectId = message.config.projectId;
    this.#branchId = message.config.branchId;
    this.#mode = message.mode;
    this.#pinnedSource = message.pinnedSource ?? null;
    this.#pinnedManifestHash = message.pinnedSource?.manifestHash ?? null;
    this.#desiredResidency = message.residency;
    this.#transport = transport;
    this.#manager = new DerivedRevisionManager({
      projectId: this.#projectId,
      branchId: this.#branchId,
      getAuthoritativeSource: () => this.#getAuthoritativeSource(),
      loadArtifact: (input) => this.#loadArtifact(input.manifest.manifestHash, input.artifact, input.signal),
      selectChunks: (manifest) => {
        if (this.#submissionResidency === null) {
          throw fatal2("NO_SUBMISSION_RESIDENCY", "derived runtime has no residency bound to the active submission");
        }
        return selectDerivedTerrainChunks(manifest, this.#submissionResidency);
      },
      stageChunk: (input) => stageDerivedRuntimeChunk(input),
      stageGlobal: (input) => this.#stageGlobal(input),
      activateRevision: (input) => this.#activate(input),
      disposeChunk: async () => {
      },
      disposeGlobal: async () => {
      }
    });
    this.#initialized = true;
    this.#postMessage(Object.freeze({
      schema: DERIVED_RUNTIME_WORKER_SCHEMA,
      type: "ready",
      requestId: message.requestId,
      mode: message.mode
    }));
    this.#schedulePoll(0, true);
  }
  #setResidency(message, kind) {
    if (this.#closed) throw fatal2("DERIVED_RUNTIME_CLOSED", "derived runtime worker is closed");
    if (!this.#initialized) throw fatal2("NOT_INITIALIZED", "derived runtime worker is not initialized");
    if (this.#pendingResidency !== null) {
      throw fatal2("RESIDENCY_UPDATE_OVERLAP", "derived runtime already has a residency update awaiting acknowledgement");
    }
    if (derivedTerrainResidencyKey(message.residency) === derivedTerrainResidencyKey(this.#desiredResidency)) {
      if (kind === "set") this.#postResidencyAck(message.requestId, message.residency);
      else {
        this.#pendingResidency = Object.freeze({ kind, requestId: message.requestId, residency: message.residency });
        if (!this.#polling) this.#acceptPendingResidency();
      }
      return;
    }
    this.#pendingResidency = Object.freeze({ kind, requestId: message.requestId, residency: message.residency });
    if (!this.#polling) this.#acceptPendingResidency();
  }
  #postResidencyAck(requestId2, residency) {
    this.#postMessage(Object.freeze({
      schema: DERIVED_RUNTIME_WORKER_SCHEMA,
      type: "residency-ack",
      requestId: requestId2,
      residency
    }));
  }
  #acceptPendingResidency() {
    const pending = this.#pendingResidency;
    if (pending === null || this.#closed) return false;
    this.#pendingResidency = null;
    this.#desiredResidency = pending.residency;
    if (pending.kind === "reconcile") this.#activeReconcileRequestId = pending.requestId;
    this.#backoffIndex = 0;
    if (this.#pollTimer !== null) {
      this.#timers.clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
      this.#pollTimerExplicit = false;
    }
    if (pending.kind === "set") this.#postResidencyAck(pending.requestId, pending.residency);
    this.#schedulePoll(0, true);
    return true;
  }
  async #getAuthoritativeSource() {
    const transport = this.#requireTransport();
    const current = this.#submissionCurrent;
    if (current === null) throw fatal2("NO_SUBMISSION_PUBLICATION", "derived runtime has no publication bound to the active submission");
    const result = await transport.fetchCurrent({ previous: current, signal: this.#lifecycle.signal });
    this.#observed = result.current;
    if (this.#mode === "pinned" && !sourceMatches(result.current.source, this.#pinnedSource)) {
      throw fatal2("PINNED_SOURCE_MISMATCH", "published source changed during pinned residency activation");
    }
    if (result.current.manifestHash !== current.manifestHash && this.#mode === "pinned") {
      throw fatal2("PINNED_MANIFEST_MISMATCH", "published derived manifest changed during pinned residency activation");
    }
    if (result.current.manifestHash !== current.manifestHash && result.current.source.revision === current.source.revision && result.current.source.headHash === current.source.headHash) {
      throw transient2("CURRENT_CHANGED", "published derived manifest changed during residency activation");
    }
    return Object.freeze({
      projectId: this.#projectId,
      branchId: this.#branchId,
      revision: result.current.source.revision,
      headHash: result.current.source.headHash
    });
  }
  async #loadArtifact(manifestHash, descriptor2, signal) {
    const current = this.#submissionCurrent;
    if (current === null || current.manifestHash !== manifestHash) {
      throw fatal2("PUBLICATION_BINDING_MISMATCH", "artifact load is not bound to the submitted publication");
    }
    const result = await this.#requireTransport().fetchArtifact(current, descriptor2, { signal });
    if (result.status !== "artifact") throw fatal2("PROTOCOL_ERROR", "derived artifact unexpectedly returned not-modified");
    return result.bytes;
  }
  #stageGlobal(input) {
    if (input.signal.aborted) throw input.signal.reason;
    if (input.artifact.artifactType === WORLD_OVERVIEW_ARTIFACT_TYPE) {
      validateDescriptor(input.artifact, WORLD_OVERVIEW_ARTIFACT_TYPE, WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE, "world overview");
      const decoded = decodeWorldOverviewArtifact(input.bytes, { shouldCancel: () => input.signal.aborted });
      if (input.signal.aborted) throw input.signal.reason;
      return Object.freeze({ kind: WORLD_OVERVIEW_ARTIFACT_TYPE, decoded });
    }
    if (input.artifact.artifactType === NAVIGATION_INDEX_ARTIFACT_TYPE) {
      validateDescriptor(input.artifact, NAVIGATION_INDEX_ARTIFACT_TYPE, NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE, "navigation index");
      decodeNavigationIndexArtifact(input.bytes, { shouldCancel: () => input.signal.aborted });
      if (input.signal.aborted) throw input.signal.reason;
      return Object.freeze({ kind: NAVIGATION_INDEX_ARTIFACT_TYPE, bytes: input.bytes });
    }
    if (input.artifact.artifactType === BIOME_FIELD_ARTIFACT_TYPE) {
      validateDescriptor(input.artifact, BIOME_FIELD_ARTIFACT_TYPE, BIOME_FIELD_ARTIFACT_MEDIA_TYPE, "biome field");
      decodeBiomeFieldArtifact(input.bytes, { shouldCancel: () => input.signal.aborted });
      if (input.signal.aborted) throw input.signal.reason;
      return Object.freeze({ kind: BIOME_FIELD_ARTIFACT_TYPE, bytes: input.bytes });
    }
    if (input.artifact.artifactType === BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE) {
      validateDescriptor(
        input.artifact,
        BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
        BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE,
        "biome content closure"
      );
      decodeBiomeContentClosureArtifact(input.bytes, { shouldCancel: () => input.signal.aborted });
      if (input.signal.aborted) throw input.signal.reason;
      return Object.freeze({ kind: BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE, bytes: input.bytes });
    }
    if (input.artifact.artifactType === BIOME_RUNTIME_PACK_ARTIFACT_TYPE) {
      validateDescriptor(
        input.artifact,
        BIOME_RUNTIME_PACK_ARTIFACT_TYPE,
        BIOME_RUNTIME_PACK_ARTIFACT_MEDIA_TYPE,
        "biome runtime pack"
      );
      decodeBiomeRuntimePackArtifact(input.bytes);
      if (input.signal.aborted) throw input.signal.reason;
      return Object.freeze({ kind: BIOME_RUNTIME_PACK_ARTIFACT_TYPE, bytes: input.bytes });
    }
    if (input.artifact.artifactType === HYDROLOGY_FIELD_ARTIFACT_TYPE) {
      validateDescriptor(input.artifact, HYDROLOGY_FIELD_ARTIFACT_TYPE, HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE, "hydrology field");
      const decode = decodeHydrologyFieldArtifact;
      const decoded = decode(input.bytes, { shouldCancel: () => input.signal.aborted });
      if (input.signal.aborted) throw input.signal.reason;
      return Object.freeze({ kind: "hydrology-field/v1", decoded });
    }
    if (input.artifact.artifactType === HYDROLOGY_WATER_ARTIFACT_TYPE) {
      validateDescriptor(input.artifact, HYDROLOGY_WATER_ARTIFACT_TYPE, HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE, "hydrology water");
      const field = input.dependencies.get(HYDROLOGY_FIELD_ARTIFACT_TYPE);
      if (field === void 0) throw fatal2("GLOBAL_DEPENDENCY_MISSING", "hydrology water requires the staged hydrology field");
      const inspectBindings = inspectHydrologyWaterArtifactBindings;
      const bindings = inspectBindings(input.bytes);
      if (bindings.hydrologyFieldContentHash !== field.artifact.contentHash) {
        throw fatal2("WATER_FIELD_BINDING_MISMATCH", "hydrology water artifact is bound to another hydrology field");
      }
      if (bindings.compilerGraphHash !== derivedArtifactCompilerGraphHash(input.manifest, HYDROLOGY_WATER_ARTIFACT_TYPE)) {
        throw fatal2("WATER_GRAPH_BINDING_MISMATCH", "hydrology water artifact is bound to another compiler graph");
      }
      const prepared = prepareGeneratedWaterFieldInput({
        bytes: input.bytes,
        descriptor: input.artifact,
        expectedBindings: bindings
      }, { shouldCancel: () => input.signal.aborted });
      if (input.signal.aborted) throw input.signal.reason;
      return Object.freeze({
        kind: "hydrology-water-topology/v1",
        artifact: input.artifact,
        bytes: input.bytes,
        bindings,
        prepared
      });
    }
    throw fatal2("UNSUPPORTED_GLOBAL_ARTIFACT", `derived runtime does not support global artifact '${input.artifact.artifactType}'`);
  }
  async #activate(input) {
    if (this.#pendingActivation !== null) throw fatal2("ACTIVATION_OVERLAP", "derived runtime activation overlapped another acknowledgement");
    const activation = input;
    const transfers = [];
    const candidate = cloneForTransfer({
      manifest: activation.manifest,
      chunks: activation.chunks,
      globals: [...activation.globals.values()]
    }, transfers);
    const activationId = `derived-activation-${++this.#activationSequence}`;
    const residency = this.#submissionResidency;
    if (residency === null) throw fatal2("NO_SUBMISSION_RESIDENCY", "derived runtime activation has no bound residency");
    const requestId2 = this.#submissionReconcileRequestId;
    const snapshot = {
      schema: DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA,
      projectId: this.#projectId,
      branchId: this.#branchId,
      manifestHash: candidate.manifest.manifestHash,
      source: candidate.manifest.source,
      manifest: candidate.manifest,
      residency,
      chunks: candidate.chunks,
      globals: candidate.globals
    };
    await new Promise((resolve, reject) => {
      const timeout = this.#timers.setTimeout(() => {
        if (this.#pendingActivation?.activationId !== activationId) return;
        this.#pendingActivation = null;
        reject(transient2("ACTIVATION_ACK_TIMEOUT", "derived runtime activation acknowledgement timed out"));
      }, this.#ackTimeoutMs);
      this.#pendingActivation = { activationId, ...requestId2 === null ? {} : { requestId: requestId2 }, resolve, reject, timeout };
      try {
        this.#postMessage(Object.freeze({
          schema: DERIVED_RUNTIME_WORKER_SCHEMA,
          type: "activate",
          activationId,
          ...requestId2 === null ? {} : { requestId: requestId2 },
          snapshot
        }), transfers);
      } catch (error) {
        this.#timers.clearTimeout(timeout);
        this.#pendingActivation = null;
        reject(error instanceof Error ? error : fatal2("POST_MESSAGE_FAILED", "derived runtime activation could not be posted"));
      }
    });
  }
  #acknowledge(message) {
    if (!this.#initialized) throw fatal2("NOT_INITIALIZED", "derived runtime worker is not initialized");
    const pending = this.#pendingActivation;
    if (pending === null || pending.activationId !== message.activationId) {
      throw fatal2("UNKNOWN_ACTIVATION", "derived runtime activation acknowledgement is not pending");
    }
    if (pending.requestId !== message.requestId) {
      throw fatal2("UNKNOWN_ACTIVATION", "derived runtime activation acknowledgement reconciliation does not match");
    }
    this.#timers.clearTimeout(pending.timeout);
    this.#pendingActivation = null;
    if (message.accepted) pending.resolve();
    else pending.reject(transient2("ACTIVATION_REJECTED", `main thread rejected activation (${message.errorCode})`));
  }
  #schedulePoll(delayMs, explicit = false) {
    if (this.#closed || this.#mode === "pinned" && !explicit) return;
    if (this.#pollTimer !== null) {
      if (!explicit || this.#pollTimerExplicit) return;
      this.#timers.clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#pollTimerExplicit = explicit;
    this.#pollTimer = this.#timers.setTimeout(() => {
      const wasExplicit = this.#pollTimerExplicit;
      this.#pollTimer = null;
      this.#pollTimerExplicit = false;
      void this.#poll(wasExplicit);
    }, delayMs);
  }
  async #poll(explicit) {
    if (this.#closed || this.#polling) return;
    this.#polling = true;
    const submissionResidency = this.#desiredResidency;
    const submissionResidencyKey = derivedTerrainResidencyKey(submissionResidency);
    const submissionReconcileRequestId = this.#activeReconcileRequestId;
    let canContinue = true;
    try {
      const result = await this.#requireTransport().fetchCurrent({ previous: this.#observed, signal: this.#lifecycle.signal });
      const current = result.current;
      this.#observed = current;
      if (this.#mode === "pinned" && !sourceMatches(current.source, this.#pinnedSource)) {
        throw fatal2(
          "PINNED_SOURCE_MISMATCH",
          `published source ${current.source.revision}/${current.source.headHash} does not match the pinned source`
        );
      }
      if (this.#mode === "pinned") {
        if (this.#pinnedManifestHash === null) this.#pinnedManifestHash = current.manifestHash;
        else if (current.manifestHash !== this.#pinnedManifestHash) {
          throw fatal2("PINNED_MANIFEST_MISMATCH", "published derived manifest does not match the pinned manifest");
        }
      }
      if (result.status === "not-modified" && this.#manager.current?.manifest.manifestHash === current.manifestHash && this.#appliedResidencyKey === submissionResidencyKey) {
        this.#backoffIndex = 0;
        this.#postMessage(Object.freeze({
          schema: DERIVED_RUNTIME_WORKER_SCHEMA,
          type: "revision",
          ...submissionReconcileRequestId === null ? {} : { requestId: submissionReconcileRequestId },
          status: "unchanged",
          manifestHash: current.manifestHash,
          revision: current.source.revision
        }));
        if (this.#activeReconcileRequestId === submissionReconcileRequestId) this.#activeReconcileRequestId = null;
        if (this.#mode === "watch") this.#schedulePoll(DERIVED_RUNTIME_POLL_DELAYS_MS[0], false);
        return;
      }
      this.#submissionCurrent = current;
      this.#submissionResidency = submissionResidency;
      this.#submissionReconcileRequestId = submissionReconcileRequestId;
      const submit = this.#manager.submit;
      const outcome = await submit.call(this.#manager, current.manifest, { signal: this.#lifecycle.signal });
      this.#appliedResidencyKey = submissionResidencyKey;
      this.#submissionCurrent = null;
      this.#submissionResidency = null;
      this.#submissionReconcileRequestId = null;
      this.#backoffIndex = 0;
      this.#postMessage(Object.freeze({
        schema: DERIVED_RUNTIME_WORKER_SCHEMA,
        type: "revision",
        ...submissionReconcileRequestId === null ? {} : { requestId: submissionReconcileRequestId },
        status: outcome.status,
        manifestHash: outcome.manifestHash,
        revision: outcome.revision
      }));
      if (this.#activeReconcileRequestId === submissionReconcileRequestId) this.#activeReconcileRequestId = null;
      if (this.#mode === "watch") this.#schedulePoll(DERIVED_RUNTIME_POLL_DELAYS_MS[0], false);
    } catch (error) {
      this.#submissionCurrent = null;
      this.#submissionResidency = null;
      this.#submissionReconcileRequestId = null;
      if (this.#closed) return;
      const summary = shortError(error);
      this.#emitError(error, submissionReconcileRequestId);
      canContinue = summary.classification !== "fatal";
      if ((summary.classification === "fatal" || summary.code === "RESIDENCY_OUTSIDE_DOMAIN") && this.#activeReconcileRequestId === submissionReconcileRequestId) this.#activeReconcileRequestId = null;
      if (summary.classification === "transient" && summary.code !== "RESIDENCY_OUTSIDE_DOMAIN") {
        const delay = DERIVED_RUNTIME_POLL_DELAYS_MS[Math.min(this.#backoffIndex, DERIVED_RUNTIME_POLL_DELAYS_MS.length - 1)];
        this.#backoffIndex = Math.min(this.#backoffIndex + 1, DERIVED_RUNTIME_POLL_DELAYS_MS.length - 1);
        this.#schedulePoll(delay, explicit || this.#mode === "pinned");
      }
    } finally {
      this.#polling = false;
      if (canContinue) this.#acceptPendingResidency();
    }
  }
  #requireTransport() {
    if (this.#transport === null) throw fatal2("NOT_INITIALIZED", "derived runtime worker is not initialized");
    return this.#transport;
  }
  #emitError(error, requestId2) {
    const summary = shortError(error);
    this.#postMessage(Object.freeze({
      schema: DERIVED_RUNTIME_WORKER_SCHEMA,
      type: "error",
      ...requestId2 === void 0 || requestId2 === null ? {} : { requestId: requestId2 },
      code: summary.code,
      classification: summary.classification,
      message: summary.message
    }));
  }
  close(request = "internal-close") {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    this.#lifecycle.abort(fatal2("DERIVED_RUNTIME_CLOSED", "derived runtime worker was closed"));
    if (this.#pollTimer !== null) {
      this.#timers.clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.#pollTimerExplicit = false;
    this.#pendingResidency = null;
    this.#activeReconcileRequestId = null;
    this.#submissionReconcileRequestId = null;
    const pending = this.#pendingActivation;
    if (pending !== null) {
      this.#timers.clearTimeout(pending.timeout);
      this.#pendingActivation = null;
      pending.reject(fatal2("DERIVED_RUNTIME_CLOSED", "derived runtime worker closed during activation"));
    }
    this.#closePromise = (async () => {
      try {
        await this.#manager?.close();
      } finally {
        this.#postMessage(Object.freeze({
          schema: DERIVED_RUNTIME_WORKER_SCHEMA,
          type: "closed",
          requestId: request
        }));
      }
    })();
    return this.#closePromise;
  }
};
function installDerivedRuntimeWorker(scope) {
  const controller = new DerivedRuntimeWorkerController({
    postMessage: (message, transfer) => scope.postMessage(message, transfer)
  });
  scope.onmessage = (event) => {
    void controller.handleMessage(event.data);
  };
  return controller;
}

// src/browser/derived-runtime-worker-entry.ts
if (typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope) {
  installDerivedRuntimeWorker(self);
}
