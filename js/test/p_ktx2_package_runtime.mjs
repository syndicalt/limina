import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("Basis runtime is copied byte-exactly from pinned Three", async () => {
  assert.equal(pkg.dependencies.three, "0.184.0");
  for (const file of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
    const source = await readFile(new URL(`node_modules/three/examples/jsm/libs/basis/${file}`, root));
    for (const target of ["../runtime/basis/", "../web/public/runtime/basis/", "../editor/vendor/runtime/basis/", "../tools/scaffold/public/runtime/basis/"]) {
      assert.equal(hash(await readFile(new URL(`${target}${file}`, root))), hash(source));
    }
  }
});
test("engine install provisions pinned authoring tools and syncs its matching runtime", () => {
  assert.match(pkg.scripts.postinstall, /^node scripts\/install-ktx-tools\.mjs --required && npm run sync:basis-runtime$/);
  assert.match(pkg.scripts["bundle:three"], /sync:basis-runtime/);
  assert.match(pkg.scripts["deps:ktx"], /^node scripts\/install-ktx-tools\.mjs(?: --required)?$/);
});
test("standalone engine distribution ships the project Basis runtime", async () => {
  const packager = await readFile(new URL("../tools/package/make-alpha.mjs", root), "utf8");
  assert.match(packager, /copy\("runtime\/basis", "runtime\/basis"\)/);
  assert.match(packager, /copy\("runtime\/basis", "editor\/runtime\/basis"\)/);
  const releasePackager = await readFile(new URL("../packager/pack.mjs", root), "utf8");
  assert.match(releasePackager, /join\(outDir, "runtime", "basis"\)/);
  const scaffoldExporter = await readFile(new URL("../tools/scaffold/scripts/export.mjs", root), "utf8");
  assert.match(scaffoldExporter, /join\(stageDir, "runtime", "basis"\)/);
});
test("cache owns KTX2 configuration, fail-closed parsing, and disposal", async () => {
  const source = await readFile(new URL("src/skills/three.ts", root), "utf8");
  assert.match(source, /usesKtx2\(bytes, assetId\)/);
  assert.match(source, /requires a renderer-configured project Basis transcoder/);
  assert.match(source, /loader\.setKTX2Loader/);
  assert.match(source, /loader\.setTranscoderPath\(this\.#ktx2TranscoderPath\)/);
  assert.match(source, /loader\.detectSupport\(renderer/);
  assert.match(source, /this\.#ktx2Loader\?\.dispose\(\)/);
});
