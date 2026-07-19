import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  archiveGuardedCaptureSources,
  runGuardedCaptureWithSourceClosure,
  verifyGuardedCaptureEvidence,
} from "./guarded-capture-publication.mjs";

const source = Object.freeze({
  path: "tools/preview/run-native-building-fire-capture.mjs",
  sha256: `sha256:${"1".repeat(64)}`,
  contentHash: `sha256:${"2".repeat(64)}`,
  bytes: 7,
});

async function fixture(t) {
  const repoRoot = await mkdtemp(resolve(tmpdir(), "limina-guarded-publication-")),
    runnerPath = resolve(repoRoot, source.path),
    evidenceRoot = resolve(repoRoot, "assets/qc/internal/fire/capture.evidence");
  await mkdir(resolve(runnerPath, ".."), { recursive: true });
  await mkdir(resolve(repoRoot, "target/release"), { recursive: true });
  await writeFile(resolve(repoRoot, "target/release/limina"), "fake native runtime\n", { mode: 0o700 });
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  return { repoRoot, runnerPath, evidenceRoot };
}

test("fake guarded capture builds closure before guard and archives before evidence", async (t) => {
  const { repoRoot, runnerPath, evidenceRoot } = await fixture(t),
    calls = [],
    execution = Object.freeze({ sources: Object.freeze([source]) }),
    guardEvidence = Object.freeze({ schema: "limina.native-capture-xid-guard/v1" }),
    sourceArchive = Object.freeze({ schema: "limina.capture-source-archive/v1", completeness: "complete" }),
    capture = await runGuardedCaptureWithSourceClosure(
      {
        repoRoot,
        runnerUrl: pathToFileURL(runnerPath).href,
        modulePath: "js/src/demos/building_fire_capture_window.ts",
        command: resolve(repoRoot, "target/release/limina"),
        args: ["--window", "js/src/demos/building_fire_capture_window.ts"],
        cwd: repoRoot,
        environment: {},
      },
      {
        buildClosure: async (request) => {
          calls.push(["closure", request.entryPaths]);
          return execution;
        },
        runGuard: async () => {
          calls.push(["guard"]);
          return guardEvidence;
        },
      },
    ),
    publication = await archiveGuardedCaptureSources(
      { capture, evidenceRoot },
      {
        writeArchive: async () => {
          calls.push(["archive"]);
          return sourceArchive;
        },
        verifyArchive: async ({ record, expectedSources }) => {
          calls.push(["verify", record, expectedSources]);
        },
      },
    ),
    evidence = { schema: "test", ...publication };
  await verifyGuardedCaptureEvidence(
    { capture, evidenceRoot, evidence },
    { verifyArchive: async () => calls.push(["evidence-verify"]) },
  );
  assert.deepEqual(
    calls.map(([name]) => name),
    ["closure", "guard", "archive", "verify", "evidence-verify"],
  );
  assert.deepEqual(calls[0][1], [
    "tools/preview/run-native-building-fire-capture.mjs",
    "js/src/demos/building_fire_capture_window.ts",
  ]);
  assert.equal(publication.captureProducer, execution);
  assert.equal(publication.guardEvidence, guardEvidence);
  assert.equal(publication.sourceArchive, sourceArchive);
});

test("wrong runner-module pair fails before guard/native delegation", async (t) => {
  const { repoRoot, runnerPath } = await fixture(t);
  let guardCalls = 0;
  await assert.rejects(
    runGuardedCaptureWithSourceClosure(
      {
        repoRoot,
        runnerUrl: pathToFileURL(runnerPath).href,
        modulePath: "js/src/demos/staged_shell_capture_window.ts",
        args: ["js/src/demos/staged_shell_capture_window.ts"],
      },
      { runGuard: async () => guardCalls++ },
    ),
    /outside the exact source contract/,
  );
  assert.equal(guardCalls, 0);
});

test("absolute, parent, command, and symlink runtime escapes fail before closure or native delegation", async (t) => {
  const { repoRoot, runnerPath } = await fixture(t),
    modulePath = "js/src/demos/building_fire_capture_window.ts",
    base = { repoRoot, runnerUrl: pathToFileURL(runnerPath).href, modulePath, args: [modulePath] };
  let closureCalls = 0,
    guardCalls = 0;
  const dependencies = {
    buildClosure: async () => closureCalls++,
    runGuard: async () => guardCalls++,
  };
  await assert.rejects(
    runGuardedCaptureWithSourceClosure(
      { ...base, runtimeBinary: resolve(repoRoot, "target/release/limina") },
      dependencies,
    ),
    /exact workspace-relative path/,
  );
  await assert.rejects(
    runGuardedCaptureWithSourceClosure({ ...base, runtimeBinary: "../outside-runtime" }, dependencies),
    /exact workspace-relative path/,
  );
  const outsideRoot = await mkdtemp(resolve(tmpdir(), "limina-runtime-escape-")),
    outside = resolve(outsideRoot, "limina");
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  await writeFile(outside, "outside runtime\n", { mode: 0o700 });
  await assert.rejects(
    runGuardedCaptureWithSourceClosure({ ...base, command: outside }, dependencies),
    /command or working directory escaped/,
  );
  const runtime = resolve(repoRoot, "target/release/limina");
  await unlink(runtime);
  await symlink(outside, runtime);
  await assert.rejects(runGuardedCaptureWithSourceClosure(base, dependencies), /real path escaped/);
  assert.equal(closureCalls, 0);
  assert.equal(guardCalls, 0);
});

test("group- or other-accessible evidence roots fail before archive writes", async (t) => {
  const { repoRoot, runnerPath, evidenceRoot } = await fixture(t),
    modulePath = "js/src/demos/building_fire_capture_window.ts",
    execution = Object.freeze({ sources: Object.freeze([source]) }),
    capture = await runGuardedCaptureWithSourceClosure(
      { repoRoot, runnerUrl: pathToFileURL(runnerPath).href, modulePath, args: [modulePath] },
      { buildClosure: async () => execution, runGuard: async () => Object.freeze({ guarded: true }) },
    );
  let archiveWrites = 0;
  await chmod(evidenceRoot, 0o750);
  await assert.rejects(
    archiveGuardedCaptureSources(
      { capture, evidenceRoot },
      { writeArchive: async () => archiveWrites++, verifyArchive: async () => {} },
    ),
    /real private directory/,
  );
  assert.equal(archiveWrites, 0);
});

test("evidence omission and duplicate archive fail closed", async (t) => {
  const { repoRoot, runnerPath, evidenceRoot } = await fixture(t),
    execution = Object.freeze({ sources: Object.freeze([source]) }),
    capture = await runGuardedCaptureWithSourceClosure(
      {
        repoRoot,
        runnerUrl: pathToFileURL(runnerPath).href,
        modulePath: "js/src/demos/building_fire_capture_window.ts",
        args: ["js/src/demos/building_fire_capture_window.ts"],
      },
      { buildClosure: async () => execution, runGuard: async () => Object.freeze({ guarded: true }) },
    ),
    dependencies = {
      writeArchive: async () => Object.freeze({ complete: true }),
      verifyArchive: async () => {},
    };
  await archiveGuardedCaptureSources({ capture, evidenceRoot }, dependencies);
  await assert.rejects(archiveGuardedCaptureSources({ capture, evidenceRoot }, dependencies), /one fresh/);
  await assert.rejects(
    verifyGuardedCaptureEvidence({ capture, evidenceRoot, evidence: { captureProducer: execution } }, dependencies),
    /omitted or replaced/,
  );
});
