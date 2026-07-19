import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  archiveGuardedCaptureSources,
  GUARDED_NATIVE_CAPTURE_CONTRACTS,
  runGuardedCaptureWithSourceClosure,
  verifyGuardedCaptureEvidence,
} from "./guarded-capture-publication.mjs";

const RUNNERS = Object.freeze([
  "run-native-building-composition-capture.mjs",
  "run-native-building-fire-capture.mjs",
  "run-native-building-production-r1-capture.mjs",
  "run-native-fb4-multi-room-capture.mjs",
  "run-native-functional-cottage-capture.mjs",
  "run-native-furniture-pack-capture.mjs",
  "run-native-staged-interior-proxy-capture.mjs",
  "run-native-staged-material-capture.mjs",
  "run-native-staged-shell-capture.mjs",
  "run-native-temperate-fidelity-capture.mjs",
]);

test("every native capture runner delegates closure, Xid, archive, and evidence authority to one helper", async () => {
  for (const file of RUNNERS) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(
      source,
      /from "\.\/guarded-capture-publication\.mjs"/,
      `${file} does not use the shared publication guard`,
    );
    assert.match(source, /runGuardedCaptureWithSourceClosure\(/, `${file} never prepares the exact guarded closure`);
    assert.match(source, /archiveGuardedCaptureSources\(/, `${file} never archives the exact guarded closure`);
    assert.match(source, /verifyGuardedCaptureEvidence\(/, `${file} never verifies archive identity in evidence`);
    assert.doesNotMatch(source, /from "\.\/xid-guard\.mjs"/, `${file} bypasses the shared publication contract`);
    assert.doesNotMatch(
      source,
      /node:child_process|spawn(?:Sync)?\s*\(\s*["']journalctl|function\s+(?:kernelLog|bootKernelLog)\b|(?:const|let|var)\s+XID\b/,
      `${file} retains divergent Xid process logic`,
    );
    assert.doesNotMatch(
      source,
      /GPU_TIMESTAMP_RISK_ACK\s*=|GPU_TIMESTAMP_QUERIES\s*=/,
      `${file} enables forbidden timestamp queries`,
    );
  }
});

test("all ten contracts delegate under fakes without invoking a native command or GPU", async (t) => {
  assert.deepEqual(
    GUARDED_NATIVE_CAPTURE_CONTRACTS.map(({ runner }) => runner.replace("tools/preview/", "")),
    RUNNERS,
  );
  const repoRoot = await mkdtemp(resolve(tmpdir(), "limina-all-capture-contracts-"));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const runtime = resolve(repoRoot, "target/release/limina");
  await mkdir(resolve(runtime, ".."), { recursive: true, mode: 0o700 });
  await writeFile(runtime, "inert fake runtime; never execute\n", { mode: 0o600 });
  assert.equal((await lstat(runtime)).mode & 0o111, 0, "fake runtime must remain non-executable");
  const calls = [],
    guardRequests = [];
  for (const [index, contract] of GUARDED_NATIVE_CAPTURE_CONTRACTS.entries()) {
    const evidenceRoot = resolve(repoRoot, `assets/qc/internal/fake-${index}.evidence`);
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const execution = Object.freeze({ sources: Object.freeze([{ path: contract.runner }]) }),
      guardEvidence = Object.freeze({ schema: "fake-xid-guard", runner: contract.runner }),
      capture = await runGuardedCaptureWithSourceClosure(
        {
          repoRoot,
          runnerUrl: pathToFileURL(resolve(repoRoot, contract.runner)).href,
          modulePath: contract.module,
          args: [contract.module],
          environment: {},
        },
        {
          buildClosure: async () => {
            calls.push(`closure:${contract.runner}`);
            return execution;
          },
          runGuard: async (request) => {
            calls.push(`guard:${contract.runner}`);
            guardRequests.push(request);
            return guardEvidence;
          },
        },
      ),
      publication = await archiveGuardedCaptureSources(
        { capture, evidenceRoot },
        {
          writeArchive: async () => {
            calls.push(`archive:${contract.runner}`);
            return Object.freeze({ schema: "fake-archive", runner: contract.runner });
          },
          verifyArchive: async () => calls.push(`verify:${contract.runner}`),
        },
      ),
      evidence = { ...publication };
    await verifyGuardedCaptureEvidence(
      { capture, evidenceRoot, evidence },
      { verifyArchive: async () => calls.push(`evidence:${contract.runner}`) },
    );
  }
  for (const contract of GUARDED_NATIVE_CAPTURE_CONTRACTS) {
    assert.deepEqual(
      calls.filter((entry) => entry.endsWith(contract.runner)),
      ["closure", "guard", "archive", "verify", "evidence"].map((phase) => `${phase}:${contract.runner}`),
    );
  }
  assert.equal(guardRequests.length, GUARDED_NATIVE_CAPTURE_CONTRACTS.length);
  assert.ok(guardRequests.every((request) => request.command === runtime));
});
