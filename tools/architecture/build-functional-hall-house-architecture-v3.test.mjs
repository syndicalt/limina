import { expect, test } from "bun:test";
import fs from "node:fs";
import {
  buildFunctionalHallHouseArchitectureV3,
  DEFAULT_SOURCE,
} from "./build-functional-hall-house-architecture-v3.mjs";

test("v3 opts into roof bearing, finished surfaces, hearth support, and bounded site bearing", () => {
  const source = JSON.parse(fs.readFileSync(DEFAULT_SOURCE, "utf8"));
  const result = buildFunctionalHallHouseArchitectureV3(source);
  expect(source.id).toBe("hall-house/temperate/architecture-v2");
  expect(result.id).toBe("hall-house/temperate/architecture-v3");
  expect(result.dormers[0].roofWallConnection).toBe("soffit-bearing");
  expect(result.entrances[0]).toMatchObject({
    constructionPolicy: "finished-surface-authority",
    bearingDepth: 0.1,
  });
  expect(result.fireplaces[0].supportY).toBe(0.09);
  expect(result.functional.site).toMatchObject({
    maximumTerrainRelief: 0.5,
    entranceSupport: {
      center: [-0.72, -4.63],
      halfExtents: [0.86, 0.19],
      exteriorGradeY: -0.31,
      bearingDepth: 0.1,
    },
  });
});
