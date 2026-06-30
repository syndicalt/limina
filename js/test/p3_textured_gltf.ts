// Phase 3 textured glTF: load a textured glTF through the actual three.loadGLTF
// skill path using the embedder's asset-only fetch/blob/createImageBitmap shims.

import { ops } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}

function record(value: unknown): Record<string, unknown> {
  assert(typeof value === "object" && value !== null, "expected object");
  return value as Record<string, unknown>;
}

const gctx = createHeadlessContext({ session: "ses_p3_textured_gltf", agentId: "agt_builder" });
const registry = gctx.registry;
const world = gctx.world;
const tracer = gctx.registry.tracer as LiminaTracer;
const ctx = gctx.base;

ops.op_physics_create_world(0);

const loaded = record(ok(await registry.invoke("three.loadGLTF", { assetId: "textured-triangle.gltf" }, ctx)));
const resource = record(loaded.resource);

assert(typeof loaded.entity === "string", "three.loadGLTF did not return entity id");
assert(resource.assetId === "textured-triangle.gltf", "resource asset id mismatch");
assert(resource.meshCount === 1, "expected one mesh");
assert(resource.materialCount === 1, "expected one material");
assert(resource.textureCount === 1, "expected one decoded texture");
assert(tracer.trace("agt_builder").some((ev) => ev.type === "three.gltf.loaded"), "missing glTF trace event");

// Falsifiable: the baseColor texture must be re-homed to real RGBA pixels. The
// embedder's WebGPU backend only samples DataTextures (it has no
// copyExternalImageToTexture, so ImageBitmap textures upload black); three.loadGLTF
// converts them. Assert the sampled pixels are the fixture's red texel, not
// metadata-only and not black.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
const root = typeof loaded.entity === "string" ? world.entities.resolve(loaded.entity)?.mesh : undefined;
assert(root !== undefined, "loaded glTF entity has no scene object");
let texel: { r: number; g: number; b: number; a: number } | undefined;
const findTexel = (node: unknown): void => {
  if (!isRecord(node)) return;
  const material = node.material;
  const mats = Array.isArray(material) ? material : material !== undefined ? [material] : [];
  for (const m of mats) {
    if (!isRecord(m)) continue;
    const map = m.map;
    if (!isRecord(map)) continue;
    const image = map.image;
    if (isRecord(image) && image.data instanceof Uint8Array && image.data.length >= 4) {
      const d = image.data;
      texel = { r: d[0], g: d[1], b: d[2], a: d[3] };
    }
  }
  const children = node.children;
  if (Array.isArray(children)) for (const child of children) findTexel(child);
};
findTexel(root);
assert(texel !== undefined, "baseColor texture was not re-homed to sampled RGBA pixels (would render black)");
assert(
  texel.r > 200 && texel.g < 60 && texel.b < 60 && texel.a === 255,
  `baseColor texel is not the fixture red: ${JSON.stringify(texel)}`,
);

ops.op_log("P3 textured glTF OK: skill path decoded + re-homed the textured glTF to sampled red RGBA pixels");
