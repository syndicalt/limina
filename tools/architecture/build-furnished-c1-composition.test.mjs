import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildFurnishedC1Composition } from "./build-furnished-c1-composition.mjs";
import { buildingCompositionManifestV2Hash, validateBuildingCompositionManifestV2 } from "../../js/src/assets/building-composition-manifest-v2.mjs";

const root = resolve(import.meta.dirname, "../..");
const first = await buildFurnishedC1Composition({ repoRoot: root, write: false });
const second = await buildFurnishedC1Composition({ repoRoot: root, write: false });
assert.deepEqual(second, first, "C1 composition producer is not deterministic");
const manifest = validateBuildingCompositionManifestV2(first.manifest);
assert.equal(first.manifestHash, buildingCompositionManifestV2Hash(manifest));
assert.equal(manifest.schema, "limina.building-composition-manifest/v2");
assert.equal(manifest.id, "composition/functional-hall-house-v4/r3");
assert.equal(manifest.revision, 3);
assert.equal(manifest.supersedes, "composition/functional-hall-house-v4/r2");
assert.equal(manifest.instances.length, 7);
assert.deepEqual(Object.fromEntries([...new Set(manifest.instances.map(({ role }) => role))].map((role) => [role, manifest.instances.filter((entry) => entry.role === role).length])), {
  "dining-table": 1, "dining-chair": 4, "hearth-settle": 1, "service-storage": 1,
});

assert.equal(manifest.dependencies.shell.artifact.artifactId, "shell/functional-hall-house-v4/r4");
assert.equal(manifest.dependencies.materialPalette.artifact.artifactId, "materials/functional-hall-house-v4/r2");
assert.equal(manifest.dependencies.interiorPlan.artifact.artifactId, "interior/functional-hall-house-v4/r4");
assert.equal(manifest.dependencies.interiorPlan.artifact.status, "approved");
assert.equal(manifest.dependencies.interiorPlan.artifact.contractHash, "sha256:58a7021047e59c6374d7e420925cdc234d922b65ff11ecb6d91c196338506864");
assert.equal(manifest.dependencies.interiorPlan.artifact.contentHash, "sha256:32a25b969c940b4ee78365da6c75c9b47a7e70646e9faf04ce6c29b1357e2f0f");
assert.equal(manifest.dependencies.materialPalette.runtimeGlb.sha256, "sha256:5d973e3f6e0dcc0a150c5f08e58682aae22d3af87808e78f1ef3844209150b88");
assert.equal(manifest.dependencies.catalog.find(({ role }) => role === "hearth-settle").runtimeGlb.sha256,
  "sha256:474086ea4c86217a65e062241f7a0a5463898d4243a68f2c1a4f9b38f8b5e6ca");
for (const dependency of [manifest.dependencies.shell, manifest.dependencies.materialPalette, manifest.dependencies.interiorPlan,
  ...manifest.dependencies.catalog]) assert.match(dependency.artifact.artifactSha256, /^sha256:[0-9a-f]{64}$/);
for (const entry of manifest.dependencies.catalog) {
  assert.ok(entry.buildEvidence.path.endsWith("build-evidence.json"));
  assert.ok(entry.functionalEvidence.path.includes("functional-evidence"));
}

const plan = JSON.parse(await readFile(resolve(root, manifest.dependencies.interiorPlan.plan.path), "utf8"));
assert.equal(plan.planId, "interior/functional-hall-house-v4/r4");
assert.equal(plan.revision, 4);
assert.equal(plan.supersedes, "interior/functional-hall-house-v4/r3");
assert.deepEqual(manifest.instances.map(({ replacesSemanticIds }) => replacesSemanticIds[0]), plan.placements.map(({ id }) => id));
assert.deepEqual(manifest.instances.map(({ placement }) => placement.position), plan.placements.map(({ position }) => position));
assert.deepEqual(manifest.instances.map(({ placement }) => placement.yawRadians), plan.placements.map(({ yawRadians }) => yawRadians));
assert.deepEqual(manifest.legacyExclusions, plan.placements.map(({ id }) => id));
const hearthPlanPlacement = plan.placements.find(({ id }) => id === "placement/hearth-settle");
const hearthInstance = manifest.instances.find(({ id }) => id === "instance/hearth-settle");
assert.deepEqual(hearthPlanPlacement.position, [2.95, 0.09, -0.9]);
assert.equal(hearthPlanPlacement.yawRadians, Math.PI);
assert.deepEqual(hearthInstance.placement.position, hearthPlanPlacement.position);
assert.equal(hearthInstance.placement.yawRadians, hearthPlanPlacement.yawRadians);

const expectedFurniture = new Map([
  ["dining-table", { artifactId: "furniture/dining-table-v1/r1", artifactSha256: "sha256:2d616f2d70ab75fb3689317f6aa28756682e76c36242372387e53f3ac7ae80c7", originalInteriorId: "interior/functional-hall-house-v4/r1" }],
  ["dining-chair", { artifactId: "furniture/dining-chair-v1/r1", artifactSha256: "sha256:7a658b4431f3560405248cd0508cbd125f3cd25a661b522fa1715f97179fd0d6", originalInteriorId: "interior/functional-hall-house-v4/r2" }],
  ["hearth-settle", { artifactId: "furniture/hearth-settle-v3/r1", artifactSha256: "sha256:23cf8c2eb3d45edd99973facb03aeb559b1a3fdb89ecd9b1f8754b57da6f4fae", originalInteriorId: "interior/functional-hall-house-v4/r3" }],
  ["service-storage", { artifactId: "furniture/service-storage-v1/r1", artifactSha256: "sha256:5b1e4ea1fc7e12f0c5cab52e43b7a9032c3b758109cea84ff894834e596e57f3", originalInteriorId: "interior/functional-hall-house-v4/r2" }],
]);
for (const entry of manifest.dependencies.catalog) {
  const expected = expectedFurniture.get(entry.role);
  assert.equal(entry.artifact.artifactId, expected.artifactId, `${entry.role} approved F1 identity changed`);
  assert.equal(entry.artifact.artifactSha256, expected.artifactSha256, `${entry.role} approved F1 bytes changed`);
  const approved = JSON.parse(await readFile(resolve(root, entry.artifact.artifactPath), "utf8"));
  assert.equal(approved.inputs.find(({ kind }) => kind === "interior-plan")?.artifactId, expected.originalInteriorId,
    `${entry.role} original approved I1 closure was rewritten instead of being composition-verified against I1 r4`);
}

