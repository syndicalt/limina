import assert from "node:assert/strict";import{readFile}from"node:fs/promises";
const build=await readFile(new URL("./build-furniture-contract.ts",import.meta.url),"utf8"),adapter=await readFile(new URL("../blender/furniture-contract-adapter.py",import.meta.url),"utf8"),validator=await readFile(new URL("../blender/validate-furniture-contract-blend.py",import.meta.url),"utf8");
for(const token of["resolveBlender","--factory-startup","furnitureDesignContractHash","finiteAccessorBounds","liminaMaterialSources","rendered:false","gpuUsed:false"])assert.ok(build.includes(token),`build missing ${token}`);
for(const token of["limina.blender-furniture-handoff/v1","cottage-structural-oak","Poly Haven","CC0-1.0","fieldedPanel","profileHorizontalAxis","export_extras=True","save_as_mainfile"])assert.ok(adapter.includes(token),`adapter missing ${token}`);
for(const token of["occupancy mismatch","whole-AABB collision is forbidden","semantic inventory","CAMERA","LIGHT"])assert.ok(validator.includes(token),`validator missing ${token}`);
console.log("furniture contract Blender build static checks passed");
