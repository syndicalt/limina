import assert from "node:assert/strict";
import test from "node:test";
import { migrateMapDoc, serializeMapDoc } from "./map-doc.mjs";

test("MapDoc migration/save preserves WB-W1 fields and unrelated unknown fields without defaults", () => {
  const raw = {
    activeMapId: "primary",
    futureTopLevel: { keep: true },
    maps: [{
      id: "primary",
      name: "Water",
      scope: "site",
      parent: null,
      features: [{ id: "r", type: "line", kind: "river", points: [[0, 0], [1, 1]], class: "stream", order: 2, widths: [1, 2] }],
      waterBodies: [{
        id: "mere",
        kind: "lake",
        level: 4,
        footprint: { points: [[0, 0], [10, 0], [0, 10]] },
        depthZones: [{ minShoreDistanceM: 0, maxShoreDistanceM: 5, depthM: 2 }],
      }],
      hydrology: {
        schema: "limina.hydrology-recipe/v1",
        precipitationMmPerYear: 800,
        riverMinCatchmentAreaM2: 100000,
        basinMinAreaM2: 400,
        basinMinDepthM: 1,
        waterfallMinDropM: 3,
      },
      futureMapField: { keep: true },
    }],
  };
  const first = migrateMapDoc(raw, "test").doc;
  assert.deepEqual(first.maps[0].waterBodies, raw.maps[0].waterBodies);
  assert.deepEqual(first.maps[0].hydrology, raw.maps[0].hydrology);
  assert.equal(first.maps[0].features[0].class, "stream");
  assert.equal(first.maps[0].features[0].order, 2);
  assert.deepEqual(first.maps[0].features[0].widths, [1, 2]);
  assert.deepEqual(first.maps[0].futureMapField, { keep: true });
  assert.deepEqual(first.futureTopLevel, { keep: true });

  const saved = serializeMapDoc(first.maps, first.activeMapId, first);
  const second = migrateMapDoc(saved, "test").doc;
  assert.deepEqual(second, first);

  const old = migrateMapDoc({ activeMapId: "primary", maps: [{ id: "primary", features: [] }] }, "test").doc;
  assert.equal(Object.hasOwn(old.maps[0], "waterBodies"), false);
  assert.equal(Object.hasOwn(old.maps[0], "hydrology"), false);
});
