import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_SOURCE = path.join(
  ROOT,
  "assets/buildings/functional-hall-house-architecture-v1.json",
);
export const DEFAULT_OUTPUT = path.join(
  ROOT,
  "assets/buildings/functional-hall-house-architecture-v2.json",
);

export function buildFunctionalHallHouseArchitectureV2(source) {
  const next = structuredClone(source);
  if (next.id !== "hall-house/temperate/architecture-v1")
    throw new Error(`architecture-v2: unexpected source id ${next.id}`);
  next.id = "hall-house/temperate/architecture-v2";

  const dormer = next.dormers?.find((item) => item.id === "dormer/south");
  if (!dormer) throw new Error("architecture-v2: south dormer is missing");
  Object.assign(dormer, {
    width: 1.8,
    eaveY: 5.92,
    roofPitchDegrees: 35,
    windowSillY: 4.82,
    hostConnection: "intersecting-gable",
  });

  const mantel = next.interiorStructure?.find(
    (item) => item.id === "hearth-mantel",
  );
  if (!mantel) throw new Error("architecture-v2: hearth mantel is missing");
  Object.assign(mantel, {
    center: [2.95, 2.2, 1.936],
    fireplaceId: "hall-hearth",
    placementPolicy: "fireplace-clearance",
  });

  for (const id of ["mantel-candle", "mantel-jug"]) {
    const prop = next.domesticProps?.find((item) => item.id === id);
    if (!prop) throw new Error(`architecture-v2: ${id} is missing`);
    prop.center[1] = 2.3;
    prop.center[2] = 1.936;
    prop.supportY = 2.3;
    prop.supportStructureId = "hearth-mantel";
  }
  return next;
}

export function writeFunctionalHallHouseArchitectureV2({
  sourcePath = DEFAULT_SOURCE,
  outputPath = DEFAULT_OUTPUT,
} = {}) {
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const result = buildFunctionalHallHouseArchitectureV2(source);
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
  return outputPath;
}

if (import.meta.main) {
  const outputPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_OUTPUT;
  console.log(writeFunctionalHallHouseArchitectureV2({ outputPath }));
}
