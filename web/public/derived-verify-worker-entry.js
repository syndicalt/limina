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

// src/browser/derived-plain-data.ts
var typeError = (message) => new TypeError(message);
function plainRecord(value, label, error = typeError) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw error(`${label} must be a plain object`);
  }
  return value;
}
function exactDataKeys(value, required, optional, label, error = typeError) {
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || required.some((key) => !names.includes(key)) || names.some((key) => !allowed.has(key))) {
    throw error(`${label} has unsupported or missing fields`);
  }
  for (const name of names) {
    const descriptor3 = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor3?.enumerable !== true || descriptor3.get !== void 0 || descriptor3.set !== void 0) {
      throw error(`${label}.${name} must be an enumerable data field`);
    }
  }
}

// src/browser/derived-terrain-residency.ts
var DERIVED_TERRAIN_RESIDENCY_SCHEMA = "limina.derived-terrain-residency/v1";
var MAX_DERIVED_TERRAIN_RESIDENCY_RADIUS = 7;
var MAX_DERIVED_TERRAIN_RESIDENCY_CHUNKS = (MAX_DERIVED_TERRAIN_RESIDENCY_RADIUS * 2 + 1) ** 2;
function plain(value, label) {
  return plainRecord(value, label);
}
function exact(value, keys, label) {
  exactDataKeys(value, keys, [], label);
}
function centerTuple(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2 || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== 3) {
    throw new TypeError("derived terrain residency center must be a dense two-element array");
  }
  for (let index = 0; index < 2; index++) {
    const descriptor3 = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor3?.enumerable !== true || descriptor3.get !== void 0 || descriptor3.set !== void 0 || !Number.isFinite(descriptor3.value)) {
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

// src/terrain/stream.ts
function tileKey(tx, tz) {
  return `${validateTerrainChunkCoordinate("tx", tx)},${validateTerrainChunkCoordinate("tz", tz)}`;
}

// src/browser/derived-terrain-index.ts
function plain2(value, label) {
  return plainRecord(value, label);
}
function exact2(value, keys, label) {
  exactDataKeys(value, keys, [], label);
}
function float32(value, length, label) {
  if (!(value instanceof Float32Array) || !(value.buffer instanceof ArrayBuffer) || value.length !== length || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    throw new TypeError(`${label} must be an owned Float32Array of length ${length}`);
  }
  return value;
}
function uint8(value, length, label) {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) || value.length !== length || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    throw new TypeError(`${label} must be an owned Uint8Array of length ${length}`);
  }
  return value;
}
function tuple3(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw new TypeError(`${label} must be a finite number tuple`);
  }
  return [value[0], value[1], value[2]];
}
function parseTransferredTerrainTile(value, expected, label) {
  const decoded = plain2(value, `${label} decoded`);
  exact2(decoded, ["metadata", "tile"], `${label} decoded`);
  const metadata = plain2(decoded.metadata, `${label} metadata`);
  const tile = plain2(decoded.tile, `${label} tile`);
  exactDataKeys(
    tile,
    [],
    ["nrows", "ncols", "origin", "scale", "heights", "paintMat", "paintW", "climate", "climateChannels", "blight"],
    `${label} tile`
  );
  const nrows = tile.nrows, ncols = tile.ncols;
  if (!Number.isSafeInteger(nrows) || !Number.isSafeInteger(ncols) || nrows < 2 || ncols < 2) {
    throw new TypeError(`${label} tile dimensions are invalid`);
  }
  const cells = nrows * ncols;
  if (metadata.mediaType !== expected.mediaType || metadata.byteLength !== expected.byteLength || metadata.nrows !== nrows || metadata.ncols !== ncols || metadata.cells !== cells) {
    throw new Error(`${label} decoded metadata does not match its artifact descriptor or tile`);
  }
  const result = {
    nrows,
    ncols,
    origin: tuple3(tile.origin, `${label} tile origin`),
    scale: tuple3(tile.scale, `${label} tile scale`),
    heights: float32(tile.heights, cells, `${label} tile heights`)
  };
  if (tile.paintMat !== void 0) result.paintMat = uint8(tile.paintMat, cells, `${label} tile paintMat`);
  if (tile.paintW !== void 0) result.paintW = float32(tile.paintW, cells, `${label} tile paintW`);
  if (tile.climate !== void 0) {
    if (tile.climateChannels !== 3) throw new TypeError(`${label} tile climateChannels must be 3`);
    result.climate = float32(tile.climate, cells * 3, `${label} tile climate`);
    result.climateChannels = 3;
  } else if (tile.climateChannels !== void 0) throw new TypeError(`${label} tile climateChannels requires climate`);
  if (tile.blight !== void 0) result.blight = float32(tile.blight, cells, `${label} tile blight`);
  return Object.freeze(result);
}
function assertDerivedTerrainTilePlacement(tile, chunk, grid) {
  if (chunk.lod !== 0) throw new Error(`derived terrain index supports only LOD0, received '${chunk.chunkId}'`);
  const expectedX = grid.origin[0] + (chunk.tx + 0.5) * grid.chunkSizeM;
  const expectedZ = grid.origin[1] + (chunk.tz + 0.5) * grid.chunkSizeM;
  if (tile.origin[0] !== expectedX || tile.origin[2] !== expectedZ || tile.scale[0] !== grid.chunkSizeM || tile.scale[2] !== grid.chunkSizeM) {
    throw new Error(`derived terrain chunk '${chunk.chunkId}' tile placement does not match the manifest grid`);
  }
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
          const descriptor3 = Object.getOwnPropertyDescriptor(input, String(index));
          if (descriptor3?.get !== void 0 || descriptor3?.set !== void 0 || descriptor3?.enumerable !== true) {
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
        const descriptor3 = Object.getOwnPropertyDescriptor(input, name);
        if (descriptor3?.get !== void 0 || descriptor3?.set !== void 0 || descriptor3?.enumerable !== true) {
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
    const descriptor3 = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor3?.get !== void 0 || descriptor3?.set !== void 0 || descriptor3?.enumerable !== true) {
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

// src/world/compiler/terrain-artifact.mjs
var TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.terrain-chunk-v1";
var MAX_TERRAIN_ARTIFACT_ROWS = 257;
var MAX_TERRAIN_ARTIFACT_COLS = 257;
var MAX_TERRAIN_ARTIFACT_CELLS = MAX_TERRAIN_ARTIFACT_ROWS * MAX_TERRAIN_ARTIFACT_COLS;
var MAX_TERRAIN_CHUNK_ARTIFACT_BYTES = 2 * 1024 * 1024;
var TERRAIN_ARTIFACT_FLAG_PAINT_MAT = 1 << 0;
var TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT = 1 << 1;
var TERRAIN_ARTIFACT_FLAG_CLIMATE = 1 << 2;
var TERRAIN_ARTIFACT_FLAG_BLIGHT = 1 << 3;
var KNOWN_FLAGS = TERRAIN_ARTIFACT_FLAG_PAINT_MAT | TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT | TERRAIN_ARTIFACT_FLAG_CLIMATE | TERRAIN_ARTIFACT_FLAG_BLIGHT;
var MAGIC = Object.freeze([76, 77, 84, 69, 82, 82, 78, 0]);
var REQUIRED_FIELDS = Object.freeze(["nrows", "ncols", "origin", "scale", "heights"]);
var ALLOWED_FIELDS = /* @__PURE__ */ new Set([...REQUIRED_FIELDS, "paintMat", "paintW", "climate", "climateChannels", "blight"]);

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
var ROOT_KEYS = /* @__PURE__ */ new Set([
  "schema",
  "version",
  "rows",
  "cols",
  "cellCount",
  "cellSizeM",
  "cellAreaM2",
  "seaLevelM",
  "precipitationMmPerYear",
  "precipitationMPerYear",
  "receiver",
  "drainageRank",
  "filledHeightM",
  "catchmentAreaM2",
  "dischargeM3PerYear",
  "streamOrder",
  "oceanMask",
  "diagnostics"
]);
var PLACEMENT_KEYS = /* @__PURE__ */ new Set(["originX", "originZ"]);
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
  for (const [key, descriptor3] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor3) || descriptor3.enumerable !== true) fail(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!optional.has(key) && !Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
  return descriptors;
}
function canonicalNumber(value, label, minimum, maximum, positive = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || (positive ? value <= minimum : value < minimum) || value > maximum) {
    fail(`${label} must be a finite canonical number in ${positive ? "(" : "["}${minimum}, ${maximum}]`);
  }
  return value;
}
function dimension(value, label) {
  if (!Number.isSafeInteger(value) || value < 2 || value > MAX_HYDROLOGY_DIMENSION) {
    fail(`${label} must be an integer in [2, ${MAX_HYDROLOGY_DIMENSION}]`);
  }
  return value;
}
function ownedArray(value, prototype, cells, label) {
  if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== prototype) fail(`${label} has the wrong typed-array representation`);
  if (!(value.buffer instanceof ArrayBuffer) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    fail(`${label} must own its complete non-shared ArrayBuffer`);
  }
  if (value.length !== cells) fail(`${label} length ${value.length} does not match ${cells} cells`);
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
function parseTopology(topology) {
  const descriptors = exactRecord(topology, ROOT_KEYS, "hydrology topology");
  if (descriptors.schema.value !== HYDROLOGY_TOPOLOGY_SCHEMA || descriptors.version.value !== HYDROLOGY_TOPOLOGY_VERSION) {
    fail("hydrology topology schema/version is unsupported");
  }
  const rows = dimension(descriptors.rows.value, "hydrology topology rows");
  const cols = dimension(descriptors.cols.value, "hydrology topology cols");
  const cells = rows * cols;
  if (cells > MAX_HYDROLOGY_CELLS || descriptors.cellCount.value !== cells) fail("hydrology topology cellCount does not match dimensions");
  const cellSizeM = canonicalNumber(descriptors.cellSizeM.value, "hydrology topology cellSizeM", 0, MAX_HYDROLOGY_CELL_SIZE_M, true);
  const cellAreaM2 = cellSizeM * cellSizeM;
  if (descriptors.cellAreaM2.value !== cellAreaM2) fail("hydrology topology cellAreaM2 is inconsistent with cellSizeM");
  const seaLevelM = canonicalNumber(descriptors.seaLevelM.value, "hydrology topology seaLevelM", -MAX_HYDROLOGY_ABS_HEIGHT_M, MAX_HYDROLOGY_ABS_HEIGHT_M);
  const precipitationMmPerYear = canonicalNumber(
    descriptors.precipitationMmPerYear.value,
    "hydrology topology precipitationMmPerYear",
    0,
    MAX_HYDROLOGY_PRECIPITATION_MM_PER_YEAR
  );
  const precipitationMPerYear = precipitationMmPerYear / 1e3;
  if (descriptors.precipitationMPerYear.value !== precipitationMPerYear) fail("hydrology topology precipitationMPerYear is inconsistent");
  const source = {
    rows,
    cols,
    cellCount: cells,
    cellSizeM,
    cellAreaM2,
    seaLevelM,
    precipitationMmPerYear,
    precipitationMPerYear,
    receiver: ownedArray(descriptors.receiver.value, Int32Array.prototype, cells, "hydrology topology receiver"),
    drainageRank: ownedArray(descriptors.drainageRank.value, Uint32Array.prototype, cells, "hydrology topology drainageRank"),
    filledHeightM: ownedArray(descriptors.filledHeightM.value, Float64Array.prototype, cells, "hydrology topology filledHeightM"),
    catchmentAreaM2: ownedArray(descriptors.catchmentAreaM2.value, Float64Array.prototype, cells, "hydrology topology catchmentAreaM2"),
    dischargeM3PerYear: ownedArray(descriptors.dischargeM3PerYear.value, Float64Array.prototype, cells, "hydrology topology dischargeM3PerYear"),
    streamOrder: ownedArray(descriptors.streamOrder.value, Uint8Array.prototype, cells, "hydrology topology streamOrder"),
    oceanMask: ownedArray(descriptors.oceanMask.value, Uint8Array.prototype, cells, "hydrology topology oceanMask")
  };
  const diagnostics = descriptors.diagnostics.value;
  if (diagnostics === null || typeof diagnostics !== "object" || Array.isArray(diagnostics) || Object.getPrototypeOf(diagnostics) !== Object.prototype || Object.getOwnPropertySymbols(diagnostics).length !== 0) {
    fail("hydrology topology diagnostics must be an object");
  }
  for (const descriptor3 of Object.values(Object.getOwnPropertyDescriptors(diagnostics))) {
    if (!("value" in descriptor3) || descriptor3.enumerable !== true) fail("hydrology topology diagnostics must contain only enumerable data fields");
  }
  return {
    ...source,
    receiver: source.receiver.slice(),
    drainageRank: source.drainageRank.slice(),
    filledHeightM: source.filledHeightM.slice(),
    catchmentAreaM2: source.catchmentAreaM2.slice(),
    dischargeM3PerYear: source.dischargeM3PerYear.slice(),
    streamOrder: source.streamOrder.slice(),
    oceanMask: source.oceanMask.slice()
  };
}
function parsePlacement(placement) {
  const descriptors = exactRecord(placement, PLACEMENT_KEYS, "hydrology artifact placement");
  return Object.freeze({
    originX: canonicalNumber(descriptors.originX.value, "hydrology artifact originX", -MAX_ORIGIN_M, MAX_ORIGIN_M),
    originZ: canonicalNumber(descriptors.originZ.value, "hydrology artifact originZ", -MAX_ORIGIN_M, MAX_ORIGIN_M)
  });
}
function writeHeader(view, field, placement, layout2) {
  for (let index = 0; index < MAGIC2.length; index++) view.setUint8(index, MAGIC2[index]);
  view.setUint16(8, HYDROLOGY_FIELD_ARTIFACT_VERSION, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, field.rows, true);
  view.setUint32(20, field.cols, true);
  view.setUint32(24, field.cellCount, true);
  view.setUint32(28, layout2.byteLength, true);
  view.setFloat64(32, placement.originX, true);
  view.setFloat64(40, placement.originZ, true);
  view.setFloat64(48, field.cellSizeM, true);
  view.setFloat64(56, field.seaLevelM, true);
  view.setFloat64(64, field.precipitationMmPerYear, true);
  view.setUint32(72, layout2.receiver, true);
  view.setUint32(76, layout2.drainageRank, true);
  view.setUint32(80, layout2.filledHeightM, true);
  view.setUint32(84, layout2.catchmentAreaM2, true);
  view.setUint32(88, layout2.streamOrder, true);
  view.setUint32(92, layout2.oceanMask, true);
}
function encodeHydrologyFieldArtifact(topology, placementInput, controlInput = void 0) {
  const shouldCancel = parseControl(controlInput, "hydrology artifact encode control");
  const placement = parsePlacement(placementInput);
  const field = parseTopology(topology);
  const meter = createMeter(shouldCancel, MAX_HYDROLOGY_CELLS * 48 + 4096);
  meter.check();
  validateChannels(field, meter, true);
  const layout2 = layoutForCells(field.cellCount);
  if (layout2.byteLength > MAX_HYDROLOGY_FIELD_ARTIFACT_BYTES) fail("hydrology artifact exceeds maximum bytes");
  const bytes = new Uint8Array(layout2.byteLength);
  const view = new DataView(bytes.buffer);
  writeHeader(view, field, placement, layout2);
  for (let index = 0; index < field.cellCount; index++) {
    meter.work();
    view.setInt32(layout2.receiver + index * 4, field.receiver[index], true);
    view.setUint32(layout2.drainageRank + index * 4, field.drainageRank[index], true);
    view.setFloat64(layout2.filledHeightM + index * 8, field.filledHeightM[index], true);
    view.setFloat64(layout2.catchmentAreaM2 + index * 8, field.catchmentAreaM2[index], true);
    view.setUint8(layout2.streamOrder + index, field.streamOrder[index]);
    view.setUint8(layout2.oceanMask + index, field.oceanMask[index]);
  }
  meter.check();
  return bytes;
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
  const rows = dimension(view.getUint32(16, true), "hydrology artifact rows");
  const cols = dimension(view.getUint32(20, true), "hydrology artifact cols");
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

// src/world/hydrology-water-topology.mjs
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
var BINDING_KEYS = Object.freeze(["hydrologyFieldContentHash", "recipeHash", "erosionStageKey", "compilerGraphHash"]);
var BINDING_KEY_SET = new Set(BINDING_KEYS);
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
function fail2(message) {
  throw new HydrologyWaterArtifactValidationError(message);
}
function canonicalNumber2(value, label, minimum, maximum, positive = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || (positive ? value <= minimum : value < minimum) || value > maximum) {
    fail2(`${label} must be a finite canonical number in ${positive ? "(" : "["}${minimum}, ${maximum}]`);
  }
  return value;
}
function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail2(`${label} must be an integer in [${minimum}, ${maximum}]`);
  return value;
}
function bytesToHex(bytes, offset) {
  let hex = "";
  for (let index = 0; index < 32; index++) hex += bytes[offset + index].toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}
