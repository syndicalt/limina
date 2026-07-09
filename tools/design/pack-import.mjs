// pack-import.mjs — import a content PACK (GLBs + manifest merges) into the engine's asset root.
//
// The engine ships NO content; a project imports packs to gain assets/trees/biomes (the decoupling).
// A pack is a folder with a `pack.json` manifest that (a) lists the GLBs it provides — each either
// OWNED (a `file` inside the pack, copied in) or REFERENCED (id only, must already exist at the
// destination) — and (b) supplies any of the three runtime manifests the loaders already read:
// `tree-pack.json` (vegetation.scatter), `biome-pack.json` (world.populateBiome), `catalog.json`
// (the asset palette). Import copies owned GLBs and shallow-merges those manifests into the asset
// root, so the native op_read_asset, the editor /assets mount, and the Design Space /api/catalog all
// see the new content immediately (every reader re-reads fresh).
//
// PATH SAFETY: every id / file is validated to be relative and non-escaping (mirrors the sandbox
// rules of op_read_asset in crates/limina-ops) so a malicious pack.json cannot write outside the
// asset root. The pure merge/validate helpers are exported so a gate can prove the semantics + the
// traversal rejection without touching the filesystem.
//
// NOTE (decoupling): today every authoring reader resolves to LIMINA_HOME/assets, so `assetsDir` is
// that root. When the asset root becomes project-local (roadmap Slice 4), only the caller's
// `assetsDir` changes — this module is already parameterized on it.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname, normalize, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACK_IMPORT_DIR = dirname(fileURLToPath(import.meta.url));
const BAKE_TREES = join(PACK_IMPORT_DIR, "..", "bake-trees.mjs"); // tools/bake-trees.mjs

/** A pack-relative path (a GLB `file` inside a pack, or a destination asset `id`) must be RELATIVE
 *  and must not escape its root. Throws on absolute / `..`-escaping paths. Returns the normalized,
 *  forward-slash form. */
export function safeRelPath(p) {
  if (typeof p !== "string" || p.length === 0) throw new Error("pack: empty path");
  if (isAbsolute(p)) throw new Error(`pack: absolute path not allowed: ${p}`);
  const norm = normalize(p).replace(/\\/g, "/");
  if (norm === ".." || norm.startsWith("../") || norm.includes("/../")) throw new Error(`pack: path escapes its root: ${p}`);
  return norm;
}

/** True when the pack is an ez-tree GENERATOR recipe (bakes trees on import) rather than a static
 *  GLB pack. */
export function isRecipe(pack) {
  return !!pack && pack.generator === "ez-tree" && pack.trees != null && typeof pack.trees === "object";
}

/** The seed list for a recipe species: its own `seeds`, else the pack-level `seeds`, else [1, 2]. */
function speciesSeeds(pack, species) {
  const own = pack.trees[species] && Array.isArray(pack.trees[species].seeds) ? pack.trees[species].seeds : null;
  const top = Array.isArray(pack.seeds) ? pack.seeds : null;
  const seeds = (own || top || [1, 2]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return seeds.length > 0 ? seeds : [1, 2];
}

/** The GLB asset ids a recipe produces: trees/<species>-<seed>.glb for every species×seed. */
export function recipeExpectedIds(pack) {
  const ids = [];
  for (const sp of Object.keys(pack.trees || {})) {
    for (const seed of speciesSeeds(pack, sp)) ids.push(`trees/${sp}-${seed}.glb`);
  }
  return ids;
}

/** The tree-pack (Record<species, {id}[]>) a recipe binds — every species to its baked variants. */
export function recipeTreePack(pack) {
  const out = {};
  for (const sp of Object.keys(pack.trees || {})) {
    out[sp] = speciesSeeds(pack, sp).map((seed) => ({ id: `trees/${sp}-${seed}.glb` }));
  }
  return out;
}

/** Validate a pack.json shape (recipe OR static). Returns { ok, errors } — never throws (so listing
 *  tolerates a bad pack in the library). */
export function validatePackManifest(pack) {
  const errors = [];
  if (!pack || typeof pack !== "object") return { ok: false, errors: ["manifest is not an object"] };
  if (typeof pack.name !== "string" || pack.name.length === 0) errors.push("name required");
  if (typeof pack.version !== "string" || pack.version.length === 0) errors.push("version required");
  if (isRecipe(pack)) {
    if (Object.keys(pack.trees).length === 0) errors.push("generator recipe has no trees");
    for (const sp of Object.keys(pack.trees)) {
      try { safeRelPath(`trees/${sp}-1.glb`); } catch (e) { errors.push(`bad species name '${sp}'`); }
    }
  } else {
    for (const a of Array.isArray(pack.assets) ? pack.assets : []) {
      if (!a || typeof a.id !== "string" || a.id.length === 0) { errors.push("asset missing id"); continue; }
      try {
        safeRelPath(a.id);
        if (a.file != null) safeRelPath(a.file);
      } catch (e) {
        errors.push(String(e && e.message ? e.message : e));
      }
    }
  }
  const prov = pack.provides || {};
  if (prov.treePack != null && typeof prov.treePack !== "object") errors.push("provides.treePack must be an object");
  if (prov.biomePack != null && typeof prov.biomePack !== "object") errors.push("provides.biomePack must be an object");
  if (prov.catalog != null && !Array.isArray(prov.catalog)) errors.push("provides.catalog must be an array");
  return { ok: errors.length === 0, errors };
}

/** Merge a tree-pack (Record<species, {id, weight?}[]>): per species, union entries de-duped by id
 *  (incoming wins on a shared id). */
export function mergeTreePack(existing, incoming) {
  const out = { ...(existing && typeof existing === "object" ? existing : {}) };
  for (const [species, entries] of Object.entries(incoming || {})) {
    const byId = new Map((Array.isArray(out[species]) ? out[species] : []).map((e) => [e.id, e]));
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || typeof e.id !== "string") continue;
      byId.set(e.id, { id: e.id, ...(typeof e.weight === "number" ? { weight: e.weight } : {}) });
    }
    out[species] = [...byId.values()];
  }
  return out;
}

