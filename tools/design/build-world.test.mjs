import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planWorldBuild } from "./build-world.mjs";
import { EROSION_RECIPE_SCHEMA, NO_EROSION_RECIPE } from "../../js/src/world/pipeline/erosion.mjs";
import { ATLAS_DESIGN_REF_SCHEMA } from "../../js/src/world/design-ref.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(`build-world.test: ${message}`);
}

const root = mkdtempSync(join(tmpdir(), "limina-build-world-"));
try {
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "house.glb"), "asset");
  const worldMap = {
    origin: [0, 0], unitsPerMeter: 1, seaLevel: 2,
    land: [{ points: [[-900, -700], [900, -700], [900, 700], [-900, 700]] }],
    relief: [], biomes: [{ biome: "forest", points: [[-100, -100], [100, -100], [100, 100], [-100, 100]] }],
    waterways: [{ points: [[-500, 0], [500, 0]], widthM: 8 }], routes: [],
    anchors: [{
      id: "settlement", kind: "asset", position: [30, 40], assetId: "house.glb",
      designRef: { schema: ATLAS_DESIGN_REF_SCHEMA, mapId: "primary", kind: "place", id: "settlement" },
    }],
    gazetteer: [{ placeId: "settlement", name: "Settlement", kind: "hamlet", position: [30, 40] }],
  };
  const plan = planWorldBuild({ projectRoot: root, worldMap, mapAssetId: "maps/primary/hash.worldmap.json", seed: 17 });
  assert(plan.size >= 2250, "terrain size must derive from map extent instead of a fixed demo size");
  assert(plan.resolution % 2 === 1, "terrain heightfield resolution must be odd");
  assert(plan.commands.some((command) => command.tool === "world.addRiver"), "waterways must produce river commands");
  assert(plan.commands.some((command) => command.tool === "asset.place"), "asset anchors must produce placements");
  const placement = plan.commands.find((command) => command.tool === "asset.place");
  assert(JSON.stringify(placement.input.designRef) === JSON.stringify(worldMap.anchors[0].designRef)
      && Object.isFrozen(placement.input.designRef),
    "asset placements must preserve the parsed Atlas designRef");
  assert(!JSON.stringify(plan).includes("Eastern Watch"), "general builder must not contain project-specific content");
  const terrain = plan.commands.find((command) => command.tool === "terrain.create");
  assert(terrain.input.generate.erosion.schema === EROSION_RECIPE_SCHEMA && terrain.input.generate.erosion.enabled === true,
    "world build must record the canonical versioned erosion recipe");

  const compatible = planWorldBuild({
    projectRoot: root,
    worldMap,
    mapAssetId: "maps/primary/hash.worldmap.json",
    seed: 17,
    erosionRecipe: NO_EROSION_RECIPE,
  });
  const compatibleTerrain = compatible.commands.find((command) => command.tool === "terrain.create");
  assert(JSON.stringify(compatibleTerrain.input.generate.erosion) === JSON.stringify(NO_EROSION_RECIPE),
    "disabled build mode must record the exact compatibility recipe");

  let malformedRecipeRejected = false;
  try {
    planWorldBuild({
      projectRoot: root,
      worldMap,
      mapAssetId: "maps/primary/hash.worldmap.json",
      erosionRecipe: { ...NO_EROSION_RECIPE, rain: 1 },
    });
  } catch (error) {
    malformedRecipeRejected = String(error).includes("requires exactly");
  }
  assert(malformedRecipeRejected, "world builder accepted a malformed erosion recipe");

  const escaped = structuredClone(worldMap);
  escaped.anchors[0].assetId = "../outside.glb";
  let rejected = false;
  try { planWorldBuild({ projectRoot: root, worldMap: escaped, mapAssetId: "maps/primary/hash.worldmap.json" }); }
  catch (error) { rejected = String(error).includes("escapes the project asset root"); }
  assert(rejected, "asset anchors must not escape the project asset root");

  const malformedRef = structuredClone(worldMap);
  malformedRef.anchors[0].designRef.label = "not identity";
  let malformedRefRejected = false;
  try { planWorldBuild({ projectRoot: root, worldMap: malformedRef, mapAssetId: "maps/primary/hash.worldmap.json" }); }
  catch (error) { malformedRefRejected = String(error).includes("designRef fields are invalid"); }
  assert(malformedRefRejected, "world builder accepted a malformed Atlas designRef");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("build-world.test OK");
