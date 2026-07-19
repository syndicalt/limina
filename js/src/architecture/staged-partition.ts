import { canonicalStringify } from "../authoring/canonical.ts";
import { sha256 } from "../world/sha256.mjs";
import type { ArchitecturePrimitive, ArchitectureSpec, CompiledArchitecture } from "./schema.ts";

const hash = (value: unknown) => `sha256:${sha256(canonicalStringify(value))}`;
const ordered = <T extends { id: string }>(values: readonly T[]) =>
  Object.freeze([...values].sort((a, b) => a.id.localeCompare(b.id)));

export interface ArchitectureStagePayload<T> {
  readonly schema: string;
  readonly sourceSpecHash: string;
  readonly sourceIrHash: string;
  readonly payloadHash: string;
  readonly payload: T;
}
export interface StagedArchitecturePartition {
  readonly schema: "limina.staged-architecture-partition/v1";
  readonly shell: ArchitectureStagePayload<{
    primitives: readonly ArchitecturePrimitive[];
    entrances: CompiledArchitecture["entrances"];
    entranceCanopies?: NonNullable<CompiledArchitecture["entranceCanopies"]>;
    doors: CompiledArchitecture["doors"];
    windows: CompiledArchitecture["windows"];
    dormers: CompiledArchitecture["dormers"];
    roofPenetrations: CompiledArchitecture["roofPenetrations"];
    roofSeams: CompiledArchitecture["roofSeams"];
    fireplaces: readonly unknown[];
    functionalContract: CompiledArchitecture["functionalContract"];
  }>;
  readonly interiorPlan: ArchitectureStagePayload<{
    sourceAuthority: "architecture-spec-compatibility";
    migrationRequired: true;
    furnishings: NonNullable<ArchitectureSpec["furnishings"]>;
    domesticProps: NonNullable<ArchitectureSpec["domesticProps"]>;
  }>;
  readonly furniturePacks: readonly ArchitectureStagePayload<{
    id: string;
    kind: string;
    primitives: readonly ArchitecturePrimitive[];
  }>[];
  readonly propPacks: readonly ArchitectureStagePayload<{
    id: string;
    kind: string;
    primitives: readonly ArchitecturePrimitive[];
  }>[];
  readonly fireRuntime: ArchitectureStagePayload<{
    sourceAuthority: "compiler-fire-compatibility";
    migrationRequired: true;
    primitives: readonly ArchitecturePrimitive[];
    practicalLights: CompiledArchitecture["practicalLights"];
    sockets: readonly {
      fireplaceId: string;
      penetrationId?: string;
      lightPosition: readonly [number, number, number];
    }[];
  }>;
}

function stage<T>(schema: string, compiled: CompiledArchitecture, payload: T): ArchitectureStagePayload<T> {
  return Object.freeze({
    schema,
    sourceSpecHash: compiled.specHash,
    sourceIrHash: compiled.irHash,
    payloadHash: hash(payload),
    payload: Object.freeze(payload),
  });
}

