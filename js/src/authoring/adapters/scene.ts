import { z } from "../../../build/zod.bundle.mjs";
import type { MaterialState, SceneObject } from "../../engine.ts";
import { Position, Rotation, Scale } from "../../ecs/world.ts";
import { propagateTransform } from "../../ecs/hierarchy.ts";
import type { WorldContext } from "../../skills/registry.ts";
import type { AuthoringAdapter, AuthoringAdapterContext, AuthoringCapture } from "../adapter.ts";
import type { JsonValue } from "../canonical.ts";
import type { AuthoringOperation } from "../schema.ts";

export const SCENE_AUTHORING_ADAPTER_ID = "scene" as const;

const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_COORDINATE = 1_000_000;
const MAX_SCALE = 10_000;
const MAX_TRANSFORM_SCOPE_ENTITIES = 4_096;
const MAX_SCENE_GRAPH_DEPTH = 256;
const MAX_MATERIAL_OBJECTS = 4_096;
const MAX_MATERIAL_SLOTS_PER_OBJECT = 64;
const MAX_MATERIAL_SLOTS_TOTAL = 16_384;

const EntityIdSchema = z.string().min(1).max(128).regex(ENTITY_ID);
const FiniteCoordinate = z.number().finite().min(-MAX_COORDINATE).max(MAX_COORDINATE);
const Vec3Schema = z.tuple([FiniteCoordinate, FiniteCoordinate, FiniteCoordinate]);
const PositiveScale = z.number().finite().positive().max(MAX_SCALE);
const ScaleSchema = z.tuple([PositiveScale, PositiveScale, PositiveScale]);
const QuaternionSchema = z.tuple([
  z.number().finite().min(-1).max(1),
  z.number().finite().min(-1).max(1),
  z.number().finite().min(-1).max(1),
  z.number().finite().min(-1).max(1),
]).superRefine((value, context) => {
  const magnitudeSquared = value.reduce((sum, component) => sum + component * component, 0);
  if (Math.abs(magnitudeSquared - 1) > 1e-4) {
    context.addIssue({ code: "custom", message: "rotation must be a normalized quaternion" });
  }
});
const TagSchema = z.string().min(1).max(64).regex(TAG);

const TransformInputSchema = z.object({
  entity: EntityIdSchema,
  position: Vec3Schema.optional(),
  rotation: QuaternionSchema.optional(),
  scale: ScaleSchema.optional(),
}).strict().refine(
  (input) => input.position !== undefined || input.rotation !== undefined || input.scale !== undefined,
  "at least one transform field is required",
);

const TagsInputSchema = z.object({
  entity: EntityIdSchema,
  tags: z.array(TagSchema).max(64),
}).strict().superRefine((input, context) => {
  const unique = new Set(input.tags);
  if (unique.size !== input.tags.length) {
    context.addIssue({ code: "custom", path: ["tags"], message: "tags must not contain duplicates" });
  }
});

const MaterialInputSchema = z.object({
  entity: EntityIdSchema,
  color: z.number().int().min(0).max(0xffffff).optional(),
  roughness: z.number().finite().min(0).max(1).optional(),
  metalness: z.number().finite().min(0).max(1).optional(),
  castShadow: z.boolean().optional(),
  receiveShadow: z.boolean().optional(),
}).strict().refine(
  (input) => input.color !== undefined || input.roughness !== undefined || input.metalness !== undefined ||
    input.castShadow !== undefined || input.receiveShadow !== undefined,
  "at least one material field is required",
);

export type SceneTransformInput = z.infer<typeof TransformInputSchema>;
export type SceneTagsInput = z.infer<typeof TagsInputSchema>;
export type SceneMaterialInput = z.infer<typeof MaterialInputSchema>;

type ParsedSceneOperation =
  | { action: "transform.set"; input: SceneTransformInput }
  | { action: "tags.replace"; input: SceneTagsInput }
  | { action: "material.patch"; input: SceneMaterialInput };

export interface SceneAuthoringAdapterOptions {
  readonly world: WorldContext;
}

interface TransformState {
  readonly entity: string;
  readonly eid: number;
  readonly position: [number, number, number];
  readonly rotation: [number, number, number, number];
  readonly scale: [number, number, number];
}

interface TransformCapture {
  readonly kind: "transform";
  readonly states: readonly TransformState[];
}

