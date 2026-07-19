import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, relative, resolve, sep } from "node:path";
import test from "node:test";
import { buildingCompositionManifestV2Hash } from "../../js/src/assets/building-composition-manifest-v2.mjs";
import { createC1AuthoringSession } from "./open-authoring.mjs";
import { runBuildingAuthoringSession } from "./run-building-authoring-session.mjs";

const ROOT = resolve(import.meta.dirname, "../.."),
  sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  portable = (path) => relative(ROOT, path).split(sep).join("/");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Z8Y6WQAAAABJRU5ErkJggg==",
  "base64",
);

async function fakePipeline(events) {
  return async ({ kind, command, args, paths, context }) => {
    events.push({ kind, command, args });
    if (kind === "extract") {
      const extraction = JSON.parse(
        await readFile(resolve(ROOT, ".limina/verification/c1-r3-bounded-extraction-central-20260716.json")),
      );
      const working = await readFile(context.workingCopy);
      extraction.source.blend = { path: portable(context.workingCopy), sha256: sha(working) };
      await writeFile(paths.extraction, `${JSON.stringify(extraction, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return;
    }
    if (kind === "build-source") {
      const manifestBytes = await readFile(paths.manifest),
        manifest = JSON.parse(manifestBytes),
        manifestHash = buildingCompositionManifestV2Hash(manifest);
      await writeFile(paths.blend, "fake-clean-blend", { flag: "wx", mode: 0o600 });
      await writeFile(paths.glb, "fake-clean-glb", { flag: "wx", mode: 0o600 });
      const blend = await readFile(paths.blend),
        glb = await readFile(paths.glb),
        evidence = {
          schema: "limina.building-composition-build-evidence/v1",
          id: manifest.id,
          manifest: { path: portable(paths.manifest), sha256: sha(manifestBytes), canonicalHash: manifestHash },
          sourceBlend: { path: portable(paths.blend), sha256: sha(blend), bytes: blend.length },
          asset: { path: portable(paths.glb), sha256: sha(glb), bytes: glb.length },
          rendered: false,
          gpuUsed: false,
          status: "cpu-authored-unreviewed",
        };
      await writeFile(paths.buildEvidence, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return;
    }
    if (kind === "build-authority") {
      const manifestBytes = await readFile(paths.manifest),
        manifest = JSON.parse(manifestBytes),
        functionalBytes = await readFile(paths.functionalEvidence),
        buildBytes = await readFile(paths.buildEvidence),
        build = JSON.parse(buildBytes),
        blend = await readFile(paths.blend),
        glb = await readFile(paths.glb);
      const authority = {
        schema: "limina.building-composition-review-scene/v1",
        approvalPolicy: { renderer: "limina-production-native-engine", humanDecisionRequired: true },
        manifest: {
          path: portable(paths.manifest),
          sha256: sha(manifestBytes),
          canonicalHash: buildingCompositionManifestV2Hash(manifest),
        },
        functionalEvidence: { path: portable(paths.functionalEvidence), sha256: sha(functionalBytes) },
        integratedSource: {
          evidence: { path: portable(paths.buildEvidence), sha256: sha(buildBytes) },
          blend: { path: portable(paths.blend), sha256: sha(blend) },
          glb: { path: portable(paths.glb), sha256: sha(glb) },
        },
      };
      await writeFile(paths.authority, `${JSON.stringify(authority, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return;
    }
    if (kind === "capture") {
      await mkdir(paths.capture, { recursive: true, mode: 0o700 });
      const authorityBytes = await readFile(paths.authority),
        outputs = [];
      for (const id of [
        "entry-circulation",
        "dining-three-quarter",
        "hearth-seating",
        "service-storage",
        "overall-room",
      ]) {
        const path = resolve(paths.capture, `${id}.png`);
        await writeFile(path, PNG, { flag: "wx", mode: 0o600 });
        outputs.push({ id, path: portable(path), pngSha256: sha(PNG), width: 1920, height: 1080 });
      }
      const capture = {
        schema: "limina.building-composition-native-review-set/v1",
        backend: "native-webgpu",
        captureClass: "production-engine",
        authority: { path: portable(paths.authority), sha256: sha(authorityBytes) },
        timingPolicy: { gpuTimestampMode: "disabled", timestampQueriesEnabled: false },
        guardEvidence: {
          preflight: { xidObserved: false },
          live: { xidObserved: false },
          postflight: { xidObserved: false },
        },
        outputs,
      };
      await writeFile(resolve(paths.capture, "capture-evidence.json"), `${JSON.stringify(capture, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return;
    }
    throw new Error(`unexpected fake pipeline kind ${kind}`);
  };
}

test(
  "private authoring preview uses only bounded builders and guarded C1 runner, then submits HITL-pending",
  { concurrency: false },
  async () => {
    const approvedPath = resolve(
        ROOT,
        "assets/buildings/authoring/functional-hall-house-v4/composition-r3/furnished-c1-r3.blend",
      ),
      approvedBefore = sha(await readFile(approvedPath));
    const session = await createC1AuthoringSession({ root: ROOT }),
      events = [],
      staged = [],
      execute = await fakePipeline(events),
      now = () => new Date("2026-07-16T20:00:00.000Z"),
      uuids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
      uuid = () => uuids.shift() ?? randomUUID();
    const preview = await runBuildingAuthoringSession({
      action: "engine-preview",
      sessionPath: session.sessionManifest,
      root: ROOT,
      captureRoot: resolve(session.sessionDirectory, "test-captures"),
      execute,
      stageArtifact: async (request) => {
        staged.push(request);
        return {
          sha256: request.expectedSha256,
          width: request.expectedWidth,
          height: request.expectedHeight,
          staged: true,
        };
      },
      now,
      uuid,
      blender: "/fake/blender",
      bun: "/fake/bun",
    });
    assert.equal(preview.result.status, "completed");
    assert.equal(preview.result.revision.checksPassed, 8);
    assert.equal(preview.result.capture.timestampQueriesEnabled, false);
    assert.equal(preview.result.capture.xidObserved, false);
    assert.equal(preview.result.humanDecision, "pending");
    assert.equal(staged.length, 5);
    assert.equal(new Set(staged.map((entry) => entry.name)).size, 5);
    assert.deepEqual(
      events.map((entry) => entry.kind),
      ["extract", "build-source", "build-authority", "capture"],
    );
    const captureCommand = events.at(-1);
    assert.equal(captureCommand.args[0], resolve(ROOT, "tools/preview/run-native-building-composition-capture.mjs"));
    assert.ok(
      events.every((entry) => !entry.command.includes("target/release/limina") && !entry.args.includes("--window")),
      "host invoked a direct engine binary/render path",
    );
    const submission = await runBuildingAuthoringSession({
      action: "submit-revision",
      sessionPath: session.sessionManifest,
      root: ROOT,
      now,
      uuid,
    });
    assert.equal(submission.submission.status, "hitl-pending");
    assert.equal(submission.submission.approvalGranted, false);
    assert.equal(submission.submission.humanDecision, "pending");
    assert.equal(sha(await readFile(approvedPath)), approvedBefore, "approved source changed");
    await appendFile(session.workingCopy, "stale-edit");
    await assert.rejects(
      runBuildingAuthoringSession({
        action: "submit-revision",
        sessionPath: session.sessionManifest,
        root: ROOT,
        now,
        uuid,
      }),
      /identical working-copy hash/,
    );
    assert.equal(
      sha(await readFile(approvedPath)),
      approvedBefore,
      "approved source changed after stale-preview rejection",
    );
  },
);

test(
  "session containment and approved-base hash mismatches fail before any runner",
  { concurrency: false },
  async () => {
    let calls = 0;
    const execute = async () => {
      calls += 1;
    };
    await assert.rejects(
      runBuildingAuthoringSession({
        action: "engine-preview",
        sessionPath: "/tmp/session-manifest.json",
        root: ROOT,
        execute,
      }),
      /escapes the private session root/,
    );
    const valid = await createC1AuthoringSession({ root: ROOT }),
      value = JSON.parse(await readFile(valid.sessionManifest));
    value.approvedSource.sha256 = `sha256:${"0".repeat(64)}`;
    const invalidDirectory = resolve(ROOT, ".limina/authoring-sessions", `c1-invalid-${randomUUID()}`),
      invalidManifest = resolve(invalidDirectory, "session-manifest.json");
    await mkdir(invalidDirectory, { mode: 0o700 });
    await chmod(invalidDirectory, 0o700);
    await writeFile(invalidManifest, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await assert.rejects(
      runBuildingAuthoringSession({ action: "engine-preview", sessionPath: invalidManifest, root: ROOT, execute }),
      /approved base drifted/,
    );
    const escaped = JSON.parse(await readFile(valid.sessionManifest));
    escaped.workingCopy.path = escaped.approvedSource.path;
    const escapedDirectory = resolve(ROOT, ".limina/authoring-sessions", `c1-escaped-${randomUUID()}`),
      escapedManifest = resolve(escapedDirectory, "session-manifest.json");
    await mkdir(escapedDirectory, { mode: 0o700 });
    await writeFile(escapedManifest, `${JSON.stringify(escaped, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await assert.rejects(
      runBuildingAuthoringSession({ action: "engine-preview", sessionPath: escapedManifest, root: ROOT, execute }),
      /working copy is not the exact private session file/,
    );
    assert.equal(calls, 0);
  },
);

test("orchestrator source contains no direct engine binary or generic Blender export path", async () => {
  const source = await readFile(new URL("./run-building-authoring-session.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /target\/release\/limina|export_scene\.gltf|--window/);
  assert.match(source, /run-native-building-composition-capture\.mjs/);
  assert.match(source, /TIMESTAMP/i);
  assert.match(source, /xidObserved/);
});
