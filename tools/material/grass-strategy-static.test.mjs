import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const shipped = [
  "web/public/limina-runtime.js",
  "editor/vendor/limina-runtime.js",
  "tools/scaffold/public/limina-player.js",
  "site/public/examples/limina-player.js",
];
const forbidden = [
  "TileGrass",
  "buildGroundCoverMount",
  "tileGrassClimate",
  "LUSH_TEMPERATE_GRASS_PACKAGE",
  "limina.grass.lush-temperate",
  "limina.grass.dense-temperate-groundcover",
  "dense-turf-disk/v1",
  "grassSoup",
  "PropKind.Grass",
  "limina:derived-ground-cover",
  "registerGrassSkill",
  "buildGrassMaterial",
  'name: "vegetation.grass"',
  "layered-meadow-rosette",
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:ts|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("shipped runtimes contain only the independently-instanced continuous-meadow strategy", async () => {
  for (const relative of shipped) {
    const source = await readFile(resolve(repo, relative), "utf8");
    for (const token of forbidden) assert.equal(source.includes(token), false, `${relative} retained ${token}`);
    assert.match(source, /limina\.grass\.interactive-temperate-meadow/, `${relative} omitted interactive meadow package`);
    assert.match(source, /individually-instanced-curved-blade\/v3/, `${relative} omitted independent-blade meadow geometry`);
  }
});

test("an assembled desktop package cannot retain the rejected strategy", async () => {
  const relative = "dist/desktop/app/js/src/content/grass/interactive-temperate-meadow.ts";
  try { await access(resolve(repo, relative), constants.F_OK); } catch { return; }
  const source = await readFile(resolve(repo, relative), "utf8");
  for (const token of forbidden) assert.equal(source.includes(token), false, `${relative} retained ${token}`);
  assert.match(source, /individually-instanced-curved-blade\/v3/, `${relative} omitted independent-blade meadow geometry`);
});

test("deleted engine-owned grass implementations cannot return", async () => {
  for (const relative of ["js/src/render/grass-source.ts", "js/src/terrain/grass-render.ts",
    "js/src/content/grass/lush-temperate-grass.ts", "js/src/content/grass/dense-temperate-groundcover.ts",
    "js/src/skills/grass.ts"]) {
    await assert.rejects(access(resolve(repo, relative), constants.F_OK), `${relative} unexpectedly exists`);
  }
});

test("source exposes only vegetation.grassField and package-owned materials", async () => {
  for (const file of await sourceFiles(resolve(repo, "js/src"))) {
    const source = await readFile(file, "utf8");
    assert.equal(source.includes("registerGrassSkill"), false, `${file} retained legacy skill registration`);
    assert.equal(source.includes("buildGrassMaterial"), false, `${file} retained the shared legacy material`);
    assert.equal(/name:\s*["']vegetation\.grass["']/.test(source), false, `${file} retained the public legacy skill`);
  }
});

test("temperate meadow spends its blade budget on independently instanced blades", async () => {
  const source = await readFile(resolve(repo, "js/src/content/grass/interactive-temperate-meadow.ts"), "utf8");
  assert.equal((source.match(/bladesPerInstance:\s*1,/g) ?? []).length, 3,
    "every near grass quality must independently instance its blades");
  assert.match(source, /individually-instanced-curved-blade\/v3/, "temperate meadow omitted the independent-blade marker");
  assert.match(source, /bounded-distant-meadow-cluster\/v3/, "temperate meadow omitted its bounded distant LOD");
  assert.doesNotMatch(source, /clusterRadius|layered-meadow-rosette/, "temperate meadow retained the rejected rosette strategy");
});

test("locked fidelity fixtures do not scatter candidate grass GLBs", async () => {
  const fixture = await readFile(resolve(repo, "tools/preview/wb-b2-ecosystem-internal.json"), "utf8");
  assert.equal(fixture.includes("vegetation/grass-medium-01"), false);
});

test("the locked temperate descriptor selects the independent-blade continuous-meadow package", async () => {
  const descriptor = JSON.parse(await readFile(resolve(repo, "assets/population/temperate-forest-grass.json"), "utf8"));
  assert.equal(descriptor.backend, "continuous-grass-field");
  assert.equal(descriptor.visualPackageId, "limina.grass.interactive-temperate-meadow");
  assert.equal(descriptor.visualPackageVersion, "3.0.1");
});
