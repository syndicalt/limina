import { compileAtlasMapDoc, compileDesignMap } from "../src/world/design-map-compile.mjs";
import { MAX_DESIGN_INDEX_ENTRIES, atlasDesignRefKey } from "../src/world/design-ref.mjs";
import { canonicalMapDocText } from "../src/world/mapdoc-canonical.mjs";
import { verifyWorldMap, WorldMapSchema, type WorldMap } from "../src/world/worldmap.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_design_ref_compile FAIL: ${message}`);
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function rejects(doc: unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { compileAtlasMapDoc({ mapsJsonText: canonicalMapDocText(doc) }); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}
function atlas(doc: unknown): WorldMap {
  return WorldMapSchema.parse(compileAtlasMapDoc({ mapsJsonText: canonicalMapDocText(doc) }).worldMap) as WorldMap;
}

const units = { kind: "m", unitsPerMeter: 2, origin: [100, -50] };
const doc: any = {
  version: 2,
  activeMapId: "primary",
  maps: [
    {
      id: "primary", name: "Primary", scope: "site", parent: null, units,
      features: [
        { id: "road", type: "line", kind: "road", points: [[0, 0], [20, 10]] },
        { id: "peak", type: "glyph", kind: "relief", glyph: "peak", x: 8, z: 4 },
      ],
      stamps: [{ id: "stamp", assetId: "church.glb", x: 4, z: 4 }],
      markers: [
        { id: "marker-a", name: "Twin Marker", kind: "landmark", position: [6, 8] },
        { id: "marker-b", name: "Twin Marker", kind: "landmark", position: [6, 8], radiusM: 20, assetId: "marker.glb" },
        { id: "marker-away", name: "Away", kind: "landmark", position: [2, 2], map: "external" },
      ],
      places: [
        { id: "twin-a", name: "Twin", kind: "village", position: [12, 6], binding: "point" },
        { id: "twin-b", name: "Twin", kind: "village", position: [12, 6], binding: "area", radiusM: 30, assetId: "village.glb" },
        { id: "elsewhere", name: "Elsewhere", kind: "village", position: [2, 2], binding: "point", map: "external" },
        { id: "planned", name: "Planned", kind: "village" },
      ],
    },
    { id: "external", name: "External", scope: "site", parent: null, units, features: [] },
  ],
};

const compiled = atlas(doc);
assert(verifyWorldMap(compiled).ok, "designRef-bearing Atlas WorldMap failed its content hash");
const refs = compiled.designIndex?.map((entry) => entry.designRef) ?? [];
const keys = refs.map(atlasDesignRefKey);
assert(keys.length === 6 && keys.every((key, index) => index === 0 || keys[index - 1] < key),
  "designIndex is not strictly sorted and complete for glyph/stamp/markers/placed places");
assert(new Set(keys).size === keys.length, "designIndex contains duplicate identity");
const twinA = compiled.designIndex?.find((entry) => entry.designRef.id === "twin-a");
const twinB = compiled.designIndex?.find((entry) => entry.designRef.id === "twin-b");
assert(twinA?.designRef.kind === "place" && twinB?.designRef.kind === "place"
    && JSON.stringify(twinA.position) === JSON.stringify([106, -47])
    && JSON.stringify(twinA.position) === JSON.stringify(twinB.position)
    && atlasDesignRefKey(twinA.designRef) !== atlasDesignRefKey(twinB.designRef),
  "duplicate-name colocated places were conflated instead of retaining exact identity");
assert(twinB.radiusM === 30, "area radiusM did not reach the navigation source index");
const markerA = compiled.designIndex?.find((entry) => entry.designRef.id === "marker-a");
const markerB = compiled.designIndex?.find((entry) => entry.designRef.id === "marker-b");
assert(markerA?.designRef.kind === "marker" && markerB?.designRef.kind === "marker"
    && JSON.stringify(markerA.position) === JSON.stringify([103, -46])
    && JSON.stringify(markerA.position) === JSON.stringify(markerB.position)
    && atlasDesignRefKey(markerA.designRef) !== atlasDesignRefKey(markerB.designRef)
    && markerB.radiusM === 20,
  "duplicate-name colocated Atlas markers were conflated or lost radius metadata");
assert(!refs.some((ref) => ["elsewhere", "planned", "marker-away"].includes(ref.id)),
  "external-map or unplaced Atlas subject leaked into the active map index");
assert(compiled.gazetteer?.length === 2 && compiled.gazetteer.every((entry) => entry.designRef?.mapId === "primary" && entry.designRef.kind === "place"),
  "Atlas map.places did not attach exact gazetteer refs");
assert(compiled.anchors.find((entry) => entry.id === "stamp")?.designRef?.kind === "stamp"
    && compiled.anchors.find((entry) => entry.id === "twin-b")?.designRef?.kind === "place"
    && compiled.anchors.find((entry) => entry.id === "marker-b")?.designRef?.kind === "marker"
    && compiled.anchors.find((entry) => entry.id === "marker-b")?.assetId === "marker.glb",
  "stamp/place/marker anchors lost exact refs or asset metadata");
assert(!refs.some((ref) => ref.id === "road") && refs.find((ref) => ref.id === "peak")?.kind === "feature",
  "area/line feature entered the navigable index or glyph source ref was omitted");

const moved = clone(doc);
moved.maps[0].places[1].position = [14, 6];
const movedMap = atlas(moved);
assert(movedMap.provenance.contentHash !== compiled.provenance.contentHash,
  "moving an indexed place did not change the WorldMap content hash");
const renamed = clone(doc);
renamed.maps[0].places[1].id = "twin-c";
const renamedMap = atlas(renamed);
assert(renamedMap.provenance.contentHash !== compiled.provenance.contentHash
    && renamedMap.designIndex?.some((entry) => entry.designRef.id === "twin-c"),
  "changing exact place identity did not change the hash/index");

const duplicate = clone(doc); duplicate.maps[0].places[1].id = "twin-a";
rejects(duplicate, /duplicated/, "duplicate Atlas place id was accepted");
const unknown = clone(doc); unknown.maps[0].places[0].label = "not a supported source field";
rejects(unknown, /fields are invalid/, "unknown Atlas place field was accepted");
const badParent = clone(doc); badParent.maps[0].places[0].parentId = "missing";
rejects(badParent, /missing place/, "missing Atlas place parent was accepted");
const badMap = clone(doc); badMap.maps[0].places[0].map = "missing";
rejects(badMap, /does not identify a map/, "unknown Atlas place map was accepted");
const duplicateMarker = clone(doc); duplicateMarker.maps[0].markers[1].id = "marker-a";
rejects(duplicateMarker, /duplicated/, "duplicate Atlas marker id was accepted");
const badMarkerMap = clone(doc); badMarkerMap.maps[0].markers[0].map = "missing";
rejects(badMarkerMap, /does not identify a map/, "unknown Atlas marker map was accepted");
const unknownMarker = clone(doc); unknownMarker.maps[0].markers[0].label = "unsupported";
rejects(unknownMarker, /fields are invalid/, "unknown Atlas marker field was accepted");

// Legacy markdown aggregation retains its source, but map assignments are now honored before
// refs are derived. Missing map assignments continue to mean the primary map.
const mapsJsonText = JSON.stringify({
  activeMapId: "primary",
  maps: [
    { id: "primary", name: "Primary", scope: "site", parent: null, units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] }, features: [] },
    { id: "external", name: "External", scope: "site", parent: null, units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] }, features: [] },
  ],
});
const worldBibleText = "---\nzone:\n  size_m: 1000\nlocations:\n  - id: default-marker\n    name: Same\n    kind: landmark\n    position: [1, 2]\n  - id: external-marker\n    name: Same\n    kind: landmark\n    position: [1, 2]\n    map: external\n---\n";
const placesText = "---\nkind: places\nplaces:\n  - id: default-place\n    name: Same\n    kind: village\n    position: [1, 2]\n  - id: external-place\n    name: Same\n    kind: village\n    position: [1, 2]\n    map: external\n---\n";
const aggregate = (mapId: string) => WorldMapSchema.parse(compileDesignMap({ mapsJsonText, worldBibleText, placesText, mapId }).worldMap) as WorldMap;
const primary = aggregate("primary"), external = aggregate("external");
assert(primary.designIndex?.some((entry) => entry.designRef.id === "default-marker" && entry.designRef.kind === "marker")
    && primary.designIndex.some((entry) => entry.designRef.id === "default-place" && entry.designRef.kind === "place")
    && !primary.designIndex.some((entry) => entry.designRef.id.startsWith("external-")),
  "primary legacy compile did not apply default/external assignment filtering");