const byRole = (role) => manifest.instances.filter((entry) => entry.role === role);
assert.deepEqual(byRole("dining-table")[0].bindings.occupancySocketIds, []);
assert.equal(byRole("dining-table")[0].bindings.approachSocketIds.length, 4);
assert.equal(byRole("dining-table")[0].bindings.facingTargetId, null);
for (const chair of byRole("dining-chair")) {
  assert.equal(chair.bindings.occupancySocketIds.length, 1); assert.deepEqual(chair.bindings.approachSocketIds, []);
  assert.ok(chair.bindings.facingTargetId); assert.ok(chair.constraints.facing);
  assert.equal(chair.constraints.facing.minimumDot, Math.cos(Math.PI / 180));
}
assert.equal(byRole("hearth-settle")[0].bindings.occupancySocketIds.length, 2);
assert.equal(byRole("hearth-settle")[0].bindings.approachSocketIds.length, 1);
assert.equal(byRole("hearth-settle")[0].constraints.facing.minimumDot, Math.cos(7 * Math.PI / 180));
assert.ok(byRole("hearth-settle")[0].constraints.facing.minimumDot < Math.cos(6.649 * Math.PI / 180));
assert.equal(byRole("service-storage")[0].bindings.occupancySocketIds.length, 0);
assert.equal(byRole("service-storage")[0].bindings.approachSocketIds.length, 1);
assert.equal(byRole("service-storage")[0].constraints.facing, null);

const mutate = (operation) => { const value = structuredClone(manifest); operation(value); return value; };
assert.throws(() => validateBuildingCompositionManifestV2(mutate((value) => { delete value.dependencies.shell.artifact.artifactSha256; })), /artifactSha256 is required/);
assert.throws(() => validateBuildingCompositionManifestV2(mutate((value) => { value.dependencies.materialPalette.artifact.status = "candidate"; })), /approved exact artifact/);
assert.throws(() => validateBuildingCompositionManifestV2(mutate((value) => { delete value.dependencies.catalog[0].buildEvidence; })), /buildEvidence is required/);
assert.throws(() => validateBuildingCompositionManifestV2(mutate((value) => { value.instances[0].bindings.occupancySocketIds = ["occupancy/invented"]; })), /socket bindings do not match dining-table/);
assert.throws(() => validateBuildingCompositionManifestV2(mutate((value) => { const chair = value.instances.find(({ role }) => role === "dining-chair"); chair.bindings.facingTargetId = null; })), /facing target does not match dining-chair/);
assert.throws(() => validateBuildingCompositionManifestV2(mutate((value) => { const storage = value.instances.find(({ role }) => role === "service-storage"); storage.constraints.facing = { socketIds: ["approach/front"], targetSemanticId: "facing/invented", minimumDot: 1 }; })), /must not invent a facing constraint/);
assert.throws(() => validateBuildingCompositionManifestV2(mutate((value) => { value.instances[0].placement.scale = [1, 1.01, 1]; })), /cannot be rescaled/);

const source = await readFile(new URL("./build-furnished-c1-composition.mjs", import.meta.url), "utf8");
assert.match(source, /hearth-settle-v3-r6\/approved-artifact\.json/);
assert.match(source, /flag: "wx"/);
assert.doesNotMatch(source, /blender|render\(|gpu|timestamp/i);
const preservedR1 = await readFile(resolve(root, "assets/buildings/authoring/functional-hall-house-v4/composition-r1/composition-manifest.json"));
assert.equal(createHash("sha256").update(preservedR1).digest("hex"), "878293890d15432541247f0c4b36dcff3a420160de9f610c4af1b16a71a89d08");
const preservedR1Failure = await readFile(resolve(root, "assets/buildings/authoring/functional-hall-house-v4/composition-r1/functional-evidence.json"));
assert.equal(createHash("sha256").update(preservedR1Failure).digest("hex"), "ba0edee4e12a9516fbd0028958a36e3fc4deee219791f6b6c2e6cc0d79c4254f");
const r1Evidence = JSON.parse(preservedR1Failure);
assert.equal(r1Evidence.verdict, "fail");
assert.deepEqual(r1Evidence.checks.filter(({ passed }) => !passed).map(({ id }) => id), ["interaction-sockets-clearances-facing"]);
const preservedR2 = await readFile(resolve(root, "assets/buildings/authoring/functional-hall-house-v4/composition-r2/composition-manifest.json"));
assert.equal(createHash("sha256").update(preservedR2).digest("hex"), "f67a2d2bdfa927630715f47ff99130c5ad6a4ac46e964fcd831f76cbb673d105");
console.log("append-only C1 r3 manifest and deterministic seven-instance producer validated");
