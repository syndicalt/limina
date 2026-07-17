import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_SOURCE = path.join(
  ROOT,
  "assets/buildings/functional-hall-house-architecture-v3.json",
);
export const DEFAULT_OUTPUT = path.join(
  ROOT,
  "assets/buildings/functional-hall-house-architecture-v4.json",
);

export function buildFunctionalHallHouseArchitectureV4(source) {
  const next = structuredClone(source);
  if (next.id !== "hall-house/temperate/architecture-v3")
    throw new Error(`architecture-v4: unexpected source id ${next.id}`);
  next.id = "hall-house/temperate/architecture-v4";
  const support = next.functional?.site?.entranceSupport;
  if (!support)
    throw new Error("architecture-v4: entrance support authority is missing");
  support.sourcePrimitiveId = "entrance/front-entry/step-0";
  return next;
}

export function writeFunctionalHallHouseArchitectureV4({
  sourcePath = DEFAULT_SOURCE,
  outputPath = DEFAULT_OUTPUT,
} = {}) {
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const result = buildFunctionalHallHouseArchitectureV4(source);
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
  return outputPath;
}

if (import.meta.main) {
  const outputPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_OUTPUT;
  console.log(writeFunctionalHallHouseArchitectureV4({ outputPath }));
}
