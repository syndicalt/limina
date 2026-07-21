// Canonical MapDoc serialization shared by Atlas persistence and the pure compiler.
// The trailing LF is part of the content-addressed source identity.

export const MAX_CANONICAL_MAPDOC_BYTES = 16 * 1024 * 1024;
const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_NODES = 2_000_000;
const MAX_CANONICAL_ARRAY_LENGTH = 1_000_000;

function utf8ByteLength(value) {
  let length = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) length++;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      length += 4;
      index++;
    } else length += 3;
  }
  return length;
}

function canonicalValue(value, path, active, budget, depth) {
  if (++budget.nodes > MAX_CANONICAL_NODES) throw new Error(`canonical JSON exceeds ${MAX_CANONICAL_NODES} values`);
  if (depth > MAX_CANONICAL_DEPTH) throw new Error(`canonical JSON exceeds depth ${MAX_CANONICAL_DEPTH}`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a finite JSON number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new Error(`${path} is not a JSON value`);
  if (active.has(value)) throw new Error(`${path} contains a cycle`);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_CANONICAL_ARRAY_LENGTH) throw new Error(`${path} exceeds ${MAX_CANONICAL_ARRAY_LENGTH} array entries`);
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
        throw new Error(`${path} contains a custom array`);
      }
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || !names.includes("length")) throw new Error(`${path} contains sparse or custom array entries`);
      const output = new Array(value.length);
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true) {
          throw new Error(`${path}[${index}] must be an enumerable data property`);
        }
        output[index] = canonicalValue(descriptor.value, `${path}[${index}]`, active, budget, depth + 1);
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain JSON object`);
    if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${path} contains symbol properties`);
    const output = Object.create(null);
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true) {
        throw new Error(`${path}.${key} must be an enumerable data property`);
      }
      output[key] = canonicalValue(descriptor.value, `${path}.${key}`, active, budget, depth + 1);
    }
    return output;
  } finally {
    active.delete(value);
  }
}

export function canonicalJsonText(value) {
  return JSON.stringify(canonicalValue(value, "$", new Set(), { nodes: 0 }, 0));
}

export function canonicalMapDocText(value) {
  const text = `${canonicalJsonText(value)}\n`;
  const bytes = utf8ByteLength(text);
  if (bytes > MAX_CANONICAL_MAPDOC_BYTES) throw new Error(`canonical MapDoc exceeds ${MAX_CANONICAL_MAPDOC_BYTES} bytes`);
  return text;
}