function ownedByteView(value) {
  if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype) fail2("hydrology water artifact bytes must be a Uint8Array");
  if (!(value.buffer instanceof ArrayBuffer) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    fail2("hydrology water artifact bytes must own its complete non-shared ArrayBuffer");
  }
  if (value.byteLength < HYDROLOGY_WATER_ARTIFACT_HEADER_BYTES || value.byteLength > MAX_HYDROLOGY_WATER_ARTIFACT_BYTES) {
    fail2("hydrology water artifact byte length is outside supported bounds");
  }
  return value;
}
function verifyZero(bytes, start, end, label) {
  for (let index = start; index < end; index++) if (bytes[index] !== 0) fail2(`${label} must be zero`);
}
function inspectHeader(bytes) {
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC3.length; index++) if (view.getUint8(index) !== MAGIC3[index]) fail2("hydrology water artifact magic mismatch");
  if (view.getUint16(8, true) !== HYDROLOGY_WATER_ARTIFACT_VERSION) fail2("hydrology water artifact version is unsupported");
  if (view.getUint16(10, true) !== 0) fail2("hydrology water artifact flags must be zero");
  if (view.getUint16(12, true) !== HYDROLOGY_WATER_ARTIFACT_HEADER_BYTES) fail2("hydrology water artifact header length mismatch");
  if (view.getUint16(14, true) !== 0 || view.getUint32(52, true) !== 0 || view.getUint32(108, true) !== 0) fail2("hydrology water artifact reserved header fields must be zero");
  verifyZero(bytes, 240, 256, "hydrology water artifact reserved header bytes");
  const rows = integer(view.getUint32(20, true), 2, MAX_HYDROLOGY_DIMENSION, "hydrology water artifact rows");
  const cols = integer(view.getUint32(24, true), 2, MAX_HYDROLOGY_DIMENSION, "hydrology water artifact cols");
  const cells = rows * cols;
  if (cells > MAX_HYDROLOGY_CELLS) fail2("hydrology water artifact grid exceeds supported cells");
  const counts = Object.freeze({
    basins: integer(view.getUint32(28, true), 0, WATER_LIMITS.bodies, "hydrology water artifact basin count"),
    rings: integer(view.getUint32(32, true), 0, MAX_RING_COUNT, "hydrology water artifact ring count"),
    basinPoints: integer(view.getUint32(36, true), 0, WATER_LIMITS.totalBodyPoints, "hydrology water artifact basin point count"),
    reaches: integer(view.getUint32(40, true), 0, WATER_LIMITS.waterways, "hydrology water artifact reach count"),
    reachPoints: integer(view.getUint32(44, true), 0, WATER_LIMITS.totalWaterwayPoints, "hydrology water artifact reach point count"),
    waterfalls: integer(view.getUint32(48, true), 0, WATER_LIMITS.totalWaterwayPoints, "hydrology water artifact waterfall count")
  });
  if (counts.basins === 0 !== (counts.rings === 0 && counts.basinPoints === 0)) fail2("hydrology water artifact basin section counts are inconsistent");
  if (counts.reaches === 0 !== (counts.reachPoints === 0 && counts.waterfalls === 0)) fail2("hydrology water artifact reach section counts are inconsistent");
  if (counts.rings < counts.basins || counts.basinPoints < counts.rings * 3 || counts.reachPoints < counts.reaches * 2) fail2("hydrology water artifact section counts are structurally impossible");
  const layout2 = layoutForCounts(counts.basins, counts.rings, counts.basinPoints, counts.reaches, counts.reachPoints, counts.waterfalls);
  if (view.getUint32(16, true) !== bytes.byteLength || bytes.byteLength !== layout2.byteLength) fail2("hydrology water artifact byte length is non-canonical");
  for (const [offset, expected, label] of [
    [80, layout2.basinRecords, "basin"],
    [84, layout2.ringRecords, "ring"],
    [88, layout2.basinPointRecords, "basin point"],
    [92, layout2.reachRecords, "reach"],
    [96, layout2.reachPointRecords, "reach point"],
    [100, layout2.waterfallRecords, "waterfall"],
    [104, layout2.dataEnd, "data end"]
  ]) {
    if (view.getUint32(offset, true) !== expected) fail2(`hydrology water artifact ${label} offset is non-canonical`);
  }
  verifyZero(bytes, layout2.dataEnd, layout2.byteLength, "hydrology water artifact trailing padding");
  const bindings2 = {};
  for (let binding = 0; binding < BINDING_KEYS.length; binding++) bindings2[BINDING_KEYS[binding]] = bytesToHex(bytes, 112 + binding * 32);
  return Object.freeze({
    view,
    rows,
    cols,
    counts,
    layout: layout2,
    bindings: Object.freeze(bindings2),
    placement: Object.freeze({
      originX: canonicalNumber2(view.getFloat64(56, true), "hydrology water artifact originX", -MAX_ORIGIN_M2, MAX_ORIGIN_M2),
      originZ: canonicalNumber2(view.getFloat64(64, true), "hydrology water artifact originZ", -MAX_ORIGIN_M2, MAX_ORIGIN_M2)
    }),
    cellSizeM: canonicalNumber2(view.getFloat64(72, true), "hydrology water artifact cellSizeM", 0, 1e6, true)
  });
}
function inspectHydrologyWaterArtifactBindings(bytesInput) {
  return inspectHeader(ownedByteView(bytesInput)).bindings;
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
var MAGIC4 = Object.freeze([76, 77, 87, 79, 86, 82, 49, 0]);
var GRID_KEYS = /* @__PURE__ */ new Set(["rows", "cols", "origin", "stepM", "heights", "paintMaterial", "paintWeight"]);
var CONTROL_KEYS2 = /* @__PURE__ */ new Set(["shouldCancel"]);
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
function fail3(message) {
  throw new WorldOverviewArtifactValidationError(message);
}
function exactRecord2(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail3(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) fail3(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor3] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail3(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor3) || descriptor3.enumerable !== true) fail3(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail3(`${label} is missing '${key}'`);
  return descriptors;
}
function parseControl2(value) {
  if (value === void 0) return void 0;
  const descriptors = exactRecord2(value, CONTROL_KEYS2, "world overview artifact control");
  if (typeof descriptors.shouldCancel.value !== "function") fail3("world overview artifact control.shouldCancel must be a function");
  return descriptors.shouldCancel.value;
}
function createMeter2(shouldCancel, limit) {
  let work = 0;
  const check = () => {
    if (shouldCancel?.()) throw new WorldOverviewArtifactCancelledError();
  };
  return Object.freeze({
    start: check,
    work() {
      if (++work > limit) fail3(`world overview artifact exceeded bounded validation work ${limit}`);
      if ((work & 1023) === 0) check();
    },
    finish: check
  });
}
function dimension2(value, label) {
  if (!Number.isSafeInteger(value) || value < WORLD_OVERVIEW_MIN_DIMENSION || value > WORLD_OVERVIEW_MAX_DIMENSION) {
    fail3(`${label} must be an integer in [${WORLD_OVERVIEW_MIN_DIMENSION}, ${WORLD_OVERVIEW_MAX_DIMENSION}]`);
  }
  return value;
}
function canonicalFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) fail3(`${label} must be a finite canonical number`);
  return value;
}
function originTuple(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2 || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== 3) {
    fail3("world overview origin must be a dense two-number tuple");
  }
  const result = new Array(2);
  for (let index = 0; index < 2; index++) {
    const descriptor3 = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor3 || !("value" in descriptor3) || descriptor3.enumerable !== true) fail3(`world overview origin[${index}] must be an enumerable data field`);
    const coordinate = canonicalFinite(descriptor3.value, `world overview origin[${index}]`);
    if (Math.abs(coordinate) > WORLD_OVERVIEW_MAX_ORIGIN_ABS_M) fail3(`world overview origin[${index}] exceeds the supported world range`);
    result[index] = coordinate;
  }
  return Object.freeze(result);
}
function isShared(buffer) {
  return Object.prototype.toString.call(buffer) === "[object SharedArrayBuffer]";
}
function ownedTypedArray(value, prototype, cells, label) {
  if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== prototype) fail3(`${label} has the wrong typed-array representation`);
  if (!(value.buffer instanceof ArrayBuffer) || isShared(value.buffer) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    fail3(`${label} must own its complete non-shared ArrayBuffer`);
  }
  if (value.length !== cells) fail3(`${label} length ${value.length} does not match ${cells} cells`);
  return value;
}
function layout(cells) {
  const heights = WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES;
  const paintMaterial = heights + cells * 4;
  const paintWeight = paintMaterial + cells;
  return Object.freeze({ heights, paintMaterial, paintWeight, byteLength: paintWeight + cells });
}
function parseGrid2(input, meter) {
  const descriptors = exactRecord2(input, GRID_KEYS, "world overview grid");
  const rows = dimension2(descriptors.rows.value, "world overview rows");
  const cols = dimension2(descriptors.cols.value, "world overview cols");
  const cells = rows * cols;
  const origin = originTuple(descriptors.origin.value);
  const stepM = canonicalFinite(descriptors.stepM.value, "world overview stepM");
  if (!(stepM > 0) || stepM > WORLD_OVERVIEW_MAX_STEP_M) fail3(`world overview stepM must be in (0, ${WORLD_OVERVIEW_MAX_STEP_M}]`);
  const maxX = canonicalFinite(origin[0] + (cols - 1) * stepM, "world overview maximum x");
  const maxZ = canonicalFinite(origin[1] + (rows - 1) * stepM, "world overview maximum z");
  if (Math.abs(maxX) > WORLD_OVERVIEW_MAX_ORIGIN_ABS_M || Math.abs(maxZ) > WORLD_OVERVIEW_MAX_ORIGIN_ABS_M) {
    fail3("world overview grid extent exceeds the supported world range");
  }
  const heights = ownedTypedArray(descriptors.heights.value, Float32Array.prototype, cells, "world overview heights");
  const paintMaterial = ownedTypedArray(descriptors.paintMaterial.value, Uint8Array.prototype, cells, "world overview paintMaterial");
  const paintWeight = ownedTypedArray(descriptors.paintWeight.value, Uint8Array.prototype, cells, "world overview paintWeight");
  for (let index = 0; index < cells; index++) {
    meter.work();
    const height = heights[index];
    if (!Number.isFinite(height) || Object.is(height, -0) || Math.abs(height) > WORLD_OVERVIEW_MAX_HEIGHT_ABS_M) {
      fail3(`world overview heights[${index}] must be finite canonical metres within the supported range`);
    }
    if (paintMaterial[index] > WORLD_OVERVIEW_MAX_PAINT_MATERIAL) {
      fail3(`world overview paintMaterial[${index}] exceeds ${WORLD_OVERVIEW_MAX_PAINT_MATERIAL}`);
    }
  }
  return Object.freeze({ rows, cols, cells, origin, stepM, heights, paintMaterial, paintWeight });
}
function writeHeader2(view, grid, offsets) {
  for (let index = 0; index < MAGIC4.length; index++) view.setUint8(index, MAGIC4[index]);
  view.setUint16(8, WORLD_OVERVIEW_ARTIFACT_VERSION, true);
  view.setUint16(10, WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES, true);
  view.setUint32(12, offsets.byteLength, true);
  view.setUint16(16, grid.rows, true);
  view.setUint16(18, grid.cols, true);
  view.setUint32(20, grid.cells, true);
  view.setFloat64(24, grid.origin[0], true);
  view.setFloat64(32, grid.origin[1], true);
  view.setFloat64(40, grid.stepM, true);
  view.setUint32(48, offsets.heights, true);
  view.setUint32(52, offsets.paintMaterial, true);
  view.setUint32(56, offsets.paintWeight, true);
  view.setUint32(60, 0, true);
}
function encodeWorldOverviewArtifact(input, controlInput) {
  const meter = createMeter2(parseControl2(controlInput), WORLD_OVERVIEW_MAX_CELLS * 2 + 4096);
  meter.start();
  const grid = parseGrid2(input, meter);
  const offsets = layout(grid.cells);
  const bytes = new Uint8Array(offsets.byteLength);
  const view = new DataView(bytes.buffer);
  writeHeader2(view, grid, offsets);
  for (let index = 0; index < grid.cells; index++) {
    meter.work();
    view.setFloat32(offsets.heights + index * 4, grid.heights[index], true);
  }
  bytes.set(grid.paintMaterial, offsets.paintMaterial);
  bytes.set(grid.paintWeight, offsets.paintWeight);
  meter.finish();
  return bytes;
}
function artifactBytes(input) {
  if (!ArrayBuffer.isView(input) || Object.getPrototypeOf(input) !== Uint8Array.prototype || !(input.buffer instanceof ArrayBuffer) || isShared(input.buffer) || input.byteOffset !== 0 || input.byteLength !== input.buffer.byteLength) {
    fail3("world overview artifact bytes must be an owned Uint8Array over a non-shared ArrayBuffer");
  }
  if (input.byteLength < WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES || input.byteLength > WORLD_OVERVIEW_MAX_ARTIFACT_BYTES) {
    fail3("world overview artifact byte length is outside the supported range");
  }
  return input;
}
function decodeWorldOverviewArtifact(input, controlInput) {
  const bytes = artifactBytes(input);
  const meter = createMeter2(parseControl2(controlInput), WORLD_OVERVIEW_MAX_CELLS * 2 + 4096);
  meter.start();
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC4.length; index++) if (view.getUint8(index) !== MAGIC4[index]) fail3("world overview artifact magic mismatch");
  if (view.getUint16(8, true) !== WORLD_OVERVIEW_ARTIFACT_VERSION) fail3("world overview artifact version is unsupported");
  if (view.getUint16(10, true) !== WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES) fail3("world overview artifact header length mismatch");
  const rows = dimension2(view.getUint16(16, true), "world overview rows");
  const cols = dimension2(view.getUint16(18, true), "world overview cols");
  const cells = rows * cols;
  if (view.getUint32(20, true) !== cells) fail3("world overview artifact cell count mismatch");
  const offsets = layout(cells);
  if (view.getUint32(12, true) !== bytes.byteLength || bytes.byteLength !== offsets.byteLength) fail3("world overview artifact byte length is non-canonical");
  if (view.getUint32(48, true) !== offsets.heights || view.getUint32(52, true) !== offsets.paintMaterial || view.getUint32(56, true) !== offsets.paintWeight) fail3("world overview artifact channel offsets are non-canonical");
  if (view.getUint32(60, true) !== 0) fail3("world overview artifact reserved header bytes must be zero");
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
var MAGIC5 = Uint8Array.of(76, 78, 65, 86, 73, 68, 88, 49);
var HEADER_BYTES = 96;
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
function fail4(message) {
  throw new NavigationIndexArtifactValidationError(message);
}
function cancelled() {
  throw new NavigationIndexArtifactValidationError(
    "navigation index operation was cancelled",
    "navigation_index_artifact_cancelled"
  );
}
function exactRecord3(value, required, optional, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) fail4(`${label} must be a plain object`);
  const names = Object.getOwnPropertyNames(value);
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.some((name) => !allowed.has(name)) || required.some((name) => !names.includes(name))) fail4(`${label} fields are invalid`);
  const fields = /* @__PURE__ */ Object.create(null);
  for (const name of names) {
    const descriptor3 = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor3?.enumerable !== true || !Object.hasOwn(descriptor3, "value")) {
      fail4(`${label}.${name} must be an enumerable data field`);
    }
    fields[name] = descriptor3.value;
  }
  return fields;
}
function parseCancellationOptions(options) {
  const fields = exactRecord3(options, [], ["cancellationFlag", "shouldCancel"], "navigation index options");
  const hasFlag = Object.hasOwn(fields, "cancellationFlag");
  const hasCallback = Object.hasOwn(fields, "shouldCancel");
  if (hasFlag && hasCallback) fail4("navigation index options must choose one cancellation mechanism");
  if (hasCallback) {
    if (typeof fields.shouldCancel !== "function") fail4("navigation index shouldCancel must be a function");
    return fields.shouldCancel;
  }
  if (!hasFlag) return null;
  const flag = fields.cancellationFlag;
  if (!(flag instanceof Int32Array) || flag.length !== 1 || typeof SharedArrayBuffer !== "function" || !(flag.buffer instanceof SharedArrayBuffer)) {
    fail4("navigation index cancellationFlag must be a one-element shared Int32Array");
  }
  return () => Atomics.load(flag, 0) !== 0;
}
function checkCancellation(shouldCancel, index = 0) {
  if (shouldCancel !== null && (index & 4095) === 0 && shouldCancel()) cancelled();
}
function finiteCoordinate(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE_M) {
    fail4(`${label} must be a finite coordinate within ${MAX_COORDINATE_M} meters`);
  }
  return Object.is(value, -0) ? 0 : value;
}
function printable(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim().length < 1 || CONTROL.test(value)) {
    fail4(`${label} must contain 1-${maximum} printable characters`);
  }
  return value;
}
function canonicalSearchKey(value, label) {
  const input = printable(value, MAX_NAVIGATION_INDEX_STRING_CHARS, label);
  const key = input.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
  if (key.length < 1 || key.length > MAX_SEARCH_KEY_CHARS || CONTROL.test(key)) {
    fail4(`${label} exceeds the canonical search-key limit`);
  }
  return key;
}
function parseBounds(input) {
  const fields = exactRecord3(input, ["minX", "minZ", "maxX", "maxZ"], [], "navigation world bounds");
  const bounds = {
    minX: finiteCoordinate(fields.minX, "navigation world bounds.minX"),
    minZ: finiteCoordinate(fields.minZ, "navigation world bounds.minZ"),
    maxX: finiteCoordinate(fields.maxX, "navigation world bounds.maxX"),
    maxZ: finiteCoordinate(fields.maxZ, "navigation world bounds.maxZ")
  };
  if (!(bounds.maxX > bounds.minX) || !(bounds.maxZ > bounds.minZ)) {
    fail4("navigation world bounds must have positive width and depth");
  }
  return Object.freeze(bounds);
}
function checkedSectionEnd(offset, count, stride, label) {
  const end = offset + count * stride;
  if (!Number.isSafeInteger(end) || end > MAX_NAVIGATION_INDEX_ARTIFACT_BYTES) {
    fail4(`${label} exceeds the navigation artifact size budget`);
  }
  return end;
}
function hasMagic(bytes) {
  for (let index = 0; index < MAGIC5.length; index++) if (bytes[index] !== MAGIC5[index]) return false;
  return true;
}
function readHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_BYTES || bytes.byteLength > MAX_NAVIGATION_INDEX_ARTIFACT_BYTES) {
    fail4(`navigation index artifact must contain ${HEADER_BYTES}-${MAX_NAVIGATION_INDEX_ARTIFACT_BYTES} bytes`);
  }
  const ownedBytes3 = Uint8Array.from(bytes);
  if (!hasMagic(ownedBytes3)) fail4("navigation index artifact magic is invalid");
  const view = new DataView(ownedBytes3.buffer);
  if (view.getUint16(8, true) !== NAVIGATION_INDEX_ARTIFACT_VERSION || view.getUint16(10, true) !== HEADER_BYTES) fail4("navigation index artifact version is unsupported");
  if (view.getUint32(12, true) !== 0 || view.getUint32(28, true) !== 0 || view.getUint32(88, true) !== 0 || view.getUint32(92, true) !== 0) {
    fail4("navigation index artifact reserved header fields must be zero");
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
    fail4("navigation index artifact counts exceed their production budgets");
  }
  const expectedKeyOffset = checkedSectionEnd(HEADER_BYTES, header.entryCount, ENTRY_BYTES, "navigation entry table");
  const expectedOrderOffset = checkedSectionEnd(expectedKeyOffset, header.keyCount, KEY_BYTES, "navigation key table");
  const expectedDescriptorOffset = checkedSectionEnd(expectedOrderOffset, header.keyCount, 4, "navigation key order");
  const expectedBlobOffset = checkedSectionEnd(expectedDescriptorOffset, header.stringCount, STRING_DESCRIPTOR_BYTES, "navigation string table");
  if (header.entryOffset !== HEADER_BYTES || header.keyOffset !== expectedKeyOffset || header.orderOffset !== expectedOrderOffset || header.descriptorOffset !== expectedDescriptorOffset || header.blobOffset !== expectedBlobOffset || header.totalBytes !== ownedBytes3.byteLength) {
    fail4("navigation index artifact section layout is invalid");
  }
  return header;
}
function descriptor(state, stringId) {
  if (stringId >= state.stringCount) fail4("navigation index string reference is out of bounds");
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
    fail4("navigation index string is not valid UTF-8");
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
    if (byte < 32 || byte === 127) fail4(`${label} contains control characters`);
    if (byte !== 32) onlySpaces = false;
  }
  if (ascii) {
    if (length < 1 || length > maximum || onlySpaces) fail4(`${label} is not a bounded printable string`);
    return;
  }
  const value = decodeString(state, stringId);
  printable(value, maximum, label);
}
function validateUsedString(state, stringId, use) {
  if (stringId >= state.stringCount) fail4("navigation index string reference is out of bounds");
  if ((state.stringUses[stringId] & use) !== 0) return;
  if (state.stringUses[stringId] === 0) {
    if (stringId !== state.nextStringId) fail4("navigation index string table is not in canonical first-use order");
    state.nextStringId++;
  }
  state.stringUses[stringId] |= use;
  if (use === STRING_USE.IDENTIFIER) validatePrintableString(state, stringId, 128, "navigation design identifier");
  else if (use === STRING_USE.LABEL) validatePrintableString(state, stringId, MAX_NAVIGATION_INDEX_STRING_CHARS, "navigation label");
  else if (use === STRING_USE.REF_KIND) {
    const value = decodeString(state, stringId);
    if (value !== "feature" && value !== "marker" && value !== "place" && value !== "stamp") {
      fail4("navigation designRef kind is invalid");
    }
  } else if (use === STRING_USE.KIND) {
    const value = decodeString(state, stringId);
    if (!KIND.test(value)) fail4("navigation entry kind is invalid");
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
        fail4("navigation search key is not canonical");
      }
    }
    if (ascii) {
      if (length < 1 || length > MAX_SEARCH_KEY_CHARS) fail4("navigation search key is not canonical");
    } else {
      const value = decodeString(state, stringId);
      if (canonicalSearchKey(value, "navigation search key") !== value) fail4("navigation search key is not canonical");
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
      fail4("navigation index string descriptor is invalid");
    }
    const startByte = state.ownedBytes[state.blobOffset + offset];
    const after = state.blobOffset + offset + length;
    if ((startByte & 192) === 128 || after < state.ownedBytes.length && (state.ownedBytes[after] & 192) === 128) {
      fail4("navigation index string descriptor splits a UTF-8 sequence");
    }
    expectedOffset += length;
  }
  if (expectedOffset !== state.ownedBytes.length - state.blobOffset) {
    fail4("navigation index string blob contains unreferenced bytes");
  }
  try {
    decoder.decode(state.ownedBytes.subarray(state.blobOffset));
  } catch {
    fail4("navigation index string blob is not valid UTF-8");
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
      if (order >= 0) fail4(order === 0 ? "navigation entries contain duplicate designRef" : "navigation entries are not canonical");
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
    if (firstKey !== expectedFirstKey || keyCount < 1 || keyCount > MAX_NAVIGATION_INDEX_SEARCH_KEYS_PER_ENTRY || firstKey + keyCount > state.keyCount) fail4("navigation entry key range is invalid");
    if (flags !== 0 && flags !== 1 || reserved !== 0 || !Number.isFinite(x) || !Number.isFinite(z) || x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ || (flags === 0 ? radius !== 0 : !Number.isFinite(radius) || radius <= 0 || radius > MAX_COORDINATE_M)) {
      fail4("navigation entry numeric record is invalid");
    }
    expectedFirstKey += keyCount;
  }
  if (expectedFirstKey !== state.keyCount) fail4("navigation key table is incomplete");
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
    if (entryIndex !== expectedEntry) fail4("navigation key entry reference is not canonical");
    validateUsedString(state, stringId, STRING_USE.SEARCH_KEY);
    if (previousStringId !== null && compareStringIds(state, previousStringId, stringId) >= 0) {
      fail4("navigation entry search keys are not strictly sorted");
    }
    previousStringId = stringId;
  }
  if (state.nextStringId !== state.stringCount) fail4("navigation string table contains unused records");
  const seen = new Uint8Array(state.keyCount);
  let previousKey = null;
  let previousEntry = -1;
  for (let index = 0; index < state.keyCount; index++) {
    checkCancellation(cancellationCheck, index);
    const keyIndex = state.view.getUint32(state.orderOffset + index * 4, true);
    if (keyIndex >= state.keyCount || seen[keyIndex] !== 0) fail4("navigation sorted-key table is not a permutation");
    seen[keyIndex] = 1;
    const keyOffset = state.keyOffset + keyIndex * KEY_BYTES;
    const stringId = state.view.getUint32(keyOffset, true);
    const entryIndex = state.view.getUint32(keyOffset + 4, true);
    if (previousKey !== null) {
      const order = compareStringIds(state, previousKey, stringId);
      if (order > 0 || order === 0 && entryIndex <= previousEntry) {
        fail4("navigation sorted-key table is not canonical");
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
var HASH = /^sha256:[0-9a-f]{64}$/;
var BiomeIrValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "BiomeIrValidationError";
  }
};
function fail5(message) {
  throw new BiomeIrValidationError(message);
}
function record(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail5(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail5(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail5(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor3] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail5(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor3) || descriptor3.enumerable !== true) fail5(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail5(`${label} is missing '${key}'`);
  return descriptors;
}
function dense(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    fail5(`${label} must be a standard array with at most ${maximum} entries`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail5(`${label} must be dense and field-free`);
  }
  return value;
}
function string(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail5(`${label} is invalid`);
  return value;
}
function text(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) fail5(`${label} is invalid`);
  return value;
}
function number(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum) fail5(`${label} must be a canonical number in [${minimum}, ${maximum}]`);
  return value;
}
function integer2(value, minimum, maximum, label) {
  const parsed = number(value, minimum, maximum, label);
  if (!Number.isSafeInteger(parsed)) fail5(`${label} must be an integer`);
  return parsed;
}
function sortedUniqueStrings(value, maximum, label) {
  const source = dense(value, maximum, label);
  const result = source.map((entry, index) => string(entry, REF, BIOME_LIMITS.refChars, `${label}[${index}]`));
  for (let index = 1; index < result.length; index++) if (result[index - 1] >= result[index]) fail5(`${label} must be strictly sorted and unique`);
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
  if (max < min) fail5(`${label}.max must be at least min`);
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
  if (d.schema.value !== BIOME_DEF_SCHEMA) fail5(`${label}.schema must be '${BIOME_DEF_SCHEMA}'`);
  const id = string(d.id.value, ID, BIOME_LIMITS.idChars, `${label}.id`);
  const version = string(d.version.value, SEMVER, 64, `${label}.version`);
  const taxonomyInput = record(d.taxonomy.value, /* @__PURE__ */ new Set(["category", "tags"]), `${label}.taxonomy`);
  if (!BIOME_CATEGORIES.includes(taxonomyInput.category.value)) fail5(`${label}.taxonomy.category is unsupported`);
  const tags = sortedUniqueStrings(taxonomyInput.tags.value, BIOME_LIMITS.tags, `${label}.taxonomy.tags`);
  const climateInput = record(d.climate.value, /* @__PURE__ */ new Set(["temperatureC", "moisture01"]), `${label}.climate`);
  const climate = Object.freeze({
    temperatureC: band(climateInput.temperatureC.value, -100, 100, `${label}.climate.temperatureC`),
    moisture01: band(climateInput.moisture01.value, 0, 1, `${label}.climate.moisture01`)
  });
  const surfaceInput = dense(d.surfaceMaterials.value, BIOME_LIMITS.surfaceMaterials, `${label}.surfaceMaterials`);
  if (surfaceInput.length < 1) fail5(`${label}.surfaceMaterials must not be empty`);
  const surfaceSeen = /* @__PURE__ */ new Set();
  const surfaceMaterials = Object.freeze(surfaceInput.map((entry, index) => {
    const e = record(entry, /* @__PURE__ */ new Set(["role"]), `${label}.surfaceMaterials[${index}]`);
    const role = string(e.role.value, REF, BIOME_LIMITS.refChars, `${label}.surfaceMaterials[${index}].role`);
    if (surfaceSeen.has(role)) fail5(`${label}.surfaceMaterials duplicates role '${role}'`);
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
  for (let index = 1; index < vegetationPalette.length; index++) if (vegetationPalette[index - 1].role >= vegetationPalette[index].role) fail5(`${label}.vegetationPalette must be strictly role-sorted and unique`);
  const resourceTableRefs = sortedUniqueStrings(d.resourceTableRefs.value, BIOME_LIMITS.tableRefs, `${label}.resourceTableRefs`);
  const spawnTableRefs = sortedUniqueStrings(d.spawnTableRefs.value, BIOME_LIMITS.tableRefs, `${label}.spawnTableRefs`);
  const ambientAudioRefs = sortedUniqueStrings(d.ambientAudioRefs.value, BIOME_LIMITS.ambientAudioRefs, `${label}.ambientAudioRefs`);
  const tintInput = dense(d.waterTintSrgb.value, 3, `${label}.waterTintSrgb`);
  if (tintInput.length !== 3) fail5(`${label}.waterTintSrgb must contain exactly 3 channels`);
  const waterTintSrgb = Object.freeze(tintInput.map((entry, index) => integer2(entry, 0, 255, `${label}.waterTintSrgb[${index}]`)));
  const fulfillmentInput = record(d.fulfillment.value, /* @__PURE__ */ new Set(["status", "bindings"]), `${label}.fulfillment`);
  if (!BIOME_FULFILLMENT_STATES.includes(fulfillmentInput.status.value)) fail5(`${label}.fulfillment.status is unsupported`);
  const declared = /* @__PURE__ */ new Set([
    ...surfaceMaterials.map((entry) => `surface-material:${entry.role}`),
    ...vegetationPalette.map((entry) => `vegetation:${entry.role}`),
    ...resourceTableRefs.map((ref) => `resource-table:${ref}`),
    ...spawnTableRefs.map((ref) => `spawn-table:${ref}`),
    ...ambientAudioRefs.map((ref) => `ambient-audio:${ref}`)
  ]);
  const bindingsInput = dense(fulfillmentInput.bindings.value, BIOME_LIMITS.bindings, `${label}.fulfillment.bindings`);
  const bindingKeys = /* @__PURE__ */ new Set();
  const bindings2 = Object.freeze(bindingsInput.map((entry, index) => {
    const e = record(entry, /* @__PURE__ */ new Set(["kind", "ref", "assetId", "contentHash", "licenseId", "sourceUri"]), `${label}.fulfillment.bindings[${index}]`);
    if (!BIOME_BINDING_KINDS.includes(e.kind.value)) fail5(`${label}.fulfillment.bindings[${index}].kind is unsupported`);
    const ref = string(e.ref.value, REF, BIOME_LIMITS.refChars, `${label}.fulfillment.bindings[${index}].ref`);
    const key = `${e.kind.value}:${ref}`;
    if (!declared.has(key)) fail5(`${label}.fulfillment binding '${key}' is not declared by the definition`);
    if (bindingKeys.has(key)) fail5(`${label}.fulfillment duplicates binding '${key}'`);
    bindingKeys.add(key);
    return Object.freeze({
      kind: e.kind.value,
      ref,
      assetId: string(e.assetId.value, REF, BIOME_LIMITS.refChars, `${label}.fulfillment.bindings[${index}].assetId`),
      contentHash: string(e.contentHash.value, HASH, 71, `${label}.fulfillment.bindings[${index}].contentHash`),
      licenseId: text(e.licenseId.value, BIOME_LIMITS.labelChars, `${label}.fulfillment.bindings[${index}].licenseId`),
      sourceUri: text(e.sourceUri.value, BIOME_LIMITS.uriChars, `${label}.fulfillment.bindings[${index}].sourceUri`)
    });
  }));
  for (let index = 1; index < bindings2.length; index++) {
    const prior = `${bindings2[index - 1].kind}:${bindings2[index - 1].ref}`, current = `${bindings2[index].kind}:${bindings2[index].ref}`;
    if (prior >= current) fail5(`${label}.fulfillment.bindings must be strictly kind/ref-sorted`);
  }
  const expectedStatus = bindings2.length === 0 ? "metadata-only" : bindings2.length === declared.size ? "fulfilled" : "partial";
  if (fulfillmentInput.status.value !== expectedStatus) fail5(`${label}.fulfillment.status must be '${expectedStatus}' for its declared bindings`);
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
    fulfillment: Object.freeze({ status: expectedStatus, bindings: bindings2 }),
    provenance: provenance(d.provenance.value, `${label}.provenance`)
  });
}
function parseBiomePack(value) {
  const d = record(value, /* @__PURE__ */ new Set(["schema", "id", "version", "definitions", "legacyAliases", "provenance"]), "biome pack");
  if (d.schema.value !== BIOME_PACK_SCHEMA) fail5(`biome pack.schema must be '${BIOME_PACK_SCHEMA}'`);
  const definitionsInput = dense(d.definitions.value, BIOME_LIMITS.definitions, "biome pack.definitions");
  if (definitionsInput.length < 1) fail5("biome pack.definitions must not be empty");
  const definitions2 = Object.freeze(definitionsInput.map((entry, index) => parseDefinition(entry, `biome pack.definitions[${index}]`)));
  for (let index = 1; index < definitions2.length; index++) if (definitions2[index - 1].id >= definitions2[index].id) fail5("biome pack.definitions must be strictly id-sorted and unique");
  const ids = new Set(definitions2.map((definition2) => definition2.id));
  const aliasesInput = dense(d.legacyAliases.value, BIOME_LIMITS.legacyAliases, "biome pack.legacyAliases");
  const legacyAliases = Object.freeze(aliasesInput.map((entry, index) => {
    const e = record(entry, /* @__PURE__ */ new Set(["legacyKind", "biomeId"]), `biome pack.legacyAliases[${index}]`);
    if (!LEGACY_BIOME_KINDS.includes(e.legacyKind.value)) fail5(`biome pack.legacyAliases[${index}].legacyKind is unsupported`);
    const biomeId = string(e.biomeId.value, ID, BIOME_LIMITS.idChars, `biome pack.legacyAliases[${index}].biomeId`);
    if (!ids.has(biomeId)) fail5(`biome pack legacy alias targets unknown biome '${biomeId}'`);
    return Object.freeze({ legacyKind: e.legacyKind.value, biomeId });
  }));
  for (let index = 1; index < legacyAliases.length; index++) if (legacyAliases[index - 1].legacyKind >= legacyAliases[index].legacyKind) fail5("biome pack.legacyAliases must be strictly legacyKind-sorted and unique");
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
var MAGIC6 = Object.freeze([76, 77, 66, 73, 79, 77, 69, 0]);
var ID2 = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
var SEMVER2 = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
var FIELD_KEYS = /* @__PURE__ */ new Set(["schema", "version", "pack", "grid", "topN", "biomeIds", "indices", "weights", "diagnostics"]);
var PACK_KEYS = /* @__PURE__ */ new Set(["id", "version"]);
var GRID_KEYS2 = /* @__PURE__ */ new Set(["origin", "rows", "cols", "cellSizeM"]);
var DIAGNOSTIC_KEYS = /* @__PURE__ */ new Set(["cells", "workUnits", "outputBytes", "influences", "modifiers"]);
var CONTROL_KEYS3 = /* @__PURE__ */ new Set(["shouldCancel"]);
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
function fail6(message) {
  throw new BiomeFieldArtifactValidationError(message);
}
function exactRecord4(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail6(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail6(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor3] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail6(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor3) || descriptor3.enumerable !== true) fail6(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail6(`${label} is missing '${key}'`);
  return descriptors;
}
function parseControl3(value) {
  if (value === void 0) return null;
  const d = exactRecord4(value, CONTROL_KEYS3, "biome field artifact control");
  if (typeof d.shouldCancel.value !== "function") fail6("biome field artifact control.shouldCancel must be a function");
  return d.shouldCancel.value;
}
function createMeter3(shouldCancel, limit) {
  let work = 0;
  const check = () => {
    if (shouldCancel?.()) throw new BiomeFieldArtifactCancelledError();
  };
  return Object.freeze({
    start: check,
    work() {
      if (++work > limit) fail6(`biome field artifact exceeded bounded validation work ${limit}`);
      if ((work & 1023) === 0) check();
    },
    finish: check
  });
}
function canonicalNumber3(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum) fail6(`${label} must be a canonical number in [${minimum}, ${maximum}]`);
  return value;
}
function integer3(value, minimum, maximum, label) {
  const result = canonicalNumber3(value, minimum, maximum, label);
  if (!Number.isSafeInteger(result)) fail6(`${label} must be an integer`);
  return result;
}
function string2(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail6(`${label} is invalid`);
  return value;
}
function denseStrings(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 2 || value.length > 64 || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail6(`${label} must be a dense standard array with 2-64 entries`);
  }
  const result = value.map((entry, index) => string2(entry, ID2, 64, `${label}[${index}]`));
  for (let index = 1; index < result.length; index++) if (result[index - 1] >= result[index]) fail6(`${label} must be strictly sorted and unique`);
  return Object.freeze(result);
}
function originTuple2(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2 || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== 3) fail6("biome field grid.origin must be a dense tuple");
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
    fail6(`${label} must own a complete non-shared Uint16Array of length ${length}`);
  }
  return value;
}
function parseField(input, meter) {
  const d = exactRecord4(input, FIELD_KEYS, "biome field");
  if (d.schema.value !== BIOME_FIELD_SCHEMA || d.version.value !== BIOME_FIELD_VERSION) fail6("biome field schema/version is unsupported");
  const packInput = exactRecord4(d.pack.value, PACK_KEYS, "biome field pack");
  const pack = Object.freeze({
    id: string2(packInput.id.value, ID2, 64, "biome field pack.id"),
    version: string2(packInput.version.value, SEMVER2, 64, "biome field pack.version")
  });
  const gridInput = exactRecord4(d.grid.value, GRID_KEYS2, "biome field grid");
  const rows = integer3(gridInput.rows.value, 1, BIOME_FIELD_LIMITS.rows, "biome field grid.rows");
  const cols = integer3(gridInput.cols.value, 1, BIOME_FIELD_LIMITS.cols, "biome field grid.cols");
  const cells = rows * cols;
  if (!Number.isSafeInteger(cells) || cells > BIOME_FIELD_LIMITS.cells) fail6("biome field cell count exceeds the supported limit");
  const grid = Object.freeze({
    origin: originTuple2(gridInput.origin.value),
    rows,
    cols,
    cellSizeM: canonicalNumber3(gridInput.cellSizeM.value, 0.01, 1e6, "biome field grid.cellSizeM")
  });
  const biomeIds = denseStrings(d.biomeIds.value, "biome field biomeIds");
  const topN = integer3(d.topN.value, 2, Math.min(BIOME_FIELD_LIMITS.topN, biomeIds.length), "biome field topN");
  const length = cells * topN;
  const indices = ownedUint16(d.indices.value, length, "biome field indices");
  const weights = ownedUint16(d.weights.value, length, "biome field weights");
  const diagnosticInput = exactRecord4(d.diagnostics.value, DIAGNOSTIC_KEYS, "biome field diagnostics");
  const outputBytes = cells * topN * 4;
  const diagnostics = Object.freeze({
    cells: integer3(diagnosticInput.cells.value, cells, cells, "biome field diagnostics.cells"),
    workUnits: integer3(diagnosticInput.workUnits.value, 0, BIOME_FIELD_LIMITS.workUnits, "biome field diagnostics.workUnits"),
    outputBytes: integer3(diagnosticInput.outputBytes.value, outputBytes, outputBytes, "biome field diagnostics.outputBytes"),
    influences: integer3(diagnosticInput.influences.value, 0, BIOME_FIELD_LIMITS.influences, "biome field diagnostics.influences"),
    modifiers: integer3(diagnosticInput.modifiers.value, 0, BIOME_FIELD_LIMITS.modifiers, "biome field diagnostics.modifiers")
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
        if (weight !== 0) fail6(`biome field cell ${cell} empty rank has nonzero weight`);
        empty = true;
        continue;
      }
      if (empty || index >= biomeIds.length || weight === 0 || weight > priorWeight || seen.has(index)) fail6(`biome field cell ${cell} rank ${rank} is non-canonical`);
      seen.add(index);
      priorWeight = weight;
      sum += weight;
    }
    if (sum !== BIOME_FIELD_WEIGHT_TOTAL) fail6(`biome field cell ${cell} weights do not normalize exactly`);
  }
  return Object.freeze({ schema: BIOME_FIELD_SCHEMA, version: BIOME_FIELD_VERSION, pack, grid, topN, biomeIds, indices, weights, diagnostics });
}
function align4(value) {
  return value + 3 & ~3;
}
function artifactBytes2(input) {
  if (!ArrayBuffer.isView(input) || Object.getPrototypeOf(input) !== Uint8Array.prototype || !(input.buffer instanceof ArrayBuffer) || isShared2(input.buffer) || input.byteOffset !== 0 || input.byteLength !== input.buffer.byteLength) fail6("biome field artifact bytes must be an owned Uint8Array over a non-shared ArrayBuffer");
  if (input.byteLength < BIOME_FIELD_ARTIFACT_HEADER_BYTES || input.byteLength > BIOME_FIELD_ARTIFACT_MAX_BYTES) fail6("biome field artifact byte length is outside the supported range");
  return input;
}
function decodeString2(bytes, start, length, label) {
  try {
    const value = decoder2.decode(bytes.subarray(start, start + length));
    if (encoder2.encode(value).length !== length) fail6(`${label} is not canonical UTF-8`);
    return value;
  } catch (error) {
    if (error instanceof BiomeFieldArtifactValidationError) throw error;
    fail6(`${label} is invalid UTF-8`);
  }
}
function decodeBiomeFieldArtifact(input, controlInput) {
  const bytes = artifactBytes2(input);
  const meter = createMeter3(parseControl3(controlInput), BIOME_FIELD_LIMITS.cells * BIOME_FIELD_LIMITS.topN * 4 + 8192);
  meter.start();
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC6.length; index++) if (view.getUint8(index) !== MAGIC6[index]) fail6("biome field artifact magic mismatch");
  if (view.getUint16(8, true) !== BIOME_FIELD_ARTIFACT_VERSION) fail6("biome field artifact version is unsupported");
  if (view.getUint16(10, true) !== BIOME_FIELD_ARTIFACT_HEADER_BYTES) fail6("biome field artifact header length mismatch");
  if (view.getUint32(12, true) !== bytes.byteLength) fail6("biome field artifact byte length is non-canonical");
  for (let offset = 84; offset < BIOME_FIELD_ARTIFACT_HEADER_BYTES; offset++) if (bytes[offset] !== 0) fail6("biome field artifact reserved header bytes must be zero");
  const rows = view.getUint32(16, true), cols = view.getUint32(20, true), cells = rows * cols;
  if (!Number.isSafeInteger(cells) || cells !== view.getUint32(24, true) || cells < 1 || cells > BIOME_FIELD_LIMITS.cells) fail6("biome field artifact cell count is invalid");
  const topN = view.getUint16(28, true), biomeCount = view.getUint16(30, true);
  if (biomeCount < 2 || biomeCount > 64 || topN < 2 || topN > Math.min(BIOME_FIELD_LIMITS.topN, biomeCount)) fail6("biome field artifact rank/biome count is invalid");
  const packIdLength = view.getUint16(56, true), packVersionLength = view.getUint16(58, true), stringTableBytes = view.getUint32(60, true);
  let cursor = BIOME_FIELD_ARTIFACT_HEADER_BYTES;
  if (cursor + stringTableBytes > bytes.byteLength || stringTableBytes < packIdLength + packVersionLength + biomeCount * 3) fail6("biome field artifact string table is invalid");
  const packId = decodeString2(bytes, cursor, packIdLength, "biome field pack id");
  cursor += packIdLength;
  const packVersion = decodeString2(bytes, cursor, packVersionLength, "biome field pack version");
  cursor += packVersionLength;
  const biomeIds = [];
  for (let index = 0; index < biomeCount; index++) {
    if (cursor + 2 > BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes) fail6("biome field artifact biome string descriptor is truncated");
    const length = view.getUint16(cursor, true);
    cursor += 2;
    if (length < 1 || cursor + length > BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes) fail6("biome field artifact biome string is truncated");
    biomeIds.push(decodeString2(bytes, cursor, length, `biome field id ${index}`));
    cursor += length;
  }
  if (cursor !== BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes) fail6("biome field artifact string table has trailing bytes");
  const shell = {
    indices: { byteLength: cells * topN * 2 },
    weights: { byteLength: cells * topN * 2 }
  };
  const expectedIndices = align4(BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes);
  const expectedWeights = expectedIndices + shell.indices.byteLength;
  const expectedLength = expectedWeights + shell.weights.byteLength;
  if (view.getUint32(64, true) !== expectedIndices || view.getUint32(68, true) !== expectedWeights || bytes.byteLength !== expectedLength) fail6("biome field artifact channel layout is non-canonical");
  for (let offset = BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes; offset < expectedIndices; offset++) if (bytes[offset] !== 0) fail6("biome field artifact alignment padding must be zero");
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

