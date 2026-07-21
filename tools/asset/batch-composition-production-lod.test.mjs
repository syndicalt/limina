import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFunctionalBuildingContract } from "../../js/src/assets/functional-building-contract.ts";
import { parseFunctionalBuildingStaticBatch } from "../../js/src/skills/functional-building-lod.ts";
import { batchCompositionProductionLod, transformCompositionNormal } from "./batch-composition-production-lod.mjs";

const SOURCE = "assets/buildings/authoring/functional-hall-house-v4/composition-r3/furnished-c1-r3.glb";
const MATERIAL_RUNTIME = "assets/buildings/authoring/functional-hall-house-v4/material-r2/runtime/shell-m1-production.glb";
const parseGlbJson = (bytes) => {
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString().trim());
};
// A +90-degree Y rotation combined with nonuniform [2,3,4] scale. Column-vector
// positions map local +X to world -Z; inverse-transpose normals must do likewise.
const rotatedNonuniform = [0, 0, -2, 0, 0, 3, 0, 0, 4, 0, 0, 0, 0, 0, 0, 1];
assert.deepEqual(transformCompositionNormal(rotatedNonuniform, [1, 0, 0]), [0, 0, -1]);
const diagonal = transformCompositionNormal(rotatedNonuniform, [Math.SQRT1_2, Math.SQRT1_2, 0]);
assert(Math.abs(diagonal[0]) < 1e-12);
assert(Math.abs(diagonal[1] - 0.5547001962252291) < 1e-12);
assert(Math.abs(diagonal[2] + 0.8320502943378437) < 1e-12);
const transformedTangent = [0, -3, -2]; // matrix * local [1,-1,0]
assert(Math.abs(diagonal.reduce((sum, value, axis) => sum + value * transformedTangent[axis], 0)) < 1e-12, "normal lost tangent orthogonality");