assert(external.designIndex?.some((entry) => entry.designRef.id === "external-marker" && entry.designRef.mapId === "external")
    && external.designIndex.some((entry) => entry.designRef.id === "external-place" && entry.designRef.mapId === "external")
    && !external.designIndex.some((entry) => entry.designRef.id.startsWith("default-")),
  "external legacy compile did not apply exact map assignment filtering");
assert(external.anchors.find((entry) => entry.id === "external-marker")?.designRef?.kind === "marker"
    && external.gazetteer?.find((entry) => entry.placeId === "external-place")?.designRef?.kind === "place",
  "legacy marker/place outputs lost durable refs");

// The source ceilings are individually large, so the combined navigable-subject budget is enforced
// at insertion time and again by the WorldMap schema. Exactly 100k remains a valid production map.
const boundaryStamps = Array.from({ length: MAX_DESIGN_INDEX_ENTRIES - 1 }, (_, index) => ({
  id: `stamp-${index}`, assetId: "fixture.glb", x: index, z: 0,
}));
const boundaryDoc = {
  activeMapId: "primary",
  maps: [{
    id: "primary", name: "Boundary", scope: "site", parent: null,
    units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] }, features: [], stamps: boundaryStamps,
  }],
};
const boundaryWorldBible = "---\nzone:\n  size_m: 200000\nlocations:\n  - id: marker\n    name: Marker\n    kind: landmark\n    position: [0, 0]\n---\n";
const boundaryMap = compileDesignMap({ mapsJsonText: JSON.stringify(boundaryDoc), worldBibleText: boundaryWorldBible }).worldMap as WorldMap;
assert(boundaryMap.designIndex?.length === MAX_DESIGN_INDEX_ENTRIES,
  "compiler rejected or truncated the exact navigable designIndex boundary");
assert(WorldMapSchema.safeParse(boundaryMap).success, "WorldMap schema rejected the exact designIndex boundary");
const oversizedWorld = {
  ...boundaryMap,
  designIndex: [...boundaryMap.designIndex!, {
    designRef: { schema: "limina.atlas-design-ref/v1", mapId: "primary", kind: "place", id: "overflow" },
    position: [0, 0],
  }],
};
assert(!WorldMapSchema.safeParse(oversizedWorld).success, "WorldMap schema accepted designIndex beyond the combined budget");
boundaryStamps.push({ id: "stamp-overflow", assetId: "fixture.glb", x: 0, z: 0 });
let overflowError: unknown;
try { compileDesignMap({ mapsJsonText: JSON.stringify(boundaryDoc), worldBibleText: boundaryWorldBible }); }
catch (error) { overflowError = error; }
assert(overflowError instanceof Error && /navigable designIndex exceeds 100000/.test(overflowError.message),
  `compiler did not fail clearly above the combined budget: ${overflowError instanceof Error ? overflowError.message : "did not throw"}`);

console.log("p_design_ref_compile OK: exact navigable refs survive duplicate names/coordinates, Atlas places/filtering are strict, hashes are sensitive, and the combined 100k budget is enforced at both boundaries.");