/** Compatibility partition used to remove visible content from the shell before the new producers replace it. */
export function partitionCompiledArchitecture(
  spec: ArchitectureSpec,
  compiled: CompiledArchitecture,
): StagedArchitecturePartition {
  if (compiled.diagnostics.some((item) => item.severity === "error"))
    throw new Error("staged architecture partition requires an error-free compile");
  const furnitureIds = new Set(compiled.furnishings.flatMap((item) => item.parts.map((part) => part.id)));
  const propIds = new Set(compiled.domesticProps.flatMap((item) => item.parts.map((part) => part.id)));
  const fireIds = new Set(
    compiled.fireplaces.flatMap((item) => [
      item.emberBed.id,
      ...item.fuel.map((part) => part.id),
      ...item.flames.map((part) => part.id),
    ]),
  );
  for (const id of [...furnitureIds, ...propIds])
    if (fireIds.has(id)) throw new Error(`staged architecture partition has multiply-owned primitive ${id}`);
  const shellPrimitives = ordered(
    compiled.primitives.filter((part) => !furnitureIds.has(part.id) && !propIds.has(part.id) && !fireIds.has(part.id)),
  );
  const finalPrimitiveById = new Map(compiled.primitives.map((item) => [item.id, item]));
  const resolved = (parts: readonly ArchitecturePrimitive[]) =>
    ordered(
      parts.map((item) => {
        const final = finalPrimitiveById.get(item.id);
        if (!final) throw new Error(`staged architecture partition cannot resolve final primitive ${item.id}`);
        return final;
      }),
    );
  const furniturePacks = ordered(compiled.furnishings).map((item) =>
    stage("limina.building-furniture-pack-source/v1", compiled, {
      id: item.id,
      kind: item.kind,
      primitives: resolved(item.parts),
    }),
  );
  const propPacks = ordered(compiled.domesticProps).map((item) =>
    stage("limina.building-prop-pack-source/v1", compiled, {
      id: item.id,
      kind: item.kind,
      primitives: resolved(item.parts),
    }),
  );
  const firePrimitives = ordered(compiled.primitives.filter((part) => fireIds.has(part.id)));
  const owned = new Set(
    [
      ...shellPrimitives,
      ...firePrimitives,
      ...furniturePacks.flatMap((item) => item.payload.primitives),
      ...propPacks.flatMap((item) => item.payload.primitives),
    ].map((item) => item.id),
  );
  if (owned.size !== compiled.primitives.length)
    throw new Error(
      `staged architecture partition lost or duplicated primitives (${owned.size}/${compiled.primitives.length})`,
    );
  const shellFireplaces = compiled.fireplaces.map((item) =>
    Object.freeze({
      id: item.id,
      ...(item.penetrationId ? { penetrationId: item.penetrationId } : {}),
      base: item.base,
      cavity: item.cavity,
      surround: item.surround,
    }),
  );
  const shell = stage("limina.building-shell-source/v1", compiled, {
    primitives: shellPrimitives,
    entrances: compiled.entrances,
    ...(compiled.entranceCanopies?.length ? { entranceCanopies: compiled.entranceCanopies } : {}),
    doors: compiled.doors,
    windows: compiled.windows,
    dormers: compiled.dormers,
    roofPenetrations: compiled.roofPenetrations,
    roofSeams: compiled.roofSeams,
    fireplaces: Object.freeze(shellFireplaces),
    functionalContract: compiled.functionalContract,
  });
  const interiorPlan = stage("limina.building-interior-plan-source/v1", compiled, {
    sourceAuthority: "architecture-spec-compatibility" as const,
    migrationRequired: true as const,
    furnishings: Object.freeze([...(spec.furnishings ?? [])]),
    domesticProps: Object.freeze([...(spec.domesticProps ?? [])]),
  });
  const fireRuntime = stage("limina.building-fire-runtime-source/v1", compiled, {
    sourceAuthority: "compiler-fire-compatibility" as const,
    migrationRequired: true as const,
    primitives: firePrimitives,
    practicalLights: compiled.practicalLights,
    sockets: Object.freeze(
      compiled.fireplaces.map((item) =>
        Object.freeze({
          fireplaceId: item.id,
          ...(item.penetrationId ? { penetrationId: item.penetrationId } : {}),
          lightPosition: item.lightPosition,
        }),
      ),
    ),
  });
  return Object.freeze({
    schema: "limina.staged-architecture-partition/v1",
    shell,
    interiorPlan,
    furniturePacks: Object.freeze(furniturePacks),
    propPacks: Object.freeze(propPacks),
    fireRuntime,
  });
}

