import { ops } from "../src/engine.ts";
import { canonicalMapDocText } from "../src/world/mapdoc-canonical.mjs";
import { compileAtlasMapDoc, compileDesignMap } from "../src/world/design-map-compile.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { stableStringifyWorldMap, verifyWorldMap, WorldMapSchema, type WorldMap } from "../src/world/worldmap.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_atlas_mapdoc_compile FAIL: ${message}`);
}
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

const doc = {
  version: 2,
  activeMapId: "surface",
  maps: [
    {
      id: "inactive",
      name: "Inactive",
      scope: "site",
      parent: null,
      features: [],
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
    },
    {
      id: "surface",
      name: "Surface",
      scope: "region",
      parent: null,
      seaLevel: 2,
      features: [
        { id: "coast", type: "area", kind: "outline", points: [[-50, -40], [50, -40], [50, 40], [-50, 40]] },
        { id: "grass", type: "area", kind: "biome", biome: "grass", points: [[-50, -40], [50, -40], [50, 40], [-50, 40]] },
        { id: "river", type: "line", kind: "river", points: [[-40, -10], [0, 0], [40, 10]] },
      ],
      stamps: [{ id: "keep", assetId: "watchtower.glb", x: 4, z: -3, rot: 0.5, scale: 1.25 }],
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
    },
  ],
};
const canonical = canonicalMapDocText(doc);
const first = compileAtlasMapDoc({ mapsJsonText: canonical });
const second = compileAtlasMapDoc({ mapsJsonText: canonical });
const map = WorldMapSchema.parse(first.worldMap) as WorldMap;
assert(stableStringifyWorldMap(map) === stableStringifyWorldMap(second.worldMap as WorldMap), "same canonical MapDoc changed output bytes");
assert(map.id === "surface", "compiler did not select activeMapId");
assert(map.provenance.sourceHash === sha256(canonical), "sourceHash does not bind exact canonical MapDoc bytes including LF");
assert(verifyWorldMap(map).ok, "compiled Atlas WorldMap failed its content hash");
assert(map.anchors.length === 1 && map.anchors[0].id === "keep" && map.anchors[0].source === "map", "MapDoc stamp did not compile without world-bible input");
assert(map.waterways[0].widthM === 3, "MapDoc-only default river width did not derive deterministically from authored span");

rejects(() => compileAtlasMapDoc({ mapsJsonText: canonical.slice(0, -1) }), /not canonical/, "missing canonical LF was accepted");
rejects(() => compileAtlasMapDoc({ mapsJsonText: JSON.stringify(doc) }), /not canonical/, "noncanonical key order was accepted");
rejects(() => compileAtlasMapDoc({ mapsJsonText: canonical, mapId: "inactive" } as any), /exactly mapsJsonText/, "caller-selected non-active map was accepted");
const stale = clone(doc); stale.version = 1;
rejects(() => compileAtlasMapDoc({ mapsJsonText: canonicalMapDocText(stale) }), /version must be 2/, "stale MapDoc version was compiled");
const duplicate = clone(doc); duplicate.maps[0].id = "surface";
rejects(() => compileAtlasMapDoc({ mapsJsonText: canonicalMapDocText(duplicate) }), /duplicated/, "duplicate map id was compiled");
const coercible = clone(doc) as any; coercible.maps[1].features[0].points[0][0] = "-50";
rejects(() => compileAtlasMapDoc({ mapsJsonText: canonicalMapDocText(coercible) }), /finite canonical number/, "numeric string coordinate was coerced");
const badInactive = clone(doc) as any; badInactive.maps[0].units.unitsPerMeter = 0;
rejects(() => compileAtlasMapDoc({ mapsJsonText: canonicalMapDocText(badInactive) }), /units/, "malformed inactive map bypassed whole-document validation");
const badInactiveRaster = clone(doc) as any;
badInactiveRaster.maps[0].rasters = { landmass: { w: 2, h: 2, rect: { x0: 0, z0: 0, w: 1, h: 1 }, data: "AA==" } };
rejects(() => compileAtlasMapDoc({ mapsJsonText: canonicalMapDocText(badInactiveRaster) }), /payload is invalid/, "malformed inactive raster payload bypassed whole-document validation");
const duplicateFeature = clone(doc) as any; duplicateFeature.maps[1].features[1].id = "coast";
rejects(() => compileAtlasMapDoc({ mapsJsonText: canonicalMapDocText(duplicateFeature) }), /duplicated/, "duplicate active feature id was compiled");

// Pin the aggregate compiler's current durable-provenance bytes, not merely repeatability. Adding
// designRef/designIndex and stable Atlas route ids intentionally change a fresh compile while
// stored routes without ids stay backward-compatible at the schema/hash boundary.
const read = (assetId: string) => new TextDecoder().decode(ops.op_read_asset(assetId));
const legacy = compileDesignMap({
  mapsJsonText: read("maps/_fixtures/eastern-watch/maps.json"),
  worldBibleText: read("maps/_fixtures/eastern-watch/world-bible.md"),
}).worldMap as WorldMap;
assert(legacy.provenance.contentHash === "d8ac428c16f7018376452b4345ad49ef0fd1e9cc2eaab9cf95bc113ed94f13df", "aggregate contentHash changed");
assert(sha256(stableStringifyWorldMap(legacy)) === "365fe3673c94de9cff67df644316e510de59a550f0035011878b884be79ff890", "aggregate canonical WorldMap bytes changed");

ops.op_log("p_atlas_mapdoc_compile OK: active-only canonical Atlas compilation binds exact MapDoc bytes; hostile/noncanonical documents fail closed; aggregate WorldMap provenance bytes remain pinned.");
