import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { generateVegetationLod, SUMMARY_SCHEMA } from "./generate-vegetation-lod.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createGridFixture(path, side = 12) {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (let z = 0; z <= side; z++) {
    for (let x = 0; x <= side; x++) {
      positions.push(x, Math.sin(x * 0.37) * Math.cos(z * 0.31) * 0.05, z);
      normals.push(0, 1, 0);
      uvs.push(x / side, z / side);
    }
  }
  for (let z = 0; z < side; z++) {
    for (let x = 0; x < side; x++) {
      const a = z * (side + 1) + x;
      const b = a + 1;
      const c = a + side + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const material = document.createMaterial("foliage").setBaseColorFactor([0.1, 0.5, 0.15, 1]);
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer))
    .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setArray(new Float32Array(normals)).setBuffer(buffer))
    .setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setArray(new Float32Array(uvs)).setBuffer(buffer))
    .setIndices(document.createAccessor().setType("SCALAR").setArray(new Uint16Array(indices)).setBuffer(buffer))
    .setMaterial(material);
  const mesh = document.createMesh("vegetation-grid").addPrimitive(primitive);
  const node = document.createNode("vegetation").setMesh(mesh);
  document.createScene("scene").addChild(node);
  document.getRoot().setDefaultScene(document.getRoot().listScenes()[0]);
  await writeFile(path, await new NodeIO().writeBinary(document));
}

test("generates a deterministic, reduced, uncompressed GLB and preserves shading contracts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "limina-vegetation-lod-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "source.glb");
  const outputA = join(directory, "lod-a.glb");
  const outputB = join(directory, "lod-b.glb");
  await createGridFixture(input);

  const first = await generateVegetationLod({ input, output: outputA, ratio: 0.5, error: 1 });
  const second = await generateVegetationLod({ input, output: outputB, ratio: 0.5, error: 1 });
  assert.equal(first.schema, SUMMARY_SCHEMA);
  assert(first.trianglesAfter > 0);
  assert(first.trianglesAfter < first.trianglesBefore);
  assert.equal(first.meshoptCompressed, false);
  assert.equal(first.outputSha256, second.outputSha256);
  assert.equal(sha256(await readFile(outputA)), sha256(await readFile(outputB)));

  const document = await new NodeIO().read(outputA);
  const primitive = document.getRoot().listMeshes()[0].listPrimitives()[0];
  assert.equal(primitive.getMaterial().getName(), "foliage");
  assert(primitive.getAttribute("NORMAL"));
  assert(primitive.getAttribute("TEXCOORD_0"));
});

test("rejects in-place output and failed reductions without publishing temporary files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "limina-vegetation-lod-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "source.glb");
  const output = join(directory, "lod.glb");
  await createGridFixture(input, 2);

  await assert.rejects(generateVegetationLod({ input, output: input, ratio: 0.5, error: 1 }), /refusing to overwrite/);
  await assert.rejects(generateVegetationLod({ input, output, ratio: 1, error: 1 }), /did not reduce triangle count/);
  assert.deepEqual((await readdir(directory)).sort(), ["source.glb"]);
});

test("validates numeric options before reading files", async () => {
  await assert.rejects(generateVegetationLod({ input: "missing.glb", output: "lod.glb", ratio: Number.NaN, error: 1 }), /ratio must be/);
  await assert.rejects(generateVegetationLod({ input: "missing.glb", output: "lod.glb", ratio: 0.5, error: -1 }), /error must be/);
});
