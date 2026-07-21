import { ops } from "../src/engine.ts";
import { sha256 } from "../src/world/sha256.mjs";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_sha256_bytes FAIL: ${message}`);
}

const boundaryVectors = new Map<number, string>([
  [0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  [1, "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a"],
  [55, "86bdf1401483a3d48aa0b853de242db9073b3e9e190bd1c8073abf0eba3d3ea7"],
  [56, "3682950d356858453c48a040cf03790b27a8a5bb541df1c7b2741140f1ca041d"],
  [63, "308f063ec4dcb7154b236d356430791a13a7b3001d6a375dcfd686368c68950f"],
  [64, "197a5d2e6d3bc917955f5c5f4fd66bf316cb07ee58f6110a730c08c11b5563e0"],
  [65, "0e0450689e33dcf6ce90264391ad6f82e0efe546579e57c0fe8dc759a37fe26a"],
  [119, "de55d54be9f6c0db65425d6e308db6ba9e8eea6e35b070e2dcd39919b668ff9c"],
  [120, "033f2213655dffe41d5824f3babf21b7f7dcb731d1c6ff1835b4937b2a16db00"],
  [127, "e11b02085cb403ba057be515f657dd7ccd525faa3f46eea4f3c1b80e1e0afc07"],
  [128, "22a665a43655bc61baeb62241a1bb247b0d8ce7c6352dbcbb035e73b99c310b2"],
  [129, "2b663e72b7901994a87ff501473d3e796cca3fe69e39bdcb0419ef4c70d69003"],
  [1024, "9beebd1abedb9a07cb93075e59b7e7372b4259f4085e2d0cefef51232bd991c7"],
]);

for (const [length, expected] of boundaryVectors) {
  const bytes = Uint8Array.from({ length }, (_unused, index) => (index * 131 + length) & 0xff);
  assert(sha256(bytes) === expected, `raw-byte vector mismatch at ${length} bytes`);
}

const stringVectors = new Map<string, string>([
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ["Limina", "688a4e70bdf656b647901a7b489300c012a503ec38e411bd7e29c44892ef51ef"],
  ["Aethon 🌍", "60d9b55351de3e766119652a94a2e8b93fdc099733e216f08a0a30c510c48eb7"],
  // Preserve the existing hand-encoder contract for lone UTF-16 surrogates.
  ["\ud800", "91a681b998555fb475479817b126c94e57e52011fa1842c5d188795a4a05226b"],
  ["\udc00", "b2d612a08bec1f41120ebd961f62ef19678375b5788c70d3f8f4c02e345ed412"],
]);
for (const [input, expected] of stringVectors) assert(sha256(input) === expected, `UTF-8 vector mismatch for ${JSON.stringify(input)}`);

const large = new Uint8Array(4 * 1024 * 1024);
for (let index = 0; index < large.length; index++) large[index] = (index * 17 + 29) & 0xff;
assert(sha256(large) === "35213951b59a23a2b667c200a409cdfda3e1e261c0f81305faf029d3cf32d0e1", "4 MiB raw-byte vector mismatch");

let invalidRejected = false;
try { sha256([1, 2, 3] as any); } catch (error) { invalidRejected = error instanceof TypeError && /string or Uint8Array/.test(error.message); }
assert(invalidRejected, "non-Uint8Array byte input was accepted");
let dataViewRejected = false;
try { sha256(new DataView(new ArrayBuffer(3)) as any); } catch (error) { dataViewRejected = error instanceof TypeError && /string or Uint8Array/.test(error.message); }
assert(dataViewRejected, "DataView input was accepted outside the documented byte contract");
class ByteSubclass extends Uint8Array {}
assert(sha256(new ByteSubclass([1, 2, 3])) === "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81", "Uint8Array subclass was rejected or hashed incorrectly");

ops.op_log("p_sha256_bytes OK: raw bytes hash directly across SHA-256 padding boundaries and a 4 MiB artifact vector; UTF-8/string compatibility and strict input typing are preserved.");
