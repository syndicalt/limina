import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import test from "node:test";
import { validateBuildingInteriorPlanV2 } from "../../js/src/assets/building-interior-plan-v2.mjs";
import { validateStagedInteriorProxyReviewAuthority } from "../../js/src/render/staged-interior-proxy-review-scene.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import { buildInteriorReviewCandidate } from "./build-interior-review-candidate.mjs";

const root = resolve(import.meta.dirname, "../.."),
  authorityPath = resolve(
    root,
    "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-review-authority.json",
  ),
  draftPath = resolve(
    root,
    "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan-artifact-draft.json",
  ),
  sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  portable = (path) => relative(root, path).split(sep).join("/");

async function fixture() {
  const authorityBytes = await readFile(authorityPath),
    authority = validateStagedInteriorProxyReviewAuthority(JSON.parse(authorityBytes)),
    plan = validateBuildingInteriorPlanV2(JSON.parse(await readFile(resolve(root, authority.plan.path)))),
    directory = await mkdtemp(resolve(root, "tools/architecture/.i1-candidate-fixture-")),
    capturePath = resolve(directory, "capture.json");
  const inventory = {
    zones: plan.zones.length,
    placements: plan.placements.length,
    facingMarkers: plan.placements.filter(({ facingTargetId }) => facingTargetId !== null).length,
    clearances: plan.interactionClearances.length,
    navigationNodes: plan.navigation.nodes.length,
    navigationEdges: plan.navigation.edges.length,
    doorSweeps: plan.doorSweeps.length,
    hearthExclusions: plan.hearthExclusions.length,
  };
  const captures = authority.evidenceViews.map((view, index) => {
    const baseline = { frameId: index * 2 + 1, renderCalls: 4, drawCalls: 10, triangles: 100 },
      candidate = { frameId: index * 2 + 2, renderCalls: 6, drawCalls: 14, triangles: 140 };
    return {
      id: view.id,
      role: view.role,
      shellVisible: view.shellVisible,
      proxiesVisible: true,
      width: 1920,
      height: 1080,
      rgbaContentHash: `sha256:${String(index + 3).repeat(64)}`,
      renderSubmission: {
        schema: "limina.three-render-submission/v2",
        source: "three-webgpu-renderer-info",
        scope: "single-production-frame-all-passes",
        instanceAccounting: "full-draw-instance-count",
        ...candidate,
        cpuEncodeMs: 1.25,
      },
      pairedRenderSubmission: {
        schema: "limina.paired-render-submission/v1",
        basis: "same-process-fixed-camera-time-residency-post-visibility-toggle",
        baseline,
        candidate,
        delta: { renderCalls: 2, drawCalls: 4, triangles: 40 },
      },
      rendererResources: {
        schema: "limina.three-render-resources/v1",
        source: "three-webgpu-renderer-info",
        scope: "renderer-live-after-production-frame",
        counts: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
        bytes: { a: 10, b: 20, c: 30, d: 40, e: 50, f: 60 },
      },
    };
  });
  const outputs = authority.evidenceViews.map((view, index) => ({
    id: view.id,
    role: view.role,
    shellVisible: view.shellVisible,
    proxiesVisible: true,
    path: `assets/qc/internal/interiors/fixture/${view.id}.png`,
    width: 1920,
    height: 1080,
    timestamp: `2026-07-15T12:00:0${index}.000Z`,
    pngSha256: `sha256:${String(index + 1).repeat(64)}`,
    pngByteLength: 1000 + index,
    rgbaContentHash: `sha256:${String(index + 3).repeat(64)}`,
    exposureEvidence: { schema: "limina.cpu-pixel-exposure/v1" },
  }));
  const source = [];
  for (const path of [
    "js/src/render/staged-interior-proxy-review-scene.ts",
    "js/src/demos/staged_interior_proxy_capture_window.ts",
    "tools/preview/run-native-staged-interior-proxy-capture.mjs",
  ]) {
    const data = await readFile(resolve(root, path));
    source.push({ path, sha256: sha(data), contentHash: portableAssetContentHash(data) });
  }
  const capture = {
    schema: "limina.staged-interior-proxy-native-review-set/v1",
    backend: "native-webgpu",
    captureClass: "production-engine",
    pixelFormat: "rgba8unorm",
    rowOrigin: "top-left",
    timingPolicy: { gpuTimestampMode: "disabled", timestampQueriesEnabled: false },
    studio: { neutral: true, world: "none", fixedTimeSeconds: authority.presentation.fixedTimeSeconds },
    authority: {
      path: portable(authorityPath),
      sha256: sha(authorityBytes),
      contentHash: portableAssetContentHash(authorityBytes),
    },
    source,
    approvedShell: authority.approvedShell,
    approvedMaterials: authority.approvedMaterials,
    derived: authority.derived,
    plan: authority.plan,
    stageArtifact: authority.stageArtifact,
    mounted: { labelCount: 8, inventory },
    lifecycle: { baselineEntities: 3, afterDisposeEntities: 3 },
    captures,
    guardEvidence: {
      schema: "limina.nvidia-xid-guard/v1",
      preflight: { xidObserved: false },
      live: { xidObserved: false },
      postflight: { xidObserved: false },
    },
    outputs,
  };
  await writeFile(capturePath, `${JSON.stringify(capture)}\n`);
  return { authority, capture, capturePath, directory };
}

test("CPU-only I1 promotion binds exact guarded native evidence and remains pending HITL", async () => {
  const value = await fixture();
  try {
    const { candidate } = await buildInteriorReviewCandidate({
      repoRoot: root,
      authorityPath,
      capturePath: value.capturePath,
      draftPath,
      outputPath: resolve(value.directory, "candidate.json"),
      write: false,
    });
    assert.equal(candidate.kind, "interior-plan");
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.metadata.humanDecision, "pending");
    assert.equal(candidate.metadata.captureBackend, "native-webgpu");
    assert.deepEqual(
      candidate.evidence.map(({ contentHash }) => contentHash),
      value.capture.outputs.map(({ pngSha256 }) => pngSha256),
    );
    assert.equal(candidate.evidence.length, 2);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("I1 promotion rejects missing paired whole-scene telemetry", async () => {
  const value = await fixture();
  try {
    delete value.capture.captures[1].pairedRenderSubmission;
    await writeFile(value.capturePath, `${JSON.stringify(value.capture)}\n`);
    await assert.rejects(
      buildInteriorReviewCandidate({
        repoRoot: root,
        authorityPath,
        capturePath: value.capturePath,
        draftPath,
        outputPath: resolve(value.directory, "candidate.json"),
        write: false,
      }),
      /paired incremental telemetry/,
    );
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("I1 candidate writer is append-only", async () => {
  const value = await fixture();
  try {
    const outputPath = resolve(value.directory, "candidate.json");
    await buildInteriorReviewCandidate({
      repoRoot: root,
      authorityPath,
      capturePath: value.capturePath,
      draftPath,
      outputPath,
    });
    await assert.rejects(
      buildInteriorReviewCandidate({
        repoRoot: root,
        authorityPath,
        capturePath: value.capturePath,
        draftPath,
        outputPath,
      }),
      /EEXIST/,
    );
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});
