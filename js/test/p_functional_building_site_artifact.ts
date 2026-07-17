import {
  FUNCTIONAL_BUILDING_SITE_ARTIFACT_SCHEMA,
  decodeFunctionalBuildingSiteArtifact,
  encodeFunctionalBuildingSiteArtifact,
  parseFunctionalBuildingSiteArtifact,
  resolveFunctionalBuildingSiteArtifact,
  verifyFunctionalBuildingSiteArtifact,
} from "../src/assets/functional-building-site-artifact.mjs";
import { resolveFunctionalBuildingSitePlacement } from "../src/assets/functional-building-site.ts";
import { sha256 } from "../src/world/sha256.mjs";
import type { FunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_functional_building_site_artifact FAIL: ${message}`); }
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  try { fn(); } catch (error) { if (pattern.test(error instanceof Error ? error.message : String(error))) return; throw error; }
  throw new Error(`p_functional_building_site_artifact FAIL: ${message}`);
}
const H = (digit: string) => `sha256:${digit.repeat(64)}`;
const yaw = .731, position = [123.5, 0, -85.75] as const;
const contract = { site: {
  footprintCenter: [.35, -.2], footprintHalfExtents: [4.5, 3.25], finishedFloorY: .2, terrainClearance: .15, vegetationClearance: .8, maximumTerrainRelief: .8,
  entranceSupport: { sourcePrimitiveId: "primitive/entry-bearing", center: [0, -3], halfExtents: [.9, .8], yawRadians: .27, exteriorGradeY: -.1, bearingDepth: .45, maximumCutDepth: .2, maximumVariation: .25 },
} } as unknown as FunctionalBuildingContract;
// A planar world surface proves grade is measured in world metres and is invariant under building yaw.
const terrain = (x: number, z: number) => 8 + .018 * x - .027 * z;
const initial = resolveFunctionalBuildingSitePlacement({ contract, position, yaw, sampleHeight: terrain, maximumSampleSpacing: .4 });
const support = contract.site!.entranceSupport!, c = Math.cos(yaw), s = Math.sin(yaw),
  supportLocalX = support.center[0] + .5 * Math.cos(support.yawRadians), supportLocalZ = support.center[1] - .5 * Math.sin(support.yawRadians),
  routeX = position[0] + supportLocalX * c + supportLocalZ * s,
  routeZ = position[2] - supportLocalX * s + supportLocalZ * c,
  routeContact = [routeX, initial.entranceSupport!.worldGradeY, routeZ] as const;
const input = { artifactId: "site/grey-field/house-01/r1", placementId: "placement/0123456789abcdef", contractHash: H("1"), semanticFingerprint: H("2"), worldMapHash: H("3"),
  contract, position, yaw, routeContact, sampleHeight: terrain, maximumSampleSpacing: .4, maximumTerrainGrade: .1, maximumRouteElevationDelta: .45 };
const artifact = resolveFunctionalBuildingSiteArtifact(input), bytes = encodeFunctionalBuildingSiteArtifact(artifact), decoded = decodeFunctionalBuildingSiteArtifact(bytes),
  ref = { schema: "limina.functional-settlement-site-ref/v1", artifactId: artifact.artifactId, path: "settlements/grey-field/site-house-01.json", sha256: `sha256:${sha256(bytes)}` },
  live = { contract, sampleHeight: terrain, placementId: input.placementId, contractHash: input.contractHash, semanticFingerprint: input.semanticFingerprint, worldMapHash: input.worldMapHash, position, yaw, routeContact };
assert(artifact.schema === FUNCTIONAL_BUILDING_SITE_ARTIFACT_SCHEMA && Object.isFrozen(artifact) && Object.isFrozen(artifact.footprint.metrics), "artifact was not strictly parsed and deeply immutable");
assert(Math.abs(artifact.footprint.maximumObservedGrade - Math.hypot(.018, .027)) < 1e-10, "world terrain gradient magnitude was not measured on the rotated footprint");
assert(Math.abs(artifact.foundation.bearingPlaneWorldY - artifact.footprint.metrics.terrainMaximum) < 1e-10, "foundation bearing plane does not touch the terrain envelope");
assert(artifact.foundation.maximumFillDepth === artifact.footprint.metrics.terrainRelief && artifact.foundation.maximumCutDepth === 0, "foundation cut/fill evidence is inconsistent");
assert(Math.abs(artifact.routeContact.worldGradeY - initial.entranceSupport!.worldGradeY) < 1e-10 && artifact.routeContact.elevationDelta <= .45, "route contact is not tied to entrance support grade");
assert(decoded.metadata.sha256 === ref.sha256 && decoded.metadata.byteLength === bytes.byteLength, "exact byte metadata is wrong");
assert(verifyFunctionalBuildingSiteArtifact(bytes, ref, live).artifact.artifactId === artifact.artifactId, "live terrain verification failed");

rejects(() => verifyFunctionalBuildingSiteArtifact(bytes, { ...ref, sha256: H("9") }, live), /exact settlement reference/, "wrong exact hash was accepted");
rejects(() => verifyFunctionalBuildingSiteArtifact(bytes, ref, { ...live, sampleHeight: (x: number, z: number) => terrain(x, z) + (x > routeX ? .02 : 0) }), /does not reproduce|grade|unbuildable/, "terrain drift was accepted");
rejects(() => verifyFunctionalBuildingSiteArtifact(bytes, ref, { ...live, worldMapHash: H("8") }), /bindings do not match/, "wrong settlement map binding was accepted");
rejects(() => resolveFunctionalBuildingSiteArtifact({ ...input, routeContact: [routeX, routeContact[1], routeZ + 2] }), /outside the authored entrance support/, "route outside entrance bearing was accepted");
rejects(() => resolveFunctionalBuildingSiteArtifact({ ...input, routeContact: [routeX, routeContact[1] + .01, routeZ] }), /does not equal/, "route vertical seam was accepted");
rejects(() => resolveFunctionalBuildingSiteArtifact({ ...input, sampleHeight: (x: number) => x * .2, maximumTerrainGrade: .1 }), /grade|relief/, "steep terrain was accepted");
rejects(() => resolveFunctionalBuildingSiteArtifact({ ...input, sampleHeight: () => undefined }), /resident terrain/, "non-resident terrain was accepted");

const noncanonical = new TextEncoder().encode(JSON.stringify(artifact) + "\n");
rejects(() => decodeFunctionalBuildingSiteArtifact(noncanonical), /not canonical/, "noncanonical bytes were accepted");
const hostile: any = JSON.parse(JSON.stringify(artifact)); hostile.extra = true;
rejects(() => parseFunctionalBuildingSiteArtifact(hostile), /unknown field/, "unknown field was accepted");
const accessor: any = JSON.parse(JSON.stringify(artifact)); Object.defineProperty(accessor.foundation, "rootWorldY", { enumerable: true, get() { throw new Error("getter ran"); } });
rejects(() => parseFunctionalBuildingSiteArtifact(accessor), /enumerable data field/, "accessor executed or was accepted");
const prototyped: any = JSON.parse(JSON.stringify(artifact)); Object.setPrototypeOf(prototyped.routeContact, { hostile: true });
rejects(() => parseFunctionalBuildingSiteArtifact(prototyped), /plain object/, "prototyped record was accepted");
const sparse: any = JSON.parse(JSON.stringify(artifact)); sparse.placement.position.length = 4;
rejects(() => parseFunctionalBuildingSiteArtifact(sparse), /dense, field-free/, "malformed vector was accepted");
const inconsistent: any = JSON.parse(JSON.stringify(artifact)); inconsistent.foundation.bearingPlaneWorldY += .01;
rejects(() => parseFunctionalBuildingSiteArtifact(inconsistent), /does not bear/, "floating foundation evidence was accepted");

console.log(`p_functional_building_site_artifact OK: ${bytes.byteLength} canonical bytes, arbitrary-yaw grade=${artifact.footprint.maximumObservedGrade.toFixed(3)}, exact foundation/entrance/route bearing, hash binding, live-terrain reproduction, hostile-shape rejection`);
