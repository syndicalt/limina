import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { validateFurnitureCaptureEnvelope } from "./build-furniture-review-candidate.mjs";
import { validateFurniturePackReviewAuthority } from "../../js/src/render/furniture-pack-review-scene.ts";
import {
  collect,
  findCalls,
  findPropertyAssignments,
  findVariable,
  hasPropertyPath,
  hasStringLiteral,
  literalValue,
  objectProperty,
  parseTypeScript,
  propertyInitializer,
  propertyPath,
  ts,
  unwrapExpression,
} from "./test-source-semantics.mjs";

const root = resolve(import.meta.dirname, "../.."),
  producer = resolve(root, "tools/architecture/build-furniture-review.ts"),
  baseArgs = [
    producer,
    "--visual-contract",
    "art-direction/furniture/hearth-settle-v2-visual-design.json",
    "--interior-artifact",
    "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan-artifact-approved.json",
    "--interior-decision",
    "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-review-decision-approve.json",
    "--interior-plan",
    "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan.json",
    "--material-artifact",
    "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-palette-artifact-approved.json",
    "--material-decision",
    "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-review-decision-approve.json",
    "--proxy-archetype",
    "proxy/hearth-settle",
    "--out",
    "assets/qc/internal/furniture/test-must-not-write.json",
  ];
const functionalPass = (verdict = "pass") => ({
  schema: "limina.furniture-functional-evidence/v1",
  verdict,
  inputs: {
    furnitureContractHash: "sha256:9d2a4760e013db370cf299c2559c034d38e6c87673b5820f28445c94fd2cae50",
    runtimeGlbSha256: "sha256:86d43554df9ccac491f888d2059f9d4543ac98ee9e07221f51bf0736e1766453",
    runtimeSemanticInventorySha256: "sha256:c280bc7b2c3a81cb23ced6f7b96b801733589d85371ae2c2ae9c5f42a0da95c4",
    interiorArtifactId: "interior/functional-hall-house-v4/r1",
    interiorContractHash: "sha256:b20c6f60d96c866eeb6fdba6c368b3b819ab85113e9765bbee192bef8d0aaded",
    interiorContentHash: "sha256:43c2ca0b29ca8b384b000628fe91e927e2b3748331f5db8fcb85fc4cbe36c9e9",
    selectedProxyArchetypeId: "proxy/hearth-settle",
  },
  policy: { boundsToleranceM: 0.02 },
  checks: [
    { id: "input-identity", passed: verdict === "pass", findings: verdict === "pass" ? [] : ["failed"], metrics: {} },
  ],
  summary: { passed: verdict === "pass" ? 1 : 0, failed: verdict === "pass" ? 0 : 1 },
});
const run = (evidence, functional) =>
  spawnSync("bun", [...baseArgs, "--evidence", evidence, "--functional-evidence", functional], {
    cwd: root,
    encoding: "utf8",
  });
