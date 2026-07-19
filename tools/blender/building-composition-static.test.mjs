import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const adapterPath = "tools/blender/building-composition-adapter.py",
  validatorPath = "tools/blender/validate-building-composition-blend.py",
  bridgePath = "tools/blender/m1_ktx2_import_bridge.py";
const adapter = readFileSync(adapterPath, "utf8"),
  validator = readFileSync(validatorPath, "utf8"),
  bridge = readFileSync(bridgePath, "utf8"),
  legacySchema = readFileSync("js/src/assets/building-composition-manifest.mjs", "utf8"),
  v2Schema = readFileSync("js/src/assets/building-composition-manifest-v2.mjs", "utf8");
for (const [path, source] of [
  [adapterPath, adapter],
  [validatorPath, validator],
]) {
  const syntax = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
    input: source,
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, `${path} is not valid Python: ${syntax.stderr}`);
  assert.match(source, /limina\.building-composition-manifest\/v2/);
  assert.match(source, /artifactSha256/);
  assert.match(source, /materialPalette/);
  assert.match(source, /source_fingerprint/);
  assert.match(source, /material_signature/);
  assert.match(source, /CAMERA.*LIGHT|LIGHT.*CAMERA/s);
  assert.doesNotMatch(source, /render\(/);
  assert.doesNotMatch(source, /\(46,\s*33,\s*5,\s*7/);
}

// Manifest v1 remains independently validated and byte-path distinct. Executable
// Blender composition intentionally fails closed unless the append-only v2 schema
// supplies approved M1, I1, catalog evidence, and dynamic instances.
assert.match(legacySchema, /limina\.building-composition-manifest\/v1/);
assert.doesNotMatch(legacySchema, /building-composition-manifest\/v2/);
assert.match(v2Schema, /limina\.building-composition-manifest\/v2/);
assert.match(adapter, /composition adapter requires manifest v2/);
assert.match(validator, /validator requires a non-empty composition manifest v2/);

// The derived C1 .blend starts from exact approved M1 runtime bytes. The editable
// A1 source is hash/provenance only and can never silently become the beauty shell.
assert.match(adapter, /bpy\.ops\.wm\.read_factory_settings\(use_empty=True\)/);
assert.match(adapter, /derive_import_bridge/);
assert.match(adapter, /bpy\.ops\.import_scene\.gltf\(filepath=material_import_path\)/);
assert.doesNotMatch(adapter, /bpy\.ops\.import_scene\.gltf\(filepath=material_runtime_path\)/);
assert.doesNotMatch(adapter, /bpy\.ops\.wm\.open_mainfile/);
assert.match(adapter, /refusing unmaterialized fallback/);
assert.match(adapter, /KHR_texture_basisu/);
assert.match(adapter, /liminaMaterialSources/);
assert.match(adapter, /10_MATERIALIZED_SHELL/);
assert.match(adapter, /limina\.materializedShellRuntimeGlbHash/);
assert.match(adapter, /limina\.materializedShellImportBridgeJson/);
assert.match(adapter, /limina\.materializedShellFingerprint/);
assert.match(adapter, /limina\.sourceGlbNodeIndex/);
assert.match(adapter, /materializedShellStructuralNodes/);
assert.match(adapter, /did not establish every exact material image/);

// Catalog and instance inventories are discovered from each exact approved source.
assert.match(adapter, /for instance in resolved\["instances"\]/);
assert.match(adapter, /len\(roots\) != 1 or roots\[0\]\.get\("limina\.role"\) != catalog\["role"\]/);
assert.match(adapter, /source contains a hierarchy island/);
assert.match(adapter, /limina\.sourceId/);
assert.match(adapter, /limina\.compositionInstancesJson/);
assert.match(adapter, /limina\.sourceCatalogBlendHashesJson/);
assert.match(adapter, /export_lights=False, export_cameras=False/);
assert.doesNotMatch(adapter, /len\(instances\) != 1|exactly one approved instance/);
assert.doesNotMatch(adapter, /source_roots.*hearth-settle/);
assert.match(adapter, /composition_id = manifest\["id"\]/);
assert.doesNotMatch(adapter, /f"composition\/\{manifest\['id'\]\}"/);
assert.match(validator, /composition_id = manifest\["id"\]/);

// Fresh validation independently reimports M1 and every instance source, comparing
// dynamic semantic sets, hierarchy, custom properties, transforms, and content.
assert.match(validator, /derive_import_bridge/);
assert.match(validator, /bpy\.ops\.import_scene\.gltf\(filepath=material_import_path\)/);
assert.doesNotMatch(validator, /bpy\.ops\.import_scene\.gltf\(filepath=material_runtime_path\)/);
assert.match(validator, /materialized shell deterministic import bridge identity drifted/);
assert.match(validator, /for instance in manifest\["instances"\]/);
assert.match(validator, /bpy\.data\.libraries\.load\(source_path, link=False\)/);
assert.match(validator, /composed shell differs from the exact approved M1 runtime/);
assert.match(validator, /differs from its exact approved source blend/);
assert.match(validator, /source custom property drifted/);
assert.match(validator, /expected_instance_matrix/);
assert.match(validator, /legacy semantic survived/);
assert.match(validator, /verify_stage_ref/);
assert.match(validator, /verify_approval/);
assert.match(validator, /A1-shell/);
assert.match(validator, /M1-materials/);
assert.match(validator, /I1-layout/);
assert.match(validator, /F1-asset/);
assert.match(validator, /structural transform\/hierarchy fingerprint drifted/);

// The bridge is tied to the package-local KTX executable by exact path, version,
// and binary hash, uses deterministic RGBA8 extraction, and rewrites only the
// temporary GLB. Its focused CPU test derives twice and checks byte identity.
assert.match(bridge, /js\/.tools\/ktx\/4\.4\.2\/linux-arm64\/root\/usr\/bin\/ktx/);
assert.match(bridge, /sha256:1699bb4bfc7bee62cf27496d1c02f85e560e3f78b1e7a7651243fc7fde271029/);
assert.match(bridge, /extract.*--testrun.*--transcode.*rgba8/s);
assert.match(bridge, /KHR_texture_basisu/);
assert.match(bridge, /image\/png/);
assert.doesNotMatch(bridge, /shell-r4|open_mainfile|pip\s+install|apt-get/);
const bridgeTest = spawnSync("python3", ["tools/blender/m1_ktx2_import_bridge.test.py"], { encoding: "utf8" });
assert.equal(bridgeTest.status, 0, bridgeTest.stderr);
assert.match(bridgeTest.stdout, /validated without Blender/);

console.log(
  "building composition v2 materialized-shell adapter and dynamic fresh-process validator static gates validated; v1 JS validation preserved separately",
);
