import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assertAcceptedTreeSource, bakeTreeImpostor } from "./bake-tree-impostor.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const BLENDER = process.env.BLENDER_BIN ?? join(homedir(), "blender-5.1.2-linux-x64", "blender");
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "limina-tree-bake-"));
  await cp(join(ROOT, "assets/fixtures/textured-cube.glb"), join(root, "tree.glb"));
  await cp(join(ROOT, "assets/fixtures/mesh.glb"), join(root, "tree-lod.glb"));
  const source = await readFile(join(root, "tree.glb")), lod = await readFile(join(root, "tree-lod.glb"));
  const manifest = { schema: "limina.asset-manifest/1", unlistedPolicy: "excluded", entries: [{
    id: "fixture-tree", class: "vegetation", model: { path: "tree.glb", sha256: hash(source) },
    lods: [{ path: "tree-lod.glb", sha256: hash(lod), distanceM: 80 }],
    qc: { humanVisualApproval: { approved: true, approvedBy: "test", referenceContract: "fixture-only" } },
  }], candidates: [] };
  const manifestPath = join(root, "manifest.json"); await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { root, manifestPath };
}

test("accepted-source boundary rejects candidates and stale LOD hashes", async () => {
  const fixture = await setup();
  try {
    const args = { input: join(fixture.root, "tree.glb"), lodInput: join(fixture.root, "tree-lod.glb"), manifest: fixture.manifestPath, assetRoot: fixture.root };
    const accepted = await assertAcceptedTreeSource(args);
    assert.equal(accepted.entryId, "fixture-tree");
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    manifest.entries[0].qc.humanVisualApproval.approved = false;
    await writeFile(fixture.manifestPath, JSON.stringify(manifest));
    await assert.rejects(() => assertAcceptedTreeSource(args), /not an accepted, human-approved vegetation/);
    manifest.entries[0].qc.humanVisualApproval.approved = true;
    manifest.entries[0].lods[0].sha256 = `sha256:${"0".repeat(64)}`;
    await writeFile(fixture.manifestPath, JSON.stringify(manifest));
    await assert.rejects(() => assertAcceptedTreeSource(args), /not pinned/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("pinned Blender Cycles CPU bake publishes evidence last and reuses the content/config cache", async (t) => {
  try { await access(BLENDER); } catch { t.skip(`pinned Blender unavailable at ${BLENDER}`); return; }
  const fixture = await setup();
  try {
    const output = join(fixture.root, "tree-impostor.glb"), evidence = join(fixture.root, "tree-impostor.evidence.json");
    const args = { input: join(fixture.root, "tree.glb"), lodInput: join(fixture.root, "tree-lod.glb"), output, evidence,
      manifest: fixture.manifestPath, assetRoot: fixture.root, grid: 2, cellSize: 32, samples: 1, seed: 7, blenderBin: BLENDER };
    const baked = await bakeTreeImpostor(args);
    assert.equal(baked.cacheHit, false);
    assert.equal(baked.rendered.engine, "CYCLES"); assert.equal(baked.rendered.device, "CPU");
    assert.equal(baked.qc.embeddedTextures, 2); assert.equal(baked.qc.triangles, 2);
    const persisted = JSON.parse(await readFile(evidence, "utf8"));
    assert.equal(persisted.outputSha256, baked.outputSha256);
    const cached = await bakeTreeImpostor({ ...args, blenderBin: "/intentionally/missing/blender" });
    assert.equal(cached.cacheHit, true, "identical source/config did not reuse the artifact cache");
    assert.equal(cached.outputSha256, baked.outputSha256);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
