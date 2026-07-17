import { ops } from "../src/engine.ts";
import { assetContentHash } from "../src/asset-registry.ts";
import { portableAssetContentHash } from "../src/world/asset-content-hash.mjs";

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(`p_asset_content_hash FAIL: ${message}`);
}

const vectors = [
  new Uint8Array(),
  new Uint8Array([0, 1, 2, 15, 16, 127, 128, 254, 255]),
  Uint8Array.from({ length: 65_537 }, (_, index) => (index * 73 + 19) & 0xff),
];
for (const bytes of vectors) {
  const portable = portableAssetContentHash(bytes);
  assert(/^sha256:[0-9a-f]{64}$/.test(portable), "portable address is malformed");
  assert(assetContentHash(bytes, ops) === portable, `native/portable address drifted for ${bytes.length} bytes`);
}
assert(portableAssetContentHash(vectors[0]) !== portableAssetContentHash(vectors[1]), "distinct byte vectors collided");

ops.op_log("[js] p_asset_content_hash OK: native AssetRegistry and pure compiler/worker hashing agree across empty, binary, and multi-chunk vectors.");