interface TagsCapture {
  readonly kind: "tags";
  readonly entity: string;
  readonly eid: number;
  readonly present: boolean;
  readonly tags: readonly string[];
}

interface ReadableColor {
  getHex(): number;
  set(value: number): void;
}

interface ReadableMaterial {
  color: ReadableColor;
  roughness: number;
  metalness: number;
}

interface MaterialObjectCapture {
  readonly castShadow: boolean | undefined;
  readonly receiveShadow: boolean | undefined;
  readonly materials: readonly {
    readonly color: number;
    readonly roughness: number;
    readonly metalness: number;
  }[];
}

interface MaterialCapture {
  readonly kind: "material";
  readonly entity: string;
  readonly eid: number;
  readonly entityMaterial: MaterialState | undefined;
  readonly objects: readonly MaterialObjectCapture[];
}

type SceneCapture = TransformCapture | TagsCapture | MaterialCapture;

function parseOperation(operation: AuthoringOperation): ParsedSceneOperation {
  switch (operation.action) {
    case "transform.set": return { action: operation.action, input: TransformInputSchema.parse(operation.input) };
    case "tags.replace": return { action: operation.action, input: TagsInputSchema.parse(operation.input) };
    case "material.patch": return { action: operation.action, input: MaterialInputSchema.parse(operation.input) };
    default: throw new Error(`scene authoring action '${operation.action}' is not allowlisted`);
  }
}

function codeUnitCompare(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function sortedTags(tags: Iterable<string>): string[] {
  return [...tags].sort(codeUnitCompare);
}

function transformState(world: WorldContext, entity: string): TransformState {
  const entry = world.entities.resolve(entity);
  if (entry === undefined) throw new Error(`scene entity '${entity}' does not exist`);
  const eid = entry.eid;
  return {
    entity,
    eid,
    position: [Position.x[eid], Position.y[eid], Position.z[eid]],
    rotation: [Rotation.x[eid], Rotation.y[eid], Rotation.z[eid], Rotation.w[eid]],
    scale: [Scale.x[eid], Scale.y[eid], Scale.z[eid]],
  };
}

function subtreeIds(world: WorldContext, root: string): string[] {
  if (world.entities.resolve(root) === undefined) throw new Error(`scene entity '${root}' does not exist`);
  const result: string[] = [];
  const active = new Set<string>();
  const visited = new Set<string>();
  const stack: { entity: string; depth: number; exit: boolean }[] = [{ entity: root, depth: 0, exit: false }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit) {
      active.delete(frame.entity);
      continue;
    }
    if (frame.depth > MAX_SCENE_GRAPH_DEPTH) {
      throw new Error(`scene hierarchy exceeds maximum depth ${MAX_SCENE_GRAPH_DEPTH}`);
    }
    if (active.has(frame.entity)) throw new Error(`scene hierarchy contains a cycle at '${frame.entity}'`);
    if (visited.has(frame.entity)) throw new Error(`scene hierarchy reaches '${frame.entity}' more than once`);
    if (result.length >= MAX_TRANSFORM_SCOPE_ENTITIES) {
      throw new Error(`scene transform scope exceeds ${MAX_TRANSFORM_SCOPE_ENTITIES} entities`);
    }
    active.add(frame.entity);
    visited.add(frame.entity);
    result.push(frame.entity);
    stack.push({ ...frame, exit: true });
    const children = world.entities.childrenOf(frame.entity).slice().sort(codeUnitCompare);
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ entity: children[index], depth: frame.depth + 1, exit: false });
    }
  }
  return result;
}

function assertTransformScopeSupported(world: WorldContext, entity: string): void {
  if (world.transforms === undefined) throw new Error("scene authoring requires versioned transform storage");
  if (world.entities.resolve(entity)?.parent !== undefined) {
    throw new Error(
      `scene transform '${entity}' is parented; exact local-offset and entity-table version restoration is unavailable`,
    );
  }
  for (const id of subtreeIds(world, entity)) {
    if (world.entities.resolve(id)?.bodyId !== undefined) {
      // A pose-only inverse cannot restore velocity, sleep/wake state, or solver state.
      throw new Error(
        `scene transform '${entity}' affects physics-bearing entity '${id}'; exact scoped native-physics capture is unavailable`,
      );
    }
  }
}

