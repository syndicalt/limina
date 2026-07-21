import { AuthoringError } from "./errors.ts";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Sha256Function = (canonicalUtf8: string) => string;
export type ContentHash = `sha256:${string}`;

const SHA256_RE = /^(?:sha256:)?([0-9a-fA-F]{64})$/;

function reject(path: string, reason: string): never {
  throw new AuthoringError("invalid_transaction", `non-canonical value at ${path}: ${reason}`, { path, reason });
}

/**
 * Serialize the supported JSON value domain without depending on object insertion order.
 *
 * Rules are intentionally stricter than JSON.stringify: only plain objects and dense arrays are
 * accepted; accessors, symbols, non-enumerable fields, custom array properties, cycles,
 * undefined, non-finite numbers, functions, bigint, and non-plain prototypes are rejected.
 * Object keys are ordered by UTF-16 code units. Strings are preserved byte-for-byte (no Unicode
 * normalization), while -0 is normalized to 0 as required by JSON's number domain.
 */
export function canonicalStringify(value: JsonValue | unknown): string {
  const active = new Set<object>();

  const visit = (input: unknown, path: string): string => {
    if (input === null) return "null";
    switch (typeof input) {
      case "boolean":
        return input ? "true" : "false";
      case "string":
        return JSON.stringify(input);
      case "number":
        if (!Number.isFinite(input)) reject(path, "numbers must be finite");
        return Object.is(input, -0) ? "0" : JSON.stringify(input);
      case "undefined":
      case "function":
      case "symbol":
      case "bigint":
        reject(path, `${typeof input} is outside the JSON value domain`);
      case "object":
        break;
      default:
        reject(path, `unsupported value type ${typeof input}`);
    }

    const object = input as object;
    if (active.has(object)) reject(path, "cyclic references are not supported");
    active.add(object);
    try {
      if (Array.isArray(object)) {
        const names = Object.getOwnPropertyNames(object);
        for (let index = 0; index < object.length; index++) {
          if (!Object.prototype.hasOwnProperty.call(object, index)) {
            reject(`${path}[${index}]`, "sparse arrays are not supported");
          }
          const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
          if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
            reject(`${path}[${index}]`, "array accessors are not supported");
          }
          if (!descriptor.enumerable) reject(`${path}[${index}]`, "non-enumerable array entries are not supported");
        }
        const expectedNames = new Set(["length", ...Array.from({ length: object.length }, (_, index) => String(index))]);
        if (names.some((name) => !expectedNames.has(name)) || Object.getOwnPropertySymbols(object).length > 0) {
          reject(path, "custom array properties are not supported");
        }
        return `[${object.map((entry, index) => visit(entry, `${path}[${index}]`)).join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) {
        reject(path, "only plain objects are supported");
      }
      if (Object.getOwnPropertySymbols(object).length > 0) reject(path, "symbol keys are not supported");

      const names = Object.getOwnPropertyNames(object);
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(object, name);
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          reject(`${path}.${name}`, "object accessors are not supported");
        }
        if (!descriptor.enumerable) reject(`${path}.${name}`, "non-enumerable properties are not supported");
      }
      names.sort();
      const record = object as Record<string, unknown>;
      return `{${names.map((name) => `${JSON.stringify(name)}:${visit(record[name], `${path}.${name}`)}`).join(",")}}`;
    } finally {
      active.delete(object);
    }
  };

  return visit(value, "$");
}

/** UTF-8 byte size without relying on Node or browser globals. Lone surrogates count as U+FFFD. */
export function utf8ByteLength(input: string): number {
  let bytes = 0;
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < input.length) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Normalize a host SHA-256 result to Limina's content-hash wire form. */
export function normalizeSha256(value: string): ContentHash {
  const match = SHA256_RE.exec(value);
  if (match === null) {
    throw new AuthoringError("invalid_hash", "SHA-256 provider returned an invalid digest", { digest: value });
  }
  return `sha256:${match[1].toLowerCase()}`;
}

export function canonicalHash(sha256: Sha256Function, value: JsonValue | unknown): ContentHash {
  return normalizeSha256(sha256(canonicalStringify(value)));
}

export function isContentHash(value: string): value is ContentHash {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}
