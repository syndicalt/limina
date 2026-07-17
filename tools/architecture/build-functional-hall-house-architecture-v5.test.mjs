import {expect,test} from "bun:test";
import fs from "node:fs";
import {buildFunctionalHallHouseArchitectureV5,DEFAULT_SOURCE} from "./build-functional-hall-house-architecture-v5.mjs";

test("v5 removes the omitted-tread horizontal gap",()=>{
  const source=JSON.parse(fs.readFileSync(DEFAULT_SOURCE,"utf8")),result=buildFunctionalHallHouseArchitectureV5(source);
  expect(source.id).toBe("hall-house/temperate/architecture-v4");expect(result.id).toBe("hall-house/temperate/architecture-v5");expect(result.functional.site.entranceSupport.center).toEqual([-.72,-4.25]);
});
