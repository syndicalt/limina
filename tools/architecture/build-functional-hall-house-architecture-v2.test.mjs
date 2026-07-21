import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import {
  buildFunctionalHallHouseArchitectureV2,
  DEFAULT_SOURCE,
} from "./build-functional-hall-house-architecture-v2.mjs";

describe("functional hall house architecture v2 derivation", () => {
  const source = JSON.parse(fs.readFileSync(DEFAULT_SOURCE, "utf8"));
  const result = buildFunctionalHallHouseArchitectureV2(source);

  test("preserves v1 and opts the revision into constrained construction", () => {
    expect(source.id).toBe("hall-house/temperate/architecture-v1");
    expect(source.dormers[0].hostConnection).toBeUndefined();
    expect(result.id).toBe("hall-house/temperate/architecture-v2");
    expect(result.dormers[0]).toMatchObject({
      width: 1.8,
      eaveY: 5.92,
      roofPitchDegrees: 35,
      windowSillY: 4.82,
      hostConnection: "intersecting-gable",
    });
  });

  test("binds the lowered mantel and its props to the fireplace support", () => {
    const mantel = result.interiorStructure.find(
      (item) => item.id === "hearth-mantel",
    );
    expect(mantel).toMatchObject({
      center: [2.95, 2.2, 1.936],
      fireplaceId: "hall-hearth",
      placementPolicy: "fireplace-clearance",
    });
    for (const id of ["mantel-candle", "mantel-jug"])
      expect(result.domesticProps.find((item) => item.id === id)).toMatchObject({
        center: expect.arrayContaining([2.3, 1.936]),
        supportY: 2.3,
        supportStructureId: "hearth-mantel",
      });
  });
});
