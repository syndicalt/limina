import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileWorldTerrainInWorker } from "./world-compiler-worker.mjs";

function compilerModule(source) {
  const root = mkdtempSync(join(tmpdir(), "limina-world-compiler-worker-"));
  const path = join(root, "compiler.mjs");
  writeFileSync(path, source);
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("returns compiler output and transfers artifact ownership", async () => {
  const fixture = compilerModule(`
    export function compileWorldTerrain(input) {
      if (input.cancellation.shouldCancel()) throw new Error("unexpected cancellation");
      const bytes = Uint8Array.of(1, 2, 3, 4);
      return { marker: input.marker, artifacts: [{ contentHash: "sha256:${"1".repeat(64)}", bytes }] };
    }
  `);
  try {
    const output = await compileWorldTerrainInWorker({
      bundlePath: fixture.path,
      input: { marker: "worker-result", cancellation: { shouldCancel() { return false; } } },
      signal: new AbortController().signal,
    });
    assert.equal(output.marker, "worker-result");
    assert.deepEqual([...output.artifacts[0].bytes], [1, 2, 3, 4]);
  } finally { fixture.cleanup(); }
});

test("AbortSignal updates the compiler cancellation checkpoint while its worker is CPU-bound", async () => {
  const fixture = compilerModule(`
    export function compileWorldTerrain(input) {
      for (let work = 0; work < 2_000_000_000; work++) {
        if ((work & 1023) === 0 && input.cancellation.shouldCancel()) {
          const error = new Error("fixture compile cancelled");
          error.code = "fixture_cancelled";
          throw error;
        }
      }
      throw new Error("fixture exhausted without observing cancellation");
    }
  `);
  try {
    const controller = new AbortController();
    const started = Date.now();
    const compile = compileWorldTerrainInWorker({ bundlePath: fixture.path, input: {}, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("superseded")), 20);
    await assert.rejects(compile, (error) => error.code === "fixture_cancelled" && /cancelled/.test(error.message));
    assert.ok(Date.now() - started < 2_000, "worker cancellation did not stop bounded CPU work promptly");
  } finally { fixture.cleanup(); }
});

test("pre-aborted work never starts a worker", async () => {
  const controller = new AbortController();
  controller.abort(new Error("closed"));
  await assert.rejects(
    compileWorldTerrainInWorker({ bundlePath: "/does/not/matter.mjs", input: {}, signal: controller.signal }),
    /closed/,
  );
});