/** Merge a biome-pack (Record<role, {id, embedRadius?}>): role-level override (incoming wins). */
export function mergeBiomePack(existing, incoming) {
  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    ...(incoming && typeof incoming === "object" ? incoming : {}),
  };
}

/** Merge a catalog (CatalogEntry[]): upsert by id (replace-in-place else append), the same
 *  semantics the engine's asset-catalog merge uses, so disk state matches engine state. */
export function mergeCatalog(existing, incoming) {
  const arr = Array.isArray(existing) ? existing.slice() : [];
  const idx = new Map(arr.map((e, i) => [e && e.id, i]));
  for (const e of Array.isArray(incoming) ? incoming : []) {
    if (!e || typeof e.id !== "string") continue;
    if (idx.has(e.id)) arr[idx.get(e.id)] = e;
    else { idx.set(e.id, arr.length); arr.push(e); }
  }
  return arr;
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

/** Enumerate packs under packsDir, each with an `imported` flag computed against the asset root
 *  (every referenced GLB present + every provided manifest key materialized). */
export function listPacks({ packsDir, assetsDir }) {
  if (!existsSync(packsDir)) return [];
  const treePack = readJson(join(assetsDir, "tree-pack.json"), {});
  const biomePack = readJson(join(assetsDir, "biome-pack.json"), {});
  const catalog = readJson(join(assetsDir, "catalog.json"), []);
  const catalogIds = new Set((Array.isArray(catalog) ? catalog : []).map((e) => e && e.id));
  const out = [];
  for (const name of readdirSync(packsDir)) {
    const manifestPath = join(packsDir, name, "pack.json");
    if (!existsSync(manifestPath)) continue;
    const pack = readJson(manifestPath, null);
    if (!pack) continue;
    const v = validatePackManifest(pack);
    const prov = pack.provides || {};
    const recipe = isRecipe(pack);
    // A recipe's assets are the trees it bakes; a static pack's are its listed GLBs.
    const expectedIds = recipe ? recipeExpectedIds(pack) : (Array.isArray(pack.assets) ? pack.assets : []).map((a) => a && a.id).filter(Boolean);
    const wantTreePack = recipe ? recipeTreePack(pack) : (prov.treePack || {});
    const assetsPresent = expectedIds.every((id) => existsSync(join(assetsDir, id)));
    const treeKeysPresent = Object.keys(wantTreePack).every((k) => Array.isArray(treePack[k]) && treePack[k].length > 0);
    const biomeKeysPresent = Object.keys(prov.biomePack || {}).every((k) => biomePack[k] != null);
    const catalogPresent = (Array.isArray(prov.catalog) ? prov.catalog : []).every((e) => e && catalogIds.has(e.id));
    out.push({
      name: pack.name || name,
      dir: name,
      version: pack.version || "",
      description: pack.description || "",
      kind: recipe ? "recipe" : "static",
      assetCount: expectedIds.length,
      provides: {
        trees: Object.keys(wantTreePack).length,
        biome: Object.keys(prov.biomePack || {}).length,
        catalog: (Array.isArray(prov.catalog) ? prov.catalog : []).length,
      },
      valid: v.ok,
      errors: v.errors,
      imported: v.ok && expectedIds.length > 0 && assetsPresent && treeKeysPresent && biomeKeysPresent && catalogPresent,
    });
  }
  return out;
}

/** Import one pack into the asset root: copy owned GLBs, merge the provided manifests. Returns a
 *  summary. `ok:false` (with `missing`) when a referenced GLB is absent or an owned file is missing —
 *  the merge still happens (a pack must never half-fail silently; the caller surfaces `missing`). */
export function importPack({ packsDir, packName, assetsDir }) {
  const packDir = join(packsDir, safeRelPath(packName));
  const manifestPath = join(packDir, "pack.json");
  if (!existsSync(manifestPath)) throw new Error(`pack not found: ${packName}`);
  const pack = JSON.parse(readFileSync(manifestPath, "utf8"));
  const v = validatePackManifest(pack);
  if (!v.ok) throw new Error(`invalid pack.json: ${v.errors.join("; ")}`);

  // GENERATOR RECIPE: bake the requested species on the fly (no committed GLBs) into <assetsDir>/trees
  // via the headless ez-tree baker, then bind them in tree-pack.json. The recipe is the portable unit;
  // the GLBs regenerate deterministically anywhere.
  if (isRecipe(pack)) {
    const species = Object.keys(pack.trees);
    const seedUnion = [...new Set(species.flatMap((sp) => speciesSeeds(pack, sp)))].sort((a, b) => a - b);
    const outDir = join(assetsDir, "trees");
    const r = spawnSync(process.execPath, [
      BAKE_TREES, "--species", species.join(","), "--seeds", seedUnion.join(","), "--out", outDir,
    ], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) {
      throw new Error(`tree bake failed (${r.status}): ${(r.stderr || r.stdout || "").slice(-400)}`);
    }
    const expected = recipeExpectedIds(pack);
    const bakedMissing = expected.filter((id) => !existsSync(join(assetsDir, id)));

    // tree-pack from the recipe + any explicit provides.treePack override.
    const treePath = join(assetsDir, "tree-pack.json");
    let merged = mergeTreePack(readJson(treePath, {}), recipeTreePack(pack));
    if (pack.provides && pack.provides.treePack) merged = mergeTreePack(merged, pack.provides.treePack);
    writeFileSync(treePath, JSON.stringify(merged, null, 2) + "\n");

    const prov = pack.provides || {};
    let biomePack = false, catalog = 0;
    if (prov.biomePack) {
      const p = join(assetsDir, "biome-pack.json");
      writeFileSync(p, JSON.stringify(mergeBiomePack(readJson(p, {}), prov.biomePack), null, 2) + "\n");
      biomePack = true;
    }
    if (Array.isArray(prov.catalog) && prov.catalog.length > 0) {
      const p = join(assetsDir, "catalog.json");
      writeFileSync(p, JSON.stringify(mergeCatalog(readJson(p, []), prov.catalog), null, 2) + "\n");
      catalog = prov.catalog.length;
    }
    return { ok: bakedMissing.length === 0, pack: pack.name || packName, kind: "recipe", baked: expected.length, missing: bakedMissing, treePack: true, biomePack, catalog };
  }

  let copied = 0;
  const missing = [];
  for (const a of Array.isArray(pack.assets) ? pack.assets : []) {
    const dest = join(assetsDir, safeRelPath(a.id));
    if (a.file != null) {
      const src = join(packDir, safeRelPath(a.file));
      if (!existsSync(src)) { missing.push(`${a.file} (owned file missing)`); continue; }
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      copied++;
    } else if (!existsSync(dest)) {
      missing.push(`${a.id} (referenced, not present)`);
    }
  }

  const prov = pack.provides || {};
  let treePack = false, biomePack = false, catalog = 0;
  if (prov.treePack) {
    const p = join(assetsDir, "tree-pack.json");
    writeFileSync(p, JSON.stringify(mergeTreePack(readJson(p, {}), prov.treePack), null, 2) + "\n");
    treePack = true;
  }
  if (prov.biomePack) {
    const p = join(assetsDir, "biome-pack.json");
    writeFileSync(p, JSON.stringify(mergeBiomePack(readJson(p, {}), prov.biomePack), null, 2) + "\n");
    biomePack = true;
  }
  if (Array.isArray(prov.catalog) && prov.catalog.length > 0) {
    const p = join(assetsDir, "catalog.json");
    writeFileSync(p, JSON.stringify(mergeCatalog(readJson(p, []), prov.catalog), null, 2) + "\n");
    catalog = prov.catalog.length;
  }

  return { ok: missing.length === 0, pack: pack.name || packName, kind: "static", copied, missing, treePack, biomePack, catalog };
}
