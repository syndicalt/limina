// Durable identity for an Atlas-authored subject. This module is dependency-free so the map
// compiler, Node tooling, engine, and browser protocol can share one hostile-input boundary.

export const ATLAS_DESIGN_REF_SCHEMA = "limina.atlas-design-ref/v1";
export const ATLAS_DESIGN_REF_KINDS = Object.freeze(["feature", "marker", "place", "stamp"]);
export const MAX_ATLAS_DESIGN_REF_IDENTIFIER_CHARS = 128;
export const MAX_DESIGN_INDEX_ENTRIES = 100_000;

const KIND_SET = new Set(ATLAS_DESIGN_REF_KINDS);
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const DESIGN_REF_FIELDS = new Set(["schema", "mapId", "kind", "id"]);

function invalid(message) {
  const error = new TypeError(message);
  error.code = "INVALID_ATLAS_DESIGN_REF";
  return error;
}

function boundedIdentifier(value, label) {
  if (typeof value !== "string" || value.length < 1
      || value.length > MAX_ATLAS_DESIGN_REF_IDENTIFIER_CHARS
      || value.trim().length < 1 || CONTROL_CHAR.test(value)) {
    throw invalid(`${label} must contain 1-${MAX_ATLAS_DESIGN_REF_IDENTIFIER_CHARS} printable characters`);
  }
  return value;
}

/** Parse an exact plain-data Atlas design reference. Unknown/accessor/symbol fields are rejected. */
export function parseAtlasDesignRef(input) {
  if (input === null || Array.isArray(input) || typeof input !== "object") {
    throw invalid("Atlas designRef must be a plain object");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid("Atlas designRef must be a plain object");
  }
  if (Object.getOwnPropertySymbols(input).length !== 0) {
    throw invalid("Atlas designRef fields are invalid");
  }
  const names = Object.getOwnPropertyNames(input);
  if (names.length !== DESIGN_REF_FIELDS.size || names.some((name) => !DESIGN_REF_FIELDS.has(name))) {
    throw invalid("Atlas designRef fields are invalid");
  }
  const fields = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (descriptor?.enumerable !== true || !("value" in descriptor)) {
      throw invalid(`Atlas designRef.${name} must be an enumerable data field`);
    }
    fields[name] = descriptor.value;
  }
  if (fields.schema !== ATLAS_DESIGN_REF_SCHEMA) {
    throw invalid("Atlas designRef.schema is invalid");
  }
  if (typeof fields.kind !== "string" || !KIND_SET.has(fields.kind)) {
    throw invalid("Atlas designRef.kind is invalid");
  }
  return Object.freeze({
    schema: ATLAS_DESIGN_REF_SCHEMA,
    mapId: boundedIdentifier(fields.mapId, "Atlas designRef.mapId"),
    kind: fields.kind,
    id: boundedIdentifier(fields.id, "Atlas designRef.id"),
  });
}

/** Unambiguous canonical lookup key; JSON encoding avoids delimiter-collision schemes. */
export function atlasDesignRefKey(input) {
  const ref = parseAtlasDesignRef(input);
  return JSON.stringify([ref.schema, ref.mapId, ref.kind, ref.id]);
}
