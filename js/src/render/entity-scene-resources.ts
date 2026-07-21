import type { SceneObject } from "../engine.ts";

const HOST_LIFETIME = "host";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isHostOwned(resource: Record<string, unknown>): boolean {
  return isRecord(resource.userData) && resource.userData.liminaLifetime === HOST_LIFETIME;
}

/**
 * Dispose resources owned by one entity scene subtree without touching immutable
 * renderer-host assets shared by glTF cache clones. Resources are de-duplicated
 * across the subtree, and every disposer is attempted before failures surface.
 */
export function disposeEntitySceneResources(root: SceneObject): void {
  const geometries = new Set<Record<string, unknown>>();
  const materials = new Set<Record<string, unknown>>();
  const textures = new Set<Record<string, unknown>>();

  const visit = (object: unknown): void => {
    if (!isRecord(object)) return;
    if (isRecord(object.geometry)) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) {
      if (!isRecord(material)) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (isRecord(value) && value.isTexture === true) textures.add(value);
      }
    }
  };

  const traversable = root as unknown as { traverse?: (visitor: (object: unknown) => void) => void };
  if (typeof traversable.traverse === "function") traversable.traverse(visit);
  else visit(root);

  const errors: unknown[] = [];
  const dispose = (resource: Record<string, unknown>): void => {
    if (isHostOwned(resource) || typeof resource.dispose !== "function") return;
    try {
      resource.dispose();
    } catch (error) {
      errors.push(error);
    }
  };

  // Textures before materials before geometry mirrors renderer-host teardown.
  for (const texture of textures) dispose(texture);
  for (const material of materials) dispose(material);
  for (const geometry of geometries) dispose(geometry);

  if (errors.length > 0) {
    throw new AggregateError(errors, `entity scene-resource disposal failed for ${errors.length} resource(s)`);
  }
}
