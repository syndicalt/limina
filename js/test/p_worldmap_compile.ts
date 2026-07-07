// p_worldmap_compile — Phase 0 of "Map-Driven Worlds": the WorldMap IR schema (worldmap.ts), its
// pure compiler (design-map-compile.mjs / compile-designmap.mjs), and the determinism gate.
//
// Run: ./target/release/limina js/test/p_worldmap_compile.ts
//
// Proves: (1) sha256.mjs matches known FIPS test vectors; (2) compiling the eastern-watch vault
// twice yields byte-identical output; (3) the compiled output zod-parses as WorldMap v1 and
// verifyWorldMap reports ok:true; (4) tampering one byte of a land point flips verifyWorldMap to
// ok:false; (5) anchors include the watchtower at its world-bible position.

import { ops } from "../src/engine.ts";
import { sha256 } from "../src/world/sha256.mjs";
import { compileDesignMap } from "../src/world/design-map-compile.mjs";
import { WorldMapSchema, stableStringifyWorldMap, verifyWorldMap, type WorldMap } from "../src/world/worldmap.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_worldmap_compile FAIL: " + message);
}

function readAssetText(assetId: string): string {
  return new TextDecoder().decode(ops.op_read_asset(assetId));
}

// ── 1. sha256.mjs matches known FIPS 180-4 test vectors. ───────────────────────────────────────
{
  assert(
    sha256("") === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    `sha256("") mismatch: ${sha256("")}`,
  );
  assert(
    sha256("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    `sha256("abc") mismatch: ${sha256("abc")}`,
  );
  // NIST two-block vector (448 bits -> exercises the >1-block padding path).
  const twoBlock = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
  assert(
    sha256(twoBlock) === "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    `sha256(two-block vector) mismatch: ${sha256(twoBlock)}`,
  );
}

// ── 2. Compiling the eastern-watch vault twice (the PURE compiler, gated directly — the CLI
//    wrapper is untested I/O glue over this same function) yields byte-identical output. ───────
const mapsJsonText = readAssetText("maps/_fixtures/eastern-watch/maps.json");
const worldBibleText = readAssetText("maps/_fixtures/eastern-watch/world-bible.md");

const runA = compileDesignMap({ mapsJsonText, worldBibleText });
const runB = compileDesignMap({ mapsJsonText, worldBibleText });
const worldMapA = runA.worldMap as WorldMap;
const worldMapB = runB.worldMap as WorldMap;

const stableA = stableStringifyWorldMap(worldMapA);
const stableB = stableStringifyWorldMap(worldMapB);
assert(stableA === stableB, "compiling the same vault twice must yield byte-identical WorldMap output");
assert(worldMapA.provenance.contentHash === worldMapB.provenance.contentHash, "contentHash must be identical across repeated compiles");
assert(worldMapA.provenance.contentHash.length === 64, `contentHash must be a 64-char sha256 hex (got ${worldMapA.provenance.contentHash.length})`);

// ── 3. The output zod-parses as WorldMap v1, and verifyWorldMap reports ok:true. ───────────────
const parsed = WorldMapSchema.parse(worldMapA);
assert(parsed.version === 1, "compiled map must declare version 1");
assert(parsed.land.length >= 1, "compiled map must have at least one land polygon");
assert(parsed.biomes.length === 3, `expected 3 biome regions (mountain/swamp/grass), got ${parsed.biomes.length}`);
assert(parsed.waterways.length === 3, `expected 3 waterway features, got ${parsed.waterways.length}`);
assert(parsed.routes.length === 2, `expected 2 route features, got ${parsed.routes.length}`);

const goodVerify = verifyWorldMap(worldMapA);
assert(goodVerify.ok, `verifyWorldMap must report ok:true for an untampered compile (expected ${goodVerify.expected}, actual ${goodVerify.actual})`);
assert(goodVerify.expected === worldMapA.provenance.contentHash, "verifyWorldMap's expected hash must equal the embedded provenance.contentHash");

// ── 4. Tampering one byte of a land point flips verifyWorldMap to ok:false. ────────────────────
{
  const tampered: WorldMap = JSON.parse(JSON.stringify(worldMapA));
  tampered.land[0].points[0] = [tampered.land[0].points[0][0] + 1, tampered.land[0].points[0][1]];
  const tamperedVerify = verifyWorldMap(tampered);
  assert(!tamperedVerify.ok, "verifyWorldMap must report ok:false after a one-byte land-point tamper");
  assert(tamperedVerify.expected === tampered.provenance.contentHash, "tampered expected must still read the (now-stale) embedded contentHash");
  assert(tamperedVerify.actual !== tamperedVerify.expected, "tampered actual (recomputed) hash must differ from the stale embedded hash");
}

// ── 5. Anchors include the watchtower at its world-bible position [30, -12] (north = -z). ──────
{
  const watchtower = parsed.anchors.find((a) => a.id === "watchtower");
  assert(watchtower !== undefined, "anchors must include a 'watchtower' entry sourced from world-bible locations");
  assert(watchtower!.kind === "military", `watchtower anchor kind must be "military" (got ${watchtower!.kind})`);
  assert(watchtower!.source === "world-bible", `watchtower anchor source must be "world-bible" (got ${watchtower!.source})`);
  assert(
    watchtower!.position[0] === 30 && watchtower!.position[1] === -12,
    `watchtower anchor position must match world-bible.md's [30, -12] (got ${JSON.stringify(watchtower!.position)})`,
  );
}

ops.op_log(
  "[js] p_worldmap_compile OK: sha256.mjs matches FIPS 180-4 test vectors (empty/abc/two-block); " +
  "compileDesignMap(eastern-watch vault) is PURE and deterministic (byte-identical stableStringifyWorldMap + " +
  "contentHash across repeated compiles); the compiled output zod-parses as WorldMap v1 (1 land ring, 3 biomes, " +
  "3 waterways, 2 routes) and verifyWorldMap reports ok:true against its own embedded provenance.contentHash; " +
  "a one-byte tamper of a land point flips verifyWorldMap to ok:false; and anchors carry the watchtower at its " +
  "world-bible position [30, -12] with kind=military, source=world-bible.",
);