function materialObjects(root: SceneObject | undefined): SceneObject[] {
  if (root === undefined) return [];
  const objects: SceneObject[] = [];
  const seen = new Set<SceneObject>();
  const active = new Set<SceneObject>();
  const stack: { object: SceneObject; depth: number; exit: boolean }[] = [{ object: root, depth: 0, exit: false }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit) {
      active.delete(frame.object);
      continue;
    }
    if (frame.depth > MAX_SCENE_GRAPH_DEPTH) {
      throw new Error(`scene object graph exceeds maximum depth ${MAX_SCENE_GRAPH_DEPTH}`);
    }
    if (active.has(frame.object)) throw new Error("scene object graph contains a cycle");
    if (seen.has(frame.object)) throw new Error("scene object graph reaches an object more than once");
    if (objects.length >= MAX_MATERIAL_OBJECTS) {
      throw new Error(`scene material scope exceeds ${MAX_MATERIAL_OBJECTS} objects`);
    }
    active.add(frame.object);
    seen.add(frame.object);
    objects.push(frame.object);
    stack.push({ ...frame, exit: true });
    const rawChildren = (frame.object as unknown as { children?: unknown }).children;
    if (rawChildren === undefined) continue;
    if (!Array.isArray(rawChildren)) throw new Error("scene object children are not an array");
    for (let index = rawChildren.length - 1; index >= 0; index--) {
      const child = rawChildren[index];
      if (typeof child !== "object" || child === null) throw new Error("scene object graph contains a non-object child");
      stack.push({ object: child as SceneObject, depth: frame.depth + 1, exit: false });
    }
  }
  return objects;
}

function readableMaterials(object: SceneObject): ReadableMaterial[] {
  const raw = (object as unknown as { material?: unknown }).material;
  const candidates: unknown[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  if (candidates.length > MAX_MATERIAL_SLOTS_PER_OBJECT) {
    throw new Error(`scene object exceeds ${MAX_MATERIAL_SLOTS_PER_OBJECT} material slots`);
  }
  return candidates.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null) throw new Error("scene object has an unreadable material");
    const material = candidate as Partial<ReadableMaterial>;
    if (
      typeof material.color !== "object" || material.color === null ||
      typeof material.color.getHex !== "function" || typeof material.color.set !== "function" ||
      typeof material.roughness !== "number" || !Number.isFinite(material.roughness) ||
      typeof material.metalness !== "number" || !Number.isFinite(material.metalness)
    ) {
      throw new Error("scene object material cannot be captured exactly");
    }
    return material as ReadableMaterial;
  });
}

function cloneMaterialState(state: MaterialState | undefined): MaterialState | undefined {
  return state === undefined ? undefined : { ...state };
}

function captureMaterial(world: WorldContext, entity: string): MaterialCapture {
  const entry = world.entities.resolve(entity);
  if (entry === undefined) throw new Error(`scene entity '${entity}' does not exist`);
  let materialSlots = 0;
  const objects = materialObjects(entry.mesh).map((object): MaterialObjectCapture => {
    const materials = readableMaterials(object);
    materialSlots += materials.length;
    if (materialSlots > MAX_MATERIAL_SLOTS_TOTAL) {
      throw new Error(`scene material scope exceeds ${MAX_MATERIAL_SLOTS_TOTAL} total material slots`);
    }
    return {
      castShadow: object.castShadow,
      receiveShadow: object.receiveShadow,
      materials: materials.map((material) => ({
        color: material.color.getHex(),
        roughness: material.roughness,
        metalness: material.metalness,
      })),
    };
  });
  return {
    kind: "material",
    entity,
    eid: entry.eid,
    entityMaterial: cloneMaterialState(entry.material),
    objects,
  };
}

function materialHashState(capture: MaterialCapture): JsonValue {
  return {
    entity: capture.entity,
    eid: capture.eid,
    entityMaterial: capture.entityMaterial === undefined ? null : { ...capture.entityMaterial },
    objects: capture.objects.map((object) => ({
      castShadow: object.castShadow ?? null,
      receiveShadow: object.receiveShadow ?? null,
      materials: object.materials.map((material) => ({
        color: material.color,
        roughness: material.roughness,
        metalness: material.metalness,
      })),
    })),
  };
}