/** One-way shell-only Blender payload. It deliberately carries no furniture, props, fire visuals, or practical lights. */
export function serializeBlenderShellInput(
  partition: StagedArchitecturePartition,
  compiled: CompiledArchitecture,
): string {
  const shell = partition.shell;
  if (shell.sourceIrHash !== compiled.irHash || shell.sourceSpecHash !== compiled.specHash)
    throw new Error("shell partition does not belong to compiled architecture");
  return canonicalStringify({
    schema: "limina.blender-architecture-input/v1",
    compilerSchema: compiled.schema,
    specHash: compiled.specHash,
    irHash: shell.payloadHash,
    primitives: shell.payload.primitives,
    entrances: shell.payload.entrances,
    ...(shell.payload.entranceCanopies?.length ? { entranceCanopies: shell.payload.entranceCanopies } : {}),
    doors: shell.payload.doors,
    windows: shell.payload.windows,
    dormers: shell.payload.dormers,
    roofPenetrations: shell.payload.roofPenetrations,
    roofSeams: shell.payload.roofSeams,
    fireplaces: shell.payload.fireplaces,
    practicalLights: [],
    furnishings: [],
    ...(shell.payload.functionalContract ? { functionalContract: shell.payload.functionalContract } : {}),
    review: compiled.review,
  });
}

const localPoint = (
  point: readonly [number, number, number],
  center: readonly [number, number, number],
  yaw: number,
): readonly [number, number, number] => {
  const dx = point[0] - center[0],
    dz = point[2] - center[2],
    c = Math.cos(yaw),
    s = Math.sin(yaw);
  return Object.freeze([c * dx - s * dz, point[1] - center[1], s * dx + c * dz]);
};
export function localizeFurniturePack(
  spec: ArchitectureSpec,
  partition: StagedArchitecturePartition,
  furnishingId: string,
) {
  const placement = spec.furnishings?.find((item) => item.id === furnishingId);
  if (!placement) throw new Error(`unknown furnishing placement ${furnishingId}`);
  const pack = partition.furniturePacks.find((item) => item.payload.id === furnishingId);
  if (!pack) throw new Error(`missing compiled furnishing pack ${furnishingId}`);
  const yaw = placement.yawRadians ?? 0,
    primitives = pack.payload.primitives.map((primitive): ArchitecturePrimitive => {
      if (primitive.kind === "box")
        return Object.freeze({
          ...primitive,
          center: localPoint(primitive.center, placement.center, yaw),
          yawRadians: (primitive.yawRadians ?? 0) - yaw,
        });
      if (primitive.kind === "oriented-cylinder")
        return Object.freeze({
          ...primitive,
          from: localPoint(primitive.from, placement.center, yaw),
          to: localPoint(primitive.to, placement.center, yaw),
        });
      if (primitive.kind === "linear-member")
        return Object.freeze({
          ...primitive,
          from: localPoint(primitive.from, placement.center, yaw),
          to: localPoint(primitive.to, placement.center, yaw),
        });
      if (primitive.kind === "lathed-profile")
        return Object.freeze({ ...primitive, center: localPoint(primitive.center, placement.center, yaw) });
      throw new Error(`furniture pack ${furnishingId} uses unsupported local primitive ${primitive.kind}`);
    });
  const payload = {
    schema: "limina.local-furniture-pack/v1" as const,
    id: pack.payload.id,
    kind: pack.payload.kind,
    sourceSpecHash: pack.sourceSpecHash,
    sourceIrHash: pack.sourceIrHash,
    placement: Object.freeze({ center: placement.center, yawRadians: yaw }),
    origin: Object.freeze([0, 0, 0] as const),
    primitives: Object.freeze(primitives),
  };
  return Object.freeze({ ...payload, payloadHash: hash(payload) });
}

export function serializeBlenderFurniturePackInput(
  localPack: ReturnType<typeof localizeFurniturePack>,
  compiled: CompiledArchitecture,
): string {
  return canonicalStringify({
    schema: "limina.blender-architecture-input/v1",
    compilerSchema: compiled.schema,
    specHash: compiled.specHash,
    irHash: localPack.payloadHash,
    primitives: localPack.primitives,
    entrances: [],
    doors: [],
    windows: [],
    dormers: [],
    roofPenetrations: [],
    roofSeams: [],
    fireplaces: [],
    practicalLights: [],
    furnishings: [{ id: localPack.id, kind: localPack.kind, parts: localPack.primitives }],
    review: compiled.review,
  });
}
