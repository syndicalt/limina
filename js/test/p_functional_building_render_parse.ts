import { ops } from "../src/engine.ts";
import { GltfSceneCache, prewarmGltfScene, parseGltfScene } from "../src/skills/three.ts";

const assetId = "buildings/functional-cottage-gorgon-v2.glb";
const bytes = ops.op_read_asset(assetId);
const cache = new GltfSceneCache();
try {
  await prewarmGltfScene(assetId, bytes, cache);
  cache.beginWorld();
  const root = await parseGltfScene(assetId, bytes, cache);
  const candidates: Array<{ name: string; userData: unknown }> = [];
  (root as unknown as { traverse(fn: (node: { name?: string; userData?: unknown }) => void): void }).traverse((node) => {
    if (node.name?.toLowerCase().includes("door") || (node.userData as { limina?: { role?: string } } | undefined)?.limina?.role === "door") {
      candidates.push({ name: node.name ?? "", userData: node.userData });
    }
  });
  if (!candidates.some((entry) => (entry.userData as { limina?: { id?: string } } | undefined)?.limina?.id === "door/front")) {
    throw new Error(`p_functional_building_render_parse FAIL: semantic door extras missing; candidates=${JSON.stringify(candidates)}`);
  }
  ops.op_log(`p_functional_building_render_parse OK: ${JSON.stringify(candidates)}`);
  cache.endWorld();
} finally {
  await cache.dispose();
}
