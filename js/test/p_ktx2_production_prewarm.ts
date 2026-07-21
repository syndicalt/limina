import { ops } from "../src/engine.ts";
import { GltfSceneCache, prewarmGltfScene } from "../src/skills/three.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_ktx2_production_prewarm FAIL: ${message}`);
}

const assetId = "buildings/functional-hall-house-v4-production.glb";
const cache = new GltfSceneCache({
  ktx2TranscoderPath: "/runtime/basis/",
  ktx2TranscoderBytes: {
    js: ops.op_read_asset("runtime/basis/basis_transcoder.js"),
    wasm: ops.op_read_asset("runtime/basis/basis_transcoder.wasm"),
  },
});
const startedAt = performance.now();
try {
  cache.configureKtx2({
    isWebGPURenderer: true,
    hasFeature: (feature: string) => feature === "texture-compression-astc"
      || feature === "texture-compression-etc2" || feature === "texture-compression-bc",
  });
  const bytes = ops.op_read_asset(`assets/${assetId}`);
  await prewarmGltfScene(assetId, bytes, cache);
  const stats = cache.stats();
  assert(stats.entries === 1 && stats.parses === 1, `unexpected cache stats ${JSON.stringify(stats)}`);
  assert(cache.has(assetId, bytes), "production GLB was not retained by the cache");
  console.log(`p_ktx2_production_prewarm OK: ${stats.residentBytes} estimated resident bytes in ${Number((performance.now() - startedAt).toFixed(1))}ms`);
} finally {
  await cache.dispose();
}