function captureHashState(capture: SceneCapture): JsonValue {
  switch (capture.kind) {
    case "transform": return { kind: capture.kind, states: capture.states.map((state) => ({ ...state })) };
    case "tags": return {
      kind: capture.kind,
      entity: capture.entity,
      eid: capture.eid,
      present: capture.present,
      tags: [...capture.tags],
    };
    case "material": return { kind: capture.kind, state: materialHashState(capture) };
  }
}

function assertSameEntity(world: WorldContext, entity: string, eid: number): void {
  const current = world.entities.resolve(entity);
  if (current === undefined || current.eid !== eid) {
    throw new Error(`scene entity '${entity}' identity changed during authoring transaction`);
  }
}

function restoreTransform(world: WorldContext, capture: TransformCapture): void {
  const storage = world.transforms;
  if (storage === undefined) throw new Error("scene authoring requires versioned transform storage");
  for (const state of capture.states) assertSameEntity(world, state.entity, state.eid);
  for (const state of capture.states) {
    storage.writePosition(state.eid, ...state.position);
    storage.writeRotation(state.eid, ...state.rotation);
    storage.writeScale(state.eid, ...state.scale);
  }
  world.spatial?.invalidate();
}

function restoreTags(world: WorldContext, capture: TagsCapture): void {
  assertSameEntity(world, capture.entity, capture.eid);
  if (capture.present) world.tags.set(capture.eid, new Set(capture.tags));
  else world.tags.delete(capture.eid);
}

function restoreMaterial(world: WorldContext, capture: MaterialCapture): void {
  assertSameEntity(world, capture.entity, capture.eid);
  const entry = world.entities.resolve(capture.entity)!;
  const objects = materialObjects(entry.mesh);
  if (objects.length !== capture.objects.length) {
    throw new Error(`scene material structure changed: expected ${capture.objects.length} objects, found ${objects.length}`);
  }
  const currentMaterials = objects.map((object, index) => {
    const materials = readableMaterials(object);
    const expected = capture.objects[index].materials.length;
    if (materials.length !== expected) {
      throw new Error(`scene material structure changed at object ${index}: expected ${expected} slots, found ${materials.length}`);
    }
    return materials;
  });
  entry.material = cloneMaterialState(capture.entityMaterial);
  for (let objectIndex = 0; objectIndex < capture.objects.length; objectIndex++) {
    const capturedObject = capture.objects[objectIndex];
    const object = objects[objectIndex];
    object.castShadow = capturedObject.castShadow;
    object.receiveShadow = capturedObject.receiveShadow;
    for (let materialIndex = 0; materialIndex < capturedObject.materials.length; materialIndex++) {
      const capturedMaterial = capturedObject.materials[materialIndex];
      const material = currentMaterials[objectIndex][materialIndex];
      material.color.set(capturedMaterial.color);
      material.roughness = capturedMaterial.roughness;
      material.metalness = capturedMaterial.metalness;
    }
  }
}

/** Production scene adapter. Lifecycle mutations remain fail-closed until the engine has exact restore. */
export class SceneAuthoringAdapter implements AuthoringAdapter<SceneCapture> {
  readonly id = SCENE_AUTHORING_ADAPTER_ID;
  readonly version = "1.0.0";
  readonly #world: WorldContext;

  constructor(options: SceneAuthoringAdapterOptions) {
    this.#world = options.world;
  }

  stateKey(operation: AuthoringOperation): string {
    const parsed = parseOperation(operation);
    const domain = parsed.action === "transform.set" ? "transform"
      : parsed.action === "tags.replace" ? "tags"
      : "material";
    return `scene:${domain}:${parsed.input.entity}`;
  }

