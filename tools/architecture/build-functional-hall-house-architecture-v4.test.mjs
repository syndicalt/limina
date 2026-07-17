import { expect, test } from "bun:test";
import fs from "node:fs";
import {
  buildFunctionalHallHouseArchitectureV4,
  DEFAULT_SOURCE,
} from "./build-functional-hall-house-architecture-v4.mjs";

test("v4 binds terrain support to the exact lowest structural tread", () => {
  const source = JSON.parse(fs.readFileSync(DEFAULT_SOURCE, "utf8"));
  const result = buildFunctionalHallHouseArchitectureV4(source);
  expect(source.id).toBe("hall-house/temperate/architecture-v3");
  expect(result.id).toBe("hall-house/temperate/architecture-v4");
  expect(result.functional.site.entranceSupport.sourcePrimitiveId).toBe(
    "entrance/front-entry/step-0",
  );
});
