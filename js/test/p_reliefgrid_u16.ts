// p_reliefgrid_u16 — the u16 heightfield encoding gate (World Builder Phase 0, Slice 0.1).
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p_reliefgrid_u16.ts
// Exit: 0 pass, throws (1) on fail.
//
// Proves the u16 foundation: (1) a u16 reliefGrid decodes correctly and can hold an Everest-scale
// peak (~8,849m) — the whole point; (2) a legacy u8 grid (no `encoding`) still decodes; (3) mis-tagging
// u16 bytes as u8 throws on the length check (falsifiable); (4) HASH DISCIPLINE — `encoding` is
// serialized ONLY-when-present, so a u8 grid hashes byte-identically to a pre-u16 build while a u16
// grid carries encoding into the content hash.

import { reliefGridSampler } from "../src/world/pipeline/map-raster.mjs";
import { u8ToB64 } from "../src/world/pipeline/raster-codec.mjs";
import { stableStringifyWorldMap } from "../src/world/worldmap-hash.mjs";
import { WorldMapSchema } from "../src/world/worldmap.ts";
import { ops } from "../src/engine.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) { ops.op_log("p_reliefgrid_u16 FAIL: " + msg); throw new Error(msg); }
}

const W = 2, H = 2, MINY = -500, MAXY = 9000;
const rect = { x0: 0, z0: 0, w: 100, h: 100 };

// ── u16: corner values 0 / 65535 → MINY / MAXY (an Everest-class peak) ────────────────────────────
const vals16 = [0, 65535, 32768, 65535];
const b16 = new Uint8Array(W * H * 2);
for (let i = 0; i < vals16.length; i++) { b16[2 * i] = vals16[i] & 0xff; b16[2 * i + 1] = (vals16[i] >> 8) & 0xff; }
const gridU16 = { w: W, h: H, rect, minY: MINY, maxY: MAXY, encoding: "u16", data: u8ToB64(b16) };
const s16 = reliefGridSampler({ reliefGrid: gridU16, origin: [0, 0], unitsPerMeter: 1 } as never)!;
assert(Math.abs(s16(0, 0) - MINY) < 0.01, `u16 valley sample ${s16(0, 0)} != ${MINY}`);
assert(Math.abs(s16(100, 0) - MAXY) < 1, `u16 peak sample ${s16(100, 0)} != ${MAXY}`);
assert(s16(100, 0) > 8848.86, `u16 must reach real Everest scale: peak=${s16(100, 0)}m`);

// ── u8 back-compat: no `encoding`, /255 decode still correct ───────────────────────────────────────
const gridU8 = { w: W, h: H, rect, minY: MINY, maxY: MAXY, data: u8ToB64(new Uint8Array([0, 255, 128, 255])) };
const s8 = reliefGridSampler({ reliefGrid: gridU8, origin: [0, 0], unitsPerMeter: 1 } as never)!;
assert(Math.abs(s8(0, 0) - MINY) < 0.01, `u8 valley sample ${s8(0, 0)} != ${MINY}`);
assert(Math.abs(s8(100, 0) - MAXY) < 1, `u8 peak sample ${s8(100, 0)} != ${MAXY}`);

// ── falsifiable: u16 bytes mis-tagged as u8 must throw on the length check ─────────────────────────
let threw = false;
try { reliefGridSampler({ reliefGrid: { ...gridU16, encoding: "u8" }, origin: [0, 0], unitsPerMeter: 1 } as never); } catch { threw = true; }
assert(threw, "u16 data mis-tagged as u8 must throw (length mismatch)");

// ── hash discipline: encoding is emitted only-when-present ─────────────────────────────────────────
const baseMap = { version: 1, id: "t", unitsPerMeter: 1, origin: [0, 0], extent: { w: 1, h: 1 }, seaLevel: 0, land: [], relief: [], biomes: [], waterways: [], routes: [], anchors: [], provenance: { tool: "design-space", contentHash: "x" } };
const strU8 = stableStringifyWorldMap({ ...baseMap, reliefGrid: gridU8 } as never, { omitContentHash: true }) as string;
const strU16 = stableStringifyWorldMap({ ...baseMap, reliefGrid: gridU16 } as never, { omitContentHash: true }) as string;
assert(!strU8.includes('"encoding"'), "a u8 grid must NOT emit an encoding key (byte-identical to pre-u16 maps)");
assert(strU16.includes('"encoding":"u16"'), "a u16 grid MUST carry encoding into the hashed form (hash discipline)");

// ── bounded malformed-input rejection: fail before allocating/decoding an attacker-sized grid ───
assert(WorldMapSchema.safeParse({ ...baseMap, reliefGrid: gridU16 }).success, "schema must accept a valid u16 grid");
assert(!WorldMapSchema.safeParse({ ...baseMap, reliefGrid: { ...gridU16, maxY: MINY } }).success, "schema must reject a reversed/empty height range");
for (const bad of [
  { ...gridU16, w: 1025 },
  { ...gridU16, w: "2" },
  { ...gridU16, encoding: "u32" },
  { ...gridU16, data: gridU16.data.slice(0, -4) },
  { ...gridU16, data: "!!!!!!!!!!!!" },
]) {
  let malformedRejected = false;
  try { reliefGridSampler({ reliefGrid: bad, origin: [0, 0], unitsPerMeter: 1 } as never); } catch { malformedRejected = true; }
  assert(malformedRejected, `malformed relief grid must be rejected: ${JSON.stringify(bad).slice(0, 120)}`);
}

ops.op_log("p_reliefgrid_u16 OK: u16 heightfield decodes (Everest-scale peak reachable: " + Math.round(s16(100, 0)) + "m), u8 back-compat intact, mis-tag/malformed/bounds violations throw, encoding hashed only-when-present (u8 hashes identically).");
