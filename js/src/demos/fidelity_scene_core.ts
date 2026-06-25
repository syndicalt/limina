// Shared builder for the visual-fidelity acceptance scene (Phase 3, T4).
//
// The scene is constructed ENTIRELY through skills (scene.createEntity,
// three.setMaterial, three.setTransform, three.setLighting, three.loadGLTF) so it
// proves the agent builder surface can author a real lit / shadowed / textured
// world -- not just handwritten demo code. Both the windowed demo
// (demos/fidelity_scene.ts) and the pixel-readback test
// (test/p3_fidelity_readback.ts) build through this one path.
//
// Layout (verified by readback):
//   * floor    -- wide box, top face at y=0, receives the cast shadow
//   * caster   -- box floating at y=3, casts a real shadow-map shadow
//   * textured -- the textured glTF, tilted to catch the directional light so its
//                 red baseColor texture samples brightly
//   * one ambient + one shadow-casting directional light (from +x,+y,-z, so the
//     shadow falls toward the camera and is not occluded by the caster).

import type { InvokeBase, SkillRegistry } from "../skills/registry.ts";
import type { MCPResponse } from "../mcp/protocol.ts";

export interface FidelityHandles {
  floor: string;
  caster: string;
  textured: string;
  /** World-space floor point fully lit by the directional light. */
  litPoint: [number, number, number];
  /** World-space floor point inside the caster's cast shadow. */
  shadowPoint: [number, number, number];
  /** Local-space interior point of the textured triangle, for `localToWorld`. */
  texturedLocalSample: [number, number, number];
  cameraPosition: [number, number, number];
  cameraTarget: [number, number, number];
}

function entityId(res: MCPResponse): string {
  if (!res.success) throw new Error("fidelity scene: skill failed: " + JSON.stringify(res.error));
  const result = res.result;
  if (result === null || typeof result !== "object" || !("entity" in result)) {
    throw new Error("fidelity scene: skill returned no entity");
  }
  const entity = result.entity;
  if (typeof entity !== "string") throw new Error("fidelity scene: entity id not a string");
  return entity;
}

async function must(reg: SkillRegistry, name: string, input: unknown, base: InvokeBase): Promise<MCPResponse> {
  const res = await reg.invoke(name, input, base);
  if (!res.success) throw new Error(`fidelity scene: ${name} failed: ${JSON.stringify(res.error)}`);
  return res;
}

/** Build the fidelity acceptance scene through skills, set the camera, and return
 *  the entity handles plus the world-space sample points a readback uses. */
export async function buildFidelityScene(reg: SkillRegistry, base: InvokeBase): Promise<FidelityHandles> {
  const floor = entityId(await must(reg, "scene.createEntity", { shape: "box", size: 30, color: 0x9aa3ad, position: [0, -15, 0] }, base));
  await must(reg, "three.setMaterial", { entity: floor, roughness: 0.95, metalness: 0.0, receiveShadow: true }, base);

  const caster = entityId(await must(reg, "scene.createEntity", { shape: "box", size: 3, color: 0xff8c1a, position: [0, 3, 0] }, base));
  await must(reg, "three.setMaterial", { entity: caster, roughness: 0.5, metalness: 0.05, castShadow: true, receiveShadow: true }, base);

  const textured = entityId(await must(reg, "three.loadGLTF", { assetId: "textured-triangle.gltf", position: [5, 0.5, 6] }, base));
  await must(reg, "three.setTransform", { entity: textured, rotationEuler: [-0.9, 0.0, 0.0], scale: [6, 6, 6] }, base);
  await must(reg, "three.setMaterial", { entity: textured, castShadow: true }, base);

  await must(reg, "three.setLighting", {
    ambientColor: 0xffffff,
    ambientIntensity: 0.5,
    directionalColor: 0xffffff,
    directionalIntensity: 3.5,
    direction: [5, 12, -9],
    castShadow: true,
    shadowMapSize: 2048,
    shadowCameraExtent: 22,
    shadowBias: -0.0008,
  }, base);

  const cameraPosition: [number, number, number] = [0, 12, 16];
  const cameraTarget: [number, number, number] = [0, 1, 0];
  base.world.camera.position.set(cameraPosition[0], cameraPosition[1], cameraPosition[2]);
  base.world.camera.lookAt(cameraTarget[0], cameraTarget[1], cameraTarget[2]);
  base.world.camera.updateProjectionMatrix();

  return {
    floor,
    caster,
    textured,
    litPoint: [-8, 0, 6],
    shadowPoint: [-1.25, 0, 2.25],
    texturedLocalSample: [1 / 3, 1 / 3, 0],
    cameraPosition,
    cameraTarget,
  };
}
