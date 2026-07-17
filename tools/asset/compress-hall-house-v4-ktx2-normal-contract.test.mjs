import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import sharp from "sharp";

const ROOT = resolve(import.meta.dirname, "../..");
const KTX = resolve(ROOT, "js/.tools/ktx/4.4.2/linux-arm64/root/usr/bin/ktx");

function parseGlb(bytes) {
  const jsonLength = bytes.readUInt32LE(12);
  const jsonEnd = 20 + jsonLength;
  const json = JSON.parse(bytes.subarray(20, jsonEnd).toString().trimEnd());
  const bin = bytes.subarray(jsonEnd + 8, jsonEnd + 8 + bytes.readUInt32LE(jsonEnd));
  return { json, bin };
}

function imageBytes(glb, index) {
  const image = glb.json.images[index];
  const view = glb.json.bufferViews[image.bufferView];
  return glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}

function vector(bytes, offset) {
  const x = bytes[offset] / 127.5 - 1;
  const y = bytes[offset + 1] / 127.5 - 1;
  const z = bytes[offset + 2] / 127.5 - 1;
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

test("production normals preserve conventional RGB tangent-space directions", async () => {
  const source = parseGlb(await readFile(resolve(ROOT, "assets/buildings/functional-hall-house-v4-lod.glb")));
  const production = parseGlb(await readFile(resolve(ROOT, "assets/buildings/functional-hall-house-v4-production.glb")));
  const manifest = JSON.parse(await readFile(resolve(ROOT, "assets/buildings/functional-hall-house-v4-production.ktx2.json")));
  const dir = await mkdtemp(join(tmpdir(), "limina-normal-contract-"));
  try {
    for (const record of manifest.textures.filter((entry) => entry.kind === "normal")) {
      assert.equal(record.channelEncoding, "rgb-tangent-space", `${record.name} channel contract`);
      assert.ok(!record.options.includes("--normal_mode"), `${record.name} must not require shader-side Z reconstruction`);
      const ktxPath = join(dir, `${record.image}.ktx2`);
      const decodedPath = join(dir, `${record.image}.png`);
      await writeFile(ktxPath, imageBytes(production, record.image));
      const extract = spawnSync(KTX, ["extract", "--transcode", "rgba8", ktxPath, decodedPath], { encoding: "utf8" });
      assert.equal(extract.status, 0, extract.stderr || extract.stdout);

      const decoded = await sharp(decodedPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const authored = await sharp(imageBytes(source, record.image))
        .resize(decoded.info.width, decoded.info.height, { kernel: sharp.kernel.lanczos3 })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(decoded.info.channels, 3);
      assert.equal(authored.info.channels, 3);
      const angles = [];
      let blue = 0;
      for (let offset = 0; offset < decoded.data.length; offset += 3) {
        const a = vector(authored.data, offset);
        const b = vector(decoded.data, offset);
        angles.push(Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI);
        blue += decoded.data[offset + 2];
      }
      angles.sort((a, b) => a - b);
      const mean = angles.reduce((sum, angle) => sum + angle, 0) / angles.length;
      const p95 = angles[Math.floor(angles.length * 0.95)];
      assert.ok(blue / angles.length > 220, `${record.name} lost its positive tangent Z channel`);
      assert.ok(mean < 5, `${record.name} mean angular error ${mean.toFixed(2)}°`);
      assert.ok(p95 < 30, `${record.name} p95 angular error ${p95.toFixed(2)}°`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
