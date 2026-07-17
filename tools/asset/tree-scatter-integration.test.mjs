import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bakeTreeImpostor } from "./bake-tree-impostor.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const BLENDER = process.env.BLENDER_BIN ?? join(homedir(), "blender-5.1.2-linux-x64", "blender");
const SOURCE = join(ROOT, "assets/trees/oak-1.glb"), REDUCED = join(ROOT, "assets/trees/oak-1-lod1.glb");
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const liminaHash = (bytes) => `sha256:${createHash("sha256").update(Buffer.from(bytes).toString("hex")).digest("hex")}`;

for (const required of [BLENDER, SOURCE, REDUCED, join(ROOT, "target/release/limina")]) {
  try { await access(required); } catch {
    console.error(`tree-scatter-integration SKIP: required input unavailable: ${required}`);
    process.exit(2);
  }
}

const root = await mkdtemp(join(tmpdir(), "limina-tree-scatter-"));
try {
  const source = join(root, "oak.glb"), reduced = join(root, "oak-lod.glb");
  await Promise.all([cp(SOURCE, source), cp(REDUCED, reduced)]);
  const [sourceBytes, reducedBytes] = await Promise.all([readFile(source), readFile(reduced)]);
  const manifest = { schema: "limina.asset-manifest/1", unlistedPolicy: "excluded", entries: [{
    id: "integration-oak", class: "vegetation", model: { path: "oak.glb", sha256: hash(sourceBytes) },
    lods: [{ path: "oak-lod.glb", sha256: hash(reducedBytes), distanceM: 80 }],
    qc: { humanVisualApproval: { approved: true, approvedBy: "automated-integration-fixture", referenceContract: "internal-test-only" } },
  }], candidates: [] };
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await bakeTreeImpostor({ input: source, lodInput: reduced, output: join(root, "oak-impostor.glb"),
    evidence: join(root, "oak-impostor.evidence.json"), manifest: manifestPath, assetRoot: root,
    grid: 2, cellSize: 32, samples: 1, seed: 7, blenderBin: BLENDER });
  const impostor = join(root, "oak-impostor.glb"), impostorBytes = await readFile(impostor);
  await writeFile(join(root, "oak-population.json"), `${JSON.stringify({ schema: "limina.biome-population-asset/v1",
    id: "oak-tree-chain", version: "1.0.0", role: "flora/oak", backend: "tree-population",
    sourceAssetId: "oak.glb", sourceContentHash: liminaHash(sourceBytes), reducedAssetId: "oak-lod.glb",
    reducedContentHash: liminaHash(reducedBytes), impostorAssetId: "oak-impostor.glb", impostorContentHash: liminaHash(impostorBytes),
    reducedDistance: 80, impostorDistance: 280, cullDistance: 1200, hysteresis: 0.15,
    provenance: { licenseId: "CC0-1.0", sourceUri: "limina://internal-integration/oak" } })}\n`);

  for (const script of ["js/test/p_tree_asset_scatter.ts", "js/test/p_tree_vegetation_scatter.ts", "js/test/p_tree_biome_scatter.ts", "js/test/p_biome_population_mount.ts"]) {
    const result = spawnSync(join(ROOT, "target/release/limina"), [join(ROOT, script)], {
      cwd: ROOT, env: { ...process.env, LIMINA_ASSET_ROOT: root }, encoding: "utf8", timeout: 60_000,
    });
    if (result.status !== 0) throw new Error(`${script} failed (${result.status}):\n${result.stdout}${result.stderr}`);
  }
  console.log("tree-scatter-integration OK: accepted real oak source/reduced assets baked a CPU impostor and passed direct, editable, legacy-biome, and B3 descriptor-driven population paths");
} finally {
  await rm(root, { recursive: true, force: true });
}
