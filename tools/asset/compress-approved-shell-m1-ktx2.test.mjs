import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { APPROVED_M1_KTX2_INVENTORY, APPROVED_M1_KTX2_PATHS, buildApprovedShellM1Ktx2Config, prepareApprovedShellM1Ktx2Outputs } from "./compress-approved-shell-m1-ktx2.mjs";
import { ktx2ModeFor, validateKtx2OutputDocument } from "./compress-hall-house-v4-ktx2.mjs";

const root = new URL("../../", import.meta.url), hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function glb(bytes) { const length = bytes.readUInt32LE(12), offset = 20 + length; return { document: JSON.parse(bytes.subarray(20, offset).toString().trimEnd()), bin: bytes.subarray(offset + 8, offset + 8 + bytes.readUInt32LE(offset)) }; }

test("exact M1 wrapper binds approved A1, lock budget, inventory, and confined output paths without compressing", async () => {
  const config = await buildApprovedShellM1Ktx2Config();
  assert.deepEqual({ input: config.input, output: config.output, manifest: config.manifest }, {
    input: "assets/buildings/authoring/functional-hall-house-v4/shell.glb",
    output: APPROVED_M1_KTX2_PATHS.output,
    manifest: APPROVED_M1_KTX2_PATHS.manifest,
  });
  assert.equal(config.expectedSourceSha256, "25577df12c293923ed24c5df33d89b820e8a3e176cce671c95b62d3daf2ba344");
  assert.deepEqual(config.expectedInventory, APPROVED_M1_KTX2_INVENTORY);
  assert.equal(config.encodingBudget.maxArtifactBytes, 25165824);
  assert.equal(config.encodingBudget.maxGpuResidencyBytes, 75497472);
  assert.equal(config.encodingBudget.maxTextureObjects, 32);
  assert.equal(config.encodingBudget.maxUniqueImages, 18);
  await assert.rejects(() => buildApprovedShellM1Ktx2Config({ output: "assets/buildings/authoring/functional-hall-house-v4/escaped.glb" }), /must remain inside/);
  await assert.rejects(() => buildApprovedShellM1Ktx2Config({ manifest: "../escaped.json" }), /must remain inside/);
});

test("exact M1 wrapper prepares absent confined output directories without invoking compression", async () => {
  const repoRoot = await mkdtemp(resolve(tmpdir(), "limina-m1-wrapper-"));
  const config = { output: APPROVED_M1_KTX2_PATHS.output, manifest: APPROVED_M1_KTX2_PATHS.manifest };
  try {
    await prepareApprovedShellM1Ktx2Outputs(config, { repoRoot });
    assert.equal((await stat(resolve(repoRoot, APPROVED_M1_KTX2_PATHS.paletteDirectory))).isDirectory(), true);
    await assert.rejects(() => prepareApprovedShellM1Ktx2Outputs({ ...config, output: "escaped.glb" }, { repoRoot }), /must remain inside/);
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

test("existing exact M1 derivation closes hashes, budgets, modes, inventory, and fallback-free GLB", async () => {
  const config = await buildApprovedShellM1Ktx2Config(), manifest = JSON.parse(await readFile(new URL(config.manifest, root))), output = await readFile(new URL(config.output, root)), { document, bin } = glb(output);
  assert.equal(manifest.schema, "limina.ktx2-production/1");
  assert.equal(manifest.source.path, config.input);
  assert.equal(manifest.source.sha256, config.expectedSourceSha256);
  assert.equal(manifest.output.path, config.output);
  assert.equal(manifest.output.sha256, hash(output));
  assert.equal(manifest.output.bytes, output.length);
  assert.ok(output.length <= config.encodingBudget.maxArtifactBytes);
  assert.ok(manifest.gpuResidency.bytes <= config.encodingBudget.maxGpuResidencyBytes);
  assert.deepEqual(manifest.policy.encodingBudget, config.encodingBudget);
  assert.equal(manifest.policy.pngFallback, false);
  assert.equal(manifest.textures.length, 18);
  assert.equal(document.images.length, 18);
  assert.equal(document.textures.length, 27);
  assert.equal(document.materials.length, 13);
  validateKtx2OutputDocument(document, { encodingBudget: config.encodingBudget, expectedInventory: config.expectedInventory });
  const critical = new Set(manifest.policy.criticalRoles);
  const ktx2Identifier = Buffer.from([0xab,0x4b,0x54,0x58,0x20,0x32,0x30,0xbb,0x0d,0x0a,0x1a,0x0a]);
  let residency = 0;
  for (const record of manifest.textures) {
    const uastc = record.kind === "normal" || (record.kind === "albedo" && critical.has(record.pack));
    assert.equal(record.mode, ktx2ModeFor(record.kind, uastc, config.encodingBudget));
    assert.ok(record.payloadBytes > 0 && /^[0-9a-f]{64}$/.test(record.payloadSha256));
    assert.ok(record.gpuBlockBytes > 0 && record.options.includes("--genmipmap"));
    assert.equal(record.width, 1024); assert.equal(record.height, 1024);
    const view = document.bufferViews[document.images[record.image].bufferView], payload = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    assert.equal(payload.length, record.payloadBytes);
    assert.equal(hash(payload), record.payloadSha256);
    assert.deepEqual(payload.subarray(0, 12), ktx2Identifier);
    residency += record.gpuBlockBytes;
  }
  assert.equal(residency, manifest.gpuResidency.bytes);
});