async function withFunctional(verdict, callback) {
  const directory = await mkdtemp(resolve(tmpdir(), "limina-f1-pass-"));
  try {
    const path = resolve(directory, "functional.json");
    await writeFile(path, JSON.stringify(functionalPass(verdict)));
    return await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("F1 producer rejects a typed asset that exceeds its exact approved I1 proxy", () =>
  withFunctional("pass", (path) => {
    const result = run("assets/buildings/authoring/furniture/hearth-settle-v2-r2/build-evidence.json", path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exceed approved I1 proxy/);
  }));

test("F1 producer rejects legacy primitive-pack evidence before authority creation", async () =>
  withFunctional("pass", async (functional) => {
    const directory = await mkdtemp(resolve(tmpdir(), "limina-f1-"));
    try {
      const evidence = JSON.parse(
        await readFile(
          resolve(root, "assets/buildings/authoring/furniture/hearth-settle-v2-r2/build-evidence.json"),
          "utf8",
        ),
      );
      evidence.schema = "limina.building-furniture-pack-evidence/v1";
      const path = resolve(directory, "legacy.json");
      await writeFile(path, JSON.stringify(evidence));
      const result = run(path, functional);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /legacy primitive packs are forbidden/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }));
test("F1 producer rejects a real verifier failure artifact", () =>
  withFunctional("fail", (path) => {
    const result = run("assets/buildings/authoring/furniture/hearth-settle-v2-r2/build-evidence.json", path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /all-checks-passed functional verifier artifact/);
  }));

const H = `sha256:${"0".repeat(64)}`,
  identity = { path: "authority.json", sha256: H, contentHash: H },
  functional = { schema: "limina.furniture-functional-evidence/v1", contractHash: H },
  authority = {
    pack: { id: "chair", sha256: H },
    source: { blendPath: "source.blend", blendSha256: H },
    dependencies: { interior: { artifactId: "i1" }, materials: { artifactId: "m1" } },
    functionalEvidence: functional,
  };
const validCapture = () => ({
  schema: "limina.furniture-pack-native-review-set/v1",
  backend: "native-webgpu",
  captureClass: "production-engine",
  pixelFormat: "rgba8unorm",
  rowOrigin: "top-left",
  authority: identity,
  pack: authority.pack,
  source: authority.source,
  dependencies: authority.dependencies,
  functionalEvidence: functional,
  mounted: { functionalEvidence: functional, collisionEvidence: "compound-semantic-functional-placement" },
  timingPolicy: { gpuTimestampMode: "disabled", timestampQueriesEnabled: false },
  guardEvidence: {
    schema: "limina.nvidia-xid-guard/v1",
    preflight: { xidObserved: false },
    live: { xidObserved: false },
    postflight: { xidObserved: false },
  },
});
test("F1 candidate envelope rejects generic placement collision claims", () => {
  const capture = validCapture();
  capture.mounted.collisionEvidence = "generic-placement-aabb-only-not-furniture-quality";
  assert.throws(() => validateFurnitureCaptureEnvelope(authority, capture, identity), /exact F1 authority/);
});
test("F1 candidate envelope rejects timestamp queries and incomplete guard evidence", () => {
  const capture = validCapture();
  capture.timingPolicy.timestampQueriesEnabled = true;
  assert.throws(() => validateFurnitureCaptureEnvelope(authority, capture, identity), /absolute native GPU guard/);
});
test("F1 candidate envelope rejects stale I1\/M1 closure transport", () => {
  const capture = validCapture();
  capture.dependencies = { ...capture.dependencies, interior: { artifactId: "stale" } };
  assert.throws(() => validateFurnitureCaptureEnvelope(authority, capture, identity), /exact F1 authority/);
});

test("F1 candidate source never fabricates an LOD contract", async () => {
  const source = await readFile(resolve(root, "tools/architecture/build-furniture-review-candidate.mjs"), "utf8");
  const file = parseTypeScript(source, "build-furniture-review-candidate.mjs"),
    lodEvidence = findPropertyAssignments(file, "lodEvidence").map((property) =>
      unwrapExpression(property.initializer),
    );
  assert.equal(hasStringLiteral(file, "authored-single-lod"), false);
  assert.ok(
    lodEvidence.some(
      (value) =>
        ts.isConditionalExpression(value) &&
        ts.isBinaryExpression(value.condition) &&
        value.condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        propertyPath(value.condition.left) === "lodProof.proven" &&
        literalValue(value.condition.right) === true &&
        literalValue(value.whenTrue) === "proven" &&
        literalValue(value.whenFalse) === "not-claimed",
    ),
    "candidate must claim LOD evidence only when the verifier proves it",
  );
});

test("F1 authority compares canonical verifier inputs by exact keys and values, not insertion order", async () => {
  const source = await readFile(producer, "utf8");
  const file = parseTypeScript(source, "build-furniture-review.ts"),
    objectKeys = findCalls(file, "Object.keys"),
    stringifyComparisons = collect(
      file,
      (node) =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        collect(
          node,
          (child) => ts.isCallExpression(child) && propertyPath(child.expression) === "JSON.stringify",
        ).some((call) => propertyPath(call.arguments[0]) === "functionalPass.inputs") &&
        collect(
          node,
          (child) => ts.isCallExpression(child) && propertyPath(child.expression) === "JSON.stringify",
        ).some((call) => propertyPath(call.arguments[0]) === "functionalInputs"),
    );
  assert.ok(
    objectKeys.some((call) => {
      const argument = unwrapExpression(call.arguments[0]),
        sortAccess = call.parent;
      return (
        ts.isBinaryExpression(argument) &&
        argument.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        propertyPath(argument.left) === "functionalPass.inputs" &&
        ts.isObjectLiteralExpression(unwrapExpression(argument.right)) &&
        ts.isPropertyAccessExpression(sortAccess) &&
        sortAccess.name.text === "sort" &&
        ts.isCallExpression(sortAccess.parent)
      );
    }),
    "authority must canonicalize verifier input keys before comparing exact values",
  );
  assert.equal(stringifyComparisons.length, 0, "authority must not compare insertion-order-sensitive JSON strings");
});

test("F1 authority supports a clean chair seat-section without enabling diagnostic overlays", async () => {
  const source = await readFile(producer, "utf8");
  const file = parseTypeScript(source, "build-furniture-review.ts"),
    detailViews = unwrapExpression(findVariable(file, "detailViews")[0].initializer),
    seatSection = propertyInitializer(objectProperty(detailViews, "seat-section"));
  assert.ok(ts.isCallExpression(seatSection) && propertyPath(seatSection.expression) === "camera");
  assert.deepEqual(seatSection.arguments.slice(0, 3).map(literalValue), ["seat-section", "functional", "static"]);
  assert.equal(hasPropertyPath(file, "validatedContract.dimensions.seatHeightM"), true);
  const scene = await readFile(resolve(root, "js/src/render/furniture-pack-review-scene.ts"), "utf8");
  const sceneFile = parseTypeScript(scene, "furniture-pack-review-scene.ts"),
    exactVisibility = (name, id) =>
      findVariable(sceneFile, name).some((declaration) => {
        const value = unwrapExpression(declaration.initializer);
        return (
          ts.isBinaryExpression(value) &&
          value.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
          propertyPath(value.left) === "view.id" &&
          literalValue(value.right) === id
        );
      });
  assert.equal(exactVisibility("socketVisible", "socket-overlay"), true);
  assert.equal(exactVisibility("collisionVisible", "collision-overlay"), true);
});

test("F1 r2 authority requires the selected archetype placement facet", async () => {
  const authority = JSON.parse(
      await readFile(
        resolve(root, "assets/buildings/authoring/furniture/dining-table-v1/review-authority-r2.json"),
        "utf8",
      ),
    ),
    scoped = { scope: "placements/proxy/dining-chair", hash: H },
    support = authority.dependencies.interior.artifact.facets.find((facet) => facet.scope === "support-bindings");
  authority.dependencies.interior.plan.revision = 2;
  authority.dependencies.interior.selectedProxy.archetypeId = "proxy/dining-chair";
  authority.dependencies.interior.selectedProxy.placementFacetHash = H;
  authority.functionalEvidence.inputs.selectedProxyArchetypeId = "proxy/dining-chair";
  authority.dependencies.interior.artifact.facets = [scoped, support];
  assert.doesNotThrow(() => validateFurniturePackReviewAuthority(authority));
  authority.dependencies.interior.artifact.facets[0] = { scope: "placements", hash: H };
  assert.throws(() => validateFurniturePackReviewAuthority(authority), /exact selected I1 placement facet/);
});
