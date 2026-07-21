import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findPropertyAssignments, literalValue, parseTypeScript } from "./test-source-semantics.mjs";
const build = await readFile(new URL("./build-furniture-contract.ts", import.meta.url), "utf8"),
  adapter = await readFile(new URL("../blender/furniture-contract-adapter.py", import.meta.url), "utf8"),
  validator = await readFile(new URL("../blender/validate-furniture-contract-blend.py", import.meta.url), "utf8");
for (const token of [
  "resolveBlender",
  "--factory-startup",
  "furnitureDesignContractHash",
  "finiteAccessorBounds",
  "liminaMaterialSources",
])
  assert.ok(build.includes(token), `build missing ${token}`);
const buildFile = parseTypeScript(build, "build-furniture-contract.ts");
for (const property of ["rendered", "gpuUsed"])
  assert.ok(
    findPropertyAssignments(buildFile, property).some((entry) => literalValue(entry.initializer) === false),
    `build must record ${property}: false`,
  );
for (const token of [
  "limina.blender-furniture-handoff/v1",
  "cottage-structural-oak",
  "Poly Haven",
  "CC0-1.0",
  "fieldedPanel",
  "profileHorizontalAxis",
  "export_extras=True",
  "save_as_mainfile",
])
  assert.ok(adapter.includes(token), `adapter missing ${token}`);
for (const token of [
  "occupancy mismatch",
  "whole-AABB collision is forbidden",
  "semantic inventory",
  "CAMERA",
  "LIGHT",
])
  assert.ok(validator.includes(token), `validator missing ${token}`);
console.log("furniture contract Blender build static checks passed");
