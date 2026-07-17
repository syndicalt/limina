import assert from "node:assert/strict";
import test from "node:test";
import * as WA from "./map-water-authoring.js";
import * as H from "./map-commands.js";
import { serializeMapDoc, migrateMapDoc } from "../map-doc.mjs";
import { readFileSync } from "node:fs";

const body = WA.createWaterBody({
  id: "high-mere",
  kind: "lake",
  level: 24,
  points: [[0, 0], [40, 0], [40, 40], [0, 40]],
  holes: [[[10, 10], [10, 20], [20, 20], [20, 10]]],
  depthZones: [
    { minShoreDistanceM: 0, maxShoreDistanceM: 4, depthM: 1 },
    { minShoreDistanceM: 4, maxShoreDistanceM: 12, depthM: 5 },
  ],
});

test("basin create/update/delete stays canonical and undoable without materializing legacy fields", () => {
  assert.deepEqual(body.footprint.points[0], [0, 0]);
  let bodies = WA.addWaterBody(undefined, body);
  assert.equal(bodies.length, 1);
  bodies = WA.updateWaterBody(bodies, "high-mere", { kind: "reservoir", level: 25 });
  assert.equal(bodies[0].kind, "reservoir");

  const map = { id: "primary", features: [] };
  const history = H.createHistory();
  H.push(history, H.cmdSetMapProp("primary", "waterBodies", map.waterBodies, bodies), {}, map);
  assert.deepEqual(map.waterBodies, bodies);
  H.undo(history, () => map);
  assert.equal(Object.hasOwn(map, "waterBodies"), false, "undo did not restore exact legacy absence");
  H.redo(history, () => map);
  assert.deepEqual(map.waterBodies, bodies);
  const deleted = WA.deleteWaterBody(map.waterBodies, "high-mere");
  assert.equal(deleted, undefined, "deleting the final basin must remove the optional field");
});

test("basin editor rejects malformed JSON, invalid topology, duplicates, and discontinuous depth zones", () => {
  assert.throws(() => WA.parseJsonField("[", "basin polygon"), /not valid JSON/);
  assert.throws(() => WA.parseJsonField(" ".repeat(1_000_001), "basin polygon"), /bounded/);
  assert.throws(() => WA.createWaterBody({ id: "cross", kind: "lake", level: 1, holes: [], points: [[0, 0], [10, 10], [0, 10], [10, 0]], depthZones: body.depthZones }), /self-intersect|area/);
  assert.throws(() => WA.createWaterBody({ id: "gap", kind: "lake", level: 1, points: body.footprint.points, holes: [], depthZones: [
    { minShoreDistanceM: 0, maxShoreDistanceM: 4, depthM: 1 },
    { minShoreDistanceM: 5, maxShoreDistanceM: 8, depthM: 2 },
  ] }), /contiguous/);
  assert.throws(() => WA.addWaterBody([body], body), /unique|duplicate/);
  assert.throws(() => WA.updateWaterBody([body], "high-mere", WA.waterBodyEditorPatch({
    kind: "lake", level: "8", pointsText: JSON.stringify(body.footprint.points), holesText: "{}", depthZonesText: JSON.stringify(body.depthZones),
  })), /holes|plain JSON/);
  assert.throws(() => WA.updateWaterBody([body], "high-mere", WA.waterBodyEditorPatch({
    kind: "lake", level: "nan", pointsText: "[]", holesText: "[]", depthZonesText: "[]",
  })), /finite|contain/);
});

test("hydrology recipe uses canonical bounds and one map-property undo step", () => {
  const recipe = WA.parseHydrologyRecipe({
    precipitationMmPerYear: 900,
    riverMinCatchmentAreaM2: 120000,
    basinMinAreaM2: 500,
    basinMinDepthM: 1.5,
    waterfallMinDropM: 4,
  });
  assert.equal(recipe.schema, WA.HYDROLOGY_RECIPE_SCHEMA);
  assert.throws(() => WA.parseHydrologyRecipe({ ...recipe, precipitationMmPerYear: Infinity }), /finite canonical/);
  assert.throws(() => WA.parseHydrologyRecipe({ ...recipe, basinMinDepthM: 0 }), /positive/);
  const map = { id: "primary", features: [], sea: true };
  const history = H.createHistory();
  H.push(history, H.cmdSetMapProp("primary", "hydrology", undefined, recipe), {}, map);
  assert.deepEqual(map.hydrology, recipe);
  H.undo(history, () => map);
  assert.equal(Object.hasOwn(map, "hydrology"), false);
  assert.equal(map.sea, true, "hydrology undo changed legacy sea authoring");
});

