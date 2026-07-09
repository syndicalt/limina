// pack-import-check.mjs — the falsifiable gate for the content-pack importer (tools/design/pack-import.mjs).
//
// Run: node tools/design/pack-import-check.mjs
// Exit: 0 pass · 1 fail · 2 environmental skip (baker deps absent).
//
// Proves: (1) path safety REJECTS traversal/absolute (the security teeth — a broken input FAILS);
// (2) the manifest validator accepts recipe + static packs and rejects malformed ones; (3) the three
// manifest merges (tree-pack union-by-id, biome-pack role-override, catalog upsert-by-id) are correct;
// (4) recipe expansion (expected ids + tree-pack) matches the species×seed grid; (5) END-TO-END: the
// real aethon-conifers recipe imports into a temp asset root — the headless baker produces every
// expected GLB and tree-pack/biome-pack are written + `imported` flips true.

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  safeRelPath, validatePackManifest, mergeTreePack, mergeBiomePack, mergeCatalog,
  recipeExpectedIds, recipeTreePack, isRecipe, listPacks, importPack,
} from "./pack-import.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
let failed = 0;
function ok(cond, msg) { if (!cond) { console.error("FAIL: " + msg); failed++; } }
function throws(fn, msg) { try { fn(); console.error("FAIL (did not throw): " + msg); failed++; } catch { /* expected */ } }

// ── 1. PATH SAFETY — the security teeth. Traversal / absolute MUST throw. ────────────────────────
ok(safeRelPath("trees/spruce-1.glb") === "trees/spruce-1.glb", "safeRelPath passes a clean relative path");
throws(() => safeRelPath("../secret"), "safeRelPath must reject a leading ..");
throws(() => safeRelPath("a/../../etc/passwd"), "safeRelPath must reject an escaping ..");
throws(() => safeRelPath("/etc/passwd"), "safeRelPath must reject an absolute path");
throws(() => safeRelPath(""), "safeRelPath must reject an empty path");

// ── 2. MANIFEST VALIDATION — recipe + static accepted; malformed rejected. ───────────────────────
const recipePack = { name: "p", version: "1", generator: "ez-tree", seeds: [1, 2], trees: { spruce: {}, oak: { seeds: [1] } } };
ok(isRecipe(recipePack), "isRecipe true for a generator recipe");
ok(validatePackManifest(recipePack).ok, "a well-formed recipe validates");
ok(validatePackManifest({ name: "s", version: "1", assets: [{ id: "trees/x.glb", file: "glb/x.glb" }] }).ok, "a well-formed static pack validates");
ok(!validatePackManifest({ version: "1", assets: [] }).ok, "a pack with no name is invalid");
ok(!validatePackManifest({ name: "b", version: "1", assets: [{ id: "../evil.glb" }] }).ok, "FALSIFIABLE: a static asset id with .. is rejected");
ok(!isRecipe({ name: "s", version: "1", assets: [] }), "isRecipe false for a static pack");

// ── 3. MERGES ────────────────────────────────────────────────────────────────────────────────────
const tp = mergeTreePack({ spruce: [{ id: "trees/spruce-1.glb" }] }, { spruce: [{ id: "trees/spruce-1.glb", weight: 2 }, { id: "trees/spruce-2.glb" }], oak: [{ id: "trees/oak-1.glb" }] });
ok(tp.spruce.length === 2, "tree-pack union de-dups by id (spruce stays 2, not 3)");
ok(tp.spruce.find((e) => e.id === "trees/spruce-1.glb").weight === 2, "tree-pack incoming wins the shared id");
ok(tp.oak.length === 1, "tree-pack adds a new species");
const bp = mergeBiomePack({ conifer: { id: "old.glb" }, boulder: { id: "rock.glb" } }, { conifer: { id: "trees/pine-1.glb" } });
ok(bp.conifer.id === "trees/pine-1.glb" && bp.boulder.id === "rock.glb", "biome-pack overrides a role, keeps the others");
const cat = mergeCatalog([{ id: "a", title: "A" }], [{ id: "a", title: "A2" }, { id: "b", title: "B" }]);
ok(cat.length === 2 && cat.find((e) => e.id === "a").title === "A2", "catalog upserts by id (replace a, append b)");

// ── 4. RECIPE EXPANSION ──────────────────────────────────────────────────────────────────────────
const ids = recipeExpectedIds(recipePack);
ok(ids.includes("trees/spruce-1.glb") && ids.includes("trees/spruce-2.glb") && ids.includes("trees/oak-1.glb") && !ids.includes("trees/oak-2.glb"),
  "recipe expected ids honor per-species seeds (spruce 1,2; oak only 1)");
const rtp = recipeTreePack(recipePack);
ok(rtp.spruce.length === 2 && rtp.oak.length === 1, "recipe tree-pack binds each species to its variants");

// ── 5. END-TO-END — the real aethon-conifers recipe bakes into a temp asset root. ────────────────
const packsDir = join(REPO, "packs");
if (!existsSync(join(packsDir, "aethon-conifers", "pack.json"))) {
  console.error("SKIP end-to-end: packs/aethon-conifers not present");
} else if (!existsSync(join(REPO, "js", "node_modules", "three")) || !existsSync(join(REPO, "js", "node_modules", ".bin", "esbuild"))) {
  console.error("pack-import-check: pure checks done; end-to-end bake SKIPPED (baker deps absent)");
  if (failed > 0) { console.error(`pack-import-check: ${failed} pure check(s) failed`); process.exit(1); }
  process.exit(2);
} else {
  const tmp = mkdtempSync(join(tmpdir(), "limina-pack-"));
  try {
    const before = listPacks({ packsDir, assetsDir: tmp }).find((p) => p.dir === "aethon-conifers");
    ok(before && before.imported === false, "before import: aethon-conifers reports imported:false");
    const r = importPack({ packsDir, packName: "aethon-conifers", assetsDir: tmp });
    ok(r.ok === true && r.kind === "recipe", "recipe import returns ok:true");
    ok(r.missing.length === 0, "no expected GLB missing after bake: " + JSON.stringify(r.missing));
    const pack = JSON.parse(readFileSync(join(packsDir, "aethon-conifers", "pack.json"), "utf8"));
    for (const id of recipeExpectedIds(pack)) ok(existsSync(join(tmp, id)), "baked GLB exists: " + id);
    const treePack = JSON.parse(readFileSync(join(tmp, "tree-pack.json"), "utf8"));
    ok(Object.keys(treePack).length === Object.keys(pack.trees).length, "tree-pack binds every recipe species");
    ok(existsSync(join(tmp, "biome-pack.json")), "biome-pack.json written");
    const after = listPacks({ packsDir, assetsDir: tmp }).find((p) => p.dir === "aethon-conifers");
    ok(after && after.imported === true, "after import: aethon-conifers reports imported:true");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (failed > 0) { console.error(`pack-import-check: ${failed} check(s) FAILED`); process.exit(1); }
console.log("pack-import-check OK: path safety rejects traversal/absolute; recipe+static validation; tree-pack union / biome-pack override / catalog upsert; recipe expansion honors per-species seeds; end-to-end aethon-conifers recipe baked every GLB + wrote tree-pack/biome-pack (imported false→true).");
