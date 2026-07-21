// Pure FB-5 closure between a validated functional settlement plan and one exact WorldMap.
// This module deliberately performs no placement, terrain sampling, site mutation, or streaming.

import { parseFunctionalSettlementPlan } from "./functional-settlement-plan.mjs";
import { WorldMapSchema, verifyWorldMap } from "../world/worldmap.ts";

export const FUNCTIONAL_SETTLEMENT_ATLAS_RESOLUTION_SCHEMA = "limina.functional-settlement-atlas-resolution/v1";
export const FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS = Object.freeze({
  connectorToleranceM: 25,
  coordinateEpsilonM: 1e-6,
  coordinateMagnitudeM: 1_000_000_000,
  anchors: 65_536,
  routes: 4_096,
  pointsPerRoute: 65_536,
  totalRoutePoints: 1_048_576,
});

export class FunctionalSettlementAtlasResolutionError extends Error {
  constructor(message) { super(message); this.name = "FunctionalSettlementAtlasResolutionError"; }
}
function fail(message) { throw new FunctionalSettlementAtlasResolutionError(message); }
function finite(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum) fail(`${label} is not a bounded finite number`);
  return value;
}
function near(left, right) { return Math.abs(left - right) <= FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.coordinateEpsilonM; }
function freezePoints(points) { return Object.freeze(points.map((point) => Object.freeze([point[0], point[1]]))); }

function pointSegmentDistanceSquared(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / lengthSquared));
  const qx = a[0] + t * dx, qz = a[1] + t * dz;
  return (px - qx) ** 2 + (pz - qz) ** 2;
}

function routeDistanceSquared(point, route) {
  let best = Infinity;
  for (let index = 1; index < route.points.length; index++) {
    best = Math.min(best, pointSegmentDistanceSquared(point[0], point[1], route.points[index - 1], route.points[index]));
  }
  return best;
}

/**
 * Resolve a strict settlement plan against exact, content-addressed WorldMap authority.
 * WorldMap is planar, so Atlas authoritatively closes x/z and yaw; the already strict plan keeps
 * y from its exact site/foundation authority. The returned position remains the complete x/y/z
 * placement and no component is recomputed or discarded.
 */
