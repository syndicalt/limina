// sha256.mjs — a dependency-free, pure-JS SHA-256 (string | Uint8Array -> lowercase hex).
//
// WHY THIS EXISTS: the engine's op_sha256 host op is NOT byte-identical across hosts (headless
// authoritative host vs browser render host vs a non-native/test host may hash differently, or
// return the "" sentinel — see asset-registry.ts's `hash !== "sha256:"` guard). WorldMap's
// contentHash is a PORTABILITY CONTRACT: the same map must hash identically whether it's compiled
// by a Node CLI tool, verified inside the limina engine (a .ts file importing this .mjs — the same
// cross-host-.mjs-import pattern as world/pipeline/terrain-heightfield.mjs), or re-verified in the
// browser bundle. A pure, standalone implementation with no host op and no runtime globals
// (no node:crypto, no WebCrypto, no TextEncoder) is the only way to guarantee that.
//
// Standard FIPS 180-4 SHA-256, single-pass (whole message buffered — worldmaps are small JSON
// documents, not multi-GB streams, so streaming support is not needed).
//
// Known test vectors (verified by js/test/p_worldmap_compile.ts):
//   sha256("")    = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
//   sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
//   sha256("abc" + "def" ... wait, use the standard NIST 2-block vector instead — see the test file.

// -- UTF-8 encode a JS string into bytes, by hand (no TextEncoder dependency). ------------------
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.codePointAt(i);
    if (cp > 0xffff) i++; // consumed a surrogate pair
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

// -- round constants: the first 32 bits of the fractional parts of the cube roots of the first
// 64 primes.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function toHex32(word) {
  return (word >>> 0).toString(16).padStart(8, "0");
}

/**
 * SHA-256 of `input` (a JS string, UTF-8 encoded, or a raw Uint8Array of bytes to hash directly).
 * Returns lowercase hex (64 chars). Pure — no host op, no crypto global, no randomness.
 */
export function sha256(input) {
  const msg = typeof input === "string" ? utf8Bytes(input) : Array.from(input);
  const bitLenLo = (msg.length * 8) >>> 0;
  const bitLenHi = Math.floor((msg.length * 8) / 0x100000000) >>> 0;

  // Padding: 0x80, zero bytes until length % 64 === 56, then the 64-bit big-endian bit length.
  const padded = msg.slice();
  padded.push(0x80);
  while (padded.length % 64 !== 56) padded.push(0);
  padded.push(
    (bitLenHi >>> 24) & 0xff, (bitLenHi >>> 16) & 0xff, (bitLenHi >>> 8) & 0xff, bitLenHi & 0xff,
    (bitLenLo >>> 24) & 0xff, (bitLenLo >>> 16) & 0xff, (bitLenLo >>> 8) & 0xff, bitLenLo & 0xff,
  );

  // Initial hash values: the first 32 bits of the fractional parts of the square roots of the
  // first 8 primes.
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let t = 0; t < 16; t++) {
      const o = block + t * 4;
      w[t] = ((padded[o] << 24) | (padded[o + 1] << 16) | (padded[o + 2] << 8) | padded[o + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return toHex32(h0) + toHex32(h1) + toHex32(h2) + toHex32(h3)
       + toHex32(h4) + toHex32(h5) + toHex32(h6) + toHex32(h7);
}