  async preflight(operation: AuthoringOperation): Promise<void> {
    const parsed = parseOperation(operation);
    const entry = this.#world.entities.resolve(parsed.input.entity);
    if (entry === undefined) throw new Error(`scene entity '${parsed.input.entity}' does not exist`);
    if (parsed.action === "transform.set") {
      assertTransformScopeSupported(this.#world, parsed.input.entity);
    } else if (parsed.action === "material.patch") {
      captureMaterial(this.#world, parsed.input.entity);
      const changesShadow = parsed.input.castShadow !== undefined || parsed.input.receiveShadow !== undefined;
      if (changesShadow && entry.mesh === undefined) throw new Error("shadow flags require a materialized scene object");
    }
  }

  async capture(operation: AuthoringOperation, context: AuthoringAdapterContext): Promise<AuthoringCapture<SceneCapture>> {
    const parsed = parseOperation(operation);
    let snapshot: SceneCapture;
    if (parsed.action === "transform.set") {
      snapshot = { kind: "transform", states: subtreeIds(this.#world, parsed.input.entity).map((id) => transformState(this.#world, id)) };
    } else if (parsed.action === "tags.replace") {
      const entry = this.#world.entities.resolve(parsed.input.entity);
      if (entry === undefined) throw new Error(`scene entity '${parsed.input.entity}' does not exist`);
      const tags = this.#world.tags.get(entry.eid);
      snapshot = {
        kind: "tags",
        entity: parsed.input.entity,
        eid: entry.eid,
        present: tags !== undefined,
        tags: tags === undefined ? [] : sortedTags(tags),
      };
    } else {
      snapshot = captureMaterial(this.#world, parsed.input.entity);
    }
    return { snapshot, stateHash: context.hashJson(captureHashState(snapshot)) };
  }

  async apply(operation: AuthoringOperation): Promise<void> {
    const parsed = parseOperation(operation);
    const entry = this.#world.entities.resolve(parsed.input.entity);
    if (entry === undefined) throw new Error(`scene entity '${parsed.input.entity}' does not exist`);
    if (parsed.action === "transform.set") {
      const storage = this.#world.transforms;
      if (storage === undefined) throw new Error("scene authoring requires versioned transform storage");
      if (parsed.input.position !== undefined) storage.writePosition(entry.eid, ...parsed.input.position);
      if (parsed.input.rotation !== undefined) storage.writeRotation(entry.eid, ...parsed.input.rotation);
      if (parsed.input.scale !== undefined) storage.writeScale(entry.eid, ...parsed.input.scale);
      this.#world.spatial?.invalidate();
      if (this.#world.entities.childrenOf(parsed.input.entity).length > 0) propagateTransform(this.#world, parsed.input.entity);
    } else if (parsed.action === "tags.replace") {
      const tags = sortedTags(parsed.input.tags);
      if (tags.length === 0) this.#world.tags.delete(entry.eid);
      else this.#world.tags.set(entry.eid, new Set(tags));
    } else {
      const patch: MaterialState = {};
      if (parsed.input.color !== undefined) patch.color = parsed.input.color;
      if (parsed.input.roughness !== undefined) patch.roughness = parsed.input.roughness;
      if (parsed.input.metalness !== undefined) patch.metalness = parsed.input.metalness;
      const changesSurface = parsed.input.color !== undefined || parsed.input.roughness !== undefined || parsed.input.metalness !== undefined;
      if (changesSurface) entry.material = { ...entry.material, ...patch };
      const objects = materialObjects(entry.mesh);
      const materialsByObject = changesSurface ? objects.map(readableMaterials) : [];
      for (let objectIndex = 0; objectIndex < objects.length; objectIndex++) {
        const object = objects[objectIndex];
        if (parsed.input.castShadow !== undefined) object.castShadow = parsed.input.castShadow;
        if (parsed.input.receiveShadow !== undefined) object.receiveShadow = parsed.input.receiveShadow;
        if (changesSurface) {
          for (const material of materialsByObject[objectIndex]) {
            if (parsed.input.color !== undefined) material.color.set(parsed.input.color);
            if (parsed.input.roughness !== undefined) material.roughness = parsed.input.roughness;
            if (parsed.input.metalness !== undefined) material.metalness = parsed.input.metalness;
          }
        }
      }
    }
  }

  async stateHash(operation: AuthoringOperation, context: AuthoringAdapterContext): Promise<`sha256:${string}`> {
    const captured = await this.capture(operation, context);
    return captured.stateHash;
  }

  async rollback(_operation: AuthoringOperation, capture: SceneCapture): Promise<void> {
    await this.#restore(capture);
  }

  async compensate(_operation: AuthoringOperation, originalCapture: SceneCapture): Promise<void> {
    await this.#restore(originalCapture);
  }

  async #restore(capture: SceneCapture): Promise<void> {
    switch (capture.kind) {
      case "transform": restoreTransform(this.#world, capture); return;
      case "tags": restoreTags(this.#world, capture); return;
      case "material": restoreMaterial(this.#world, capture); return;
    }
  }
}

export function createSceneAuthoringAdapter(options: SceneAuthoringAdapterOptions): SceneAuthoringAdapter {
  return new SceneAuthoringAdapter(options);
}
