import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const driver=readFileSync(new URL("./build-building.ts",import.meta.url),"utf8");
const adapter=readFileSync(new URL("../blender/architecture-adapter.py",import.meta.url),"utf8");
const validator=readFileSync(new URL("../blender/validate-architecture-blend.py",import.meta.url),"utf8");
const addon=readFileSync(new URL("../blender/limina-authoring-addon.py",import.meta.url),"utf8");
const opener=readFileSync(new URL("./open-authoring.mjs",import.meta.url),"utf8");

test("architecture build preserves and independently reopens an editable Blender source",()=>{
  assert.match(driver,/--blend-out/);assert.match(driver,/--handoff/);
  assert.match(driver,/validate-architecture-blend\.py/);
  assert.match(driver,/limina\.blender-authoring-handoff\/v1/);
  assert.match(driver,/canonicalSource:"blend\+recipe"/);
  assert.match(driver,/genericGltfExportAllowed:false/);
  assert.match(driver,/modifierPreservation:"partial\/applied-edge-easing"/);
  assert.match(adapter,/save_as_mainfile\(filepath=BLEND_OUT,compress=True\)/);
  assert.ok(adapter.indexOf("save_as_mainfile")<adapter.indexOf("export_scene.gltf"),"source blend must be saved before delivery export");
  for(const collection of ["00_READ_ME","10_GENERATED_STRUCTURE","20_ARTIST_SURFACES","30_INTERIOR_DRESSING","40_ARTICULATION","COLLISION","SOCKETS","VFX_ANCHORS","90_EXPORT"]){
    assert.match(adapter,new RegExp(collection));assert.match(validator,new RegExp(collection));
  }
  for(const property of ["limina.id","limina.role","limina.owner","limina.editPolicy","limina.lodLevels"]){
    assert.match(adapter,new RegExp(property.replace(".","\\.")));
  }
  assert.match(validator,/duplicate semantic id/);
  assert.match(validator,/source blend recipe identity drifted/);
});

test("beginner authoring launcher supplies honest session-scoped Blender controls",()=>{
  assert.match(opener,/resolveBlender/);assert.match(opener,/limina-authoring-addon\.py/);
  assert.match(opener,/furnished-c1-r3\.blend/);assert.match(opener,/\.limina\/authoring-sessions/);
  assert.match(opener,/COPYFILE_EXCL/);assert.match(opener,/0o700/);assert.match(opener,/approvedSourceImmutable: true/);
  assert.match(opener,/genericGltfExportAllowed: false/);assert.match(opener,/validateBuildingHitlDecision/);
  assert.match(addon,/bl_category\s*=\s*"Limina"/);assert.match(addon,/limina\.validate_source/);
  assert.match(addon,/limina\.blender-authoring-handoff\/v1/);assert.match(addon,/limina\.blender-building-composition-handoff\/v2/);
  assert.match(addon,/Expected exactly seven bounded composition handles/);assert.match(addon,/composition-instance/);
  assert.match(addon,/hide_select = not safe/);assert.match(addon,/lock_scale/);
  assert.match(addon,/limina\.engine_preview/);assert.match(addon,/limina\.submit_revision/);
  assert.match(addon,/host orchestrator is unavailable/);assert.match(addon,/Protected/);
  assert.match(addon,/save_verified_private_working_copy/);assert.match(addon,/save_as_mainfile\(filepath=str\(working\)/);
  assert.ok(addon.indexOf("save_verified_private_working_copy()")<addon.indexOf("subprocess.Popen(command"),"verified private save must precede host invocation");
  assert.doesNotMatch(addon,/export_scene\.gltf/);
});
