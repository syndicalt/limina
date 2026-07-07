// raster-codec.mjs — encoding for MapDoc paint rasters (Map Painter P1). PURE and
// dependency-free (no fs/Buffer/zlib) so it runs identically in the design-space frontend
// (served via /shared/), the pure compiler (design-map-compile.mjs), and the gate.
//
// Why RLE: paint masks are runny (long ocean/land runs), and the whole save path — POST body,
// maps.json on disk, /api/state — is plain un-gzipped JSON. A 512² u8 mask is 262,144 raw bytes
// (~350 KB as base64); rle8 typically shrinks it to a few KB. The elevation raster (S1) predates
// this codec and stays raw base64 — `enc` is absent there, and absent means raw.
//
// rle8 wire format: repeated (count, value) byte pairs, count 1..255, concatenated runs in
// row-major cell order. Deterministic: one canonical encoding per input (maximal runs).

/** Encode u8 cells as rle8 pairs. Returns a Uint8Array of (count, value) pairs. */
export function rleEncodeU8(cells) {
  const out = [];
  let i = 0;
  while (i < cells.length) {
    const v = cells[i];
    let run = 1;
    while (run < 255 && i + run < cells.length && cells[i + run] === v) run++;
    out.push(run, v);
    i += run;
  }
  return Uint8Array.from(out);
}

/** Decode rle8 pairs back to cells. Throws if the stream doesn't produce exactly expectedLength. */
export function rleDecodeU8(bytes, expectedLength) {
  const out = new Uint8Array(expectedLength);
  let o = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const run = bytes[i], v = bytes[i + 1];
    if (o + run > expectedLength) throw new Error(`rle8: overflow at pair ${i / 2} (have ${o}, run ${run}, expected ${expectedLength})`);
    out.fill(v, o, o + run);
    o += run;
  }
  if (o !== expectedLength) throw new Error(`rle8: decoded ${o} cells, expected ${expectedLength}`);
  return out;
}

/** u8 -> base64 without Buffer (chunked to keep the argument list bounded). */
export function u8ToB64(u8) {
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function b64ToU8(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Cells -> the {enc, data} fields of a MapDoc raster. */
export function encodeRasterCells(cells) {
  return { enc: "rle8", data: u8ToB64(rleEncodeU8(cells)) };
}

/** {enc?, data} -> cells. `enc` absent = raw base64 (the S1 elevation format). */
export function decodeRasterCells(raster, expectedLength) {
  const bytes = b64ToU8(String(raster.data));
  if (raster.enc === "rle8") return rleDecodeU8(bytes, expectedLength);
  if (raster.enc !== undefined) throw new Error(`raster-codec: unknown enc "${raster.enc}"`);
  if (bytes.length !== expectedLength) throw new Error(`raster: raw data length ${bytes.length} != expected ${expectedLength}`);
  return bytes;
}
