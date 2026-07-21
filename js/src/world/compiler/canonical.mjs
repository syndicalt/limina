import { sha256 } from "../sha256.mjs";

export const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const DEFAULT_CANONICAL_MAX_BYTES = 1024 * 1024;
export const DEFAULT_CANONICAL_MAX_DEPTH = 32;
export const DEFAULT_CANONICAL_MAX_NODES = 100_000;
export const DEFAULT_CANONICAL_MAX_PROPERTIES = 4_096;
export const DEFAULT_CANONICAL_MAX_ARRAY_LENGTH = 65_536;

export function compilerUtf8ByteLength(input) {
  if (typeof input !== "string") throw new Error("compiler UTF-8 byte length input must be a string");
  let bytes = 0;
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < input.length) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; }
      else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Strict, bounded JSON canonicalization for compiler configs/manifests. */
export function canonicalCompilerJson(value, limits = {}) {
  const maxBytes = limits.maxBytes ?? DEFAULT_CANONICAL_MAX_BYTES;
  const maxDepth = limits.maxDepth ?? DEFAULT_CANONICAL_MAX_DEPTH;
  const maxNodes = limits.maxNodes ?? DEFAULT_CANONICAL_MAX_NODES;
  const maxProperties = limits.maxProperties ?? DEFAULT_CANONICAL_MAX_PROPERTIES;
  const maxArrayLength = limits.maxArrayLength ?? DEFAULT_CANONICAL_MAX_ARRAY_LENGTH;
  for (const [name, limit] of Object.entries({ maxBytes, maxDepth, maxNodes, maxProperties, maxArrayLength })) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`compiler canonical ${name} must be a positive safe integer`);
  }

  const active = new Set();
  let nodes = 0;
  const visit = (input, path, depth) => {
    if (++nodes > maxNodes) throw new Error(`compiler canonical value exceeds ${maxNodes} nodes`);
    if (depth > maxDepth) throw new Error(`compiler canonical value exceeds depth ${maxDepth} at ${path}`);
    if (input === null) return "null";
    switch (typeof input) {
      case "boolean": return input ? "true" : "false";
      case "string": return JSON.stringify(input);
      case "number":
        if (!Number.isFinite(input)) throw new Error(`compiler canonical number at ${path} must be finite`);
        return Object.is(input, -0) ? "0" : JSON.stringify(input);
      case "object": break;
      default: throw new Error(`compiler canonical value at ${path} is outside the JSON domain`);
    }

    if (active.has(input)) throw new Error(`compiler canonical value contains a cycle at ${path}`);
    active.add(input);
    try {
      if (Array.isArray(input)) {
        if (input.length > maxArrayLength) throw new Error(`compiler canonical array at ${path} exceeds ${maxArrayLength} entries`);
        const names = Object.getOwnPropertyNames(input);
        const expected = new Set(["length", ...Array.from({ length: input.length }, (_, index) => String(index))]);
        if (names.some((name) => !expected.has(name)) || Object.getOwnPropertySymbols(input).length > 0) {
          throw new Error(`compiler canonical array at ${path} has custom properties`);
        }
        const items = [];
        for (let index = 0; index < input.length; index++) {
          if (!Object.prototype.hasOwnProperty.call(input, index)) throw new Error(`compiler canonical array at ${path} is sparse`);
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (descriptor?.get !== undefined || descriptor?.set !== undefined || descriptor?.enumerable !== true) {
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
        if (descriptor?.get !== undefined || descriptor?.set !== undefined || descriptor?.enumerable !== true) {
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

export function compilerContentHash(value, limits = {}) {
  return `sha256:${sha256(canonicalCompilerJson(value, limits))}`;
}

export function validateCompilerContentHash(value, label = "compiler content hash") {
  if (typeof value !== "string" || !CONTENT_HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase sha256 content hash`);
  }
  return value;
}

export function cloneCanonicalCompilerJson(value, limits = {}) {
  return JSON.parse(canonicalCompilerJson(value, limits));
}
