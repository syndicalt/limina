import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolve } from "node:path";
import sharp from "../../js/node_modules/sharp/lib/index.js";

const ROOT = resolve(import.meta.dirname, "../..");
const EXPECTED = Object.freeze({
  "cottage-white-plaster": ["Poly Haven", "white_plaster_02"],
  "cottage-fieldstone": ["Poly Haven", "castle_wall_slates"],
  "cottage-grey-roof": ["Poly Haven", "grey_roof_tiles_02"],
  "cottage-structural-oak": ["Poly Haven", "rough_wood"],
  "cottage-worn-planks": ["Poly Haven", "medieval_wood"],
  "cottage-medieval-brick": ["Poly Haven", "medieval_red_brick"],
});
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("functional cottage material sources are pinned CC0 PBR packs", async () => {
  for (const [id, [provider, assetId]] of Object.entries(EXPECTED)) {
    const directory = resolve(ROOT, "assets/materials", id);
    const manifestBytes = await readFile(resolve(directory, "material-pack.json"));
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.schema, "limina.material-pack/v1");
    assert.equal(manifest.id, id);
    assert.equal(manifest.source.provider, provider);
    assert.equal(manifest.source.assetId, assetId);
    assert.equal(manifest.source.licenseSpdx, "CC0-1.0");
    assert.match(manifest.source.assetUrl, /^https:\/\//);
    for (const slot of ["albedo", "normal", "roughness", "occlusion", "displacement"]) {
      const record = manifest.maps[slot];
      assert.equal(record.assetId, `materials/${id}/${slot}.jpg`);
      const bytes = await readFile(resolve(ROOT, "assets", record.assetId));
      assert.equal(bytes.byteLength, record.bytes);
      assert.equal(sha256(bytes), record.sha256);
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.width, 1024);
      assert.equal(metadata.height, 1024);
      assert.equal(metadata.format, "jpeg");
    }
  }
});
