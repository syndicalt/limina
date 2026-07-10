import * as THREE from "../../../build/three.bundle.mjs";
import type { WaterRenderQuality } from "../quality.ts";
import { WATER_OWNED_TEXTURES_KEY } from "./material.ts";

export type VisibleWaterKind = "ocean" | "basin" | "river";

export interface VisibleWaterEntry {
  readonly key: string;
  readonly kind: VisibleWaterKind;
  readonly identity: string;
  readonly mesh: THREE.Mesh;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface VisibleWaterScene {
  add(child: unknown): void;
  remove(child: unknown): void;
}

export interface VisibleWaterMount {
  entry: VisibleWaterEntry;
  mounted: boolean;
}

function disposeEntry(scene: VisibleWaterScene, entry: VisibleWaterEntry): unknown[] {
  const errors: unknown[] = [];
  try { scene.remove(entry.mesh); } catch (error) { errors.push(error); }
  errors.push(...disposeMeshResources(entry.mesh));
  return errors;
}

function disposeMeshResources(mesh: THREE.Mesh): unknown[] {
  const errors: unknown[] = [];
  const textures = new Set<{ dispose?(): void }>();
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    const owned = (material.userData as Record<string, unknown>)[WATER_OWNED_TEXTURES_KEY];
    if (Array.isArray(owned)) for (const texture of owned) {
      if (texture && typeof texture === "object") textures.add(texture as { dispose?(): void });
    }
  }
  for (const texture of textures) {
    try { texture.dispose?.(); } catch (error) { errors.push(error); }
  }
  for (const material of new Set(materials)) {
    try { material.dispose(); } catch (error) { errors.push(error); }
  }
  try { mesh.geometry.dispose(); } catch (error) { errors.push(error); }
  return errors;
}

/** Per-world semantic owner for authored visible-water meshes. */
export class VisibleWaterManager {
  readonly #entries = new Map<string, VisibleWaterEntry>();
  readonly #factories = new Map<string, (quality: Readonly<WaterRenderQuality>) => THREE.Mesh>();
  readonly #scene: VisibleWaterScene;
  #quality: Readonly<WaterRenderQuality>;
  #disposed = false;

  constructor(scene: VisibleWaterScene, quality: Readonly<WaterRenderQuality>) {
    if (scene === null || typeof scene !== "object" || typeof scene.add !== "function" || typeof scene.remove !== "function") {
      throw new TypeError("visible water manager requires a scene with add/remove");
    }
    this.#scene = scene;
    this.#quality = quality;
  }

  get size(): number { return this.#entries.size; }
  get disposed(): boolean { return this.#disposed; }
  get quality(): Readonly<WaterRenderQuality> { return this.#quality; }

  setQuality(quality: Readonly<WaterRenderQuality>): void {
    if (this.#disposed) throw new Error("visible water manager is disposed");
    if (quality === this.#quality) return;
    if (this.#entries.size > quality.maxResidentFragments) {
      throw new RangeError(`visible water quality permits ${quality.maxResidentFragments} resident fragments, but ${this.#entries.size} are mounted`);
    }
    const replacements: Array<{ current: VisibleWaterEntry; replacement: THREE.Mesh }> = [];
    try {
      for (const current of this.#entries.values()) {
        const replacement = this.#factories.get(current.key)!(quality);
        if (!(replacement instanceof THREE.Mesh)) throw new TypeError("visible water factory must return a THREE.Mesh");
        replacements.push({ current, replacement });
      }
    } catch (error) {
      const cleanupErrors = replacements.flatMap(({ replacement }) => disposeMeshResources(replacement));
      if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "visible water quality rebuild and rollback failed");
      throw error;
    }
    const cleanupErrors: unknown[] = [];
    for (const { current, replacement } of replacements) {
      const mesh = current.mesh;
      const oldGeometry = mesh.geometry;
      const oldMaterial = mesh.material;
      mesh.geometry = replacement.geometry;
      mesh.material = replacement.material;
      mesh.position.copy(replacement.position);
      mesh.rotation.copy(replacement.rotation);
      mesh.scale.copy(replacement.scale);
      mesh.renderOrder = replacement.renderOrder;
      mesh.castShadow = replacement.castShadow;
      mesh.receiveShadow = replacement.receiveShadow;
      mesh.name = replacement.name;
      mesh.userData = replacement.userData;
      replacement.geometry = oldGeometry;
      replacement.material = oldMaterial;
      cleanupErrors.push(...disposeMeshResources(replacement));
    }
    this.#quality = quality;
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "visible water quality replacement cleanup failed");
  }

  has(key: string): boolean { return this.#entries.has(key); }

  entries(): readonly VisibleWaterEntry[] {
    return Object.freeze([...this.#entries.values()]);
  }

  mount(
    key: string,
    kind: VisibleWaterKind,
    create: (quality: Readonly<WaterRenderQuality>) => THREE.Mesh,
    metadata: Readonly<Record<string, unknown>> = Object.freeze({}),
    identity = key,
  ): VisibleWaterMount {
    if (this.#disposed) throw new Error("visible water manager is disposed");
    if (typeof key !== "string" || key.length === 0 || key.length > 512) throw new TypeError("visible water key is invalid");
    if (kind !== "ocean" && kind !== "basin" && kind !== "river") throw new TypeError("visible water kind is invalid");
    if (typeof identity !== "string" || identity.length === 0 || identity.length > 2048) {
      throw new TypeError("visible water identity is invalid");
    }
    if (typeof create !== "function") throw new TypeError("visible water factory must be a function");
    const current = this.#entries.get(key);
    if (current !== undefined) {
      if (current.kind !== kind || current.identity !== identity) {
        throw new Error(`visible water '${key}' conflicts with its existing semantic identity`);
      }
      return { entry: current, mounted: false };
    }
    if (this.#entries.size >= this.#quality.maxResidentFragments) {
      throw new RangeError(`visible water resident fragment cap ${this.#quality.maxResidentFragments} exceeded`);
    }
    const mesh = create(this.#quality);
    if (!(mesh instanceof THREE.Mesh)) throw new TypeError("visible water factory must return a THREE.Mesh");
    const entry = Object.freeze({ key, kind, identity, mesh, metadata: Object.freeze({ ...metadata }) });
    try { this.#scene.add(mesh); }
    catch (error) {
      const cleanup = disposeEntry(this.#scene, entry);
      if (cleanup.length > 0) throw new AggregateError([error, ...cleanup], `visible water '${key}' mount and rollback failed`);
      throw error;
    }
    this.#entries.set(key, entry);
    this.#factories.set(key, create);
    return { entry, mounted: true };
  }

  remove(key: string): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    try { this.#scene.remove(entry.mesh); }
    catch (error) { throw new AggregateError([error], `visible water '${key}' could not detach from its scene`); }
    this.#entries.delete(key);
    this.#factories.delete(key);
    const errors = disposeMeshResources(entry.mesh);
    if (errors.length > 0) throw new AggregateError(errors, `visible water '${key}' disposal failed in ${errors.length} step(s)`);
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    const errors: unknown[] = [];
    for (const key of [...this.#entries.keys()].reverse()) {
      try { this.remove(key); } catch (error) { errors.push(error); }
    }
    if (this.#entries.size === 0) this.#disposed = true;
    if (errors.length > 0) throw new AggregateError(errors, `visible water disposal failed in ${errors.length} step(s)`);
  }
}
