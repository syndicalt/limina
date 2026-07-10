import test from "node:test";
import assert from "node:assert/strict";
import { projectNavigationSubjects } from "./map-navigation-projection.js";
import { compileAtlasMapDoc } from "../../../js/src/world/design-map-compile.mjs";
import { canonicalMapDocText } from "../../../js/src/world/mapdoc-canonical.mjs";

test("projects placed POIs and their ancestor chain into the assigned map", () => {
  const maps = [{ id: "primary", features: [] }, { id: "north", features: [] }];
  const places = [
    { id: "realm", name: "Realm", kind: "region" },
    { id: "town", name: "Town", kind: "settlement", parentId: "realm", position: [10, 20], map: "north", ignored: true },
    { id: "home", name: "Home", kind: "building", position: [1, 2] },
    { id: "capital", name: "Capital", kind: "settlement", position: [5, 6] },
    { id: "outpost", name: "Outpost", kind: "building", parentId: "capital", position: [50, 60], map: "north" },
    { id: "off-place", name: "Off", kind: "building", position: [9, 9], map: "__off__" },
    { id: "unused", name: "Unused", kind: "region" },
  ];
  const markers = [
    { id: "gate", name: "Gate", kind: "landmark", x: 3, z: 4 },
    { id: "peak", name: "Peak", kind: "landmark", position: [30, 40], map: "north" },
    { id: "hidden", name: "Hidden", kind: "landmark", x: 9, z: 9, map: "__off__" },
  ];
  const projected = projectNavigationSubjects(maps, places, markers);
  assert.deepEqual(projected[0].places.map((place) => place.id), ["home", "capital"]);
  assert.deepEqual(projected[1].places.map((place) => place.id), ["realm", "town", "capital", "outpost"]);
  assert.equal(projected[1].places[1].ignored, undefined);
  assert.equal(projected[1].places.find((place) => place.id === "capital").position, undefined,
    "cross-map ancestor became a duplicate navigable POI");
  assert.equal(projected[1].places.find((place) => place.id === "capital").map, "north");
  assert(projected.every((map) => !(map.places || []).some((place) => place.id === "off-place")));
  assert.deepEqual(projected[0].markers[0].position, [3, 4]);
  assert.deepEqual(projected[1].markers[0].position, [30, 40]);
  assert.equal(projected[0].markers[0].map, "primary");
  assert.equal(projected[1].markers[0].map, "north");
  assert(projected.every((map) => !(map.markers || []).some((marker) => marker.id === "hidden")));
  assert.equal(maps[0].places, undefined, "projection mutated live MapDoc state");
});

test("removes stale projection fields when no navigable subjects remain", () => {
  const projected = projectNavigationSubjects([{ id: "primary", places: [{}], markers: [{}] }], [], []);
  assert.equal(Object.hasOwn(projected[0], "places"), false);
  assert.equal(Object.hasOwn(projected[0], "markers"), false);
});

test("projected ancestors and map assignments compile without duplicate cross-map POIs", () => {
  const base = (id) => ({ id, name: id, scope: "site", parent: null, features: [], units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] } });
  const maps = projectNavigationSubjects(
    [base("primary"), base("north")],
    [
      { id: "realm", name: "Realm", kind: "region", position: [1, 1] },
      { id: "town", name: "Town", kind: "settlement", parentId: "realm", position: [10, 20], map: "north" },
    ],
    [
      { id: "home-marker", name: "Home", kind: "landmark", x: 2, z: 3 },
      { id: "north-marker", name: "North", kind: "landmark", x: 12, z: 13, map: "north" },
    ],
  );
  const worldMap = compileAtlasMapDoc({ mapsJsonText: canonicalMapDocText({ version: 2, activeMapId: "north", maps }) }).worldMap;
  const ids = worldMap.designIndex.map((entry) => entry.designRef.id);
  assert.deepEqual(ids, ["north-marker", "town"]);
  assert.equal(worldMap.gazetteer.length, 1);
  assert.equal(worldMap.gazetteer[0].parentId, "realm");
});
