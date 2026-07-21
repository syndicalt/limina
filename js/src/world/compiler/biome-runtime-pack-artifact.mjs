import { BIOME_LIBRARY_V1 } from "../biome-library-v1.mjs";
import { biomeRuntimePackContentHash, parseBiomeRuntimePack } from "../biome-runtime-pack.mjs";

export const BIOME_RUNTIME_PACK_ARTIFACT_TYPE = "biome-runtime-pack/v1";
export const BIOME_RUNTIME_PACK_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.biome-runtime-pack+json";
export const MAX_BIOME_RUNTIME_PACK_ARTIFACT_BYTES = 4 * 1024 * 1024;

/** Runtime-pack artifact bytes are the exact source-fenced JSON bytes. Semantic identity is
 * re-derived after strict parsing so transport identity and biome authority cannot be confused. */
export function decodeBiomeRuntimePackArtifact(bytes) {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)
      || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength
      || bytes.byteLength < 2 || bytes.byteLength > MAX_BIOME_RUNTIME_PACK_ARTIFACT_BYTES) {
    throw new TypeError("biome runtime-pack artifact must be an owned bounded Uint8Array");
  }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) { throw new Error(`biome runtime-pack artifact JSON is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  const runtimePack = parseBiomeRuntimePack(parsed, BIOME_LIBRARY_V1);
  return Object.freeze({ runtimePack, semanticContentHash: biomeRuntimePackContentHash(runtimePack, BIOME_LIBRARY_V1) });
}
