import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  TREE_IMPOSTOR_PROJECTION,
  TREE_IMPOSTOR_SCHEMA,
  buildTreeImpostorArtifact,
  decodeUpperHemisphereOcta,
  encodeUpperHemisphereOcta,
  packTreeImpostorViews,
  treeImpostorViewDirections,
  validateTreeImpostorArtifact,
} from "./tree-impostor-artifact.mjs";

const HASH_A = `sha256:${"a".repeat(64)}`, HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`, HASH_D = `sha256:${"d".repeat(64)}`;

async function fixture(root, { grid = 2, cellSize = 32, emptyDepth = false } = {}) {
  const albedoViews = [], normalDepthViews = [];
  for (let index = 0; index < grid * grid; index++) {
    const left = 6 + index % 2, top = 5, width = 18, height = 22;
    const alpha = await sharp({ create: { width: cellSize, height: cellSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width, height, channels: 4, background: { r: 50 + index * 20, g: 130, b: 45, alpha: 1 } } }).png().toBuffer(), left, top }])
      .png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
    const normal = await sharp({ create: { width: cellSize, height: cellSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width, height, channels: 4, background: { r: 128, g: 128, b: emptyDepth ? 0 : 90 + index, alpha: 1 } } }).png().toBuffer(), left, top }])
      .png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
    const albedoPath = join(root, `albedo-${index}.png`), normalPath = join(root, `normal-${index}.png`);
    await Promise.all([writeFile(albedoPath, alpha), writeFile(normalPath, normal)]);
    albedoViews.push(albedoPath); normalDepthViews.push(normalPath);
  }
  return { albedoViews, normalDepthViews, config: { grid, cellSize, alphaCutoff: 0.45 } };
}

test("upper-hemisphere octa table is deterministic, unit length, and never points below ground", () => {
  const directions = treeImpostorViewDirections(8);
  assert.equal(directions.length, 64);
  assert.equal(JSON.stringify(directions), JSON.stringify(treeImpostorViewDirections(8)));
  for (const direction of directions) {
    assert.ok(direction[1] >= 0, `below-horizon direction ${direction}`);
    assert.ok(Math.abs(Math.hypot(...direction) - 1) < 1e-7, `non-unit direction ${direction}`);
  }
  assert.deepEqual(decodeUpperHemisphereOcta(0.5, 0.5), [0, 1, 0]);
  assert.deepEqual(decodeUpperHemisphereOcta(1, 1), [1, 0, 0]);
  assert.deepEqual(decodeUpperHemisphereOcta(1, 0), [0, 0, 1]);
  assert.deepEqual(decodeUpperHemisphereOcta(0, 0), [-1, 0, 0]);
  assert.deepEqual(decodeUpperHemisphereOcta(0, 1), [0, 0, -1]);
  assert.equal(TREE_IMPOSTOR_PROJECTION, "upper-hemi-octa-rotated-diamond");
  for (const [u, v] of [[0, 0], [1, 1], [0.13, 0.77], [0.5, 0.5], [1, 0.5]]) {
    const encoded = encodeUpperHemisphereOcta(decodeUpperHemisphereOcta(u, v));
    assert.ok(Math.abs(encoded[0] - u) < 2e-8 && Math.abs(encoded[1] - v) < 2e-8, `hemi-octa roundtrip failed for ${u},${v}: ${encoded}`);
  }
  for (const grid of [2, 4, 8, 16]) {
    const unique = new Set(treeImpostorViewDirections(grid).map((direction) => direction.join(",")));
    assert.equal(unique.size, grid * grid, `${grid}x${grid} atlas contains duplicate view directions`);
  }
});

test("packer emits deterministic self-contained alpha-cutout GLB with exact descriptor and channel QC", async () => {
  const root = await mkdtemp(join(tmpdir(), "limina-impostor-"));
  try {
    const views = await fixture(root), packed = await packTreeImpostorViews(views);
    const output = join(root, "oak-impostor.glb");
    const options = { sourceSha256: HASH_A, lodSha256: HASH_B, sourceContentHash: HASH_C, lodContentHash: HASH_D,
      bounds: { min: [-3, 0, -2], max: [3, 11, 2] }, packed,
      bakeConfig: { samples: 8, seed: 77 }, output };
    const first = await buildTreeImpostorArtifact(options), second = await buildTreeImpostorArtifact({ ...options, output: undefined });
    assert.equal(first.schema, TREE_IMPOSTOR_SCHEMA);
    assert.equal(first.sha256, second.sha256, "same source/config/views did not produce byte-identical GLB");
    assert.equal(first.descriptor.cacheKey, second.descriptor.cacheKey, "cache key is not deterministic");
    assert.deepEqual(first.qc, await validateTreeImpostorArtifact(await readFile(output)));
    assert.equal(first.qc.triangles, 2);
    assert.equal(first.qc.embeddedTextures, 2);
    assert.equal(first.qc.albedo.width, 64);
    assert.equal(first.qc.normalDepth.channels, 4);
    assert.equal((await readdir(root)).filter((name) => name.includes(".tmp-")).length, 0, "atomic publication left temporary files");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("channel and shape validation fail closed before artifact publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "limina-impostor-bad-"));
  try {
    const views = await fixture(root, { emptyDepth: true }), packed = await packTreeImpostorViews(views);
    const output = join(root, "bad.glb");
    await assert.rejects(() => buildTreeImpostorArtifact({ sourceSha256: HASH_A, lodSha256: HASH_B, sourceContentHash: HASH_C, lodContentHash: HASH_D,
      bounds: { min: [-1, 0, -1], max: [1, 2, 1] }, packed, output }), /no encoded depth evidence/);
    await assert.rejects(() => readFile(output), /ENOENT/);
    const wrong = await fixture(root, { grid: 2, cellSize: 32 });
    await writeFile(wrong.albedoViews[0], await sharp({ create: { width: 16, height: 16, channels: 4, background: "red" } }).png().toBuffer());
    await assert.rejects(() => packTreeImpostorViews(wrong), /32x32 PNG/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
