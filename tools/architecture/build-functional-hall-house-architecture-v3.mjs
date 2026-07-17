import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_SOURCE = path.join(
  ROOT,
  "assets/buildings/functional-hall-house-architecture-v2.json",
);
export const DEFAULT_OUTPUT = path.join(
  ROOT,
  "assets/buildings/functional-hall-house-architecture-v3.json",
);

export function buildFunctionalHallHouseArchitectureV3(source) {
  const next = structuredClone(source);
  if (next.id !== "hall-house/temperate/architecture-v2")
    throw new Error(`architecture-v3: unexpected source id ${next.id}`);
  next.id = "hall-house/temperate/architecture-v3";

  const dormer = next.dormers?.find((item) => item.id === "dormer/south");
  if (!dormer?.hostConnection)
    throw new Error("architecture-v3: connected south dormer is missing");
  dormer.roofWallConnection = "soffit-bearing";

  const entrance = next.entrances?.find((item) => item.id === "front-entry");
  if (!entrance) throw new Error("architecture-v3: front entrance is missing");
  entrance.constructionPolicy = "finished-surface-authority";
  entrance.bearingDepth = 0.1;

  const fireplace = next.fireplaces?.find((item) => item.id === "hall-hearth");
  if (!fireplace) throw new Error("architecture-v3: hall fireplace is missing");
  fireplace.supportY = next.functional.site.finishedFloorY;

  next.functional.site.maximumTerrainRelief = 0.5;
  next.functional.site.entranceSupport = {
    center: [-0.72, -4.63],
    halfExtents: [0.86, 0.19],
    yawRadians: 0,
    exteriorGradeY: entrance.exteriorGradeY,
    bearingDepth: entrance.bearingDepth,
    maximumCutDepth: 0.04,
    maximumVariation: 0.08,
  };
  return next;
}

export function writeFunctionalHallHouseArchitectureV3({
  sourcePath = DEFAULT_SOURCE,
  outputPath = DEFAULT_OUTPUT,
} = {}) {
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const result = buildFunctionalHallHouseArchitectureV3(source);
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
  return outputPath;
}

if (import.meta.main) {
  const outputPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_OUTPUT;
  console.log(writeFunctionalHallHouseArchitectureV3({ outputPath }));
}