await mkdir(".limina", { recursive: true });
const directory = await mkdtemp(".limina/composition-production-lod-test-");
try {
  const output = join(directory, "nested", "c1-production-lod.glb");
  const result = await batchCompositionProductionLod(SOURCE, output);
  assert.equal(result.sourceSha256, "adabb56bd808ea0731ec6f45531bc99ecb7670a8cf232769c9e93cc3c8fe94dd");
  assert.equal(result.compositionId, "composition/functional-hall-house-v4/r3");
  assert.equal(result.doorRoot, 79);
  assert.deepEqual(result.measurements.map(({ level, triangles, sourcePrimitiveCount }) => ({ level, triangles, sourcePrimitiveCount })), [
    { level: 0, triangles: 9132, sourcePrimitiveCount: 487 },
    { level: 1, triangles: 5052, sourcePrimitiveCount: 279 },
    { level: 2, triangles: 2748, sourcePrimitiveCount: 231 },
  ]);
  assert.deepEqual(result.representationDedupe, { sourceTextures: 90, textures: 21, sourceMaterials: 34, materials: 16, images: 21 });

  const bytes = await readFile(output);
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const gltf = parseGlbJson(bytes);
  const sourceGltf = parseGlbJson(await readFile(SOURCE));
  const materialGltf = parseGlbJson(await readFile(MATERIAL_RUNTIME));
  const batch = gltf.asset.extras.liminaStaticBatch;
  assert.deepEqual(gltf.asset.extras.liminaFunctionalBuilding, materialGltf.asset.extras.liminaFunctionalBuilding,
    "functional authority was not restored exactly from the approved M1 runtime");
  const functional = parseFunctionalBuildingContract(bytes);
  assert.equal(functional.buildingId, "hall-house/temperate/v4");
  assert.equal(functional.rootNodeId, "building/root");
  assert.equal(functional.colliders.length, 37, "shell functional collider contract drifted");
  assert.equal(functional.doors.length, 1, "operable door contract drifted");
  assert.deepEqual(parseFunctionalBuildingStaticBatch(bytes), { lodRoots: batch.lodRoots, doorRoot: batch.doorRoot });
  assert.equal(batch.schema, "limina.static-batch/1");
  assert.equal(batch.furniturePolicy, "LOD0-only");
  assert.equal(gltf.textures.length, 21);
  assert.equal(gltf.materials.length, 16);
  assert.equal(gltf.images.length, 21);
  assert.equal(new Set(batch.lodRoots).size, 3);
  const semanticIds = gltf.nodes.map((node) => node.extras?.limina?.id ?? node.extras?.["limina.id"]).filter((id) => typeof id === "string");
  assert.equal(semanticIds.length, 654);
  assert.equal(new Set(semanticIds).size, 654);
  assert.equal(gltf.nodes.filter((node) => (node.extras?.limina?.role ?? node.extras?.["limina.role"]) === "collider").length, 123);
  assert.equal(gltf.nodes.filter((node) => (node.extras?.limina?.role ?? node.extras?.["limina.role"]) === "socket").length, 12);
  assert.equal(gltf.nodes.filter((node) => (node.extras?.limina?.role ?? node.extras?.["limina.role"]) === "composition-instance").length, 7);

  const descendants = (root) => {
    const found = new Set();
    const visit = (index) => {
      assert(!found.has(index), `cycle or duplicate below node ${root}`);
      found.add(index);
      for (const child of gltf.nodes[index].children ?? []) visit(child);
    };
    visit(root);
    return found;
  };
  const doorNodes = descendants(batch.doorRoot);
  assert.equal(doorNodes.size, 14);
  assert.equal([...doorNodes].filter((index) => gltf.nodes[index].mesh !== undefined).length, 14, "articulated door meshes were stripped");
  const doorTriangles = [...doorNodes].reduce((sum, index) => {
    const mesh = gltf.meshes[gltf.nodes[index].mesh];
    return sum + mesh.primitives.reduce((meshSum, primitive) => meshSum + gltf.accessors[primitive.indices].count / 3, 0);
  }, 0);
  assert.equal(doorTriangles, 168);
  assert.equal(batch.measurements[0].triangles + doorTriangles, 9300, "full LOD0-visible triangle closure drifted");
  for (const root of batch.lodRoots) for (const node of doorNodes) assert(!descendants(root).has(node), "door leaked into a static LOD root");

  const buildingRoot = gltf.nodes.findIndex((node) => node.extras?.limina?.id === "building/root" && node.extras?.limina?.role === "root");
  const compositionRoot = gltf.nodes.findIndex((node) => node.extras?.["limina.id"] === "composition/functional-hall-house-v4/r3"
    && node.extras?.["limina.role"] === "building-composition");
  assert.equal(buildingRoot, 393);
  assert.equal(compositionRoot, 654);
  assert.deepEqual(gltf.scenes[gltf.scene].nodes, [buildingRoot], "building/root is not the sole canonical scene root");
  assert.deepEqual(gltf.nodes[buildingRoot].children.slice(-4), [compositionRoot, ...batch.lodRoots],
    "composition and all LOD roots are not direct children of building/root");
  const buildingDescendants = descendants(buildingRoot);
  for (const [index, node] of gltf.nodes.entries()) {
    const semanticId = node.extras?.limina?.id ?? node.extras?.["limina.id"];
    if (typeof semanticId === "string") assert(buildingDescendants.has(index), `semantic node ${semanticId} is outside building/root`);
  }
  assert.equal([...buildingDescendants].filter((index) => {
    const node = gltf.nodes[index];
    return typeof (node.extras?.limina?.id ?? node.extras?.["limina.id"]) === "string";
  }).length, 654, "not all semantic nodes descend from building/root");

  for (let index = 0; index < sourceGltf.nodes.length; index++) {
    const before = sourceGltf.nodes[index], after = gltf.nodes[index];
    for (const key of ["matrix", "translation", "rotation", "scale"]) assert.deepEqual(after[key], before[key], `source transform ${index}.${key} changed`);
    assert.deepEqual(after.extras?.limina, before.extras?.limina, `nested semantic authority on node ${index} changed`);
    for (const key of Object.keys(before.extras ?? {}).filter((key) => key.startsWith("limina."))) {
      assert.deepEqual(after.extras?.[key], before.extras[key], `semantic authority on node ${index}.${key} changed`);
    }
    if (index !== buildingRoot) assert.deepEqual(after.children, before.children, `source hierarchy below node ${index} changed`);
  }

  let shellSources = 0, furnitureSources = 0;
  for (const [index, node] of gltf.nodes.entries()) {
    const shell = node.extras?.limina?.role === "architecture-primitive" && !doorNodes.has(index);
    const furniture = node.extras?.["limina.role"] === "furniture-part";
    if (!shell && !furniture) continue;
    shell ? shellSources++ : furnitureSources++;
    assert.equal(node.mesh, undefined, `static source ${index} retained duplicate visual geometry`);
    assert.equal(node.extras.visualBatchRange?.schema, "limina.visual-batch-range/1");
    assert.equal(node.extras.visualBatchRange?.authoritative, true);
  }
  assert.equal(shellSources, 339);
  assert.equal(furnitureSources, 148);

  const materialProperties = gltf.materials.map((material) => {
    const { name: _name, ...properties } = material;
    return JSON.stringify(properties);
  });
  assert.equal(new Set(materialProperties).size, 16, "canonical material duplicates remain");
  assert.equal(new Set(gltf.textures.map((texture) => JSON.stringify(texture))).size, 21, "canonical texture duplicates remain");

  const deterministicOutput = join(directory, "c1-production-lod-repeat.glb");
  const repeated = await batchCompositionProductionLod(SOURCE, deterministicOutput);
  assert.equal(repeated.sha256, result.sha256, "same exact approved input did not produce deterministic bytes");
  assert.deepEqual(await readFile(deterministicOutput), bytes);

  await assert.rejects(batchCompositionProductionLod(SOURCE, output), /EEXIST/, "append-only output was overwritten");
  const tampered = join(directory, "tampered.glb");
  const source = await readFile(SOURCE);
  const changed = Buffer.from(source); changed[changed.length - 1] ^= 1;
  await writeFile(tampered, changed, { flag: "wx" });
  await assert.rejects(batchCompositionProductionLod(tampered, join(directory, "tampered-output.glb")), /source hash mismatch/);
  await assert.rejects(batchCompositionProductionLod(SOURCE, "../escape.glb"), /escapes the workspace/);

  console.log(`batch-composition-production-lod OK: ${result.measurements.map((entry) => `LOD${entry.level} ${entry.triangles} tris/${entry.draws} draws`).join(", ")}; door isolated; furniture LOD0-only; 90->21 textures and 34->16 materials`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
