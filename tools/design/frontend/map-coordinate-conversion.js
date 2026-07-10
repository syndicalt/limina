export function createWorldMapToMapDocTransform(worldMap, targetUnits = { kind: "m", unitsPerMeter: 1, origin: [0, 0] }) {
  const sourceScale = worldMap?.unitsPerMeter ?? 1;
  const sourceOrigin = Array.isArray(worldMap?.origin) ? worldMap.origin : [0, 0];
  const targetScale = targetUnits?.unitsPerMeter ?? 1;
  const targetOrigin = Array.isArray(targetUnits?.origin) ? targetUnits.origin : [0, 0];
  if (![sourceScale, sourceOrigin[0], sourceOrigin[1], targetScale, targetOrigin[0], targetOrigin[1]].every(Number.isFinite)
      || !(sourceScale > 0) || !(targetScale > 0) || targetUnits?.kind !== "m") {
    throw new Error("worldmap import coordinate frames are invalid");
  }
  const point = (value) => [
    (sourceOrigin[0] + value[0] * sourceScale - targetOrigin[0]) * targetScale,
    (sourceOrigin[1] + value[1] * sourceScale - targetOrigin[1]) * targetScale,
  ];
  const rect = (value) => {
    const start = point([value.x0, value.z0]);
    return { x0: start[0], z0: start[1], w: value.w * sourceScale * targetScale, h: value.h * sourceScale * targetScale };
  };
  const metersToTargetLength = (meters) => {
    if (!Number.isFinite(meters) || meters < 0) throw new Error("worldmap import length is invalid");
    return meters * targetScale;
  };
  return Object.freeze({ point, rect, metersToTargetLength, targetUnitsPerMeter: targetScale });
}
