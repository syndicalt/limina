// Small global authorization artifact for revision-scoped biome content. Heavy descriptor/model
// bytes live in the publisher's content-addressed store; this canonical JSON closure is the only
// authority the runtime may use to fetch them.

import {
  BIOME_CONTENT_BUNDLE_LIMITS,
  parseBiomeContentBundle,
  stableStringifyBiomeContentBundle,
} from "../biome-content-bundle.mjs";
import { derivedArtifactContentHash } from "./manifest.mjs";

export const BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE = "biome-content-closure/v1";
export const BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.biome-content-bundle-v1+json";
export const MAX_BIOME_CONTENT_CLOSURE_ARTIFACT_BYTES = BIOME_CONTENT_BUNDLE_LIMITS.canonicalBytes + 1;

export class BiomeContentClosureArtifactError extends Error {
  constructor(message) { super(message); this.name = "BiomeContentClosureArtifactError"; }
}

export class BiomeContentClosureArtifactCancelledError extends Error {
  constructor() { super("biome content closure artifact operation cancelled"); this.name = "BiomeContentClosureArtifactCancelledError"; }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function cancel(control) {
  if (control !== undefined && (control === null || typeof control !== "object" || Array.isArray(control)
      || Object.getPrototypeOf(control) !== Object.prototype || Object.keys(control).join() !== "shouldCancel"
      || typeof control.shouldCancel !== "function")) {
    throw new BiomeContentClosureArtifactError("biome content closure artifact control must contain exactly shouldCancel");
  }
  if (control?.shouldCancel() === true) throw new BiomeContentClosureArtifactCancelledError();
}

function ownedBytes(value) {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)
      || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    throw new BiomeContentClosureArtifactError("biome content closure artifact bytes must be an owned complete Uint8Array");
  }
  if (value.byteLength < 2 || value.byteLength > MAX_BIOME_CONTENT_CLOSURE_ARTIFACT_BYTES) {
    throw new BiomeContentClosureArtifactError("biome content closure artifact byte length is outside its bounded range");
  }
  return value;
}

export function encodeBiomeContentClosureArtifact(bundle, control) {
  cancel(control);
  const bytes = encoder.encode(`${stableStringifyBiomeContentBundle(bundle)}\n`);
  if (bytes.byteLength > MAX_BIOME_CONTENT_CLOSURE_ARTIFACT_BYTES) {
    throw new BiomeContentClosureArtifactError("biome content closure artifact exceeds its byte cap");
  }
  cancel(control);
  return bytes;
}

export function decodeBiomeContentClosureArtifact(input, control) {
  const bytes = ownedBytes(input);
  cancel(control);
  let text;
  try { text = decoder.decode(bytes); }
  catch (error) { throw new BiomeContentClosureArtifactError(`biome content closure artifact is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`); }
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
    throw new BiomeContentClosureArtifactError("biome content closure artifact must be one canonical JSON line");
  }
  let source;
  try { source = JSON.parse(text.slice(0, -1)); }
  catch (error) { throw new BiomeContentClosureArtifactError(`biome content closure artifact JSON is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  let bundle;
  try { bundle = parseBiomeContentBundle(source); }
  catch (error) { throw new BiomeContentClosureArtifactError(`biome content closure artifact bundle is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  const canonical = encodeBiomeContentClosureArtifact(bundle, control);
  if (canonical.byteLength !== bytes.byteLength || !canonical.every((value, index) => value === bytes[index])) {
    throw new BiomeContentClosureArtifactError("biome content closure artifact is not canonical");
  }
  cancel(control);
  return Object.freeze({ bundle, metadata: Object.freeze({
    artifactType: BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
    mediaType: BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE,
    contentHash: derivedArtifactContentHash(bytes),
    byteLength: bytes.byteLength,
  }) });
}

export function biomeContentClosureArtifactContentHash(bytes) {
  return decodeBiomeContentClosureArtifact(bytes).metadata.contentHash;
}