export function resolveFunctionalSettlementAtlas(planValue, catalogValue, worldMapValue, options = {}) {
  const plan = parseFunctionalSettlementPlan(planValue, catalogValue);
  let worldMap;
  try { worldMap = WorldMapSchema.parse(worldMapValue); }
  catch (error) { fail(`WorldMap rejected: ${error instanceof Error ? error.message : String(error)}`); }

  if (options === null || typeof options !== "object" || Array.isArray(options)
      || (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
      || Object.getOwnPropertySymbols(options).length !== 0) fail("Atlas resolution options must be a plain object");
  const optionDescriptors = Object.getOwnPropertyDescriptors(options);
  for (const [key, descriptor] of Object.entries(optionDescriptors)) {
    if (key !== "connectorToleranceM") fail(`Atlas resolution options has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`Atlas resolution options.${key} must be an enumerable data field`);
  }
  const connectorToleranceM = optionDescriptors.connectorToleranceM === undefined ? 0
    : finite(optionDescriptors.connectorToleranceM.value, 0, FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.connectorToleranceM, "Atlas connectorToleranceM");

  const verification = verifyWorldMap(worldMap);
  if (!verification.ok) fail(`WorldMap content hash mismatch: expected ${verification.expected}, actual ${verification.actual}`);
  if (worldMap.id !== plan.atlas.mapId) fail(`settlement Atlas map id '${plan.atlas.mapId}' does not match WorldMap '${worldMap.id}'`);
  const exactHash = `sha256:${verification.actual}`;
  if (plan.atlas.worldMapHash !== exactHash) fail(`settlement Atlas hash '${plan.atlas.worldMapHash}' does not match WorldMap '${exactHash}'`);

  const anchors = new Map();
  if (worldMap.anchors.length > FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.anchors) fail(`WorldMap exceeds ${FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.anchors} anchors`);
  for (let index = 0; index < worldMap.anchors.length; index++) {
    const anchor = worldMap.anchors[index];
    if (anchors.has(anchor.id)) fail(`WorldMap has duplicate anchor '${anchor.id}'`);
    anchors.set(anchor.id, anchor);
  }
  const routes = new Map();
  if (worldMap.routes.length > FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.routes) fail(`WorldMap exceeds ${FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.routes} routes`);
  let totalRoutePoints = 0;
  for (let index = 0; index < worldMap.routes.length; index++) {
    const route = worldMap.routes[index];
    if (route.id === undefined) fail(`WorldMap route[${index}] has no stable Atlas id`);
    if (routes.has(route.id)) fail(`WorldMap has duplicate route '${route.id}'`);
    if (route.points.length > FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.pointsPerRoute) fail(`WorldMap route '${route.id}' exceeds ${FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.pointsPerRoute} points`);
    totalRoutePoints += route.points.length;
    if (totalRoutePoints > FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.totalRoutePoints) fail(`WorldMap route geometry exceeds ${FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.totalRoutePoints} points`);
    for (let pointIndex = 0; pointIndex < route.points.length; pointIndex++) {
      finite(route.points[pointIndex][0], -FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.coordinateMagnitudeM, FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.coordinateMagnitudeM, `WorldMap route '${route.id}'.points[${pointIndex}][0]`);
      finite(route.points[pointIndex][1], -FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.coordinateMagnitudeM, FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.coordinateMagnitudeM, `WorldMap route '${route.id}'.points[${pointIndex}][1]`);
    }
    routes.set(route.id, route);
  }

  const resolvedPlacements = plan.placements.map((placement, index) => {
    const anchor = anchors.get(placement.atlasBinding.anchorId);
    if (anchor === undefined) fail(`placement '${placement.placementId}' references missing WorldMap anchor '${placement.atlasBinding.anchorId}'`);
    if (anchor.rot === undefined) fail(`WorldMap anchor '${anchor.id}' has no authored yaw`);
    finite(anchor.rot, -Math.PI, Math.PI, `WorldMap anchor '${anchor.id}'.rot`);
    if (!near(anchor.position[0], placement.position[0]) || !near(anchor.position[1], placement.position[2])
        || !near(anchor.rot, placement.yaw)) {
      fail(`placement '${placement.placementId}' loses the WorldMap anchor position or rotation`);
    }
    const route = routes.get(placement.atlasBinding.routeId);
    if (route === undefined) fail(`placement '${placement.placementId}' references missing WorldMap route '${placement.atlasBinding.routeId}'`);
    const contact = [placement.entryConnector.routeContact[0], placement.entryConnector.routeContact[2]];
    const distanceM = Math.sqrt(routeDistanceSquared(contact, route));
    if (distanceM > connectorToleranceM + FUNCTIONAL_SETTLEMENT_ATLAS_LIMITS.coordinateEpsilonM) {
      fail(`placement '${placement.placementId}' routeContact is ${distanceM}m from route '${route.id}', beyond ${connectorToleranceM}m`);
    }
    return Object.freeze({
      placementId: placement.placementId,
      position: placement.position,
      yaw: placement.yaw,
      anchor: Object.freeze({ id: anchor.id, position: Object.freeze([anchor.position[0], placement.position[1], anchor.position[1]]), yaw: anchor.rot }),
      route: Object.freeze({ id: route.id, class: route.class, points: freezePoints(route.points) }),
      routeContact: placement.entryConnector.routeContact,
      connectorDistanceM: distanceM,
      inputOrder: index,
    });
  });

  return Object.freeze({
    schema: FUNCTIONAL_SETTLEMENT_ATLAS_RESOLUTION_SCHEMA,
    plan,
    atlas: Object.freeze({ mapId: worldMap.id, worldMapHash: exactHash, connectorToleranceM }),
    placements: Object.freeze(resolvedPlacements),
  });
}