// src/world/biome-surface-plan.mjs
var BIOME_SURFACE_PLAN_LIMITS = Object.freeze({ rows: 1025, cols: 1025, cells: 1050625, roles: 32, slots: 16, bytes: 64 * 1024 * 1024 });

// src/world/surface-composite-tile.mjs
var SURFACE_COMPOSITE_TILE_SCHEMA = "limina.surface-composite-tile/v1";
var SURFACE_COMPOSITE_POLICY_VERSION = 8;
var SURFACE_COMPOSITE_LIMITS = Object.freeze({ interior: 256, gutter: 4, roles: 32, sourceDimension: 4096, outputBytes: 4 * 1024 * 1024 });

// src/world/compiler/surface-composite-artifact.mjs
var SURFACE_COMPOSITE_ARTIFACT_TYPE = "surface-composite-tile/v1";
var SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.surface-composite-qoi-v1";
var SURFACE_COMPOSITE_ARTIFACT_VERSION = 1;
var MAX_SURFACE_COMPOSITE_ARTIFACT_BYTES = 4 * 1024 * 1024;
var MAX_SURFACE_COMPOSITE_DECODED_BYTES = 4 * 1024 * 1024;
var MAGIC7 = Object.freeze([76, 77, 83, 85, 82, 70, 1, 0]);
var HEADER_BYTES2 = 32;
var MAX_METADATA_BYTES = 16 * 1024;
var HASH2 = /^sha256:[0-9a-f]{64}$/;
var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder("utf-8", { fatal: true });
function checkpoint(control, index = 0) {
  if ((index & 4095) === 0 && control?.shouldCancel?.() === true) {
    const error = new Error("surface composite artifact operation cancelled");
    error.name = "AbortError";
    throw error;
  }
}
function plain3(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}
function exact3(value, keys, label) {
  const names = Object.getOwnPropertyNames(value), expected = new Set(keys);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== expected.size || names.some((name) => !expected.has(name))) {
    throw new TypeError(`${label} fields are invalid`);
  }
  for (const name of names) {
    const descriptor3 = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor3?.enumerable !== true || descriptor3.get !== void 0 || descriptor3.set !== void 0) {
      throw new TypeError(`${label}.${name} must be an enumerable data field`);
    }
  }
  return value;
}
function integer4(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} is out of bounds`);
  return value;
}
function finite2(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) throw new RangeError(`${label} must be a canonical finite number`);
  return value;
}
function hash(value, label) {
  if (typeof value !== "string" || !HASH2.test(value)) throw new TypeError(`${label} must be a canonical content hash`);
  return value;
}
function tuple2(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2) throw new TypeError(`${label} must be a two-number array`);
  return Object.freeze([finite2(value[0], `${label}[0]`), finite2(value[1], `${label}[1]`)]);
}
function canonicalMetadata(input, verifyPixels = true) {
  const root = exact3(plain3(input, "surface composite"), ["schema", "source", "coord", "placement", "resolution", "maps", "edgeHashes", "diagnostics"], "surface composite");
  if (root.schema !== SURFACE_COMPOSITE_TILE_SCHEMA) throw new TypeError("surface composite schema is unsupported");
  const sourceInput = plain3(root.source, "surface composite source");
  const source = exact3(sourceInput, Object.hasOwn(sourceInput, "environmentHash") ? ["biomeFieldHash", "biomePackHash", "terrainChunkHash", "environmentHash", "policyVersion"] : ["biomeFieldHash", "biomePackHash", "terrainChunkHash", "policyVersion"], "surface composite source");
  const coord = exact3(plain3(root.coord, "surface composite coord"), ["tx", "tz", "lod"], "surface composite coord");
  const placement = exact3(plain3(root.placement, "surface composite placement"), ["origin", "sizeM", "featureOrigin"], "surface composite placement");
  const resolution = exact3(plain3(root.resolution, "surface composite resolution"), ["interior", "gutter", "total"], "surface composite resolution");
  const maps = exact3(plain3(root.maps, "surface composite maps"), ["albedo", "normal", "orm"], "surface composite maps");
  const edges = exact3(plain3(root.edgeHashes, "surface composite edge hashes"), ["north", "east", "south", "west"], "surface composite edge hashes");
  const diagnostics = exact3(plain3(root.diagnostics, "surface composite diagnostics"), ["roles", "runtimeTextureSamples", "outputBytes"], "surface composite diagnostics");
  const interior = integer4(resolution.interior, 2, 256, "surface composite interior");
  const gutter = integer4(resolution.gutter, 0, 4, "surface composite gutter");
  const total = integer4(resolution.total, 2, 264, "surface composite total");
  if (total !== interior + gutter * 2) throw new Error("surface composite resolution is inconsistent");
  const decodedMapBytes = total * total * 4;
  if (decodedMapBytes * 3 > MAX_SURFACE_COMPOSITE_DECODED_BYTES) throw new RangeError("surface composite decoded maps exceed budget");
  const mapMeta = {};
  for (const name of ["albedo", "normal", "orm"]) {
    const entry = plain3(maps[name], `surface composite ${name}`);
    const required = name === "albedo" ? ["data", "contentHash", "colorSpace"] : name === "normal" ? ["data", "contentHash", "colorSpace", "convention"] : ["data", "contentHash", "colorSpace", "channels"];
    exact3(entry, required, `surface composite ${name}`);
    if (!(entry.data instanceof Uint8Array) || !(entry.data.buffer instanceof ArrayBuffer) || entry.data.length !== decodedMapBytes || entry.data.byteOffset !== 0 || entry.data.byteLength !== entry.data.buffer.byteLength) {
      throw new TypeError(`surface composite ${name} must be owned exact RGBA8 data`);
    }
    const contentHash2 = hash(entry.contentHash, `surface composite ${name} hash`);
    if (verifyPixels && `sha256:${sha256(entry.data)}` !== contentHash2) throw new Error(`surface composite ${name} content hash mismatch`);
    if (entry.colorSpace !== (name === "albedo" ? "srgb" : "none")) throw new Error(`surface composite ${name} color space is invalid`);
    if (name === "normal" && entry.convention !== "opengl-y-plus") throw new Error("surface composite normal convention is invalid");
    if (name === "orm" && entry.channels !== "ao-roughness-metalness-grass-density") throw new Error("surface composite ORM channels are invalid");
    mapMeta[name] = Object.freeze({
      contentHash: contentHash2,
      colorSpace: entry.colorSpace,
      ...name === "normal" ? { convention: entry.convention } : {},
      ...name === "orm" ? { channels: entry.channels } : {}
    });
  }
  const outputBytes = integer4(diagnostics.outputBytes, 1, MAX_SURFACE_COMPOSITE_DECODED_BYTES, "surface composite output bytes");
  if (outputBytes !== decodedMapBytes * 3 || diagnostics.runtimeTextureSamples !== 3) throw new Error("surface composite diagnostics are inconsistent");
  return Object.freeze({
    schema: SURFACE_COMPOSITE_TILE_SCHEMA,
    source: Object.freeze({
      biomeFieldHash: hash(source.biomeFieldHash, "surface composite biome field hash"),
      biomePackHash: hash(source.biomePackHash, "surface composite biome pack hash"),
      terrainChunkHash: hash(source.terrainChunkHash, "surface composite terrain chunk hash"),
      environmentHash: hash(source.environmentHash ?? source.terrainChunkHash, "surface composite environment hash"),
      policyVersion: integer4(source.policyVersion, SURFACE_COMPOSITE_POLICY_VERSION, SURFACE_COMPOSITE_POLICY_VERSION, "surface composite policy version")
    }),
    coord: Object.freeze({ tx: integer4(coord.tx, -1e6, 1e6, "surface composite tx"), tz: integer4(coord.tz, -1e6, 1e6, "surface composite tz"), lod: integer4(coord.lod, 0, 16, "surface composite lod") }),
    placement: Object.freeze({ origin: tuple2(placement.origin, "surface composite origin"), sizeM: (() => {
      const size = finite2(placement.sizeM, "surface composite size");
      if (!(size > 0) || size > 1e6) throw new RangeError("surface composite size is out of bounds");
      return size;
    })(), featureOrigin: tuple2(placement.featureOrigin, "surface composite feature origin") }),
    resolution: Object.freeze({ interior, gutter, total }),
    maps: Object.freeze(mapMeta),
    edgeHashes: Object.freeze({ north: hash(edges.north, "surface composite north edge"), east: hash(edges.east, "surface composite east edge"), south: hash(edges.south, "surface composite south edge"), west: hash(edges.west, "surface composite west edge") }),
    diagnostics: Object.freeze({ roles: integer4(diagnostics.roles, 1, 32, "surface composite roles"), runtimeTextureSamples: 3, outputBytes }),
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
function encodeSurfaceCompositeArtifact(input, control = {}) {
  checkpoint(control);
  const metadata = canonicalMetadata(input), metadataBytes = textEncoder.encode(JSON.stringify(metadata));
  const streams = [input.maps.albedo.data, input.maps.normal.data, input.maps.orm.data].map((data) => qoiEncode(data, control));
  const length = HEADER_BYTES2 + metadataBytes.length + streams.reduce((sum, stream) => sum + stream.length, 0);
  if (length > MAX_SURFACE_COMPOSITE_ARTIFACT_BYTES) throw new RangeError("surface composite artifact exceeds encoded byte budget");
  const bytes = new Uint8Array(length);
  bytes.set(MAGIC7);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, SURFACE_COMPOSITE_ARTIFACT_VERSION, true);
  view.setUint16(10, HEADER_BYTES2, true);
  view.setUint32(12, length, true);
  view.setUint32(16, metadataBytes.length, true);
  streams.forEach((stream, index) => view.setUint32(20 + index * 4, stream.length, true));
  bytes.set(metadataBytes, HEADER_BYTES2);
  let offset = HEADER_BYTES2 + metadataBytes.length;
  for (const stream of streams) {
    bytes.set(stream, offset);
    offset += stream.length;
  }
  return bytes;
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
var HASH3 = /^sha256:[0-9a-f]{64}$/;
var REF2 = /^[a-z][a-z0-9._/-]*$/;
var ROOT_KEYS2 = /* @__PURE__ */ new Set(["schema", "coord", "identity", "placements"]);
var COORD_KEYS = /* @__PURE__ */ new Set(["tx", "tz", "lod"]);
var IDENTITY_KEYS = /* @__PURE__ */ new Set(["fieldContentHash", "runtimePackContentHash"]);
var PLACEMENT_KEYS2 = /* @__PURE__ */ new Set(["role", "assetId", "contentHash", "x", "y", "z", "yaw", "scale", "pageX", "pageZ"]);
var CONTROL_KEYS4 = /* @__PURE__ */ new Set(["shouldCancel"]);
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
function fail7(message) {
  throw new BiomePopulationArtifactValidationError(message);
}
function isShared3(buffer) {
  return Object.prototype.toString.call(buffer) === "[object SharedArrayBuffer]";
}
function align82(value) {
  return value + 7 & ~7;
}
function exactRecord5(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail7(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) fail7(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor3] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail7(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor3) || descriptor3.enumerable !== true) fail7(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail7(`${label} is missing '${key}'`);
  return descriptors;
}
function denseArray(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail7(`${label} must be a dense standard array with at most ${maximum} entries`);
  }
  return value;
}
function parseControl4(value) {
  if (value === void 0) return null;
  const d = exactRecord5(value, CONTROL_KEYS4, "biome population artifact control");
  if (typeof d.shouldCancel.value !== "function") fail7("biome population artifact control.shouldCancel must be a function");
  return d.shouldCancel.value;
}
function createMeter4(shouldCancel) {
  let work = 0;
  const check = () => {
    if (shouldCancel?.() === true) throw new BiomePopulationArtifactCancelledError();
  };
  return Object.freeze({
    start: check,
    work() {
      work++;
      if (work > MAX_BIOME_POPULATION_ARTIFACT_PLACEMENTS * 8 + 65536) fail7("biome population artifact validation work exceeded its bound");
      if ((work & 1023) === 0) check();
    },
    finish: check
  });
}
function canonicalNumber4(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum) {
    fail7(`${label} must be a canonical number in [${minimum}, ${maximum}]`);
  }
  return value;
}
function integer5(value, minimum, maximum, label) {
  const result = canonicalNumber4(value, minimum, maximum, label);
  if (!Number.isSafeInteger(result)) fail7(`${label} must be an integer`);
  return result;
}
function reference(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > BIOME_POPULATION_ASSET_LIMITS.refChars || !REF2.test(value)) {
    fail7(`${label} is invalid`);
  }
  const bytes = encoder3.encode(value);
  if (bytes.length > BIOME_POPULATION_ASSET_LIMITS.refChars) fail7(`${label} UTF-8 encoding is too long`);
  return Object.freeze({ value, bytes });
}
function contentHash(value, label) {
  if (typeof value !== "string" || !HASH3.test(value)) fail7(`${label} must be a canonical content hash`);
  return value;
}
function hashHex(value) {
  return value.slice("sha256:".length);
}
function writeHex(bytes, offset, hex) {
  for (let index = 0; index < 32; index++) bytes[offset + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
}
function readHex(bytes, offset) {
  let result = "";
  for (let index = 0; index < 32; index++) result += bytes[offset + index].toString(16).padStart(2, "0");
  return result;
}
function descriptorKey(role, assetId2, hash2) {
  return `${role}\0${assetId2}\0${hash2}`;
}
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function parsePlan(input, meter) {
  const root = exactRecord5(input, ROOT_KEYS2, "biome population artifact plan");
  if (root.schema.value !== BIOME_POPULATION_ARTIFACT_SCHEMA) fail7("biome population artifact plan schema is unsupported");
  const coordInput = exactRecord5(root.coord.value, COORD_KEYS, "biome population artifact coord");
  const coord = Object.freeze({
    tx: integer5(coordInput.tx.value, -MAX_COORD, MAX_COORD, "biome population artifact coord.tx"),
    tz: integer5(coordInput.tz.value, -MAX_COORD, MAX_COORD, "biome population artifact coord.tz"),
    lod: integer5(coordInput.lod.value, 0, 16, "biome population artifact coord.lod")
  });
  const identityInput = exactRecord5(root.identity.value, IDENTITY_KEYS, "biome population artifact identity");
  const identity = Object.freeze({
    fieldContentHash: contentHash(identityInput.fieldContentHash.value, "biome population artifact identity.fieldContentHash"),
    runtimePackContentHash: contentHash(identityInput.runtimePackContentHash.value, "biome population artifact identity.runtimePackContentHash")
  });
  const source = denseArray(root.placements.value, MAX_BIOME_POPULATION_ARTIFACT_PLACEMENTS, "biome population artifact placements");
  const placements = new Array(source.length);
  for (let index = 0; index < source.length; index++) {
    meter.work();
    const d = exactRecord5(source[index], PLACEMENT_KEYS2, `biome population artifact placements[${index}]`);
    const role = reference(d.role.value, `biome population artifact placements[${index}].role`).value;
    const assetId2 = reference(d.assetId.value, `biome population artifact placements[${index}].assetId`).value;
    const hash2 = contentHash(d.contentHash.value, `biome population artifact placements[${index}].contentHash`);
    const scale = canonicalNumber4(d.scale.value, Number.MIN_VALUE, MAX_SCALE, `biome population artifact placements[${index}].scale`);
    if (scale === 0) fail7(`biome population artifact placements[${index}].scale must be positive`);
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
function buildDescriptors(plan, meter) {
  const unique = /* @__PURE__ */ new Map();
  for (const placement of plan.placements) {
    meter.work();
    const key = descriptorKey(placement.role, placement.assetId, placement.contentHash);
    if (!unique.has(key)) unique.set(key, { role: placement.role, assetId: placement.assetId, contentHash: placement.contentHash });
  }
  const descriptors = [...unique.values()].sort((left, right) => compareText(left.role, right.role) || compareText(left.assetId, right.assetId) || compareText(left.contentHash, right.contentHash));
  const byKey = /* @__PURE__ */ new Map();
  let byteLength2 = 0;
  for (let index = 0; index < descriptors.length; index++) {
    meter.work();
    const descriptor3 = descriptors[index];
    const roleBytes = encoder3.encode(descriptor3.role), assetIdBytes = encoder3.encode(descriptor3.assetId);
    descriptor3.roleBytes = roleBytes;
    descriptor3.assetIdBytes = assetIdBytes;
    byteLength2 += 36 + roleBytes.length + assetIdBytes.length;
    byKey.set(descriptorKey(descriptor3.role, descriptor3.assetId, descriptor3.contentHash), index);
  }
  return Object.freeze({ descriptors, byKey, byteLength: byteLength2 });
}
function integrityBytes(bytes) {
  const material = new Uint8Array(bytes);
  material.fill(0, 112, 144);
  return material;
}
function artifactBytes3(input) {
  if (!ArrayBuffer.isView(input) || Object.getPrototypeOf(input) !== Uint8Array.prototype || !(input.buffer instanceof ArrayBuffer) || isShared3(input.buffer) || input.byteOffset !== 0 || input.byteLength !== input.buffer.byteLength) {
    fail7("biome population artifact bytes must be an owned Uint8Array over a non-shared ArrayBuffer");
  }
  if (input.length < BIOME_POPULATION_ARTIFACT_HEADER_BYTES || input.length > MAX_BIOME_POPULATION_ARTIFACT_BYTES) {
    fail7("biome population artifact byte length is outside the supported range");
  }
  return input;
}
function encodeBiomePopulationArtifact(input, controlInput) {
  const meter = createMeter4(parseControl4(controlInput));
  meter.start();
  const plan = parsePlan(input, meter);
  const table = buildDescriptors(plan, meter);
  const descriptorOffset = BIOME_POPULATION_ARTIFACT_HEADER_BYTES;
  const placementOffset = align82(descriptorOffset + table.byteLength);
  const byteLength2 = placementOffset + plan.placements.length * BIOME_POPULATION_ARTIFACT_PLACEMENT_BYTES;
  if (!Number.isSafeInteger(byteLength2) || byteLength2 > MAX_BIOME_POPULATION_ARTIFACT_BYTES) {
    fail7(`biome population artifact exceeds ${MAX_BIOME_POPULATION_ARTIFACT_BYTES} bytes`);
  }
  const bytes = new Uint8Array(byteLength2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC8.length; index++) bytes[index] = MAGIC8[index];
  view.setUint16(8, BIOME_POPULATION_ARTIFACT_VERSION, true);
  view.setUint16(10, BIOME_POPULATION_ARTIFACT_HEADER_BYTES, true);
  view.setUint32(12, byteLength2, true);
  view.setInt32(16, plan.coord.tx, true);
  view.setInt32(20, plan.coord.tz, true);
  view.setUint16(24, plan.coord.lod, true);
  view.setUint32(28, plan.placements.length, true);
  view.setUint32(32, table.descriptors.length, true);
  view.setUint32(36, descriptorOffset, true);
  view.setUint32(40, table.byteLength, true);
  view.setUint32(44, placementOffset, true);
  writeHex(bytes, 48, hashHex(plan.identity.fieldContentHash));
  writeHex(bytes, 80, hashHex(plan.identity.runtimePackContentHash));
  let cursor = descriptorOffset;
  for (const descriptor3 of table.descriptors) {
    meter.work();
    view.setUint16(cursor, descriptor3.roleBytes.length, true);
    view.setUint16(cursor + 2, descriptor3.assetIdBytes.length, true);
    writeHex(bytes, cursor + 4, hashHex(descriptor3.contentHash));
    cursor += 36;
    bytes.set(descriptor3.roleBytes, cursor);
    cursor += descriptor3.roleBytes.length;
    bytes.set(descriptor3.assetIdBytes, cursor);
    cursor += descriptor3.assetIdBytes.length;
  }
  if (cursor !== descriptorOffset + table.byteLength) throw new Error("biome population artifact internal descriptor layout mismatch");
  for (let index = 0; index < plan.placements.length; index++) {
    meter.work();
    const placement = plan.placements[index], offset = placementOffset + index * BIOME_POPULATION_ARTIFACT_PLACEMENT_BYTES;
    const descriptorIndex = table.byKey.get(descriptorKey(placement.role, placement.assetId, placement.contentHash));
    if (descriptorIndex === void 0) throw new Error("biome population artifact internal descriptor reference mismatch");
    view.setUint32(offset, descriptorIndex, true);
    view.setInt32(offset + 4, placement.pageX, true);
    view.setInt32(offset + 8, placement.pageZ, true);
    view.setFloat64(offset + 16, placement.x, true);
    view.setFloat64(offset + 24, placement.y, true);
    view.setFloat64(offset + 32, placement.z, true);
    view.setFloat64(offset + 40, placement.yaw, true);
    view.setFloat64(offset + 48, placement.scale, true);
  }
  writeHex(bytes, 112, sha256(integrityBytes(bytes)));
  meter.finish();
  return bytes;
}
function decodeString3(bytes, start, length, label) {
  try {
    const value = decoder3.decode(bytes.subarray(start, start + length));
    if (encoder3.encode(value).length !== length) fail7(`${label} is not canonical UTF-8`);
    return value;
  } catch (error) {
    if (error instanceof BiomePopulationArtifactValidationError) throw error;
    fail7(`${label} is invalid UTF-8`);
  }
}
function decodeBiomePopulationArtifact(input, controlInput) {
  const bytes = artifactBytes3(input);
  const meter = createMeter4(parseControl4(controlInput));
  meter.start();
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC8.length; index++) if (bytes[index] !== MAGIC8[index]) fail7("biome population artifact magic mismatch");
  if (view.getUint16(8, true) !== BIOME_POPULATION_ARTIFACT_VERSION) fail7("biome population artifact version is unsupported");
  if (view.getUint16(10, true) !== BIOME_POPULATION_ARTIFACT_HEADER_BYTES) fail7("biome population artifact header length mismatch");
  if (view.getUint32(12, true) !== bytes.length) fail7("biome population artifact byte length is non-canonical");
  if (view.getUint16(26, true) !== 0) fail7("biome population artifact reserved header bytes must be zero");
  for (let offset = 144; offset < BIOME_POPULATION_ARTIFACT_HEADER_BYTES; offset++) if (bytes[offset] !== 0) fail7("biome population artifact reserved header bytes must be zero");
  const expectedIntegrity = readHex(bytes, 112), actualIntegrity = sha256(integrityBytes(bytes));
  meter.finish();
  if (expectedIntegrity !== actualIntegrity) fail7("biome population artifact integrity hash mismatch");
  const placementCount = view.getUint32(28, true), descriptorCount = view.getUint32(32, true);
  if (placementCount > MAX_BIOME_POPULATION_ARTIFACT_PLACEMENTS || descriptorCount > placementCount) fail7("biome population artifact count is out of bounds");
  const descriptorOffset = view.getUint32(36, true), descriptorBytes = view.getUint32(40, true), placementOffset = view.getUint32(44, true);
  const expectedPlacementOffset = align82(BIOME_POPULATION_ARTIFACT_HEADER_BYTES + descriptorBytes);
  const expectedLength = expectedPlacementOffset + placementCount * BIOME_POPULATION_ARTIFACT_PLACEMENT_BYTES;
  if (descriptorOffset !== BIOME_POPULATION_ARTIFACT_HEADER_BYTES || placementOffset !== expectedPlacementOffset || expectedLength !== bytes.length) {
    fail7("biome population artifact table layout is non-canonical");
  }
  for (let offset = descriptorOffset + descriptorBytes; offset < placementOffset; offset++) if (bytes[offset] !== 0) fail7("biome population artifact alignment padding must be zero");
  const descriptors = new Array(descriptorCount);
  let cursor = descriptorOffset, priorKey = null;
  for (let index = 0; index < descriptorCount; index++) {
    meter.work();
    if (cursor + 36 > descriptorOffset + descriptorBytes) fail7("biome population artifact descriptor is truncated");
    const roleLength = view.getUint16(cursor, true), assetIdLength = view.getUint16(cursor + 2, true);
    if (roleLength < 1 || assetIdLength < 1 || roleLength > BIOME_POPULATION_ASSET_LIMITS.refChars || assetIdLength > BIOME_POPULATION_ASSET_LIMITS.refChars || cursor + 36 + roleLength + assetIdLength > descriptorOffset + descriptorBytes) {
      fail7("biome population artifact descriptor string length is invalid");
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
    const key = descriptorKey(checkedRole, checkedAssetId, hash2);
    if (priorKey !== null && priorKey >= key) fail7("biome population artifact descriptors are not strictly sorted and unique");
    priorKey = key;
    descriptors[index] = Object.freeze({ role: checkedRole, assetId: checkedAssetId, contentHash: hash2 });
  }
  if (cursor !== descriptorOffset + descriptorBytes) fail7("biome population artifact descriptor table has trailing bytes");
  const placements = new Array(placementCount);
  for (let index = 0; index < placementCount; index++) {
    meter.work();
    const offset = placementOffset + index * BIOME_POPULATION_ARTIFACT_PLACEMENT_BYTES;
    const descriptorIndex = view.getUint32(offset, true);
    if (descriptorIndex >= descriptors.length) fail7(`biome population artifact placement ${index} descriptor index is invalid`);
    if (view.getUint32(offset + 12, true) !== 0) fail7(`biome population artifact placement ${index} reserved bytes must be zero`);
    const descriptor3 = descriptors[descriptorIndex];
    placements[index] = {
      ...descriptor3,
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
var HASH4 = /^sha256:[0-9a-f]{64}$/;
var HTTPS = /^https:\/\/[^\s]+$/;
var PRODUCTION_WRAPPER_KINDS = /* @__PURE__ */ new Set(["surface-wrapper", "population-descriptor"]);
var BiomeContentBundleValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "BiomeContentBundleValidationError";
  }
};
function fail8(message) {
  throw new BiomeContentBundleValidationError(message);
}
function record2(value, required, optional, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail8(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail8(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail8(`${label} must not contain symbol fields`);
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor3] of Object.entries(descriptors)) {
    if (!allowed.has(key)) fail8(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor3) || descriptor3.enumerable !== true) {
      fail8(`${label}.${key} must be an enumerable data field`);
    }
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail8(`${label} is missing '${key}'`);
  return descriptors;
}
function dense2(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail8(`${label} must be a dense, field-free standard array with at most ${maximum} entries`);
  }
  return value;
}
function string3(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) {
    fail8(`${label} is invalid`);
  }
  return value;
}
function text2(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) fail8(`${label} is invalid`);
  return value;
}
function assetId(value, label) {
  const parsed = string3(value, REF3, BIOME_CONTENT_BUNDLE_LIMITS.idChars, label);
  if (parsed.startsWith("/") || parsed.includes("\\") || parsed.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail8(`${label} contains an unsafe path segment`);
  }
  return parsed;
}
function https(value, label) {
  return string3(value, HTTPS, BIOME_CONTENT_BUNDLE_LIMITS.uriChars, label);
}
function byteLength(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 1 || value > BIOME_CONTENT_BUNDLE_LIMITS.entryBytes) {
    fail8(`${label} must be a positive canonical integer no greater than ${BIOME_CONTENT_BUNDLE_LIMITS.entryBytes}`);
  }
  return value;
}
function parseIdentity(value, label) {
  const d = record2(value, /* @__PURE__ */ new Set(["assetId", "contentHash"]), /* @__PURE__ */ new Set(), label);
  return Object.freeze({
    assetId: assetId(d.assetId.value, `${label}.assetId`),
    contentHash: string3(d.contentHash.value, HASH4, 71, `${label}.contentHash`)
  });
}
function parseAttribution(value, label) {
  const d = record2(value, /* @__PURE__ */ new Set(["author", "title", "sourceUrl", "licenseUrl", "modified"]), /* @__PURE__ */ new Set(), label);
  if (typeof d.modified.value !== "boolean") fail8(`${label}.modified must be a boolean`);
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
  if (!tierA && !tierB) fail8(`${label}.licenseSpdx '${licenseSpdx}' is not an allowed Tier A or Tier B license`);
  if (tierB && d.attribution === void 0) fail8(`${label}.attribution is required for ${licenseSpdx}`);
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
    fail8(`${label}.humanVisualEvidence is required for an accepted bundle`);
  }
  if (status === "candidate" && d.humanVisualEvidence !== void 0) {
    fail8(`${label}.humanVisualEvidence cannot be claimed by a candidate bundle`);
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
  if (!BIOME_CONTENT_BUNDLE_KINDS.includes(d.kind.value)) fail8(`${label}.kind is unsupported`);
  const productionRequired = PRODUCTION_WRAPPER_KINDS.has(d.kind.value);
  if (productionRequired && d.acceptance === void 0) fail8(`${label}.acceptance is required for production wrapper kind '${d.kind.value}'`);
  if (!productionRequired && d.acceptance !== void 0) fail8(`${label}.acceptance is only valid on production wrapper entries`);
  return Object.freeze({
    assetId: assetId(d.assetId.value, `${label}.assetId`),
    contentHash: string3(d.contentHash.value, HASH4, 71, `${label}.contentHash`),
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
    fail8(`biome content bundle.schema must be '${BIOME_CONTENT_BUNDLE_SCHEMA}'`);
  }
  if (!BIOME_CONTENT_BUNDLE_STATUSES.includes(d.status.value)) fail8("biome content bundle.status is unsupported");
  const status = d.status.value;
  const runtimePack = parseIdentity(d.runtimePack.value, "biome content bundle.runtimePack");
  const sourceEntries = dense2(d.entries.value, BIOME_CONTENT_BUNDLE_LIMITS.entries, "biome content bundle.entries");
  if (sourceEntries.length < 1) fail8("biome content bundle.entries must not be empty");
  const entries = Object.freeze(sourceEntries.map((entry, index) => parseEntry(entry, index, status)));
  for (let index = 1; index < entries.length; index++) {
    if (entries[index - 1].assetId >= entries[index].assetId) {
      fail8("biome content bundle.entries must be strictly assetId-sorted and unique");
    }
  }
  if (entries.some((entry) => entry.assetId === runtimePack.assetId)) {
    fail8("biome content bundle runtime-pack assetId must not collide with a leaf entry");
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > BIOME_CONTENT_BUNDLE_LIMITS.totalBytes) {
    fail8(`biome content bundle entry bytes exceed ${BIOME_CONTENT_BUNDLE_LIMITS.totalBytes}`);
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
      if (evidence === void 0) fail8(`${entry.assetId} ${field} does not resolve inside the bundle closure`);
      if (evidence.kind !== expectedKind) fail8(`${entry.assetId} ${field} must resolve to kind '${expectedKind}'`);
      if (evidence.contentHash !== identity.contentHash) fail8(`${entry.assetId} ${field} contentHash does not match its closure entry`);
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
    fail8(`biome content bundle canonical closure exceeds ${BIOME_CONTENT_BUNDLE_LIMITS.canonicalBytes} bytes`);
  }
  const derivedClosureHash = `sha256:${sha256(closureBytes)}`;
  if (!withClosureHash) return Object.freeze({ core, derivedClosureHash });
  const supplied = string3(d.closureHash.value, HASH4, 71, "biome content bundle.closureHash");
  if (supplied !== derivedClosureHash) fail8("biome content bundle.closureHash does not match its runtime pack and entries");
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
var HASH5 = /^sha256:[0-9a-f]{64}$/;
var BiomeRuntimePackValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "BiomeRuntimePackValidationError";
  }
};
function fail9(message) {
  throw new BiomeRuntimePackValidationError(message);
}
function record3(value, required, optional, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail9(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail9(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail9(`${label} must not contain symbol fields`);
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor3] of Object.entries(descriptors)) {
    if (!allowed.has(key)) fail9(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor3) || descriptor3.enumerable !== true) fail9(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail9(`${label} is missing '${key}'`);
  return descriptors;
}
function dense3(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    fail9(`${label} must be a standard array with at most ${maximum} entries`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail9(`${label} must be dense and field-free`);
  }
  return value;
}
function string4(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail9(`${label} is invalid`);
  return value;
}
function text3(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) fail9(`${label} is invalid`);
  return value;
}
function number2(value, minimum, maximum, label, positive = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum || positive && value === 0) {
    fail9(`${label} must be a finite canonical number in ${positive ? "(" : "["}${minimum}, ${maximum}]`);
  }
  return value;
}
function integer6(value, minimum, maximum, label) {
  const parsed = number2(value, minimum, maximum, label);
  if (!Number.isSafeInteger(parsed)) fail9(`${label} must be an integer`);
  return parsed;
}
function tupleBand(value, minimum, maximum, label, positive = false) {
  const source = dense3(value, 2, label);
  if (source.length !== 2) fail9(`${label} must contain exactly [min, max]`);
  const min = number2(source[0], minimum, maximum, `${label}[0]`, positive);
  const max = number2(source[1], minimum, maximum, `${label}[1]`, positive);
  if (max < min) fail9(`${label}[1] must be at least ${label}[0]`);
  return Object.freeze([min, max]);
}
function tuple32(value, minimum, maximum, label, positive = false) {
  const source = dense3(value, 3, label);
  if (source.length !== 3) fail9(`${label} must contain exactly three values`);
  return Object.freeze(source.map((entry, index) => number2(entry, minimum, maximum, `${label}[${index}]`, positive)));
}
function surfaceCalibration(value, label) {
  const d = record3(value, /* @__PURE__ */ new Set(["albedoLinearGain", "normalStrength", "displacementScaleM"]), /* @__PURE__ */ new Set(), label);
  return Object.freeze({
    albedoLinearGain: tuple32(d.albedoLinearGain.value, Number.MIN_VALUE, 4, `${label}.albedoLinearGain`, true),
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
  const band2 = (descriptor3, minimum, maximum, path) => {
    if (descriptor3 === void 0) return void 0;
    const source = dense3(descriptor3.value, 3, path);
    if (source.length !== 3) fail9(`${path} must contain exactly [min, max, feather]`);
    const min = number2(source[0], minimum, maximum, `${path}[0]`);
    const max = number2(source[1], minimum, maximum, `${path}[1]`);
    const feather = number2(source[2], 0, maximum - minimum, `${path}[2]`);
    if (max < min) fail9(`${path}[1] must be at least ${path}[0]`);
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
    if (rules[index - 1].role >= rules[index].role) fail9(`${label} must be strictly role-sorted and unique`);
  }
}
function parseSurfaceRules(value, definition2, label) {
  const declared = new Set(definition2.surfaceMaterials.map((entry) => entry.role));
  const rules = dense3(value, BIOME_RUNTIME_PACK_LIMITS.surfaceRules, label).map((entry, index) => {
    const path = `${label}[${index}]`;
    const d = record3(entry, /* @__PURE__ */ new Set(["role", "weight", "tileScaleM"]), /* @__PURE__ */ new Set(["calibration", "environment"]), path);
    const role = string4(d.role.value, REF4, BIOME_RUNTIME_PACK_LIMITS.idChars, `${path}.role`);
    if (!declared.has(role)) fail9(`${path}.role '${role}' is not declared by biome '${definition2.id}'`);
    return Object.freeze({
      role,
      weight: number2(d.weight.value, 0, BIOME_RUNTIME_PACK_LIMITS.weight, `${path}.weight`, true),
      tileScaleM: number2(d.tileScaleM.value, 0, BIOME_RUNTIME_PACK_LIMITS.tileScaleM, `${path}.tileScaleM`, true),
      ...d.calibration === void 0 ? {} : { calibration: surfaceCalibration(d.calibration.value, `${path}.calibration`) },
      ...d.environment === void 0 ? {} : { environment: surfaceEnvironment(d.environment.value, `${path}.environment`) }
    });
  });
  if (rules.length < 1) fail9(`${label} must not be empty`);
  assertStrictRoleOrder(rules, label);
  if (rules.length !== declared.size) fail9(`${label} must cover every surface role declared by biome '${definition2.id}'`);
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
    if (!declared.has(role)) fail9(`${path}.role '${role}' is not declared by biome '${definition2.id}'`);
    const tint = dense3(d.tintSrgb.value, 3, `${path}.tintSrgb`);
    if (tint.length !== 3) fail9(`${path}.tintSrgb must contain exactly 3 channels`);
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
  if (rules.length !== declared.size) fail9(`${label} must cover every vegetation role declared by biome '${definition2.id}'`);
  return Object.freeze(rules);
}
function parseBindings(value, declaredKeys, label) {
  const bindings2 = dense3(value, BIOME_RUNTIME_PACK_LIMITS.bindingsPerBiome, label).map((entry, index) => {
    const path = `${label}[${index}]`;
    const d = record3(entry, /* @__PURE__ */ new Set(["kind", "role", "assetId", "contentHash", "licenseId", "sourceUri"]), /* @__PURE__ */ new Set(), path);
    if (!BIOME_RUNTIME_BINDING_KINDS.includes(d.kind.value)) fail9(`${path}.kind is unsupported`);
    const role = string4(d.role.value, REF4, BIOME_RUNTIME_PACK_LIMITS.idChars, `${path}.role`);
    const key = `${d.kind.value}:${role}`;
    if (!declaredKeys.has(key)) fail9(`${path} targets undeclared runtime rule '${key}'`);
    return Object.freeze({
      kind: d.kind.value,
      role,
      assetId: string4(d.assetId.value, REF4, BIOME_RUNTIME_PACK_LIMITS.idChars, `${path}.assetId`),
      contentHash: string4(d.contentHash.value, HASH5, 71, `${path}.contentHash`),
      licenseId: text3(d.licenseId.value, BIOME_RUNTIME_PACK_LIMITS.labelChars, `${path}.licenseId`),
      sourceUri: text3(d.sourceUri.value, BIOME_RUNTIME_PACK_LIMITS.uriChars, `${path}.sourceUri`)
    });
  });
  for (let index = 1; index < bindings2.length; index++) {
    const previous = `${bindings2[index - 1].kind}:${bindings2[index - 1].role}`;
    const current = `${bindings2[index].kind}:${bindings2[index].role}`;
    if (previous >= current) fail9(`${label} must be strictly kind/role-sorted and unique`);
  }
  return Object.freeze(bindings2);
}
function fulfillmentStatus(bound, required) {
  if (bound === 0) return "metadata-only";
  return bound === required ? "fulfilled" : "partial";
}
function parseBiomeEntry(value, definition2, label) {
  const d = record3(value, /* @__PURE__ */ new Set(["biomeId", "status", "surfaceRules", "vegetationRules", "bindings"]), /* @__PURE__ */ new Set(), label);
  const biomeId = string4(d.biomeId.value, ID4, 64, `${label}.biomeId`);
  if (biomeId !== definition2.id) fail9(`${label}.biomeId does not match its metadata definition`);
  const surfaceRules = parseSurfaceRules(d.surfaceRules.value, definition2, `${label}.surfaceRules`);
  const vegetationRules = parseVegetationRules(d.vegetationRules.value, definition2, `${label}.vegetationRules`);
  const declaredKeys = /* @__PURE__ */ new Set([
    ...surfaceRules.map((entry) => `surface:${entry.role}`),
    ...vegetationRules.map((entry) => `vegetation:${entry.role}`)
  ]);
  const bindings2 = parseBindings(d.bindings.value, declaredKeys, `${label}.bindings`);
  const status = fulfillmentStatus(bindings2.length, declaredKeys.size);
  if (!BIOME_RUNTIME_FULFILLMENT_STATES.includes(d.status.value)) fail9(`${label}.status is unsupported`);
  if (d.status.value !== status) fail9(`${label}.status must be '${status}' for its declared bindings`);
  return Object.freeze({ biomeId, status, surfaceRules, vegetationRules, bindings: bindings2 });
}
function parseBiomeRuntimePack(value, metadataPackValue) {
  const metadataPack = parseBiomePack(metadataPackValue);
  const metadataPackHash = biomePackContentHash(metadataPack);
  const d = record3(value, /* @__PURE__ */ new Set(["schema", "id", "version", "metadataPackContentHash", "status", "biomes"]), /* @__PURE__ */ new Set(), "biome runtime pack");
  if (d.schema.value !== BIOME_RUNTIME_PACK_SCHEMA) fail9(`biome runtime pack.schema must be '${BIOME_RUNTIME_PACK_SCHEMA}'`);
  if (d.metadataPackContentHash.value !== metadataPackHash) fail9("biome runtime pack.metadataPackContentHash does not match the provided metadata pack");
  const definitions2 = new Map(metadataPack.definitions.map((definition2) => [definition2.id, definition2]));
  const source = dense3(d.biomes.value, BIOME_RUNTIME_PACK_LIMITS.biomes, "biome runtime pack.biomes");
  if (source.length < 1) fail9("biome runtime pack.biomes must not be empty");
  const biomes = Object.freeze(source.map((entry, index) => {
    const entryRecord = record3(entry, /* @__PURE__ */ new Set(["biomeId", "status", "surfaceRules", "vegetationRules", "bindings"]), /* @__PURE__ */ new Set(), `biome runtime pack.biomes[${index}]`);
    const biomeId = string4(entryRecord.biomeId.value, ID4, 64, `biome runtime pack.biomes[${index}].biomeId`);
    const definition2 = definitions2.get(biomeId);
    if (definition2 === void 0) fail9(`biome runtime pack references unknown biome '${biomeId}'`);
    return parseBiomeEntry(entry, definition2, `biome runtime pack.biomes[${index}]`);
  }));
  for (let index = 1; index < biomes.length; index++) {
    if (biomes[index - 1].biomeId >= biomes[index].biomeId) fail9("biome runtime pack.biomes must be strictly biomeId-sorted and unique");
  }
  const required = biomes.reduce((sum, biome) => sum + biome.surfaceRules.length + biome.vegetationRules.length, 0);
  const bound = biomes.reduce((sum, biome) => sum + biome.bindings.length, 0);
  const status = fulfillmentStatus(bound, required);
  if (!BIOME_RUNTIME_FULFILLMENT_STATES.includes(d.status.value)) fail9("biome runtime pack.status is unsupported");
  if (d.status.value !== status) fail9(`biome runtime pack.status must be '${status}' for its declared bindings`);
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

// src/browser/derived-runtime-verify.ts
var DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA = "limina.derived-runtime-resource-snapshot/v2";
var MAX_DETACHED_DERIVED_TERRAIN_MESHES = MAX_DERIVED_TERRAIN_RESIDENCY_CHUNKS;
var MAX_DETACHED_DERIVED_TERRAIN_CPU_BYTES = 256 * 1024 * 1024;
var TERRAIN_CHUNK_ARTIFACT_TYPE = "terrain-chunk/v1";
var HASH6 = /^sha256:[0-9a-f]{64}$/;
var DETACHED_DERIVED_POPULATION_PLAN_SCHEMA = "limina.detached-derived-population-plan/v1";
function plain4(value, label) {
  return plainRecord(value, label);
}
function exact4(value, keys, label) {
  exactDataKeys(value, keys, [], label);
}
function dense4(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    throw new TypeError(`${label} must be a bounded standard array`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    throw new TypeError(`${label} must be dense and field-free`);
  }
  return value;
}
function descriptor2(value, label) {
  const record4 = plain4(value, label);
  exact4(record4, ["artifactType", "contentHash", "byteLength", "mediaType"], label);
  if (typeof record4.artifactType !== "string" || typeof record4.mediaType !== "string" || typeof record4.contentHash !== "string" || !HASH6.test(record4.contentHash) || !Number.isSafeInteger(record4.byteLength) || record4.byteLength < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return Object.freeze({
    artifactType: record4.artifactType,
    contentHash: record4.contentHash,
    byteLength: record4.byteLength,
    mediaType: record4.mediaType
  });
}
function sameDescriptor(left, right) {
  return left.artifactType === right.artifactType && left.contentHash === right.contentHash && left.byteLength === right.byteLength && left.mediaType === right.mediaType;
}
function completeUint8(value, label) {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    throw new TypeError(`${label} must be an owned complete Uint8Array`);
  }
  return value;
}
function bindings(value) {
  const record4 = plain4(value, "generated water bindings");
  exact4(record4, ["hydrologyFieldContentHash", "recipeHash", "erosionStageKey", "compilerGraphHash"], "generated water bindings");
  for (const key of Object.keys(record4)) {
    if (typeof record4[key] !== "string" || !HASH6.test(record4[key])) throw new TypeError(`generated water binding '${key}' is invalid`);
  }
  return Object.freeze(record4);
}
function generatedRenderTopology(value) {
  const topology = plain4(value, "generated water render topology");
  if (!Array.isArray(topology.basins) || !Array.isArray(topology.reaches)) {
    throw new TypeError("generated water render topology requires basin and reach arrays");
  }
  return Object.freeze({
    ...topology,
    basins: Object.freeze(topology.basins.map((input, index) => {
      const basin = plain4(input, `generated water render basin ${index}`);
      const footprint = plain4(basin.footprint, `generated water render basin ${index} footprint`);
      return Object.freeze({
        ...basin,
        footprint: Object.freeze({ ...footprint, holes: Object.freeze(Array.isArray(footprint.holes) ? footprint.holes : []) })
      });
    })),
    reaches: Object.freeze([...topology.reaches])
  });
}
function verifyTransferredDerivedRuntimeSnapshot(input) {
  const snapshot = plain4(input, "derived runtime resource snapshot");
  exact4(snapshot, ["schema", "projectId", "branchId", "manifestHash", "source", "manifest", "residency", "chunks", "globals"], "derived runtime resource snapshot");
  if (snapshot.schema !== DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA) throw new Error("derived runtime resource snapshot schema is unsupported");
  const manifest = parseDerivedRevisionManifest(snapshot.manifest);
  if (snapshot.projectId !== manifest.projectId || snapshot.branchId !== manifest.branchId || snapshot.manifestHash !== manifest.manifestHash || compilerContentHash(snapshot.source) !== compilerContentHash(manifest.source)) {
    throw new Error("derived runtime resource snapshot identity disagrees with its manifest");
  }
  const residency = parseDerivedTerrainResidency(snapshot.residency);
  const expectedChunks = selectDerivedTerrainChunks(manifest, residency);
  const entries = dense4(snapshot.chunks, MAX_DETACHED_DERIVED_TERRAIN_MESHES, "derived runtime terrain chunks");
  if (entries.length < 1 || entries.length !== expectedChunks.length) {
    throw new Error("derived runtime terrain residency set is incomplete or exceeds its requested window");
  }
  const manifestChunks = new Map(manifest.chunks.map((chunk) => [chunk.chunkId, chunk]));
  const manifestGlobals = derivedGlobalArtifacts(manifest);
  const manifestBiomeField = manifestGlobals.find((artifact) => artifact.artifactType === BIOME_FIELD_ARTIFACT_TYPE);
  const seenIds = /* @__PURE__ */ new Set(), seenCoords = /* @__PURE__ */ new Set();
  const indexed = [];
  const surfaces = /* @__PURE__ */ new Map();
  const populations = /* @__PURE__ */ new Map();
  const populationChunks = [];
  const populationPlacements = [];
  let populationIdentity = null;
  let retainedCpuBytes = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = plain4(entries[index], `derived runtime terrain chunk ${index}`);
    exact4(entry, ["chunkId", "chunk", "resource"], `derived runtime terrain chunk ${index}`);
    if (typeof entry.chunkId !== "string" || seenIds.has(entry.chunkId)) throw new Error("derived runtime terrain chunks contain duplicate or invalid ids");
    if (entry.chunkId !== expectedChunks[index]?.chunkId) throw new Error("derived runtime terrain chunks do not match requested manifest order");
    const canonical = manifestChunks.get(entry.chunkId);
    if (canonical === void 0 || compilerContentHash(entry.chunk) !== compilerContentHash(canonical)) {
      throw new Error(`derived runtime terrain chunk '${entry.chunkId}' identity does not match its manifest`);
    }
    const coordinate = `${canonical.lod}:${canonical.tx}:${canonical.tz}`;
    if (seenCoords.has(coordinate)) throw new Error(`derived runtime terrain coordinate '${coordinate}' is duplicated`);
    if (canonical.artifacts.length < 1 || canonical.artifacts.length > 3) {
      throw new Error(`derived terrain chunk '${canonical.chunkId}' must carry terrain and at most one surface and population artifact`);
    }
    const artifactByType = new Map(canonical.artifacts.map((artifact2) => [artifact2.artifactType, artifact2]));
    if (artifactByType.size !== canonical.artifacts.length || [...artifactByType.keys()].some((type) => type !== TERRAIN_CHUNK_ARTIFACT_TYPE && type !== SURFACE_COMPOSITE_ARTIFACT_TYPE && type !== BIOME_POPULATION_ARTIFACT_TYPE)) {
      throw new Error(`derived terrain chunk '${canonical.chunkId}' artifact contract is unsupported`);
    }
    const artifact = artifactByType.get(TERRAIN_CHUNK_ARTIFACT_TYPE);
    const surfaceArtifact = artifactByType.get(SURFACE_COMPOSITE_ARTIFACT_TYPE);
    const populationArtifact = artifactByType.get(BIOME_POPULATION_ARTIFACT_TYPE);
    if (artifact === void 0 || artifact.mediaType !== TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE || artifact.byteLength > MAX_TERRAIN_CHUNK_ARTIFACT_BYTES || surfaceArtifact !== void 0 && (surfaceArtifact.mediaType !== SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE || surfaceArtifact.byteLength > MAX_SURFACE_COMPOSITE_ARTIFACT_BYTES) || populationArtifact !== void 0 && (populationArtifact.mediaType !== BIOME_POPULATION_ARTIFACT_MEDIA_TYPE || populationArtifact.byteLength > MAX_BIOME_POPULATION_ARTIFACT_BYTES)) {
      throw new Error(`derived terrain chunk '${canonical.chunkId}' artifact contract is unsupported`);
    }
    if (populationArtifact !== void 0 && surfaceArtifact === void 0) {
      throw new Error(`derived terrain chunk '${canonical.chunkId}' population is missing its surface identity context`);
    }
    const resource = plain4(entry.resource, `derived runtime terrain chunk '${canonical.chunkId}' resource`);
    exact4(
      resource,
      surfaceArtifact === void 0 ? ["kind", "decoded"] : populationArtifact === void 0 ? ["kind", "decoded", "surface", "artifacts"] : ["kind", "decoded", "surface", "population", "artifacts"],
      `derived runtime terrain chunk '${canonical.chunkId}' resource`
    );
    if (resource.kind !== TERRAIN_CHUNK_ARTIFACT_TYPE) throw new Error(`derived terrain chunk '${canonical.chunkId}' resource kind is unsupported`);
    const tile = parseTransferredTerrainTile(resource.decoded, artifact, `derived terrain chunk '${canonical.chunkId}'`);
    assertDerivedTerrainTilePlacement(tile, canonical, manifest.grid);
    retainedCpuBytes += artifact.byteLength;
    if (surfaceArtifact !== void 0) {
      if (manifestBiomeField === void 0) {
        throw new Error(`derived terrain chunk '${canonical.chunkId}' surface is missing its global biome field dependency`);
      }
      const transferredArtifacts = plain4(resource.artifacts, `derived terrain chunk '${canonical.chunkId}' resource artifacts`);
      exact4(
        transferredArtifacts,
        populationArtifact === void 0 ? ["terrain", "surface"] : ["terrain", "surface", "population"],
        `derived terrain chunk '${canonical.chunkId}' resource artifacts`
      );
      const transferredTerrain = descriptor2(transferredArtifacts.terrain, `derived terrain chunk '${canonical.chunkId}' transferred terrain artifact`);
      const transferredSurface = descriptor2(transferredArtifacts.surface, `derived terrain chunk '${canonical.chunkId}' transferred surface artifact`);
      const transferredPopulation = populationArtifact === void 0 ? void 0 : descriptor2(transferredArtifacts.population, `derived terrain chunk '${canonical.chunkId}' transferred population artifact`);
      if (!sameDescriptor(transferredTerrain, artifact) || !sameDescriptor(transferredSurface, surfaceArtifact) || populationArtifact !== void 0 && (transferredPopulation === void 0 || !sameDescriptor(transferredPopulation, populationArtifact))) {
        throw new Error(`derived terrain chunk '${canonical.chunkId}' transferred artifact bindings do not match its manifest`);
      }
      const decodedSurface = resource.surface;
      const canonicalSurfaceBytes = encodeSurfaceCompositeArtifact(decodedSurface);
      if (canonicalSurfaceBytes.byteLength !== surfaceArtifact.byteLength || derivedArtifactContentHash(canonicalSurfaceBytes) !== surfaceArtifact.contentHash) {
        throw new Error(`derived terrain chunk '${canonical.chunkId}' surface does not match its canonical descriptor`);
      }
      const expectedOriginX = manifest.grid.origin[0] + canonical.tx * manifest.grid.chunkSizeM;
      const expectedOriginZ = manifest.grid.origin[1] + canonical.tz * manifest.grid.chunkSizeM;
      if (decodedSurface.coord.tx !== canonical.tx || decodedSurface.coord.tz !== canonical.tz || decodedSurface.coord.lod !== canonical.lod || decodedSurface.source.terrainChunkHash !== artifact.contentHash || decodedSurface.source.biomeFieldHash !== manifestBiomeField.contentHash) {
        throw new Error(`derived terrain chunk '${canonical.chunkId}' surface bindings do not match its terrain, biome field, or coordinate`);
      }
      if (decodedSurface.placement.origin[0] !== expectedOriginX || decodedSurface.placement.origin[1] !== expectedOriginZ || decodedSurface.placement.sizeM !== manifest.grid.chunkSizeM || decodedSurface.placement.origin[0] !== tile.origin[0] - tile.scale[0] / 2 || decodedSurface.placement.origin[1] !== tile.origin[2] - tile.scale[2] / 2) {
        throw new Error(`derived terrain chunk '${canonical.chunkId}' surface placement does not match the manifest grid or terrain tile`);
      }
      const decodedBytes = decodedSurface.maps.albedo.data.byteLength + decodedSurface.maps.normal.data.byteLength + decodedSurface.maps.orm.data.byteLength;
      retainedCpuBytes += decodedBytes;
      surfaces.set(tileKey(canonical.tx, canonical.tz), Object.freeze({ artifact: surfaceArtifact, decoded: decodedSurface }));
      if (populationArtifact !== void 0) {
        if (manifestBiomeField === void 0) {
          throw new Error(`derived terrain chunk '${canonical.chunkId}' population is missing its global biome field dependency`);
        }
        const transferredPopulationResource = plain4(
          resource.population,
          `derived terrain chunk '${canonical.chunkId}' population resource`
        );
        exact4(
          transferredPopulationResource,
          ["plan", "metadata"],
          `derived terrain chunk '${canonical.chunkId}' population resource`
        );
        const metadata = plain4(
          transferredPopulationResource.metadata,
          `derived terrain chunk '${canonical.chunkId}' population metadata`
        );
        exact4(
          metadata,
          ["schema", "artifactType", "mediaType", "version", "byteLength", "contentHash", "storage"],
          `derived terrain chunk '${canonical.chunkId}' population metadata`
        );
        const canonicalPopulationBytes = encodeBiomePopulationArtifact(transferredPopulationResource.plan);
        if (canonicalPopulationBytes.byteLength !== populationArtifact.byteLength || derivedArtifactContentHash(canonicalPopulationBytes) !== populationArtifact.contentHash || metadata.artifactType !== BIOME_POPULATION_ARTIFACT_TYPE || metadata.mediaType !== BIOME_POPULATION_ARTIFACT_MEDIA_TYPE || metadata.schema !== BIOME_POPULATION_ARTIFACT_SCHEMA || metadata.byteLength !== populationArtifact.byteLength || metadata.contentHash !== populationArtifact.contentHash) {
          throw new Error(`derived terrain chunk '${canonical.chunkId}' population does not match its canonical descriptor`);
        }
        const decodedPopulation = decodeBiomePopulationArtifact(canonicalPopulationBytes);
        if (compilerContentHash(metadata) !== compilerContentHash(decodedPopulation.metadata)) {
          throw new Error(`derived terrain chunk '${canonical.chunkId}' population metadata is not canonical`);
        }
        const plan = decodedPopulation.plan;
        if (plan.coord.tx !== canonical.tx || plan.coord.tz !== canonical.tz || plan.coord.lod !== canonical.lod) {
          throw new Error(`derived terrain chunk '${canonical.chunkId}' population coordinate does not match its manifest chunk`);
        }
        if (plan.identity.fieldContentHash !== manifestBiomeField.contentHash || plan.identity.fieldContentHash !== decodedSurface.source.biomeFieldHash) {
          throw new Error(`derived terrain chunk '${canonical.chunkId}' population biome-field identity does not match its publication`);
        }
        if (plan.identity.runtimePackContentHash !== decodedSurface.source.biomePackHash) {
          throw new Error(`derived terrain chunk '${canonical.chunkId}' population runtime-pack identity does not match its surface`);
        }
        if (populationIdentity !== null && (populationIdentity.fieldContentHash !== plan.identity.fieldContentHash || populationIdentity.runtimePackContentHash !== plan.identity.runtimePackContentHash)) {
          throw new Error("derived terrain population chunks do not share one publication identity");
        }
        if (populationIdentity === null) populationIdentity = Object.freeze({ ...plan.identity });
        const parsedPopulation = Object.freeze({ artifact: populationArtifact, plan });
        populations.set(tileKey(canonical.tx, canonical.tz), parsedPopulation);
        populationChunks.push(Object.freeze({
          tx: canonical.tx,
          tz: canonical.tz,
          lod: canonical.lod,
          contentHash: populationArtifact.contentHash,
          placementCount: plan.placements.length
        }));
        populationPlacements.push(...plan.placements);
        retainedCpuBytes += populationArtifact.byteLength;
      }
    }
    if (!Number.isSafeInteger(retainedCpuBytes) || retainedCpuBytes > MAX_DETACHED_DERIVED_TERRAIN_CPU_BYTES) {
      throw new RangeError("derived terrain snapshot exceeds the 256 MiB retained CPU budget");
    }
    seenIds.add(entry.chunkId);
    seenCoords.add(coordinate);
    indexed.push(Object.freeze({ chunk: canonical, tile }));
  }
  const populationPlan = populationIdentity === null ? null : Object.freeze({
    schema: DETACHED_DERIVED_POPULATION_PLAN_SCHEMA,
    identity: populationIdentity,
    chunks: Object.freeze(populationChunks),
    placements: Object.freeze(populationPlacements)
  });
  const globalEntries = dense4(snapshot.globals, 64, "derived runtime globals");
  if (globalEntries.length !== manifestGlobals.length) throw new Error("derived runtime global resource set is incomplete");
  const globals = /* @__PURE__ */ new Map();
  for (let index = 0; index < globalEntries.length; index++) {
    const entry = plain4(globalEntries[index], `derived runtime global ${index}`);
    exact4(entry, ["artifactType", "artifact", "resource"], `derived runtime global ${index}`);
    if (typeof entry.artifactType !== "string" || globals.has(entry.artifactType)) throw new Error("derived runtime globals contain duplicate or invalid types");
    const parsedArtifact = descriptor2(entry.artifact, `derived runtime global '${entry.artifactType}' artifact`);
    const canonical = manifestGlobals.find((artifact) => artifact.artifactType === entry.artifactType);
    if (canonical === void 0 || !sameDescriptor(parsedArtifact, canonical)) throw new Error(`derived runtime global '${entry.artifactType}' identity does not match its manifest`);
    globals.set(entry.artifactType, { artifact: canonical, resource: plain4(entry.resource, `derived runtime global '${entry.artifactType}' resource`) });
  }
  let generatedWater = null;
  let worldOverview = null;
  let navigationIndexBytes = null;
  let biomeField = null;
  const overview = globals.get(WORLD_OVERVIEW_ARTIFACT_TYPE);
  if (overview !== void 0) {
    exact4(overview.resource, ["kind", "decoded"], "world overview resource");
    if (overview.resource.kind !== WORLD_OVERVIEW_ARTIFACT_TYPE) throw new Error("world overview resource kind is unsupported");
    const decodedEnvelope = plain4(overview.resource.decoded, "world overview decoded resource");
    exact4(decodedEnvelope, ["grid", "metadata"], "world overview decoded resource");
    const canonicalBytes = encodeWorldOverviewArtifact(decodedEnvelope.grid);
    if (overview.artifact.mediaType !== WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE || canonicalBytes.byteLength !== overview.artifact.byteLength || derivedArtifactContentHash(canonicalBytes) !== overview.artifact.contentHash) {
      throw new Error("world overview resource does not match its canonical descriptor");
    }
    worldOverview = decodeWorldOverviewArtifact(canonicalBytes);
  }
  const navigation = globals.get(NAVIGATION_INDEX_ARTIFACT_TYPE);
  if (navigation !== void 0) {
    exact4(navigation.resource, ["kind", "bytes"], "navigation index resource");
    if (navigation.resource.kind !== NAVIGATION_INDEX_ARTIFACT_TYPE) throw new Error("navigation index resource kind is unsupported");
    const canonicalBytes = completeUint8(navigation.resource.bytes, "navigation index resource bytes");
    if (navigation.artifact.mediaType !== NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE || canonicalBytes.byteLength !== navigation.artifact.byteLength || derivedArtifactContentHash(canonicalBytes) !== navigation.artifact.contentHash) {
      throw new Error("navigation index resource does not match its canonical descriptor");
    }
    decodeNavigationIndexArtifact(canonicalBytes);
    navigationIndexBytes = canonicalBytes;
  }
  const biome = globals.get(BIOME_FIELD_ARTIFACT_TYPE);
  if (biome !== void 0) {
    exact4(biome.resource, ["kind", "bytes"], "biome field resource");
    if (biome.resource.kind !== BIOME_FIELD_ARTIFACT_TYPE) throw new Error("biome field resource kind is unsupported");
    const canonicalBytes = completeUint8(biome.resource.bytes, "biome field resource bytes");
    if (biome.artifact.mediaType !== BIOME_FIELD_ARTIFACT_MEDIA_TYPE || canonicalBytes.byteLength !== biome.artifact.byteLength || derivedArtifactContentHash(canonicalBytes) !== biome.artifact.contentHash) {
      throw new Error("biome field resource does not match its canonical descriptor");
    }
    biomeField = decodeBiomeFieldArtifact(canonicalBytes);
  }
  let biomeContent = null;
  let biomeRuntimePack = null;
  const content = globals.get(BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE);
  if (content !== void 0) {
    exact4(content.resource, ["kind", "bytes"], "biome content closure resource");
    if (content.resource.kind !== BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE) {
      throw new Error("biome content closure resource kind is unsupported");
    }
    const bytes = completeUint8(content.resource.bytes, "biome content closure resource bytes");
    if (content.artifact.mediaType !== BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE || bytes.byteLength !== content.artifact.byteLength || derivedArtifactContentHash(bytes) !== content.artifact.contentHash) {
      throw new Error("biome content closure resource does not match its canonical descriptor");
    }
    biomeContent = decodeBiomeContentClosureArtifact(bytes).bundle;
  }
  const runtimePackResource = globals.get(BIOME_RUNTIME_PACK_ARTIFACT_TYPE);
  if (runtimePackResource !== void 0) {
    exact4(runtimePackResource.resource, ["kind", "bytes"], "biome runtime-pack resource");
    if (runtimePackResource.resource.kind !== BIOME_RUNTIME_PACK_ARTIFACT_TYPE) throw new Error("biome runtime-pack resource kind is unsupported");
    const bytes = completeUint8(runtimePackResource.resource.bytes, "biome runtime-pack resource bytes");
    if (runtimePackResource.artifact.mediaType !== BIOME_RUNTIME_PACK_ARTIFACT_MEDIA_TYPE || bytes.byteLength !== runtimePackResource.artifact.byteLength || derivedArtifactContentHash(bytes) !== runtimePackResource.artifact.contentHash) {
      throw new Error("biome runtime-pack resource does not match its canonical descriptor");
    }
    const decoded = decodeBiomeRuntimePackArtifact(bytes);
    biomeRuntimePack = Object.freeze({ bytes, semanticContentHash: decoded.semanticContentHash });
  }
  const water = globals.get(HYDROLOGY_WATER_ARTIFACT_TYPE);
  const hydrologyField = globals.get(HYDROLOGY_FIELD_ARTIFACT_TYPE);
  let renderField = null;
  if (hydrologyField !== void 0) {
    exact4(hydrologyField.resource, ["kind", "decoded"], "hydrology field resource");
    if (hydrologyField.resource.kind !== HYDROLOGY_FIELD_ARTIFACT_TYPE) throw new Error("hydrology field resource kind is unsupported");
    const decoded = plain4(hydrologyField.resource.decoded, "hydrology field decoded resource");
    exact4(decoded, ["placement", "topology", "artifact"], "hydrology field decoded resource");
    const canonicalBytes = encodeHydrologyFieldArtifact(decoded.topology, decoded.placement);
    if (hydrologyField.artifact.mediaType !== HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE || canonicalBytes.byteLength !== hydrologyField.artifact.byteLength || derivedArtifactContentHash(canonicalBytes) !== hydrologyField.artifact.contentHash) {
      throw new Error("hydrology field resource does not match its canonical descriptor");
    }
    const canonical = decodeHydrologyFieldArtifact(canonicalBytes);
    renderField = Object.freeze({
      placement: Object.freeze({ originX: canonical.placement.originX, originZ: canonical.placement.originZ }),
      rows: canonical.topology.rows,
      cols: canonical.topology.cols,
      cellSizeM: canonical.topology.cellSizeM,
      seaLevelM: canonical.topology.seaLevelM,
      oceanMask: canonical.topology.oceanMask
    });
  }
  for (const artifactType of globals.keys()) {
    if (artifactType !== HYDROLOGY_FIELD_ARTIFACT_TYPE && artifactType !== HYDROLOGY_WATER_ARTIFACT_TYPE && artifactType !== WORLD_OVERVIEW_ARTIFACT_TYPE && artifactType !== NAVIGATION_INDEX_ARTIFACT_TYPE && artifactType !== BIOME_FIELD_ARTIFACT_TYPE && artifactType !== BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE && artifactType !== BIOME_RUNTIME_PACK_ARTIFACT_TYPE) {
      throw new Error(`derived render candidate does not support global '${artifactType}'`);
    }
  }
  if (populationPlan !== null) {
    if (biomeContent === null) throw new Error("verified biome population is missing its content closure");
    if (biomeRuntimePack === null) throw new Error("verified biome population is missing its runtime-pack artifact");
    if (biomeContent.runtimePack.contentHash !== populationPlan.identity.runtimePackContentHash) {
      throw new Error("biome content closure runtime-pack identity does not match population plans");
    }
    if (biomeRuntimePack.semanticContentHash !== biomeContent.runtimePack.contentHash) {
      throw new Error("biome runtime-pack artifact semantic identity does not match its content closure");
    }
    const authorized = new Map(biomeContent.entries.map((entry) => [entry.assetId, entry]));
    for (const placement of populationPlan.placements) {
      const entry = authorized.get(placement.assetId);
      if (entry?.kind !== "population-descriptor" || entry.contentHash !== placement.contentHash) {
        throw new Error(`biome population descriptor '${placement.assetId}' is not authorized by its content closure`);
      }
    }
  }
  if (water !== void 0) {
    const field = hydrologyField;
    if (field === void 0) throw new Error("generated water is missing its hydrology field dependency");
    exact4(water.resource, ["kind", "artifact", "bytes", "bindings", "prepared"], "generated water resource");
    if (water.resource.kind !== HYDROLOGY_WATER_ARTIFACT_TYPE) throw new Error("generated water resource kind is unsupported");
    const resourceArtifact = descriptor2(water.resource.artifact, "generated water resource artifact");
    if (!sameDescriptor(resourceArtifact, water.artifact) || resourceArtifact.mediaType !== HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE) {
      throw new Error("generated water resource artifact does not match its manifest descriptor");
    }
    const bytes = completeUint8(water.resource.bytes, "generated water resource bytes");
    if (bytes.byteLength !== resourceArtifact.byteLength || derivedArtifactContentHash(bytes) !== resourceArtifact.contentHash) {
      throw new Error("generated water resource bytes do not match their canonical descriptor");
    }
    const parsedBindings = bindings(water.resource.bindings);
    const rawBindings = inspectHydrologyWaterArtifactBindings(bytes);
    if (compilerContentHash(parsedBindings) !== compilerContentHash(rawBindings) || parsedBindings.hydrologyFieldContentHash !== field.artifact.contentHash || parsedBindings.compilerGraphHash !== derivedArtifactCompilerGraphHash(manifest, HYDROLOGY_WATER_ARTIFACT_TYPE)) {
      throw new Error("generated water resource bindings do not match its bytes, field, or compiler graph");
    }
    const prepared = plain4(water.resource.prepared, "generated water prepared resource");
    exact4(prepared, ["artifactContentHash", "bindings", "topology"], "generated water prepared resource");
    if (prepared.artifactContentHash !== resourceArtifact.contentHash || compilerContentHash(prepared.bindings) !== compilerContentHash(parsedBindings)) {
      throw new Error("generated water prepared identity does not match its canonical artifact");
    }
    generatedWater = Object.freeze({
      artifact: resourceArtifact,
      bytes,
      bindings: parsedBindings,
      topology: generatedRenderTopology(prepared.topology),
      field: renderField
    });
  }
  return Object.freeze({
    manifest,
    residency,
    indexed: Object.freeze(indexed),
    surfaces: Object.freeze([...surfaces.entries()].map(([key, value]) => Object.freeze([key, value]))),
    populations: Object.freeze([...populations.entries()].map(([key, value]) => Object.freeze([key, value]))),
    populationPlan,
    biomeContent,
    biomeRuntimePack,
    retainedCpuBytes,
    worldOverview,
    navigationIndexBytes,
    biomeField,
    generatedWater
  });
}
function collectDerivedSnapshotTransferables(value) {
  const buffers = /* @__PURE__ */ new Set();
  const seen = /* @__PURE__ */ new Set();
  const visit = (node) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (node instanceof ArrayBuffer) {
      buffers.add(node);
      return;
    }
    if (ArrayBuffer.isView(node)) {
      if (node.buffer instanceof ArrayBuffer) buffers.add(node.buffer);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (node instanceof Map) {
      for (const [key, entry] of node) {
        visit(key);
        visit(entry);
      }
      return;
    }
    if (node instanceof Set) {
      for (const entry of node) visit(entry);
      return;
    }
    for (const key of Object.getOwnPropertyNames(node)) {
      const field = Object.getOwnPropertyDescriptor(node, key);
      if (field !== void 0 && "value" in field) visit(field.value);
    }
  };
  visit(value);
  return [...buffers];
}
var DERIVED_VERIFY_WORKER_SCHEMA = "limina.derived-verify-worker/v1";
var MAX_VERIFY_ERROR_MESSAGE_LENGTH = 2048;
function shortVerifyError(error) {
  const errorName = error instanceof RangeError ? "RangeError" : error instanceof TypeError ? "TypeError" : "Error";
  const raw = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    errorName,
    errorMessage: raw.length <= MAX_VERIFY_ERROR_MESSAGE_LENGTH ? raw : `${raw.slice(0, MAX_VERIFY_ERROR_MESSAGE_LENGTH - 3)}...`
  });
}
function createDerivedVerifyWorkerController(post) {
  if (typeof post !== "function") throw new TypeError("derived verify worker post must be a function");
  return (message) => {
    const requestId = message !== null && typeof message === "object" && Number.isSafeInteger(message.requestId) ? message.requestId : null;
    try {
      const record4 = plainRecord(message, "derived verify request");
      exactDataKeys(record4, ["schema", "type", "requestId", "snapshot"], [], "derived verify request");
      if (record4.schema !== DERIVED_VERIFY_WORKER_SCHEMA || record4.type !== "verify" || requestId === null) {
        throw new TypeError("derived verify request envelope is invalid");
      }
      const verification = verifyTransferredDerivedRuntimeSnapshot(record4.snapshot);
      post(
        { schema: DERIVED_VERIFY_WORKER_SCHEMA, type: "verified", requestId, verification },
        collectDerivedSnapshotTransferables(verification)
      );
    } catch (error) {
      post({ schema: DERIVED_VERIFY_WORKER_SCHEMA, type: "verify-rejected", requestId, ...shortVerifyError(error) });
    }
  };
}
function installDerivedVerifyWorker(scope) {
  const handle = createDerivedVerifyWorkerController((message, transfer) => scope.postMessage(message, transfer));
  scope.onmessage = (event) => handle(event.data);
}

// src/browser/derived-verify-worker-entry.ts
if (typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope) {
  installDerivedVerifyWorker(self);
}
