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
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (descriptor?.get !== void 0 || descriptor?.set !== void 0 || descriptor?.enumerable !== true) {
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
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (descriptor?.get !== void 0 || descriptor?.set !== void 0 || descriptor?.enumerable !== true) {
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
  const byteLength = compilerUtf8ByteLength(canonical);
  if (byteLength > maxBytes) throw new Error(`compiler canonical value is ${byteLength} bytes; maximum is ${maxBytes}`);
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
var MAX_DERIVED_MANIFEST_BYTES = 32 * 1024 * 1024;
var MAX_DERIVED_CHUNKS = 16384;
var MAX_SOURCE_CONTENT_REFS = 64;
var MAX_ARTIFACTS_PER_CHUNK = 16;
var MAX_GLOBAL_DERIVED_ARTIFACTS = 64;
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
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== void 0 || descriptor?.set !== void 0 || descriptor?.enumerable !== true) {
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
  if (schema !== DERIVED_REVISION_MANIFEST_SCHEMA_V1 && schema !== DERIVED_REVISION_MANIFEST_SCHEMA_V2) {
    throw new Error(
      `derived revision manifest schema must be '${DERIVED_REVISION_MANIFEST_SCHEMA_V1}' or '${DERIVED_REVISION_MANIFEST_SCHEMA_V2}'`
    );
  }
  const isV2 = schema === DERIVED_REVISION_MANIFEST_SCHEMA_V2;
  const keys = /* @__PURE__ */ new Set(["schema", "projectId", "branchId", "source", "compiler", "grid", "chunks"]);
  if (isV2) keys.add("globalArtifacts");
  if (includeHash) keys.add("manifestHash");
  exactKeys(value, keys, "derived revision manifest");
  const projectId = identifier(value.projectId, PROJECT_ID, "derived manifest projectId");
  const branchId = identifier(value.branchId, BRANCH_ID, "derived manifest branchId");
  const source = parseSource(value.source);
  const compiler = parseCompiler(value.compiler);
  const grid = parseGrid(value.grid);
  const budget = { artifactCount: 0, totalArtifactBytes: 0 };
  const globalArtifacts = isV2 ? parseGlobalArtifacts(value.globalArtifacts, budget) : void 0;
  const chunks = parseChunks(value.chunks, grid, source.contentRefs, budget);
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
  return manifest.schema === DERIVED_REVISION_MANIFEST_SCHEMA_V2 ? manifest.globalArtifacts : EMPTY_GLOBAL_DERIVED_ARTIFACTS;
}
function derivedArtifactContentHash(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("derived artifact bytes must be Uint8Array");
  if (bytes.byteLength > MAX_DERIVED_ARTIFACT_BYTES) throw new Error(`derived artifact exceeds ${MAX_DERIVED_ARTIFACT_BYTES} bytes`);
  return `sha256:${sha256(bytes)}`;
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
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || descriptor.get !== void 0 || descriptor.set !== void 0) {
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
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor?.enumerable !== true || descriptor.get !== void 0 || descriptor.set !== void 0;
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
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable !== true || descriptor.get !== void 0 || descriptor.set !== void 0;
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
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw fatal("PROTOCOL_ERROR", `${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
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
function descriptorKey(descriptor) {
  return `${descriptor.artifactType}\0${descriptor.contentHash}\0${descriptor.byteLength}\0${descriptor.mediaType}`;
}
function descriptorSet(manifest) {
  const descriptors = /* @__PURE__ */ new Set();
  for (const descriptor of derivedGlobalArtifacts(manifest)) descriptors.add(descriptorKey(descriptor));
  for (const chunk of manifest.chunks) for (const descriptor of chunk.artifacts) descriptors.add(descriptorKey(descriptor));
  return descriptors;
}
function contentEtag(contentHash) {
  return `"${contentHash}"`;
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
  async fetchArtifact(current, descriptor, options = {}) {
    const binding = this.#bindings.get(current);
    if (binding === void 0 || !binding.descriptorKeys.has(descriptorKey(descriptor))) {
      throw fatal("PROTOCOL_ERROR", "derived artifact descriptor is not bound to this transport publication");
    }
    if (descriptor.byteLength > MAX_DERIVED_ARTIFACT_BYTES) throw fatal("PROTOCOL_ERROR", "derived artifact descriptor exceeds the server cap");
    const manifestHex = current.manifestHash.slice(7);
    const contentHex = descriptor.contentHash.slice(7);
    const response = await this.#request(
      `${this.#config.baseUrl}/v1/derived/manifests/${manifestHex}/artifacts/${contentHex}`,
      {
        signal: options.signal,
        headers: options.allowNotModified ? { "If-None-Match": contentEtag(descriptor.contentHash) } : void 0
      }
    );
    if (response.status === 304) {
      try {
        if (!options.allowNotModified) throw fatal("PROTOCOL_ERROR", "derived artifact returned an unsolicited 304");
        this.#validateArtifactHeaders(response, current, descriptor, true);
      } catch (error) {
        await cancelResponseBody(response);
        throw error;
      }
      return Object.freeze({ status: "not-modified", contentHash: descriptor.contentHash });
    }
    if (response.status !== 200) await this.#throwResponseError(response, options.signal);
    try {
      this.#validateArtifactHeaders(response, current, descriptor, false);
    } catch (error) {
      await cancelResponseBody(response);
      throw error;
    }
    const bytes = await readBounded(response, descriptor.byteLength, MAX_DERIVED_ARTIFACT_BYTES, options.signal);
    throwIfAborted(options.signal);
    const actualHash = await sha2562(this.#crypto, bytes);
    throwIfAborted(options.signal);
    if (actualHash !== descriptor.contentHash) throw fatal("INTEGRITY_ERROR", "derived artifact SHA-256 does not match its descriptor");
    return Object.freeze({ status: "artifact", contentHash: descriptor.contentHash, bytes });
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
  #validateArtifactHeaders(response, current, descriptor, notModified) {
    exactHeader(response.headers, "etag", contentEtag(descriptor.contentHash), "derived artifact");
    exactHeader(response.headers, "x-limina-content-hash", descriptor.contentHash, "derived artifact");
    exactHeader(response.headers, "x-limina-manifest-hash", current.manifestHash, "derived artifact");
    exactHeader(response.headers, "content-type", descriptor.mediaType, "derived artifact");
    const length = parseLength(response.headers, MAX_DERIVED_ARTIFACT_BYTES, "derived artifact");
    const expected = notModified ? 0 : descriptor.byteLength;
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
    const descriptor = Object.getOwnPropertyDescriptor(selected, String(index));
    const canonicalIndex = canonicalIndices.get(descriptor?.value);
    if (descriptor?.enumerable !== true || descriptor.get !== void 0 || descriptor.set !== void 0 || canonicalIndex === void 0 || canonicalIndex <= previousIndex) {
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
var PAINT_MATERIAL_MAX = 6;
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
  const layout = payloadLayout(cells, flags, climateChannels);
  if (layout.paintMatPadding !== null) {
    for (let offset = layout.paintMatPadding.offset; offset < layout.paintMatPadding.offset + layout.paintMatPadding.byteLength; offset++) {
      if (bytes[offset] !== 0) throw new Error("terrain artifact paintMat alignment padding must be zero");
    }
  }
  const origin = new Array(3);
  const scale = new Array(3);
  for (let axis = 0; axis < 3; axis++) {
    origin[axis] = boundedOrigin(view.getFloat64(32 + axis * 8, true), `terrain artifact origin[${axis}]`);
    scale[axis] = boundedScale(view.getFloat64(56 + axis * 8, true), `terrain artifact scale[${axis}]`);
  }
  const heights = readFloat32Channel(view, layout.heights, cells);
  validateFloatChannel(heights, "terrain artifact heights", normalized);
  let paintMat;
  if (layout.paintMat !== null) {
    paintMat = new Uint8Array(cells);
    paintMat.set(bytes.subarray(layout.paintMat, layout.paintMat + cells));
    for (let index = 0; index < paintMat.length; index++) {
      if (paintMat[index] > PAINT_MATERIAL_MAX) throw new RangeError(`terrain artifact paintMat[${index}] must be in [0, ${PAINT_MATERIAL_MAX}]`);
    }
  }
  let paintW;
  if (layout.paintW !== null) {
    paintW = readFloat32Channel(view, layout.paintW, cells);
    validateFloatChannel(paintW, "terrain artifact paintW", normalized);
  }
  let climate;
  if (layout.climate !== null) {
    climate = readFloat32Channel(view, layout.climate, cells * climateChannels);
    validateClimate(climate, cells);
  }
  let blight;
  if (layout.blight !== null) {
    blight = readFloat32Channel(view, layout.blight, cells);
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
    offsets: layout,
    storage: "owned-channel-copies"
  });
  return Object.freeze({ metadata, tile });
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
var MAGIC2 = new Uint8Array([76, 72, 89, 68, 70, 76, 68, 49]);
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
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`${label}.${key} must be an enumerable data field`);
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
  for (let index = 0; index < MAGIC2.length; index++) if (view.getUint8(index) !== MAGIC2[index]) fail("hydrology artifact magic mismatch");
  if (view.getUint16(8, true) !== HYDROLOGY_FIELD_ARTIFACT_VERSION) fail("hydrology artifact version is unsupported");
  if (view.getUint16(10, true) !== 0) fail("hydrology artifact flags must be zero");
  if (view.getUint16(12, true) !== HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES) fail("hydrology artifact header length mismatch");
  if (view.getUint16(14, true) !== 0) fail("hydrology artifact reserved header field must be zero");
  for (let index = 96; index < HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES; index++) if (view.getUint8(index) !== 0) fail("hydrology artifact reserved header bytes must be zero");
  const rows = dimension2(view.getUint32(16, true), "hydrology artifact rows");
  const cols = dimension2(view.getUint32(20, true), "hydrology artifact cols");
  const cells = rows * cols;
  if (cells > MAX_HYDROLOGY_CELLS || view.getUint32(24, true) !== cells) fail("hydrology artifact cell count does not match dimensions");
  const layout = layoutForCells(cells);
  if (view.getUint32(28, true) !== bytes.byteLength || bytes.byteLength !== layout.byteLength) fail("hydrology artifact byte length is non-canonical");
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
    [72, layout.receiver, "receiver"],
    [76, layout.drainageRank, "drainageRank"],
    [80, layout.filledHeightM, "filledHeightM"],
    [84, layout.catchmentAreaM2, "catchmentAreaM2"],
    [88, layout.streamOrder, "streamOrder"],
    [92, layout.oceanMask, "oceanMask"]
  ]) if (view.getUint32(offset, true) !== expected) fail(`hydrology artifact ${label} offset is non-canonical`);
  for (let index = layout.dataEnd; index < layout.byteLength; index++) if (view.getUint8(index) !== 0) fail("hydrology artifact alignment padding must be zero");
  const receiver = new Int32Array(cells);
  const drainageRank = new Uint32Array(cells);
  const filledHeightM = new Float64Array(cells);
  const catchmentAreaM2 = new Float64Array(cells);
  const streamOrder = new Uint8Array(cells);
  const oceanMask = new Uint8Array(cells);
  for (let index = 0; index < cells; index++) {
    meter.work();
    receiver[index] = view.getInt32(layout.receiver + index * 4, true);
    drainageRank[index] = view.getUint32(layout.drainageRank + index * 4, true);
    filledHeightM[index] = view.getFloat64(layout.filledHeightM + index * 8, true);
    catchmentAreaM2[index] = view.getFloat64(layout.catchmentAreaM2 + index * 8, true);
    streamOrder[index] = view.getUint8(layout.streamOrder + index);
    oceanMask[index] = view.getUint8(layout.oceanMask + index);
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
    offsets: layout,
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
var MAGIC3 = new Uint8Array([76, 72, 89, 87, 65, 84, 49, 0]);
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
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail3(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail3(`${label}.${key} must be an enumerable data field`);
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
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) fail3(`${label} must be dense enumerable data`);
    values[index] = descriptor.value;
  }
  return values;
}
function canonicalNumber2(value, label, minimum, maximum, positive2 = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || (positive2 ? value <= minimum : value < minimum) || value > maximum) {
    fail3(`${label} must be a finite canonical number in ${positive2 ? "(" : "["}${minimum}, ${maximum}]`);
  }
  return value;
}
function integer(value, minimum, maximum, label) {
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
    const hash = descriptors[key].value;
    if (typeof hash !== "string" || !HASH_RE.test(hash)) fail3(`${label}.${key} must be a lowercase sha256 content hash`);
    parsed[key] = hash;
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
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail3(`${label}.${key} must be an enumerable data field`);
    validateDiagnostics(descriptor.value, seen, budget, `${label}.${key}`);
  }
}
function parseTopology(value) {
  const seen = /* @__PURE__ */ new Set();
  const descriptors = exactRecord2(value, ROOT_KEYS, "hydrology water topology", seen);
  if (descriptors.schema.value !== HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA || descriptors.version.value !== HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION) fail3("hydrology water topology schema/version is unsupported");
  const rows = integer(descriptors.rows.value, 2, MAX_HYDROLOGY_DIMENSION, "hydrology water topology rows");
  const cols = integer(descriptors.cols.value, 2, MAX_HYDROLOGY_DIMENSION, "hydrology water topology cols");
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
    const record = exactRecord2(candidate, BASIN_KEYS, path, seen);
    const seedCell = integer(record.seedCell.value, 0, cells - 1, `${path}.seedCell`);
    const spillOutsideCell = integer(record.spillOutsideCell.value, 0, cells - 1, `${path}.spillOutsideCell`);
    const id = `gen-b-${spillOutsideCell.toString(36)}-${seedCell.toString(36)}`;
    if (record.id.value !== id) fail3(`${path}.id must equal '${id}'`);
    if (basinIds.has(id)) fail3(`hydrology water topology has duplicate basin id '${id}'`);
    if (basinIndex > 0 && id <= priorBasinId) fail3("hydrology water topology basins must be strictly ordered by id");
    priorBasinId = id;
    basinIds.add(id);
    if (record.kind.value !== "lake") fail3(`${path}.kind must be 'lake'`);
    const footprintRecord = exactRecord2(record.footprint.value, FOOTPRINT_KEYS, `${path}.footprint`, seen, /* @__PURE__ */ new Set(["holes"]));
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
      spillLevelM: canonicalNumber2(record.spillLevelM.value, `${path}.spillLevelM`, -WATER_LIMITS.absLevelM, WATER_LIMITS.absLevelM),
      maxDepthM: canonicalNumber2(record.maxDepthM.value, `${path}.maxDepthM`, 0, WATER_LIMITS.depthM, true),
      areaM2: canonicalNumber2(record.areaM2.value, `${path}.areaM2`, 0, 1e12, true),
      cellCount: integer(record.cellCount.value, 1, cells, `${path}.cellCount`),
      seedCell,
      spillInsideCell: integer(record.spillInsideCell.value, 0, cells - 1, `${path}.spillInsideCell`),
      spillOutsideCell,
      spillOutsideDrainageRank: integer(record.spillOutsideDrainageRank.value, 0, cells - 1, `${path}.spillOutsideDrainageRank`),
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
    const record = exactRecord2(candidate, REACH_KEYS, path, seen);
    const startCell = integer(record.startCell.value, 0, cells - 1, `${path}.startCell`);
    const endCell = integer(record.endCell.value, 0, cells - 1, `${path}.endCell`);
    const id = `gen-r-${startCell.toString(36)}-${endCell.toString(36)}`;
    if (record.id.value !== id) fail3(`${path}.id must equal '${id}'`);
    if (reachIds.has(id)) fail3(`hydrology water topology has duplicate reach id '${id}'`);
    if (startCell <= priorReachStart) fail3("hydrology water topology reaches must be strictly ordered by startCell");
    priorReachStart = startCell;
    reachIds.add(id);
    const order = integer(record.order.value, 1, WATER_LIMITS.streamOrder, `${path}.order`);
    const className = order <= 2 ? "stream" : "river";
    if (record.class.value !== className) fail3(`${path}.class is inconsistent with order`);
    const points = Object.freeze(denseArray(record.points.value, 2, WATER_LIMITS.waterwayPoints, `${path}.points`, seen).map((point, index) => parsePoint(point, `${path}.points[${index}]`, seen)));
    const widthsSource = denseArray(record.widths.value, points.length, points.length, `${path}.widths`, seen);
    const terrainSource = denseArray(record.terrainElevationsM.value, points.length, points.length, `${path}.terrainElevationsM`, seen);
    const surfaceSource = denseArray(record.surfaceElevationsM.value, points.length, points.length, `${path}.surfaceElevationsM`, seen);
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
    const waterfallSource = denseArray(record.waterfalls.value, 0, points.length - 1, `${path}.waterfalls`, seen);
    let priorEnd = 0;
    const waterfalls = waterfallSource.map((candidateSpan, waterfallIndex) => {
      const spanPath = `${path}.waterfalls[${waterfallIndex}]`;
      const span = exactRecord2(candidateSpan, WATERFALL_KEYS, spanPath, seen);
      const startSegment = integer(span.startSegment.value, 0, points.length - 2, `${spanPath}.startSegment`);
      const endSegmentExclusive = integer(span.endSegmentExclusive.value, startSegment + 1, points.length - 1, `${spanPath}.endSegmentExclusive`);
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
  for (let index = 0; index < MAGIC3.length; index++) if (view.getUint8(index) !== MAGIC3[index]) fail3("hydrology water artifact magic mismatch");
  if (view.getUint16(8, true) !== HYDROLOGY_WATER_ARTIFACT_VERSION) fail3("hydrology water artifact version is unsupported");
  if (view.getUint16(10, true) !== 0) fail3("hydrology water artifact flags must be zero");
  if (view.getUint16(12, true) !== HYDROLOGY_WATER_ARTIFACT_HEADER_BYTES) fail3("hydrology water artifact header length mismatch");
  if (view.getUint16(14, true) !== 0 || view.getUint32(52, true) !== 0 || view.getUint32(108, true) !== 0) fail3("hydrology water artifact reserved header fields must be zero");
  verifyZero(bytes, 240, 256, "hydrology water artifact reserved header bytes");
  const rows = integer(view.getUint32(20, true), 2, MAX_HYDROLOGY_DIMENSION, "hydrology water artifact rows");
  const cols = integer(view.getUint32(24, true), 2, MAX_HYDROLOGY_DIMENSION, "hydrology water artifact cols");
  const cells = rows * cols;
  if (cells > MAX_HYDROLOGY_CELLS) fail3("hydrology water artifact grid exceeds supported cells");
  const counts = Object.freeze({
    basins: integer(view.getUint32(28, true), 0, WATER_LIMITS.bodies, "hydrology water artifact basin count"),
    rings: integer(view.getUint32(32, true), 0, MAX_RING_COUNT, "hydrology water artifact ring count"),
    basinPoints: integer(view.getUint32(36, true), 0, WATER_LIMITS.totalBodyPoints, "hydrology water artifact basin point count"),
    reaches: integer(view.getUint32(40, true), 0, WATER_LIMITS.waterways, "hydrology water artifact reach count"),
    reachPoints: integer(view.getUint32(44, true), 0, WATER_LIMITS.totalWaterwayPoints, "hydrology water artifact reach point count"),
    waterfalls: integer(view.getUint32(48, true), 0, WATER_LIMITS.totalWaterwayPoints, "hydrology water artifact waterfall count")
  });
  if (counts.basins === 0 !== (counts.rings === 0 && counts.basinPoints === 0)) fail3("hydrology water artifact basin section counts are inconsistent");
  if (counts.reaches === 0 !== (counts.reachPoints === 0 && counts.waterfalls === 0)) fail3("hydrology water artifact reach section counts are inconsistent");
  if (counts.rings < counts.basins || counts.basinPoints < counts.rings * 3 || counts.reachPoints < counts.reaches * 2) fail3("hydrology water artifact section counts are structurally impossible");
  const layout = layoutForCounts(counts.basins, counts.rings, counts.basinPoints, counts.reaches, counts.reachPoints, counts.waterfalls);
  if (view.getUint32(16, true) !== bytes.byteLength || bytes.byteLength !== layout.byteLength) fail3("hydrology water artifact byte length is non-canonical");
  for (const [offset, expected, label] of [
    [80, layout.basinRecords, "basin"],
    [84, layout.ringRecords, "ring"],
    [88, layout.basinPointRecords, "basin point"],
    [92, layout.reachRecords, "reach"],
    [96, layout.reachPointRecords, "reach point"],
    [100, layout.waterfallRecords, "waterfall"],
    [104, layout.dataEnd, "data end"]
  ]) {
    if (view.getUint32(offset, true) !== expected) fail3(`hydrology water artifact ${label} offset is non-canonical`);
  }
  verifyZero(bytes, layout.dataEnd, layout.byteLength, "hydrology water artifact trailing padding");
  const bindings = {};
  for (let binding = 0; binding < BINDING_KEYS.length; binding++) bindings[BINDING_KEYS[binding]] = bytesToHex(bytes, 112 + binding * 32);
  return Object.freeze({
    view,
    rows,
    cols,
    counts,
    layout,
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
  const { view, rows, cols, counts, layout, bindings: frozenBindings, placement, cellSizeM } = header;
  if (expectedBindings !== void 0) for (const key of BINDING_KEYS) {
    if (expectedBindings[key] !== frozenBindings[key]) fail3(`hydrology water artifact binding '${key}' does not match expected value`);
  }
  const allBasinPoints = new Array(counts.basinPoints);
  for (let index = 0; index < counts.basinPoints; index++) {
    meter.work();
    const offset = layout.basinPointRecords + index * BASIN_POINT_BYTES;
    allBasinPoints[index] = Object.freeze([
      canonicalNumber2(view.getFloat64(offset, true), `hydrology water artifact basin point ${index}.x`, -WATER_LIMITS.absCoordinateM, WATER_LIMITS.absCoordinateM),
      canonicalNumber2(view.getFloat64(offset + 8, true), `hydrology water artifact basin point ${index}.z`, -WATER_LIMITS.absCoordinateM, WATER_LIMITS.absCoordinateM)
    ]);
  }
  const ringRecords = new Array(counts.rings);
  let expectedBasinPoint = 0;
  for (let index = 0; index < counts.rings; index++) {
    meter.work();
    const offset = layout.ringRecords + index * RING_RECORD_BYTES;
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
    const offset = layout.basinRecords + index * BASIN_RECORD_BYTES;
    verifyZero(bytes, offset + 28, offset + 32, `hydrology water artifact basin ${index} reserved bytes`);
    verifyZero(bytes, offset + 60, offset + 64, `hydrology water artifact basin ${index} trailing reserved bytes`);
    const ringStart = view.getUint32(offset + 16, true), ringCount = view.getUint32(offset + 20, true);
    if (ringStart !== expectedRing || ringCount < 1 || ringCount > WATER_LIMITS.holes + 1 || ringStart + ringCount > counts.rings) fail3(`hydrology water artifact basin ${index} ring range is non-canonical`);
    expectedRing += ringCount;
    let pointCount = 0;
    const rings = [];
    for (let ring = ringStart; ring < ringStart + ringCount; ring++) {
      const record = ringRecords[ring];
      if (record.basinIndex !== index || record.role !== (ring === ringStart ? 0 : 1)) fail3(`hydrology water artifact basin ${index} ring ownership/role is inconsistent`);
      rings.push(Object.freeze(allBasinPoints.slice(record.pointStart, record.pointStart + record.pointCount)));
      pointCount += record.pointCount;
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
    const offset = layout.reachPointRecords + index * REACH_POINT_BYTES;
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
    const offset = layout.waterfallRecords + index * WATERFALL_RECORD_BYTES;
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
    const offset = layout.reachRecords + index * REACH_RECORD_BYTES;
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
      offsets: layout,
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
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail4(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail4(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!optional.has(key) && !Object.hasOwn(value, key)) fail4(`${label} is missing '${key}'`);
  return descriptors;
}
function parseBindingHashes(value, label) {
  const descriptors = exactDataRecord(value, GENERATED_BINDING_KEYS, label);
  const parsed = {};
  for (const key of GENERATED_BINDING_KEYS) {
    const hash = descriptors[key].value;
    if (typeof hash !== "string" || !DERIVED_CONTENT_HASH_RE.test(hash)) fail4(`${label}.${key} must be a lowercase sha256 content hash`);
    parsed[key] = hash;
  }
  return Object.freeze(parsed);
}
function prepareGeneratedWaterFieldInput(input, options = {}) {
  const descriptors = exactDataRecord(input, GENERATED_INPUT_KEYS, "generated water field input");
  const optionDescriptors = options === void 0 ? {} : exactDataRecord(options, /* @__PURE__ */ new Set(["shouldCancel"]), "generated water field options", /* @__PURE__ */ new Set(["shouldCancel"]));
  const shouldCancel = optionDescriptors.shouldCancel?.value;
  if (shouldCancel !== void 0 && typeof shouldCancel !== "function") fail4("generated water field options.shouldCancel must be a function");
  const descriptor = exactDataRecord(descriptors.descriptor.value, GENERATED_DESCRIPTOR_KEYS, "generated water artifact descriptor");
  if (descriptor.artifactType.value !== HYDROLOGY_WATER_ARTIFACT_TYPE) fail4(`generated water artifact type must be '${HYDROLOGY_WATER_ARTIFACT_TYPE}'`);
  if (descriptor.mediaType.value !== HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE) fail4(`generated water artifact media type must be '${HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE}'`);
  const contentHash = descriptor.contentHash.value;
  if (typeof contentHash !== "string" || !DERIVED_CONTENT_HASH_RE.test(contentHash)) fail4("generated water artifact contentHash must be a lowercase sha256 content hash");
  const byteLength = descriptor.byteLength.value;
  if (!Number.isSafeInteger(byteLength) || byteLength < 256 || byteLength > MAX_HYDROLOGY_WATER_ARTIFACT_BYTES) {
    fail4(`generated water artifact byteLength must be an integer in [256, ${MAX_HYDROLOGY_WATER_ARTIFACT_BYTES}]`);
  }
  const expectedBindings = parseBindingHashes(descriptors.expectedBindings.value, "expected generated water bindings");
  const bytes = descriptors.bytes.value;
  let decoded;
  try {
    if (!ArrayBuffer.isView(bytes) || Object.getPrototypeOf(bytes) !== Uint8Array.prototype || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) {
      fail4("generated water artifact bytes must own a complete non-shared Uint8Array");
    }
    if (bytes.byteLength !== byteLength) fail4(`generated water artifact byteLength mismatch: descriptor ${byteLength}, actual ${bytes.byteLength}`);
    const actualHash = `sha256:${sha256(bytes)}`;
    if (actualHash !== contentHash) fail4(`generated water artifact content hash mismatch: expected ${contentHash}, actual ${actualHash}`);
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
    artifactContentHash: contentHash,
    bindings: decoded.bindings,
    topology: decoded.topology
  });
  verifiedGeneratedInputs.add(prepared);
  return prepared;
}

// src/browser/derived-terrain-residency.ts
var DERIVED_TERRAIN_RESIDENCY_SCHEMA = "limina.derived-terrain-residency/v1";
var MAX_DERIVED_TERRAIN_RESIDENCY_RADIUS = 7;
var MAX_DERIVED_TERRAIN_RESIDENCY_CHUNKS = (MAX_DERIVED_TERRAIN_RESIDENCY_RADIUS * 2 + 1) ** 2;
function plain(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}
function exact(value, keys, label) {
  const names = Object.getOwnPropertyNames(value);
  const expected = new Set(keys);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== expected.size || names.some((name) => !expected.has(name))) {
    throw new TypeError(`${label} fields are invalid`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.enumerable !== true || descriptor.get !== void 0 || descriptor.set !== void 0) {
      throw new TypeError(`${label}.${name} must be an enumerable data field`);
    }
  }
}
function centerTuple(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2 || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== 3) {
    throw new TypeError("derived terrain residency center must be a dense two-element array");
  }
  for (let index = 0; index < 2; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || descriptor.get !== void 0 || descriptor.set !== void 0 || !Number.isFinite(descriptor.value)) {
      throw new TypeError("derived terrain residency center must contain finite data values");
    }
  }
  return Object.freeze([
    Object.is(value[0], -0) ? 0 : value[0],
    Object.is(value[1], -0) ? 0 : value[1]
  ]);
}
function parseDerivedTerrainResidency(input) {
  const value = plain(input, "derived terrain residency");
  exact(value, ["schema", "center", "lod", "radius"], "derived terrain residency");
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
var HASH3 = /^sha256:[0-9a-f]{64}$/;
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
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.enumerable !== true || descriptor.get !== void 0 || descriptor.set !== void 0) {
      throw fatal2("INVALID_MESSAGE", `${label}.${name} must be an enumerable data field`);
    }
  }
}
function requestId(value, label) {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) throw fatal2("INVALID_MESSAGE", `${label} is invalid`);
  return value;
}
function parsePinnedSource(value) {
  const record = plainRecord(value, "derived runtime pinnedSource");
  exactDataKeys(record, ["revision", "headHash"], ["manifestHash"], "derived runtime pinnedSource");
  if (!Number.isSafeInteger(record.revision) || record.revision < 0 || typeof record.headHash !== "string" || !HASH3.test(record.headHash) || record.manifestHash !== void 0 && (typeof record.manifestHash !== "string" || !HASH3.test(record.manifestHash))) {
    throw fatal2("INVALID_MESSAGE", "derived runtime pinnedSource is invalid");
  }
  return Object.freeze({
    revision: record.revision,
    headHash: record.headHash,
    ...record.manifestHash === void 0 ? {} : { manifestHash: record.manifestHash }
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
  const record = plainRecord(value, "derived runtime worker message");
  const type = Object.getOwnPropertyDescriptor(record, "type")?.value;
  if (type === "init") return parseInit(record);
  if (type === "set-residency") return parseSetResidency(record);
  if (type === "reconcile-residency") return parseReconcileResidency(record);
  if (type === "activation-ack") return parseAck(record);
  if (type === "close") return parseClose(record);
  throw fatal2("INVALID_MESSAGE", "derived runtime worker message type is unsupported");
}
function validateDescriptor(descriptor, artifactType, mediaType, label) {
  if (descriptor.artifactType !== artifactType || descriptor.mediaType !== mediaType) {
    throw fatal2("ARTIFACT_CONTRACT_MISMATCH", `${label} descriptor type or media type is invalid`);
  }
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
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw fatal2("RESOURCE_NOT_SERIALIZABLE", `derived runtime resource field '${key}' is not plain data`);
    }
    copy[key] = cloneForTransfer(descriptor.value, transfers, seen);
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
      stageChunk: (input) => this.#stageChunk(input.artifacts, input.signal),
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
  async #loadArtifact(manifestHash, descriptor, signal) {
    const current = this.#submissionCurrent;
    if (current === null || current.manifestHash !== manifestHash) {
      throw fatal2("PUBLICATION_BINDING_MISMATCH", "artifact load is not bound to the submitted publication");
    }
    const result = await this.#requireTransport().fetchArtifact(current, descriptor, { signal });
    if (result.status !== "artifact") throw fatal2("PROTOCOL_ERROR", "derived artifact unexpectedly returned not-modified");
    return result.bytes;
  }
  #stageChunk(artifacts, signal) {
    if (signal.aborted) throw signal.reason;
    if (artifacts.length !== 1) throw fatal2("UNSUPPORTED_CHUNK_ARTIFACTS", "derived terrain chunk must contain exactly one artifact");
    const payload = artifacts[0];
    validateDescriptor(payload.artifact, TERRAIN_CHUNK_ARTIFACT_TYPE, TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE, "terrain chunk");
    const decoded = decodeTerrainChunkArtifact(payload.bytes);
    if (signal.aborted) throw signal.reason;
    return Object.freeze({ kind: "terrain-chunk/v1", decoded });
  }
  #stageGlobal(input) {
    if (input.signal.aborted) throw input.signal.reason;
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
      if (bindings.compilerGraphHash !== input.manifest.compiler.graphHash) {
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
