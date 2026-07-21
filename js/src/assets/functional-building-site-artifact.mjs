// FB-5 portable site/foundation authority. This module is deliberately pure: it samples a supplied
// terrain function and returns immutable evidence, but never edits terrain or places a building.

import { resolveFunctionalBuildingSitePlacement } from "./functional-building-site.ts";
import { canonicalCompilerJson } from "../world/compiler/canonical.mjs";
import { sha256 } from "../world/sha256.mjs";

export const FUNCTIONAL_BUILDING_SITE_ARTIFACT_SCHEMA = "limina.functional-building-site-artifact/v1";
export const FUNCTIONAL_BUILDING_SITE_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.functional-building-site+json";
export const FUNCTIONAL_SETTLEMENT_SITE_REF_SCHEMA = "limina.functional-settlement-site-ref/v1";
export const FUNCTIONAL_BUILDING_SITE_ARTIFACT_MAX_BYTES = 32 * 1024;
export const FUNCTIONAL_BUILDING_SITE_LIMITS = Object.freeze({
  idChars: 160,
  coordinateMagnitude: 1_000_000_000,
  maximumSpacing: 1,
  maximumTerrainGrade: 4,
  maximumRouteElevationTolerance: 0.5,
  maximumSamples: 200_000,
});

const ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._/-]{0,511}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const EPS = 1e-8;
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });

export class FunctionalBuildingSiteArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = "FunctionalBuildingSiteArtifactError";
  }
}
function fail(message) {
  throw new FunctionalBuildingSiteArtifactError(message);
}
function record(value, required, optional, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length) fail(`${label} must not contain symbol fields`);
  const allowed = new Set([...required, ...optional]),
    descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true)
      fail(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
  return descriptors;
}
function array(value, length, label) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== length ||
    Object.getOwnPropertySymbols(value).length ||
    Object.getOwnPropertyNames(value).length !== length + 1
  )
    fail(`${label} must be a dense, field-free ${length}-vector`);
  return value;
}
function finite(value, minimum, maximum, label) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  )
    fail(`${label} must be a bounded finite number`);
  return value;
}
function uint(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(`${label} must be a positive bounded integer`);
  return value;
}
function id(value, label) {
  if (
    typeof value !== "string" ||
    !ID.test(value) ||
    value.length > FUNCTIONAL_BUILDING_SITE_LIMITS.idChars ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    fail(`${label} is invalid`);
  return value;
}
function hash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) fail(`${label} must be a lowercase sha256 hash`);
  return value;
}
function path(value, label) {
  if (typeof value !== "string" || !PATH.test(value)) fail(`${label} is invalid`);
  return value;
}
function vector(value, length, label, magnitude = FUNCTIONAL_BUILDING_SITE_LIMITS.coordinateMagnitude) {
  return Object.freeze(
    array(value, length, label).map((item, index) => finite(item, -magnitude, magnitude, `${label}[${index}]`)),
  );
}
function metrics(value, label) {
  const d = record(
    value,
    new Set(["terrainMinimum", "terrainMaximum", "terrainRelief", "sampleCount"]),
    new Set(),
    label,
  );
  const terrainMinimum = finite(
      d.terrainMinimum.value,
      -FUNCTIONAL_BUILDING_SITE_LIMITS.coordinateMagnitude,
      FUNCTIONAL_BUILDING_SITE_LIMITS.coordinateMagnitude,
      `${label}.terrainMinimum`,
    ),
    terrainMaximum = finite(
      d.terrainMaximum.value,
      terrainMinimum,
      FUNCTIONAL_BUILDING_SITE_LIMITS.coordinateMagnitude,
      `${label}.terrainMaximum`,
    ),
    terrainRelief = finite(
      d.terrainRelief.value,
      0,
      FUNCTIONAL_BUILDING_SITE_LIMITS.coordinateMagnitude,
      `${label}.terrainRelief`,
    ),
    sampleCount = uint(d.sampleCount.value, FUNCTIONAL_BUILDING_SITE_LIMITS.maximumSamples, `${label}.sampleCount`);
  if (Math.abs(terrainMaximum - terrainMinimum - terrainRelief) > EPS)
    fail(`${label}.terrainRelief is inconsistent with its extrema`);
  return Object.freeze({ terrainMinimum, terrainMaximum, terrainRelief, sampleCount });
}
function support(value, label) {
  const d = record(
    value,
    new Set([
      "terrainMinimum",
      "terrainMaximum",
      "terrainVariation",
      "worldGradeY",
      "fillDepth",
      "cutDepth",
      "sampleCount",
    ]),
    new Set(),
    label,
  );
  const terrainMinimum = finite(d.terrainMinimum.value, -1e9, 1e9, `${label}.terrainMinimum`),
    terrainMaximum = finite(d.terrainMaximum.value, terrainMinimum, 1e9, `${label}.terrainMaximum`),
    terrainVariation = finite(d.terrainVariation.value, 0, 1e9, `${label}.terrainVariation`),
    worldGradeY = finite(d.worldGradeY.value, -1e9, 1e9, `${label}.worldGradeY`),
    fillDepth = finite(d.fillDepth.value, 0, 1e9, `${label}.fillDepth`),
    cutDepth = finite(d.cutDepth.value, 0, 1e9, `${label}.cutDepth`),
    sampleCount = uint(d.sampleCount.value, FUNCTIONAL_BUILDING_SITE_LIMITS.maximumSamples, `${label}.sampleCount`);
  if (
    Math.abs(terrainMaximum - terrainMinimum - terrainVariation) > EPS ||
    Math.abs(Math.max(0, worldGradeY - terrainMinimum) - fillDepth) > EPS ||
    Math.abs(Math.max(0, terrainMaximum - worldGradeY) - cutDepth) > EPS
  )
    fail(`${label} metrics are internally inconsistent`);
  return Object.freeze({
    terrainMinimum,
    terrainMaximum,
    terrainVariation,
    worldGradeY,
    fillDepth,
    cutDepth,
    sampleCount,
  });
}

