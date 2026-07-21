#!/usr/bin/env node

// Fail-closed vendor patch for three@0.184.0.
//
// wgpu #6406 documents incorrect Vulkan timestamp results when resolveQuerySet and the
// subsequent readback copy share one command encoder. wgpu-profiler #85 ships the same
// workaround: resolve and copy in separate command buffers, submitted in order.
//
// Remove this patch once upstream Three.js adopts an equivalent fix.

import { readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(root, "node_modules/three/package.json");
const sources = [
  {
    // Human-readable upstream source.
    path: resolve(root, "node_modules/three/src/renderers/webgpu/utils/WebGPUTimestampQueryPool.js"),
    pristineSha256: "2a0d4afb31849e72bb1e2821e707acf6e5f2ab16476dc2a32dbbc5f6beffd86d",
    patchedSha256: "35bf5fcff2279f746d3c8c8832dc70b80d6f32b33f6edbdc534ba18a825837a7",
  },
  {
    // `three/webgpu` resolves to this prebuilt module, so the Limina bundle consumes this file.
    path: resolve(root, "node_modules/three/build/three.webgpu.js"),
    pristineSha256: "444f623f1dc99228ee6fc68b68f83a8e1741059363df9796c48a68925ca05363",
    patchedSha256: "83f1d40704beebe826bfb14962eab66eed75f4d6d68b63bb5c2e5461902beaee",
  },
];
const checkOnly = process.argv.includes("--check");
const checkBundle = process.argv.includes("--check-bundle");
const sha256 = (source) => createHash("sha256").update(source).digest("hex");

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
if (packageJson.version !== "0.184.0") {
  throw new Error(`three timestamp patch expected three 0.184.0, found ${packageJson.version}`);
}

const original = `\t\t\tconst commandEncoder = this.device.createCommandEncoder();

\t\t\tcommandEncoder.resolveQuerySet(
\t\t\t\tthis.querySet,
\t\t\t\t0,
\t\t\t\tqueryCount,
\t\t\t\tthis.resolveBuffer,
\t\t\t\t0
\t\t\t);

\t\t\tcommandEncoder.copyBufferToBuffer(
\t\t\t\tthis.resolveBuffer,
\t\t\t\t0,
\t\t\t\tthis.resultBuffer,
\t\t\t\t0,
\t\t\t\tbytesUsed
\t\t\t);

\t\t\tconst commandBuffer = commandEncoder.finish();
\t\t\tthis.device.queue.submit( [ commandBuffer ] );`;

const patched = `\t\t\t// LIMINA_WGPU_6406_SPLIT_ENCODERS: Vulkan needs resolve and readback copy in
\t\t\t// separate command buffers so the query resolve has a copy-destination barrier.
\t\t\t// https://github.com/gfx-rs/wgpu/issues/6406
\t\t\tconst resolveEncoder = this.device.createCommandEncoder( { label: 'LIMINA_WGPU_6406_RESOLVE' } );

\t\t\tresolveEncoder.resolveQuerySet(
\t\t\t\tthis.querySet,
\t\t\t\t0,
\t\t\t\tqueryCount,
\t\t\t\tthis.resolveBuffer,
\t\t\t\t0
\t\t\t);

\t\t\tconst copyEncoder = this.device.createCommandEncoder( { label: 'LIMINA_WGPU_6406_COPY' } );
\t\t\tcopyEncoder.copyBufferToBuffer(
\t\t\t\tthis.resolveBuffer,
\t\t\t\t0,
\t\t\t\tthis.resultBuffer,
\t\t\t\t0,
\t\t\t\tbytesUsed
\t\t\t);

\t\t\tthis.device.queue.submit( [ resolveEncoder.finish(), copyEncoder.finish() ] );`;

// Read and validate every vendor file before mutating any of them. A known mixed state can result
// from an interrupted prior patch and is safely completed; any foreign byte rejects the operation.
const states = await Promise.all(sources.map(async (spec) => {
  const source = await readFile(spec.path, "utf8");
  const hash = sha256(source);
  const state = hash === spec.pristineSha256 ? "pristine" : hash === spec.patchedSha256 ? "patched" : "foreign";
  if (state === "foreign") throw new Error(`three timestamp patch refused foreign source ${spec.path} sha256=${hash}`);
  return { ...spec, source, state };
}));

if (checkOnly && states.some(({ state }) => state !== "patched")) {
  throw new Error(`three timestamp patch is incomplete: ${states.map(({ path, state }) => `${path}=${state}`).join(", ")}`);
}

if (!checkOnly) {
  const writes = [];
  for (const state of states) {
    if (state.state === "patched") continue;
    const originalCount = state.source.split(original).length - 1;
    if (originalCount !== 1) throw new Error(`three timestamp patch expected one exact block in ${state.path}, found ${originalCount}`);
    const next = state.source.replace(original, patched);
    const nextHash = sha256(next);
    if (nextHash !== state.patchedSha256) {
      throw new Error(`three timestamp patch produced unexpected sha256 for ${state.path}: ${nextHash}`);
    }
    writes.push({ path: state.path, next });
  }
  // Prepare every replacement before the rename phase. Known partial states are recoverable on the
  // next invocation because pristine and patched whole-file hashes are both accepted above.
  for (const write of writes) await writeFile(`${write.path}.limina-tmp`, write.next, "utf8");
  for (const write of writes) await rename(`${write.path}.limina-tmp`, write.path);
}

for (const state of states) {
  console.log(`three timestamp patch ${checkOnly ? "verified" : state.state === "patched" ? "already applied" : "applied"}: ${state.path}`);
}

if (checkBundle) {
  const bundlePath = resolve(root, "build/three.bundle.mjs");
  const bundle = await readFile(bundlePath, "utf8");
  for (const marker of ["LIMINA_WGPU_6406_RESOLVE", "LIMINA_WGPU_6406_COPY"]) {
    const count = bundle.split(marker).length - 1;
    if (count !== 1) throw new Error(`three timestamp bundle expected one ${marker} marker, found ${count}`);
  }
  const splitSubmit = "this.device.queue.submit([resolveEncoder.finish(), copyEncoder.finish()]);";
  if (!bundle.includes(splitSubmit)) throw new Error("three timestamp bundle is missing the split command-buffer submission");
  const staleSubmit = "const commandBuffer = commandEncoder.finish();\n      this.device.queue.submit([commandBuffer]);";
  if (bundle.includes(staleSubmit)) throw new Error("three timestamp bundle still contains the old single-encoder submission");
  console.log("three timestamp generated bundle verified");
}