test("WorldMap layer import swaps basin/hydrology state in the same undo transaction", () => {
  const prior = { id: "primary", features: [], waterBodies: [body], hydrology: { old: true } };
  const original = JSON.parse(JSON.stringify(prior));
  const nextBody = { ...body, id: "imported-mere", footprint: { points: [[100, 100], [120, 100], [120, 120], [100, 120]] }, depthZones: body.depthZones };
  const recipe = WA.parseHydrologyRecipe({ precipitationMmPerYear: 700, riverMinCatchmentAreaM2: 90000,
    basinMinAreaM2: 300, basinMinDepthM: 1, waterfallMinDropM: 2 });
  const history = H.createHistory();
  H.push(history, H.cmdImportLayers("primary", prior, { waterBodies: [nextBody], hydrology: recipe }), {}, prior);
  assert.equal(prior.waterBodies[0].id, "imported-mere");
  assert.deepEqual(prior.hydrology, recipe);
  H.undo(history, () => prior);
  assert.deepEqual(prior, original, "import undo did not restore prior basin/hydrology bytes exactly");
});

test("WorldMap water import preserves holes/depth/recipe while applying the exact target coordinate transform", () => {
  const recipe = WA.parseHydrologyRecipe({ precipitationMmPerYear: 800, riverMinCatchmentAreaM2: 100000,
    basinMinAreaM2: 400, basinMinDepthM: 1, waterfallMinDropM: 3 });
  const imported = WA.importWorldMapWater({ waterBodies: [body], hydrology: recipe }, ([x, z]) => [x * 2 + 40, z * 2 + 40]);
  assert.deepEqual(imported.waterBodies[0].footprint.points[0], [40, 40]);
  assert.deepEqual(imported.waterBodies[0].footprint.points[2], [120, 120]);
  assert.deepEqual(imported.waterBodies[0].footprint.holes[0][0], [60, 60]);
  assert.deepEqual(imported.waterBodies[0].depthZones, body.depthZones);
  assert.deepEqual(imported.hydrology, recipe);
});

test("MapDoc persistence preserves basin and hydrology bytes while legacy docs stay field-free", () => {
  const recipe = WA.parseHydrologyRecipe({ precipitationMmPerYear: 800, riverMinCatchmentAreaM2: 100000,
    basinMinAreaM2: 400, basinMinDepthM: 1, waterfallMinDropM: 3 });
  const map = { id: "primary", name: "Water", scope: "site", parent: null, features: [],
    units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] }, waterBodies: [body], hydrology: recipe };
  const saved = serializeMapDoc([map], "primary");
  const roundTrip = migrateMapDoc(JSON.parse(JSON.stringify(saved)), "test").doc;
  assert.deepEqual(roundTrip.maps[0].waterBodies, [body]);
  assert.deepEqual(roundTrip.maps[0].hydrology, recipe);
  const legacy = migrateMapDoc({ maps: [{ id: "primary", features: [] }], activeMapId: "primary" }, "test").doc.maps[0];
  assert.equal(Object.hasOwn(legacy, "waterBodies"), false);
  assert.equal(Object.hasOwn(legacy, "hydrology"), false);
});

test("Atlas UI wires canonical validation, undo commands, feedback, and explicit shared-module serving", () => {
  const mapSource = readFileSync(new URL("./map.js", import.meta.url), "utf8");
  const paintSource = readFileSync(new URL("./map-paint.js", import.meta.url), "utf8");
  const serverSource = readFileSync(new URL("../serve-design.mjs", import.meta.url), "utf8");
  for (const marker of [
    'import * as WA from "./map-water-authoring.js"', '["basin","◯"', '["hydrology","☂"',
    'WA.createWaterBody(', 'WA.updateWaterBody(', 'WA.deleteWaterBody(', 'WA.parseHydrologyRecipe(',
    'H.cmdSetMapProp(activeMapId,"waterBodies"', 'H.cmdSetMapProp(activeMapId,"hydrology"',
    'id="wb-feedback" role="alert"', 'id="hydro-feedback" role="status"',
  ]) assert.ok(mapSource.includes(marker), `Atlas water workflow is missing ${marker}`);
  assert.match(serverSource, /"\/js\/src\/world\/water-ir\.mjs"/);
  assert.match(serverSource, /"\/js\/src\/world\/hydrology-ir\.mjs"/);
  assert.match(serverSource, /Explicit allow-list only/);
  assert.match(paintSource, /WA\.importWorldMapWater\(worldMap, toTarget\)/);
});
