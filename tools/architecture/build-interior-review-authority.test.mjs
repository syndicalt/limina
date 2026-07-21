import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  validateStagedInteriorProxyReviewAuthority,
  verifyStagedInteriorProxyReviewClosure,
} from "../../js/src/render/staged-interior-proxy-review-scene.ts";
import { buildInteriorPlanStage } from "./build-interior-plan-stage.mjs";
import {
  buildInteriorReviewAuthorityFromClosure,
  writeInteriorReviewAuthority,
} from "./build-interior-review-authority.mjs";

const repo = resolve(import.meta.dirname, "../.."),
  relativePaths = {
    shellArtifact: "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell-artifact-approved.json",
    shellDecision: "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell-review-decision-approve.json",
    materialArtifact:
      "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-palette-artifact-approved.json",
    materialDecision:
      "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-review-decision-approve.json",
    plan: "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan.json",
    stageArtifact: "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan-artifact-draft.json",
  };

const cached = new Map();
async function closure(revision = 1) {
  if (cached.has(revision)) return cached.get(revision);
  const stage = await buildInteriorPlanStage({ repoRoot: repo, revision, write: false }),
    [shellArtifact, shellDecision, materialArtifact, materialDecision] = await Promise.all(
      [
        relativePaths.shellArtifact,
        relativePaths.shellDecision,
        relativePaths.materialArtifact,
        relativePaths.materialDecision,
      ].map((path) => readFile(resolve(repo, path))),
    ),
    material = JSON.parse(materialArtifact),
    derivedRuntime = await readFile(resolve(repo, material.metadata.derivedRuntime.path)),
    stageArtifact = Buffer.from(`${JSON.stringify(stage.artifact, null, 2)}\n`);
  const bytes = {
      shellArtifact,
      shellDecision,
      materialArtifact,
      materialDecision,
      plan: stage.planBytes,
      stageArtifact,
      derivedRuntime,
    },
    paths = {
      ...Object.fromEntries(Object.entries(relativePaths).map(([key, path]) => [key, resolve(repo, path)])),
      plan: stage.paths.planOutputPath,
      stageArtifact: stage.paths.artifactOutputPath,
    },
    value = {
      bytes,
      paths,
      stage,
      authority: buildInteriorReviewAuthorityFromClosure({ repoRoot: repo, paths, bytes }),
    };
  cached.set(revision, value);
  return value;
}

test("builds strict neutral-studio I1 authority from the real approved shell-r4/M1-r2 closure", async () => {
  const { authority } = await closure(),
    valid = validateStagedInteriorProxyReviewAuthority(authority);
  assert.equal(valid.plan.planId, "interior/functional-hall-house-v4/r1");
  assert.equal(
    valid.approvedShell.assetContentHash,
    "sha256:4aba79d5285d5bd0dddbc454b1949e986bf7cf52ce2e743a23814433b04b69ed",
  );
  assert.equal(
    valid.approvedMaterials.assetContentHash,
    "sha256:5d973e3f6e0dcc0a150c5f08e58682aae22d3af87808e78f1ef3844209150b88",
  );
  assert.equal(valid.derived.assetHash, "sha256:aa3d6f39e62aacd936406c7bd1c0078aa61ff446fba34938d979f2660284b78a");
  assert.deepEqual(valid.placement, { position: [0, 0, 0], yawRadians: 0 });
  assert.deepEqual(
    valid.evidenceViews.map(({ id, shellVisible }) => ({ id, shellVisible })),
    [
      { id: "layout-top-down", shellVisible: false },
      { id: "entry-walkthrough", shellVisible: true },
    ],
  );
});

test("emitted authority passes the runtime byte closure including exact approval decision files", async () => {
  const { authority, bytes } = await closure(),
    files = new Map([
      [authority.approvedShell.path, bytes.shellArtifact],
      [authority.approvedShell.approvalDecisionPath, bytes.shellDecision],
      [authority.approvedMaterials.path, bytes.materialArtifact],
      [authority.approvedMaterials.approvalDecisionPath, bytes.materialDecision],
      [authority.plan.path, bytes.plan],
      [authority.stageArtifact.path, bytes.stageArtifact],
      [authority.derived.runtimeGlbPath, bytes.derivedRuntime],
    ]),
    verified = verifyStagedInteriorProxyReviewClosure(authority, (path) => files.get(path));
  assert.equal(verified.plan.planId, authority.plan.planId);
});

test("r2 authority binds exact supersession and chair-yaw migration without weakening r1 defaults", async () => {
  const r1 = await closure(),
    r2 = await closure(2);
  assert.equal(r1.authority.plan.revision, 1);
  assert.equal(r1.authority.yawConventionMigration, undefined);
  assert.equal(r2.authority.plan.planId, "interior/functional-hall-house-v4/r2");
  assert.equal(r2.authority.plan.revision, 2);
  assert.equal(r2.stage.plan.supersedes, "interior/functional-hall-house-v4/r1");
  assert.deepEqual(r2.authority.yawConventionMigration, r2.stage.artifact.metadata.yawConventionMigration);
  const files = new Map([
    [r2.authority.approvedShell.path, r2.bytes.shellArtifact],
    [r2.authority.approvedShell.approvalDecisionPath, r2.bytes.shellDecision],
    [r2.authority.approvedMaterials.path, r2.bytes.materialArtifact],
    [r2.authority.approvedMaterials.approvalDecisionPath, r2.bytes.materialDecision],
    [r2.authority.plan.path, r2.bytes.plan],
    [r2.authority.stageArtifact.path, r2.bytes.stageArtifact],
    [r2.authority.derived.runtimeGlbPath, r2.bytes.derivedRuntime],
  ]);
  assert.equal(verifyStagedInteriorProxyReviewClosure(r2.authority, (path) => files.get(path)).plan.revision, 2);
});

