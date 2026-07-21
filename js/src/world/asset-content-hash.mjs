// Portable form of the engine AssetRegistry address. AssetRegistry historically feeds the
// lowercase hexadecimal representation of raw bytes to op_sha256 because the host operation accepts
// strings. Derived compilers/workers cannot depend on host ops, so they use the exact same mapping
// through Limina's dependency-free SHA-256 implementation.

import { sha256 } from "./sha256.mjs";

const HEX = Object.freeze(Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0")));

export function portableAssetContentHash(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("asset content hash requires Uint8Array bytes");
  let encoded = "";
  // Chunk the concatenation so large GLBs do not create a quadratic chain of intermediate strings.
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    const end = Math.min(bytes.length, offset + 16_384);
    encoded = "";
    for (let index = offset; index < end; index++) encoded += HEX[bytes[index]];
    chunks.push(encoded);
  }
  return `sha256:${sha256(chunks.join(""))}`;
}