/** Strict parser for untrusted decoded publication data. */
export function parseFunctionalBuildingSiteArtifact(value) {
  const d = record(
    value,
    new Set([
      "schema",
      "artifactId",
      "placementId",
      "bindings",
      "placement",
      "policy",
      "footprint",
      "foundation",
      "routeContact",
    ]),
    new Set(["entranceSupport"]),
    "functional building site artifact",
  );
  if (d.schema.value !== FUNCTIONAL_BUILDING_SITE_ARTIFACT_SCHEMA)
    fail("functional building site artifact.schema is unsupported");
  const bindingsRaw = record(
      d.bindings.value,
      new Set(["contractHash", "semanticFingerprint", "worldMapHash"]),
      new Set(),
      "functional building site artifact.bindings",
    ),
    bindings = Object.freeze({
      contractHash: hash(bindingsRaw.contractHash.value, "bindings.contractHash"),
      semanticFingerprint: hash(bindingsRaw.semanticFingerprint.value, "bindings.semanticFingerprint"),
      worldMapHash: hash(bindingsRaw.worldMapHash.value, "bindings.worldMapHash"),
    });
  const placementRaw = record(
      d.placement.value,
      new Set(["position", "yaw"]),
      new Set(),
      "functional building site artifact.placement",
    ),
    placement = Object.freeze({
      position: vector(placementRaw.position.value, 3, "placement.position"),
      yaw: finite(placementRaw.yaw.value, -Math.PI, Math.PI, "placement.yaw"),
    });
  const policyRaw = record(
      d.policy.value,
      new Set(["maximumSampleSpacing", "maximumTerrainGrade", "maximumRouteElevationDelta"]),
      new Set(),
      "functional building site artifact.policy",
    ),
    policy = Object.freeze({
      maximumSampleSpacing: finite(
        policyRaw.maximumSampleSpacing.value,
        Number.MIN_VALUE,
        1,
        "policy.maximumSampleSpacing",
      ),
      maximumTerrainGrade: finite(
        policyRaw.maximumTerrainGrade.value,
        0,
        FUNCTIONAL_BUILDING_SITE_LIMITS.maximumTerrainGrade,
        "policy.maximumTerrainGrade",
      ),
      maximumRouteElevationDelta: finite(
        policyRaw.maximumRouteElevationDelta.value,
        0,
        FUNCTIONAL_BUILDING_SITE_LIMITS.maximumRouteElevationTolerance,
        "policy.maximumRouteElevationDelta",
      ),
    });
  const footprintRaw = record(
      d.footprint.value,
      new Set(["center", "halfExtents", "metrics", "maximumObservedGrade"]),
      new Set(),
      "functional building site artifact.footprint",
    ),
    footprint = Object.freeze({
      center: vector(footprintRaw.center.value, 2, "footprint.center"),
      halfExtents: vector(footprintRaw.halfExtents.value, 2, "footprint.halfExtents"),
      metrics: metrics(footprintRaw.metrics.value, "footprint.metrics"),
      maximumObservedGrade: finite(
        footprintRaw.maximumObservedGrade.value,
        0,
        FUNCTIONAL_BUILDING_SITE_LIMITS.maximumTerrainGrade,
        "footprint.maximumObservedGrade",
      ),
    });
  if (
    footprint.halfExtents.some((axis) => axis <= 0) ||
    footprint.maximumObservedGrade > policy.maximumTerrainGrade + EPS
  )
    fail("functional building site artifact footprint exceeds its grade policy");
  const foundationRaw = record(
      d.foundation.value,
      new Set(["rootWorldY", "finishedFloorWorldY", "bearingPlaneWorldY", "maximumFillDepth", "maximumCutDepth"]),
      new Set(),
      "functional building site artifact.foundation",
    ),
    foundation = Object.freeze({
      rootWorldY: finite(foundationRaw.rootWorldY.value, -1e9, 1e9, "foundation.rootWorldY"),
      finishedFloorWorldY: finite(foundationRaw.finishedFloorWorldY.value, -1e9, 1e9, "foundation.finishedFloorWorldY"),
      bearingPlaneWorldY: finite(foundationRaw.bearingPlaneWorldY.value, -1e9, 1e9, "foundation.bearingPlaneWorldY"),
      maximumFillDepth: finite(foundationRaw.maximumFillDepth.value, 0, 1e9, "foundation.maximumFillDepth"),
      maximumCutDepth: finite(foundationRaw.maximumCutDepth.value, 0, 1e9, "foundation.maximumCutDepth"),
    });
  if (
    Math.abs(foundation.bearingPlaneWorldY - footprint.metrics.terrainMaximum) > EPS ||
    Math.abs(foundation.maximumFillDepth - footprint.metrics.terrainRelief) > EPS ||
    foundation.maximumCutDepth > EPS
  )
    fail("functional building site artifact foundation does not bear on the sampled terrain envelope");
  const routeRaw = record(
      d.routeContact.value,
      new Set(["position", "terrainY", "worldGradeY", "elevationDelta"]),
      new Set(),
      "functional building site artifact.routeContact",
    ),
    routeContact = Object.freeze({
      position: vector(routeRaw.position.value, 3, "routeContact.position"),
      terrainY: finite(routeRaw.terrainY.value, -1e9, 1e9, "routeContact.terrainY"),
      worldGradeY: finite(routeRaw.worldGradeY.value, -1e9, 1e9, "routeContact.worldGradeY"),
      elevationDelta: finite(routeRaw.elevationDelta.value, 0, 1e9, "routeContact.elevationDelta"),
    });
  if (
    Math.abs(Math.abs(routeContact.worldGradeY - routeContact.terrainY) - routeContact.elevationDelta) > EPS ||
    routeContact.elevationDelta > policy.maximumRouteElevationDelta + EPS ||
    Math.abs(routeContact.position[1] - routeContact.worldGradeY) > EPS
  )
    fail("functional building site artifact route contact violates its elevation policy");
  const entranceSupport =
    d.entranceSupport === undefined
      ? undefined
      : support(d.entranceSupport.value, "functional building site artifact.entranceSupport");
  if (entranceSupport === undefined || Math.abs(entranceSupport.worldGradeY - routeContact.worldGradeY) > EPS)
    fail("functional building site artifact requires one entrance support sharing the route grade");
  return Object.freeze({
    schema: FUNCTIONAL_BUILDING_SITE_ARTIFACT_SCHEMA,
    artifactId: id(d.artifactId.value, "artifactId"),
    placementId: id(d.placementId.value, "placementId"),
    bindings,
    placement,
    policy,
    footprint,
    foundation,
    routeContact,
    entranceSupport,
  });
}

