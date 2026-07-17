import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EVIDENCE_SCHEMA, retopoStatic, validateStaticOpaqueGlb } from "./retopo-static.mjs";

const blender = process.env.BLENDER_BIN ?? join(process.env.HOME, "blender-5.1.2-linux-x64", "blender");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(output)));
  });
}

function syntheticGlb(json) {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(encoded.byteLength / 4) * 4;
  const total = 20 + jsonLength;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20); bytes.set(encoded, 20);
  return bytes;
}

function validJson(overrides = {}) {
  return {
    asset: { version: "2.0" },
    accessors: [
      { type: "VEC3", componentType: 5126, count: 3, min: [0, 0, 0], max: [1, 1, 0] },
      { type: "SCALAR", componentType: 5123, count: 3 },
    ],
    materials: [{}], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0, ...overrides,
  };
}

test("preflight rejects every out-of-scope static-opaque boundary", () => {
  assert.throws(() => validateStaticOpaqueGlb(syntheticGlb(validJson({ animations: [{}] }))), /animations/);
  assert.throws(() => validateStaticOpaqueGlb(syntheticGlb(validJson({ skins: [{}] }))), /rig/);
  const morph = validJson(); morph.meshes[0].primitives[0].targets = [{ POSITION: 0 }];
  assert.throws(() => validateStaticOpaqueGlb(syntheticGlb(morph)), /shape keys/);
  const alpha = validJson(); alpha.materials[0].alphaMode = "MASK";
  assert.throws(() => validateStaticOpaqueGlb(syntheticGlb(alpha)), /static opaque/);
  const infinite = validJson(); infinite.nodes[0].translation = [Number.NaN, 0, 0];
  assert.throws(() => validateStaticOpaqueGlb(syntheticGlb(infinite)), /non-finite/);
  const huge = validJson(); huge.accessors[0].max = [61, 1, 1];
  assert.throws(() => validateStaticOpaqueGlb(syntheticGlb(huge)), /exceed 60 metres/);
  const externalBuffer = validJson({ buffers: [{ byteLength: 12, uri: "mesh.bin" }] });
  assert.throws(() => validateStaticOpaqueGlb(syntheticGlb(externalBuffer)), /buffer 0 is external/);
  const externalImage = validJson({ images: [{ uri: "albedo.png" }] });
  assert.throws(() => validateStaticOpaqueGlb(syntheticGlb(externalImage)), /image 0 is external/);
  const nestedExtension = validJson();
  nestedExtension.materials[0].pbrMetallicRoughness = { baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { offset: [0.5, 0.5] } } } };
  nestedExtension.extensionsUsed = ["KHR_texture_transform"];
  assert.throws(() => validateStaticOpaqueGlb(syntheticGlb(nestedExtension)), /unsupported glTF extensions.*KHR_texture_transform/);
});

test("two pinned CPU builds are byte-identical and publish complete evidence last", { timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "limina-retopo-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source.glb");
  await run(blender, ["--background", "--factory-startup", "--threads", "1", "--python", join(import.meta.dirname, "make-test-fixture.py"), "--", "--output", source]);
  const builds = [];
  for (const suffix of ["a", "b"]) {
    const paths = { output: join(directory, `clean-${suffix}.glb`), lodOutput: join(directory, `clean-${suffix}-lod.glb`), evidence: join(directory, `clean-${suffix}.json`) };
    builds.push(await retopoStatic({ input: source, ...paths, seed: 1729, targetFaces: 128, resolution: 16, cageExtrusion: 0.1, lodRatio: 0.5, lodError: 1, blenderBin: blender }));
  }
  assert.equal(builds[0].schema, EVIDENCE_SCHEMA);
  assert.equal(builds[0].output.sha256, builds[1].output.sha256);
  assert.equal(builds[0].lod.sha256, builds[1].lod.sha256);
  assert.equal(builds[0].output.metrics.materialCount, 1);
  assert.equal(builds[0].repositoryGates.qc.score, 1);
  assert(builds[0].lod.metrics.triangles < builds[0].output.metrics.triangles);
  const json = validateStaticOpaqueGlb(await readFile(join(directory, "clean-a.glb")), "published output").json;
  assert.notEqual(json.materials[0].normalTexture, undefined);
  assert.notEqual(json.materials[0].occlusionTexture, undefined);
  assert.notEqual(json.materials[0].pbrMetallicRoughness.baseColorTexture, undefined);
  assert.notEqual(json.materials[0].pbrMetallicRoughness.metallicRoughnessTexture, undefined);
  assert.equal(json.materials[0].occlusionTexture.index, json.materials[0].pbrMetallicRoughness.metallicRoughnessTexture.index);
});

test("failure leaves no partial outputs and never overwrites", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "limina-retopo-fail-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "bad.glb");
  await writeFile(input, syntheticGlb(validJson({ animations: [{}] })));
  await assert.rejects(retopoStatic({ input, output: join(directory, "out.glb"), lodOutput: join(directory, "lod.glb"), evidence: join(directory, "proof.json") }), /animations/);
  assert.deepEqual(await readdir(directory), ["bad.glb"]);

  const validInput = join(directory, "synthetic.glb");
  await writeFile(validInput, syntheticGlb(validJson()));
  await assert.rejects(retopoStatic({ input: validInput, output: join(directory, "out.glb"), lodOutput: join(directory, "lod.glb"), evidence: join(directory, "proof.json"), blenderBin: join(directory, "missing-blender") }), /ENOENT|spawn/);
  assert.deepEqual((await readdir(directory)).sort(), ["bad.glb", "synthetic.glb"]);

  const output = join(directory, "out.glb");
  await writeFile(output, "sentinel");
  await assert.rejects(retopoStatic({ input: validInput, output, lodOutput: join(directory, "lod.glb"), evidence: join(directory, "proof.json") }), /refusing to overwrite/);
  assert.equal(await readFile(output, "utf8"), "sentinel");
});
