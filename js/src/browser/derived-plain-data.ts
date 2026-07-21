/**
 * Shared fail-closed plain-data validators for the derived-* seams (worker protocol, transport
 * payloads, transferred snapshots, residency, terrain index). Every seam enforces one shape
 * contract — own enumerable data fields only, no symbols, no accessors, plain Object prototype —
 * and the contract must not fork per file; only the thrown error type is seam-specific, so each
 * caller binds its own factory. Bundled into both the main runtime and the derived-runtime worker
 * entry: this module must stay dependency-free.
 */

export type PlainDataErrorFactory = (message: string) => Error;

const typeError: PlainDataErrorFactory = (message) => new TypeError(message);

export function plainRecord(
  value: unknown,
  label: string,
  error: PlainDataErrorFactory = typeError,
): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

export function exactDataKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
  error: PlainDataErrorFactory = typeError,
): void {
  const allowed = new Set([...required, ...optional]);
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || required.some((key) => !names.includes(key))
      || names.some((key) => !allowed.has(key))) {
    throw error(`${label} has unsupported or missing fields`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw error(`${label}.${name} must be an enumerable data field`);
    }
  }
}