function worldFromLocal(position, yaw, x, z) {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return [position[0] + x * c + z * s, position[2] - x * s + z * c];
}
function sampleFootprint(site, position, yaw, spacing, sampleHeight) {
  const stepsX = Math.max(1, Math.ceil((site.footprintHalfExtents[0] * 2) / spacing)),
    stepsZ = Math.max(1, Math.ceil((site.footprintHalfExtents[1] * 2) / spacing));
  if ((stepsX + 1) * (stepsZ + 1) > FUNCTIONAL_BUILDING_SITE_LIMITS.maximumSamples)
    fail("site footprint sampling exceeds the bounded sample cap");
  const rows = [],
    dx = (site.footprintHalfExtents[0] * 2) / stepsX,
    dz = (site.footprintHalfExtents[1] * 2) / stepsZ;
  for (let iz = 0; iz <= stepsZ; iz++) {
    const row = [];
    for (let ix = 0; ix <= stepsX; ix++) {
      const localX = site.footprintCenter[0] - site.footprintHalfExtents[0] + dx * ix,
        localZ = site.footprintCenter[1] - site.footprintHalfExtents[1] + dz * iz,
        [x, z] = worldFromLocal(position, yaw, localX, localZ),
        y = sampleHeight(x, z);
      if (y === undefined || !Number.isFinite(y)) fail(`site footprint leaves resident terrain at ${x},${z}`);
      row.push(y);
    }
    rows.push(row);
  }
  let maximumGrade = 0;
  for (let iz = 0; iz <= stepsZ; iz++)
    for (let ix = 0; ix <= stepsX; ix++) {
      const x0 = ix === stepsX ? ix - 1 : ix,
        x1 = ix === stepsX ? ix : ix + 1,
        z0 = iz === stepsZ ? iz - 1 : iz,
        z1 = iz === stepsZ ? iz : iz + 1,
        gradeX = (rows[iz][x1] - rows[iz][x0]) / ((x1 - x0) * dx),
        gradeZ = (rows[z1][ix] - rows[z0][ix]) / ((z1 - z0) * dz);
      maximumGrade = Math.max(maximumGrade, Math.hypot(gradeX, gradeZ));
    }
  return maximumGrade;
}
function pointInSupport(site, localX, localZ) {
  const support = site.entranceSupport,
    dx = localX - support.center[0],
    dz = localZ - support.center[1],
    c = Math.cos(support.yawRadians),
    s = Math.sin(support.yawRadians);
  return (
    Math.abs(dx * c - dz * s) <= support.halfExtents[0] + EPS &&
    Math.abs(dx * s + dz * c) <= support.halfExtents[1] + EPS
  );
}

