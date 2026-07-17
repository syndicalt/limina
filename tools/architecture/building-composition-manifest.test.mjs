import assert from "node:assert/strict";
import { buildingCompositionManifestHash, validateBuildingCompositionManifest, assertBuildingCompositionInputsApproved } from "../../js/src/assets/building-composition-manifest.mjs";

const h = (digit) => `sha256:${digit.repeat(64)}`;
const artifact = (artifactId, kind, contentHash, status = "approved") => ({
  artifactPath: `assets/${artifactId}.json`, artifactId, kind, status, contractHash: h("a"), contentHash,
});
const manifest = {
  schema: "limina.building-composition-manifest/v1", id: "composition/hall-house-v4/r1", revision: 1,
  buildingId: "hall-house/temperate/v4", coordinateSystem: { units: "meter", up: "Y", front: "-Z" },
  dependencies: {
    shell: { artifact: artifact("shell/hall-house-v4/r1", "shell", h("1")), sourceBlend: { path: "assets/shell.blend", sha256: h("2") }, runtimeGlb: { path: "assets/shell.glb", sha256: h("1") } },
    interiorPlan: { artifact: artifact("interior/hall-house-v4/r1", "interior-plan", h("3")), plan: { path: "assets/interior.json", sha256: h("3") } },
    catalog: [{ artifact: artifact("furniture/hearth-settle-v2-r2/r1", "furniture-pack", h("4")), sourceBlend: { path: "assets/settle.blend", sha256: h("5") }, runtimeGlb: { path: "assets/settle.glb", sha256: h("4") }, approvalDecision: { path: "assets/approve.json", sha256: h("6") } }],
  },
  instances: [{
    id: "instance/hearth-settle", kind: "furniture", catalogArtifactId: "furniture/hearth-settle-v2-r2/r1",
    placement: { position: [3.1, .09, .1], yawRadians: Math.PI, scale: [1, 1, 1] }, replacesSemanticIds: ["hall-hearth-bench"],
    bindings: { roomId: "room/main", zoneId: "zone/hearth", supportId: "surface/main-hall-floor", facingTargetId: "fireplace/hall-hearth", occupancySocketIds: ["occupancy/left", "occupancy/right"], approachSocketIds: ["approach/left", "approach/right"] },
    constraints: { floorContact: { surfaceId: "surface/main-hall-floor", targetY: .09, toleranceM: .002 }, containment: { roomId: "room/main" }, clearances: [{ id: "clearance/hearth", againstSemanticId: "fireplace/hall-hearth/base", minimumM: .9 }], facing: { socketIds: ["occupancy/left", "occupancy/right"], targetSemanticId: "fireplace/hall-hearth", minimumDot: .98 }, approachCollisionFree: true },
  }],
  legacyExclusions: ["hall-hearth-bench"],
};

assert.equal(validateBuildingCompositionManifest(manifest).instances[0].placement.position[0], 3.1);
assert.match(buildingCompositionManifestHash(manifest), /^sha256:[0-9a-f]{64}$/);
assert.equal(buildingCompositionManifestHash(structuredClone(manifest)), buildingCompositionManifestHash(manifest));
assert.equal(assertBuildingCompositionInputsApproved(manifest), manifest);

const genericAabb = structuredClone(manifest); genericAabb.instances[0].constraints = { wholeAabb: true };
assert.throws(() => validateBuildingCompositionManifest(genericAabb), /floorContact is required|wholeAabb is unsupported/);
const scaled = structuredClone(manifest); scaled.instances[0].placement.scale = [1.01, 1, 1];
assert.throws(() => validateBuildingCompositionManifest(scaled), /cannot be rescaled/);
const stale = structuredClone(manifest); stale.dependencies.catalog[0].runtimeGlb.sha256 = h("7");
assert.throws(() => validateBuildingCompositionManifest(stale), /exact stage content hash/);
const draft = structuredClone(manifest); draft.dependencies.interiorPlan.artifact.status = "draft";
assert.throws(() => assertBuildingCompositionInputsApproved(draft), /requires approved exact inputs/);
console.log("building composition manifest strict identity and placement gates validated");
