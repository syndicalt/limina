import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMaterialPackLayer } from "./material-pack-layer.mjs";

const root = resolve(fileURLToPath(new URL("../../assets", import.meta.url)));
for (const id of ["forest-ground", "temperate-grass-turf", "river-gravel", "river-silt", "abyssal-silt", "basalt-rock"]) {
  const layer = await loadMaterialPackLayer({ root, manifestAssetId: `materials/${id}/material-pack.json`, width: 32 });
  assert.equal(layer.width, 32);
  assert.equal(layer.albedo.length, 32 * 32 * 4);
  assert.equal(layer.normal.length, 32 * 32 * 4);
  assert.equal(layer.orm.length, 32 * 32 * 4);
  assert.equal(layer.displacement.length, 32 * 32);
  assert.ok(layer.orm.every((value, offset) => offset % 4 === 2 ? value === 0 : offset % 4 === 3 ? value === 255 : true));
  assert.equal(layer.provenance.licenseSpdx, "CC0-1.0");
}
await assert.rejects(() => loadMaterialPackLayer({ root, manifestAssetId: "../package.json", width: 32 }), /escapes/);
console.log("material-pack-layer OK: six pinned CC0 packs verify raw and engine hashes and decode to albedo/normal/ORM/displacement layers");