/** Resolve live terrain into the one artifact value that may later authorize transactional placement. */
export function resolveFunctionalBuildingSiteArtifact(input) {
  const site = input.contract?.site;
  if (!site?.entranceSupport) fail("site artifact requires an authored entrance support");
  const spacing = finite(input.maximumSampleSpacing ?? 0.5, Number.MIN_VALUE, 1, "maximumSampleSpacing"),
    maximumTerrainGrade = finite(input.maximumTerrainGrade ?? 0.75, 0, 4, "maximumTerrainGrade"),
    maximumRouteElevationDelta = finite(input.maximumRouteElevationDelta ?? 0.1, 0, 0.5, "maximumRouteElevationDelta"),
    position = vector(input.position, 3, "position"),
    yaw = finite(input.yaw, -Math.PI, Math.PI, "yaw"),
    route = vector(input.routeContact, 3, "routeContact");
  if (typeof input.sampleHeight !== "function") fail("site artifact sampleHeight must be a function");
  const resolved = resolveFunctionalBuildingSitePlacement({
    contract: input.contract,
    position,
    yaw,
    sampleHeight: input.sampleHeight,
    maximumSampleSpacing: spacing,
  });
  const maximumObservedGrade = sampleFootprint(site, position, yaw, spacing, input.sampleHeight);
  if (maximumObservedGrade > maximumTerrainGrade + EPS)
    fail(`site footprint grade ${maximumObservedGrade.toFixed(3)} exceeds ${maximumTerrainGrade.toFixed(3)}`);
  const c = Math.cos(yaw),
    s = Math.sin(yaw),
    dx = route[0] - position[0],
    dz = route[2] - position[2],
    localX = dx * c - dz * s,
    localZ = dx * s + dz * c;
  if (!pointInSupport(site, localX, localZ)) fail("route contact is outside the authored entrance support");
  const terrainY = input.sampleHeight(route[0], route[2]);
  if (terrainY === undefined || !Number.isFinite(terrainY)) fail("route contact leaves resident terrain");
  const worldGradeY = resolved.entranceSupport.worldGradeY,
    elevationDelta = Math.abs(worldGradeY - terrainY);
  if (Math.abs(route[1] - worldGradeY) > EPS)
    fail("route contact elevation does not equal the authored entrance grade");
  if (elevationDelta > maximumRouteElevationDelta + EPS)
    fail(`route contact elevation delta ${elevationDelta.toFixed(3)} exceeds ${maximumRouteElevationDelta.toFixed(3)}`);
  const value = {
    schema: FUNCTIONAL_BUILDING_SITE_ARTIFACT_SCHEMA,
    artifactId: input.artifactId,
    placementId: input.placementId,
    bindings: {
      contractHash: input.contractHash,
      semanticFingerprint: input.semanticFingerprint,
      worldMapHash: input.worldMapHash,
    },
    placement: { position, yaw },
    policy: { maximumSampleSpacing: spacing, maximumTerrainGrade, maximumRouteElevationDelta },
    footprint: {
      center: site.footprintCenter,
      halfExtents: site.footprintHalfExtents,
      metrics: {
        terrainMinimum: resolved.terrainMinimum,
        terrainMaximum: resolved.terrainMaximum,
        terrainRelief: resolved.terrainRelief,
        sampleCount: resolved.sampleCount,
      },
      maximumObservedGrade,
    },
    foundation: {
      rootWorldY: resolved.rootWorldY,
      finishedFloorWorldY: resolved.rootWorldY + site.finishedFloorY,
      bearingPlaneWorldY: resolved.rootWorldY + site.finishedFloorY - site.terrainClearance,
      maximumFillDepth: resolved.terrainRelief,
      maximumCutDepth: 0,
    },
    routeContact: { position: route, terrainY, worldGradeY, elevationDelta },
    entranceSupport: resolved.entranceSupport,
  };
  return parseFunctionalBuildingSiteArtifact(value);
}

