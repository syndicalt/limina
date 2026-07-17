import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { flattenVegetationGlb, SUMMARY_SCHEMA } from "./flatten-vegetation-glb.mjs";
import { inspectGlbAsset, sha256 } from "../qc/asset-manifest.mjs";

const PNG_1X1 = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

async function fixture(path, materialCount = 1, unusedVertex = false) {
  const document = new Document();
  const buffer = document.createBuffer();
  const texture = document.createTexture("pixel").setMimeType("image/png").setImage(PNG_1X1);
  const materials = Array.from({ length: materialCount }, (_, index) => document.createMaterial(`ground-${index}`)
    .setBaseColorFactor([0.2 + index * 0.1, 0.6, 0.15, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.85)
    .setBaseColorTexture(texture)
    .setMetallicRoughnessTexture(texture)
    .setNormalTexture(texture));
  const scene = document.createScene("scene");
  for (let index = 0; index < 4; index++) {
    const positions = document.createAccessor().setType("VEC3")
      .setArray(new Float32Array(unusedVertex
        ? [0, 0, 0, 1, 0, 0, 0, 1, 0, 50, 50, 50]
        : [0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
    const normals = document.createAccessor().setType("VEC3")
      .setArray(new Float32Array(unusedVertex
        ? [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]
        : [0, 0, 1, 0, 0, 1, 0, 0, 1])).setBuffer(buffer);
    const uvs = document.createAccessor().setType("VEC2")
      .setArray(new Float32Array(unusedVertex ? [0, 0, 1, 0, 0, 1, 1, 1] : [0, 0, 1, 0, 0, 1])).setBuffer(buffer);
    const primitive = document.createPrimitive().setAttribute("POSITION", positions)
      .setAttribute("NORMAL", normals).setAttribute("TEXCOORD_0", uvs)
      .setMaterial(materials[index % materialCount]);
    if (unusedVertex) primitive.setIndices(document.createAccessor().setType("SCALAR").setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer));
    const mesh = document.createMesh(`part-${index}`).addPrimitive(primitive);
    scene.addChild(document.createNode(`node-${index}`).setTranslation([index * 2, index * 0.25, 0]).setMesh(mesh));
  }
  document.getRoot().setDefaultScene(scene);
  await writeFile(path, await new NodeIO().writeBinary(document));
}

test("losslessly flattens deterministic multi-node vegetation and preserves texture payloads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "limina-flatten-vegetation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "source.glb");
  const outputA = join(directory, "flat-a.glb");
  const outputB = join(directory, "flat-b.glb");
  await fixture(input);
  const sourceBytes = await readFile(input);
  const sourceMetrics = inspectGlbAsset(sourceBytes);

  const first = await flattenVegetationGlb({ input, output: outputA, maxMeshes: 1 });
  const second = await flattenVegetationGlb({ input, output: outputB, maxMeshes: 1 });
  assert.equal(first.schema, SUMMARY_SCHEMA);
  assert.equal(first.metricsBefore.meshCount, 4);
  assert.equal(first.metricsAfter.meshCount, 1);
  assert.equal(first.metricsAfter.vertexCount, sourceMetrics.vertexCount);
  assert.equal(first.metricsAfter.triangleCount, sourceMetrics.triangleCount);
  assert.deepEqual(first.metricsAfter.boundsM, sourceMetrics.boundsM);
  assert.equal(first.texturePayloadsPreserved, true);
  assert.equal(first.materialContractsPreserved, true);
  assert(first.maxBoundsDeltaM <= 0.00001);
  assert.equal(first.sha256After, second.sha256After);
  assert.equal(sha256(await readFile(outputA)), sha256(await readFile(outputB)));
});

test("fails closed when incompatible materials cannot meet the target", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "limina-flatten-incompatible-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "source.glb");
  const output = join(directory, "flat.glb");
  await fixture(input, 2);
  await assert.rejects(flattenVegetationGlb({ input, output, maxMeshes: 1 }), /exceeding target 1/);
  await assert.rejects(readFile(output), /ENOENT/);
});

test("rejects join compaction that would remove unused vertices", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "limina-flatten-unused-vertex-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "source.glb");
  const output = join(directory, "flat.glb");
  await fixture(input, 1, true);
  await assert.rejects(flattenVegetationGlb({ input, output, maxMeshes: 1 }), /changed vertex count/);
  await assert.rejects(readFile(output), /ENOENT/);
});
