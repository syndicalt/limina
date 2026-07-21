import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { AMBIENTCG_MATERIAL_PACK_SCHEMA, fetchAmbientCgMaterial } from "./fetch-ambientcg.mjs";

const bytes = (value) => new TextEncoder().encode(value);
function fixtureFetch(options = {}) {
  const archive = zipSync(options.entries ?? {
    "Ground037_1K-JPG_Color.jpg": bytes("color"),
    "Ground037_1K-JPG_NormalDX.jpg": bytes("wrong-normal"),
    "Ground037_1K-JPG_NormalGL.jpg": bytes("right-normal"),
    "Ground037_1K-JPG_Roughness.jpg": bytes("rough"),
    "Ground037_1K-JPG_AmbientOcclusion.jpg": bytes("ao"),
    "Ground037_1K-JPG_Displacement.jpg": bytes("height"),
  }, { mtime: new Date("1980-01-02T00:00:00.000Z") });
  const metadata = JSON.stringify({ assets: [{
    id: "Ground037", type: "material", title: "Ground 037", url: "https://ambientcg.com/a/Ground037",
    maps: ["color", "normal", "roughness", "ambient-occlusion", "displacement"],
    downloads: [{ attributes: "1K-JPG", extension: "zip", url: "https://ambientcg.com/get?file=Ground037_1K-JPG.zip", size: archive.byteLength }],
  }] });
  return async (url) => String(url).includes("/api/v3/assets")
    ? new Response(metadata, { headers: { "content-length": String(metadata.length) } })
    : new Response(archive, { headers: { "content-length": String(archive.byteLength) } });
}

test("publishes a bounded content-addressed v3 material pack with OpenGL normals", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "limina-ambientcg-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const manifest = await fetchAmbientCgMaterial({ assetId: "Ground037", name: "forest-ground", outputRoot, fetchImpl: fixtureFetch() });
  assert.equal(manifest.schema, AMBIENTCG_MATERIAL_PACK_SCHEMA);
  assert.equal(manifest.source.apiVersion, "v3");
  assert.equal(manifest.source.licenseSpdx, "CC0-1.0");
  assert.equal(new TextDecoder().decode(await readFile(join(outputRoot, "forest-ground", "normal.jpg"))), "right-normal");
  assert.equal(manifest.materialImport.occlusion, "materials/forest-ground/occlusion.jpg");
  assert.equal(manifest.materialImport.displacement, "materials/forest-ground/displacement.jpg");
  assert.match(manifest.maps.albedo.assetHash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(manifest.maps.albedo.assetHash, manifest.maps.albedo.sha256, "external and engine hash domains were silently conflated");
  const stored = JSON.parse(await readFile(join(outputRoot, "forest-ground", "material-pack.json"), "utf8"));
  assert.deepEqual(stored, manifest);
  await assert.rejects(
    fetchAmbientCgMaterial({ assetId: "Ground037", name: "forest-ground", outputRoot, fetchImpl: fixtureFetch() }),
    /already exists/,
  );
});

test("fails closed on unsafe, duplicate, missing, or off-origin archive contracts", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "limina-ambientcg-bad-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  await assert.rejects(fetchAmbientCgMaterial({ assetId: "../bad", outputRoot, fetchImpl: fixtureFetch() }), /assetId is invalid/);
  const duplicate = fixtureFetch({ entries: {
    "a_Color.jpg": bytes("a"), "b_Color.png": bytes("b"), "a_NormalGL.jpg": bytes("n"),
    "a_Roughness.jpg": bytes("r"), "a_AmbientOcclusion.jpg": bytes("o"),
  } });
  await assert.rejects(fetchAmbientCgMaterial({ assetId: "Ground037", name: "duplicate", outputRoot, fetchImpl: duplicate }), /duplicate albedo/);
  const missing = fixtureFetch({ entries: { "a_Color.jpg": bytes("a") } });
  await assert.rejects(fetchAmbientCgMaterial({ assetId: "Ground037", name: "missing", outputRoot, fetchImpl: missing }), /missing required normal/);
  const offOrigin = async (url) => {
    if (!String(url).includes("/api/v3/assets")) throw new Error("archive must not be requested");
    return new Response(JSON.stringify({ assets: [{ id: "Ground037", type: "material", maps: [], downloads: [{ attributes: "1K-JPG", extension: "zip", url: "https://evil.example/a.zip", size: 12 }] }] }));
  };
  await assert.rejects(fetchAmbientCgMaterial({ assetId: "Ground037", name: "off-origin", outputRoot, fetchImpl: offOrigin }), /outside the pinned HTTPS endpoint/);
});