export function encodeFunctionalBuildingSiteArtifact(value) {
  const parsed = parseFunctionalBuildingSiteArtifact(value),
    text = `${canonicalCompilerJson(parsed, { maxBytes: FUNCTIONAL_BUILDING_SITE_ARTIFACT_MAX_BYTES, maxDepth: 12, maxNodes: 256, maxProperties: 64, maxArrayLength: 3 })}\n`,
    bytes = encoder.encode(text);
  if (bytes.byteLength > FUNCTIONAL_BUILDING_SITE_ARTIFACT_MAX_BYTES)
    fail("functional building site artifact exceeds its byte cap");
  return bytes;
}
export function decodeFunctionalBuildingSiteArtifact(bytesValue) {
  if (
    !(bytesValue instanceof Uint8Array) ||
    bytesValue.byteLength < 2 ||
    bytesValue.byteLength > FUNCTIONAL_BUILDING_SITE_ARTIFACT_MAX_BYTES
  )
    fail("functional building site artifact bytes are outside their bounded range");
  const bytes = new Uint8Array(bytesValue),
    text = (() => {
      try {
        return decoder.decode(bytes);
      } catch (error) {
        fail(
          `functional building site artifact is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n"))
    fail("functional building site artifact must be one canonical JSON line");
  let source;
  try {
    source = JSON.parse(text.slice(0, -1));
  } catch (error) {
    fail(
      `functional building site artifact JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const artifact = parseFunctionalBuildingSiteArtifact(source),
    canonical = encodeFunctionalBuildingSiteArtifact(artifact);
  if (canonical.byteLength !== bytes.byteLength || !canonical.every((value, index) => value === bytes[index]))
    fail("functional building site artifact bytes are not canonical");
  return Object.freeze({
    artifact,
    metadata: Object.freeze({
      mediaType: FUNCTIONAL_BUILDING_SITE_ARTIFACT_MEDIA_TYPE,
      byteLength: bytes.byteLength,
      sha256: `sha256:${sha256(bytes)}`,
    }),
  });
}

/** Verify the exact settlement reference and reproduce the artifact from current contract/terrain. */
export function verifyFunctionalBuildingSiteArtifact(bytes, expectedRef, liveInput) {
  const decoded = decodeFunctionalBuildingSiteArtifact(bytes),
    ref = record(
      expectedRef,
      new Set(["schema", "artifactId", "path", "sha256"]),
      new Set(),
      "expected site artifact reference",
    ),
    artifactId = id(ref.artifactId.value, "expected site artifact reference.artifactId"),
    expectedHash = hash(ref.sha256.value, "expected site artifact reference.sha256");
  if (ref.schema.value !== FUNCTIONAL_SETTLEMENT_SITE_REF_SCHEMA)
    fail("expected site artifact reference.schema is unsupported");
  path(ref.path.value, "expected site artifact reference.path");
  if (decoded.artifact.artifactId !== artifactId || decoded.metadata.sha256 !== expectedHash)
    fail("site artifact does not match its exact settlement reference");
  const expected = {
    placementId: id(liveInput.placementId, "live settlement placementId"),
    contractHash: hash(liveInput.contractHash, "live settlement contractHash"),
    semanticFingerprint: hash(liveInput.semanticFingerprint, "live settlement semanticFingerprint"),
    worldMapHash: hash(liveInput.worldMapHash, "live settlement worldMapHash"),
    position: vector(liveInput.position, 3, "live settlement position"),
    yaw: finite(liveInput.yaw, -Math.PI, Math.PI, "live settlement yaw"),
    routeContact: vector(liveInput.routeContact, 3, "live settlement routeContact"),
  };
  if (
    decoded.artifact.placementId !== expected.placementId ||
    decoded.artifact.bindings.contractHash !== expected.contractHash ||
    decoded.artifact.bindings.semanticFingerprint !== expected.semanticFingerprint ||
    decoded.artifact.bindings.worldMapHash !== expected.worldMapHash ||
    canonicalCompilerJson(decoded.artifact.placement) !==
      canonicalCompilerJson({ position: expected.position, yaw: expected.yaw }) ||
    canonicalCompilerJson(decoded.artifact.routeContact.position) !== canonicalCompilerJson(expected.routeContact)
  )
    fail("site artifact bindings do not match the exact settlement placement");
  const reproduced = resolveFunctionalBuildingSiteArtifact({
    ...liveInput,
    artifactId,
    placementId: expected.placementId,
    contractHash: expected.contractHash,
    semanticFingerprint: expected.semanticFingerprint,
    worldMapHash: expected.worldMapHash,
    position: expected.position,
    yaw: expected.yaw,
    routeContact: expected.routeContact,
    maximumSampleSpacing: decoded.artifact.policy.maximumSampleSpacing,
    maximumTerrainGrade: decoded.artifact.policy.maximumTerrainGrade,
    maximumRouteElevationDelta: decoded.artifact.policy.maximumRouteElevationDelta,
  });
  const reproducedBytes = encodeFunctionalBuildingSiteArtifact(reproduced);
  if (
    reproducedBytes.byteLength !== bytes.byteLength ||
    !reproducedBytes.every((value, index) => value === bytes[index])
  )
    fail("site artifact does not reproduce from current terrain and contract authority");
  return decoded;
}
