import { canonicalStringify } from "../authoring/canonical.ts";
import type { CompiledArchitecture } from "./schema.ts";
/** Canonical one-way payload for the host Blender adapter. Blender may realize these primitives; it must not solve construction. */
export function serializeBlenderArchitectureInput(compiled: CompiledArchitecture): string {
  if (compiled.diagnostics.some((d) => d.severity === "error"))
    throw new Error("architecture blender adapter: compile contains errors");
  const functional = compiled.functionalContract;
  const multiRoom =
    functional?.schema === "limina.functional-building/v2"
      ? {
          schema: "limina.blender-multi-room-realization/v1",
          verticalLinkIds: functional.verticalLinks.map((link) => link.id),
          spawnAnchorIds: functional.spawnAnchors.map((anchor) => anchor.id),
          visibilityCellIds: functional.visibilityCells.map((cell) => cell.id),
          partitionedFloors: compiled.volumes
            .filter((volume) => volume.floorFragments)
            .map((volume) => ({
              volumeId: volume.id,
              prohibitedFullFloorId: volume.floor.id,
              fragmentIds: volume.floorFragments!.map((fragment) => fragment.id),
            })),
        }
      : undefined;
  return canonicalStringify({
    schema: "limina.blender-architecture-input/v1",
    compilerSchema: compiled.schema,
    specHash: compiled.specHash,
    irHash: compiled.irHash,
    primitives: compiled.primitives,
    entrances: compiled.entrances,
    ...(compiled.entranceCanopies?.length ? { entranceCanopies: compiled.entranceCanopies } : {}),
    doors: compiled.doors,
    windows: compiled.windows,
    dormers: compiled.dormers,
    roofPenetrations: compiled.roofPenetrations,
    roofSeams: compiled.roofSeams,
    fireplaces: compiled.fireplaces,
    practicalLights: compiled.practicalLights,
    furnishings: compiled.furnishings,
    ...(functional ? { functionalContract: functional } : {}),
    ...(multiRoom ? { multiRoom } : {}),
    ...(compiled.visualContract ? { visualContract: compiled.visualContract } : {}),
    review: compiled.review,
  });
}
