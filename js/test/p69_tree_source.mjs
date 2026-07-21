// p69_tree_source — headless gate for the pure runtime tree generator
// (js/src/render/tree-source.ts). Imports the REAL module and asserts against REAL generated
// BufferGeometry (never a stub of it). Proves: the species catalog is real, geometry is
// non-empty, deterministic, varied per-seed, distinct per-species (this is what catches
// ez-tree's silent unknown-preset fallback-to-default), and that unknown species THROW.
//
// Run: node js/test/p69_tree_source.mjs   (Node 24 strips the .ts types natively.)
//
// ez-tree's generate() constructs materials via THREE.TextureLoader, which needs a DOM.
// Geometry is independent of texture pixels, so this minimal verified DOM stub lets geometry
// generation complete headless. It MUST be installed BEFORE any three/ez-tree import — hence
// the dynamic import() of the module below, after the stub is in place.
globalThis.document = {
  createElementNS: () => ({ style: {}, setAttribute() {}, set src(_v) {}, get src() { return ""; }, addEventListener() {}, removeEventListener() {} }),
  createElement: () => ({ style: {}, getContext: () => null, setAttribute() {} }),
};
globalThis.Image = class { set src(_v) {} };

const { TREE_SPECIES, SPECIES_PRESETS, generateTree } = await import("../src/render/tree-source.ts");

function assert(cond, msg) {
  if (!cond) throw new Error("p69_tree_source: " + msg);
}

function assertThrows(fn, msg) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, msg);
}

/** All mesh position-attribute arrays under an Object3D, in stable traversal order. */
function positionChunks(obj) {
  const chunks = [];
  obj.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const pos = o.geometry.getAttribute("position");
      if (pos && pos.array && pos.array.length > 0) chunks.push(pos.array);
    }
  });
  return chunks;
}

/** Concatenate every mesh position buffer into one Float32Array (deterministic order). */
function concatPositions(obj) {
  const chunks = positionChunks(obj);
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Byte-identical comparison of two Float32Arrays (exact float equality). */
function identical(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── 1. Catalog is real ───────────────────────────────────────────────────────────────────
assert(TREE_SPECIES.includes("oak"), "TREE_SPECIES must include 'oak'");
assert(TREE_SPECIES.length >= 5, `TREE_SPECIES must have >=5 species, got ${TREE_SPECIES.length}`);
for (const species of TREE_SPECIES) {
  const presets = SPECIES_PRESETS[species];
  assert(
    Array.isArray(presets) && presets.length >= 1,
    `species '${species}' must map to >=1 preset in SPECIES_PRESETS`,
  );
}

// ── 2. Geometry is non-empty ─────────────────────────────────────────────────────────────
const SEED = 424242;
const oak = generateTree("oak", SEED);
assert(typeof oak.traverse === "function" && oak.isObject3D === true, "generateTree must return a THREE.Object3D");
const oakFloats = concatPositions(oak);
assert(oakFloats.length > 0, "generateTree('oak', seed) meshes must have non-empty position attributes");

// ── 3. Determinism: same (species, seed) → byte-identical positions across separate calls ──
const oakA = concatPositions(generateTree("oak", SEED));
const oakB = concatPositions(generateTree("oak", SEED));
assert(identical(oakA, oakB), "same (species, seed) must yield byte-identical position buffers");

// ── 4. Variety: same species, different seeds → positions DIFFER ──────────────────────────
const oakSeed1 = concatPositions(generateTree("oak", 1));
const oakSeed2 = concatPositions(generateTree("oak", 2));
assert(!identical(oakSeed1, oakSeed2), "same species with different seeds must yield DIFFERENT geometry (the 'trees look like copies' fix)");

// ── 5. Distinct species: oak vs pine (same seed) → DIFFERENT geometry ─────────────────────
//      This is the anti-landmine check: an accidental fallback-to-default would make these equal.
const oakDistinct = concatPositions(generateTree("oak", SEED));
const pineDistinct = concatPositions(generateTree("pine", SEED));
assert(!identical(oakDistinct, pineDistinct), "different species (oak vs pine, same seed) must yield DIFFERENT geometry — a match means an unknown-preset silent fallback");

// ── 5b. EVERY advertised species is genuinely distinct: all pairs differ at a fixed seed. ─────
//      Enforces the honesty property — no species may be a silent alias of another (which would
//      render byte-identical). Re-adding a proxy like birch→aspen would fail here.
{
  const geo = TREE_SPECIES.map((s) => concatPositions(generateTree(s, SEED)));
  for (let i = 0; i < TREE_SPECIES.length; i++) {
    for (let j = i + 1; j < TREE_SPECIES.length; j++) {
      assert(
        !identical(geo[i], geo[j]),
        `species '${TREE_SPECIES[i]}' and '${TREE_SPECIES[j]}' render byte-identical geometry — an advertised species must not be a silent alias of another`,
      );
    }
  }
}

// ── 6. Guard: unknown species THROWS (never silent-fallback) ──────────────────────────────
assertThrows(() => generateTree("dragon", 1), "generateTree must THROW on an unknown species ('dragon')");

console.log(`[js] p69_tree_source OK: ${TREE_SPECIES.length} species (${TREE_SPECIES.join("/")}) map to real ez-tree presets; generateTree() is non-empty (${oakFloats.length} oak floats), deterministic (byte-identical re-gen), varied per-seed, and every advertised species is pairwise-distinct (no silent aliases); throws on unknown species`);