test("r3 authority binds only the corrected hearth-settle migration and supersedes r2", async () => {
  const r3 = await closure(3),
    valid = validateStagedInteriorProxyReviewAuthority(r3.authority);
  assert.equal(valid.plan.planId, "interior/functional-hall-house-v4/r3");
  assert.equal(valid.plan.revision, 3);
  assert.equal(r3.stage.plan.supersedes, "interior/functional-hall-house-v4/r2");
  assert.equal(r3.stage.artifact.supersedes, "interior/functional-hall-house-v4/r2");
  assert.deepEqual(valid.yawConventionMigration, {
    from: "legacy-positive-yaw-hearth-settle",
    to: "engine-three-local-negative-z-facing-target",
    changedPlacementIds: ["placement/hearth-settle"],
  });
  const files = new Map([
    [valid.approvedShell.path, r3.bytes.shellArtifact],
    [valid.approvedShell.approvalDecisionPath, r3.bytes.shellDecision],
    [valid.approvedMaterials.path, r3.bytes.materialArtifact],
    [valid.approvedMaterials.approvalDecisionPath, r3.bytes.materialDecision],
    [valid.plan.path, r3.bytes.plan],
    [valid.stageArtifact.path, r3.bytes.stageArtifact],
    [valid.derived.runtimeGlbPath, r3.bytes.derivedRuntime],
  ]);
  assert.equal(verifyStagedInteriorProxyReviewClosure(valid, (path) => files.get(path)).plan.revision, 3);
});

test("r4 authority binds the front-facing wall-parallel settle revision and exact byte closure", async () => {
  const r4 = await closure(4),
    valid = validateStagedInteriorProxyReviewAuthority(r4.authority);
  assert.equal(valid.plan.planId, "interior/functional-hall-house-v4/r4");
  assert.equal(valid.plan.revision, 4);
  assert.equal(r4.stage.plan.supersedes, "interior/functional-hall-house-v4/r3");
  assert.equal(r4.stage.artifact.supersedes, "interior/functional-hall-house-v4/r3");
  assert.deepEqual(valid.yawConventionMigration, {
    from: "side-staged-hearth-settle",
    to: "front-facing-wall-parallel-hearth-settle",
    changedPlacementIds: ["placement/hearth-settle"],
  });
  const settle = r4.stage.plan.placements.find(({ id }) => id === "placement/hearth-settle");
  assert.deepEqual(settle.position, [2.95, 0.09, -0.9]);
  assert.equal(settle.yawRadians, Math.PI);
  const files = new Map([
    [valid.approvedShell.path, r4.bytes.shellArtifact],
    [valid.approvedShell.approvalDecisionPath, r4.bytes.shellDecision],
    [valid.approvedMaterials.path, r4.bytes.materialArtifact],
    [valid.approvedMaterials.approvalDecisionPath, r4.bytes.materialDecision],
    [valid.plan.path, r4.bytes.plan],
    [valid.stageArtifact.path, r4.bytes.stageArtifact],
    [valid.derived.runtimeGlbPath, r4.bytes.derivedRuntime],
  ]);
  assert.equal(verifyStagedInteriorProxyReviewClosure(valid, (path) => files.get(path)).plan.revision, 4);
});

test("fails closed on decision, derived runtime, plan, and draft closure drift", async () => {
  const { bytes, paths } = await closure();
  const changes = [
    {
      key: "shellDecision",
      value: Buffer.concat([bytes.shellDecision, Buffer.from(" ")]),
      pattern: /approval metadata drifted/,
    },
    { key: "derivedRuntime", value: Buffer.from("drift"), pattern: /derived runtime bytes drifted/ },
    { key: "plan", value: Buffer.from("{}\n"), pattern: /building interior plan v2/ },
    {
      key: "stageArtifact",
      value: Buffer.from(JSON.stringify({ ...JSON.parse(bytes.stageArtifact), status: "candidate" })),
      pattern: /exact unreviewed proxy-only/,
    },
  ];
  for (const change of changes) {
    const mutated = { ...bytes, [change.key]: change.value };
    assert.throws(
      () => buildInteriorReviewAuthorityFromClosure({ repoRoot: repo, paths, bytes: mutated }),
      change.pattern,
    );
  }
});

test("authority output is private and append-only", async () => {
  const { authority } = await closure(),
    directory = await mkdtemp(resolve(tmpdir(), "limina-i1-authority-")),
    output = resolve(directory, "interior-r1/interior-review-authority.json");
  try {
    await writeInteriorReviewAuthority(authority, output);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(writeInteriorReviewAuthority(authority, output), /EEXIST/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
