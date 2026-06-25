#!/usr/bin/env node
// Downloads the hero cinematic's real CC0 assets into site/public/hero/.
// Run from site/:  node scripts/fetch-hero-assets.mjs   (add --force to re-download)
//
// Sources (all CC0):
//   - RobotExpressive.glb  (three.js examples; Tomás Laulhé / Don McCurdy)
//   - Deer.glb, Slime.glb  (Quaternius TestGltfAssets)
//   - 5 HDRIs @1k          (Poly Haven, via api.polyhaven.com)
//
// Genre dressing (trees/rocks/cacti/sci-fi/houses) is procedural at runtime —
// see src/scripts/hero-cinematic/manifest.ts (DRESSING) and world.ts. Downloadable
// low-poly CC0 kits (Quaternius/Kenney zips) are not scriptably reachable and
// Poly Haven meshes are full-photogrammetry (100s of MB), so dressing is generated.
//
// Keep asset URLs in sync with src/scripts/hero-cinematic/manifest.ts (source of truth).

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORCE = process.argv.includes('--force');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // site/
const OUT = join(ROOT, 'public', 'hero');
const UA = 'limina-hero-build';

const CHARACTER = {
  key: 'robot',
  out: 'models/robot.glb',
  url: 'https://raw.githubusercontent.com/mrdoob/three.js/r184/examples/models/gltf/RobotExpressive/RobotExpressive.glb',
  fallbackUrl:
    'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/models/gltf/RobotExpressive/RobotExpressive.glb',
  credit: 'RobotExpressive by Tomás Laulhé (CC0), modified by Don McCurdy — via three.js examples',
};

const CREATURES = [
  {
    key: 'deer',
    out: 'models/deer.glb',
    url: 'https://raw.githubusercontent.com/Quaternius/TestGltfAssets/master/Deer/Deer.glb',
    credit: 'Deer by Quaternius (CC0)',
  },
  {
    key: 'slime',
    out: 'models/slime.glb',
    url: 'https://raw.githubusercontent.com/Quaternius/TestGltfAssets/master/Slime/Slime.glb',
    credit: 'Slime by Quaternius (CC0)',
  },
];

const HDRIS = [
  { phase: 'builder', slug: 'studio_small_03', fallback: 'studio_small_08' },
  { phase: 'fantasy', slug: 'kloofendal_48d_partly_cloudy_puresky', fallback: 'qwantani_puresky' },
  { phase: 'western', slug: 'qwantani_dusk_2_puresky', fallback: 'qwantani_dusk_2' },
  { phase: 'scifi', slug: 'dikhololo_night', fallback: 'moonless_golf' },
  { phase: 'sim', slug: 'kloofendal_48d_partly_cloudy', fallback: 'spruit_sunrise' },
];

// KayKit Medieval Hexagon Pack (CC0, Kay Lousberg) — standalone medieval buildings
// for the fantasy town street. Each .gltf references its own .bin + a shared
// texture atlas, all by same-dir relative URI, so we flatten them into one folder.
const KAYKIT_HEX =
  'https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0/main/addons/kaykit_medieval_hexagon_pack/Assets/gltf';
const KAYKIT_ATLAS = `${KAYKIT_HEX}/decoration/nature/hexagons_medieval.png`;
const FANTASY_BUILDINGS = [
  ['green', 'building_home_A_green'],
  ['blue', 'building_home_B_blue'],
  ['green', 'building_tavern_green'],
  ['blue', 'building_blacksmith_blue'],
  ['green', 'building_market_green'],
  ['blue', 'building_church_blue'],
  ['green', 'building_windmill_green'],
  ['blue', 'building_well_blue'],
  ['green', 'building_tower_A_green'],
  ['blue', 'building_tower_B_blue'],
  ['green', 'building_watermill_green'],
  ['blue', 'building_barracks_blue'],
  ['green', 'building_lumbermill_green'],
];
// Distant landmark for the backdrop (kept separate from the street rotation).
const FANTASY_LANDMARK = ['blue', 'building_castle_blue'];
// Nature assets (decoration/nature/) — foliage, rocks, mountains, clouds.
const FANTASY_NATURE = [
  'tree_single_A', 'tree_single_B',
  'trees_A_large', 'trees_A_medium', 'trees_A_small',
  'trees_B_large', 'trees_B_medium', 'trees_B_small',
  'rock_single_A', 'rock_single_B', 'rock_single_C', 'rock_single_D', 'rock_single_E',
  'mountain_A', 'mountain_B', 'mountain_C',
  'mountain_A_grass_trees', 'mountain_B_grass_trees', 'mountain_C_grass_trees',
  'hill_single_A', 'hill_single_B', 'hill_single_C',
  'cloud_big', 'cloud_small',
];
// Neutral (uncoloured) buildings, e.g. the bridge — buildings/neutral/.
const FANTASY_NEUTRAL = ['building_bridge_A', 'building_bridge_B'];

// KayKit Space Base Bits (CC0, Kay Lousberg) — modular sci-fi base for the scifi
// scene. All gltfs live flat in one folder and share spacebits_texture.png.
const KAYKIT_SPACE =
  'https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-Space-Base-Bits-1.0/main/addons/kaykit_space_base_bits/Assets/gltf';
const SCIFI_MODELS = [
  'basemodule_A', 'basemodule_B', 'basemodule_C', 'basemodule_D', 'basemodule_E', 'basemodule_garage',
  'cargodepot_A', 'cargodepot_B', 'cargodepot_C', 'structure_low',
  'structure_tall', 'drill_structure', 'windturbine_tall', 'windturbine_low',
  'landingpad_large', 'landingpad_small', 'lander_A', 'lander_B',
  'containers_A', 'containers_B', 'containers_C', 'cargo_A', 'cargo_B', 'cargo_A_stacked', 'solarpanel',
  'rock_A', 'rock_B', 'rocks_A', 'rocks_B',
];

// KayKit City Builder Bits (CC0, Kay Lousberg) — residential street for the sim
// scene: houses, road tiles, cars, street props. Flat folder, shared atlas.
const KAYKIT_CITY =
  'https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-City-Builder-Bits-1.0/main/addons/kaykit_city_builder_bits/Assets/gltf';
const SIM_MODELS = [
  'building_A', 'building_B', 'building_C', 'building_D', 'building_E', 'building_F', 'building_G', 'building_H',
  'car_sedan', 'car_hatchback', 'car_stationwagon', 'car_taxi',
  'streetlight', 'bush', 'firehydrant', 'trafficlight_A',
];

const errors = [];
const credits = [];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url, outRel) {
  const outAbs = join(OUT, outRel);
  if (!FORCE && (await exists(outAbs))) {
    console.log(`  skip (exists) ${outRel}`);
    return true;
  }
  await mkdir(dirname(outAbs), { recursive: true });
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outAbs, buf);
  console.log(`  ok   ${outRel}  (${(buf.length / 1024).toFixed(0)} KB)`);
  return true;
}

async function fetchGlb(entry) {
  console.log(`[glb] ${entry.key}`);
  if (await download(entry.url, entry.out)) {
    credits.push(entry.credit);
    return entry.out;
  }
  if (entry.fallbackUrl && (await download(entry.fallbackUrl, entry.out))) {
    credits.push(entry.credit + ' [fallback url]');
    return entry.out;
  }
  errors.push(`${entry.key}: could not download (${entry.url})`);
  return null;
}

async function fetchFantasyKit() {
  console.log('[kit] fantasy (KayKit medieval buildings)');
  const out = [];
  // shared atlas once
  if (!(await download(KAYKIT_ATLAS, 'models/fantasy/hexagons_medieval.png'))) {
    errors.push('fantasy kit: atlas download failed');
    return out;
  }
  for (const [color, name] of [...FANTASY_BUILDINGS, FANTASY_LANDMARK]) {
    const gltfOk = await download(`${KAYKIT_HEX}/buildings/${color}/${name}.gltf`, `models/fantasy/${name}.gltf`);
    const binOk = await download(`${KAYKIT_HEX}/buildings/${color}/${name}.bin`, `models/fantasy/${name}.bin`);
    if (gltfOk && binOk) out.push(`/hero/models/fantasy/${name}.gltf`);
    else errors.push(`fantasy kit: ${name} download failed`);
  }
  for (const name of FANTASY_NATURE) {
    const gltfOk = await download(`${KAYKIT_HEX}/decoration/nature/${name}.gltf`, `models/fantasy/${name}.gltf`);
    const binOk = await download(`${KAYKIT_HEX}/decoration/nature/${name}.bin`, `models/fantasy/${name}.bin`);
    if (gltfOk && binOk) out.push(`/hero/models/fantasy/${name}.gltf`);
    else errors.push(`fantasy nature: ${name} download failed`);
  }
  for (const name of FANTASY_NEUTRAL) {
    const gltfOk = await download(`${KAYKIT_HEX}/buildings/neutral/${name}.gltf`, `models/fantasy/${name}.gltf`);
    const binOk = await download(`${KAYKIT_HEX}/buildings/neutral/${name}.bin`, `models/fantasy/${name}.bin`);
    if (gltfOk && binOk) out.push(`/hero/models/fantasy/${name}.gltf`);
    else errors.push(`fantasy neutral: ${name} download failed`);
  }
  if (out.length) credits.push('KayKit Medieval Hexagon Pack by Kay Lousberg (CC0)');
  return out;
}

async function fetchScifiKit() {
  console.log('[kit] scifi (KayKit Space Base Bits)');
  const out = [];
  if (!(await download(`${KAYKIT_SPACE}/spacebits_texture.png`, 'models/scifi/spacebits_texture.png'))) {
    errors.push('scifi kit: atlas download failed');
    return out;
  }
  for (const name of SCIFI_MODELS) {
    const gltfOk = await download(`${KAYKIT_SPACE}/${name}.gltf`, `models/scifi/${name}.gltf`);
    const binOk = await download(`${KAYKIT_SPACE}/${name}.bin`, `models/scifi/${name}.bin`);
    if (gltfOk && binOk) out.push(`/hero/models/scifi/${name}.gltf`);
    else errors.push(`scifi kit: ${name} download failed`);
  }
  if (out.length) credits.push('KayKit Space Base Bits by Kay Lousberg (CC0)');
  return out;
}

async function fetchSimKit() {
  console.log('[kit] sim (KayKit City Builder Bits)');
  const out = [];
  if (!(await download(`${KAYKIT_CITY}/citybits_texture.png`, 'models/sim/citybits_texture.png'))) {
    errors.push('sim kit: atlas download failed');
    return out;
  }
  for (const name of SIM_MODELS) {
    const gltfOk = await download(`${KAYKIT_CITY}/${name}.gltf`, `models/sim/${name}.gltf`);
    const binOk = await download(`${KAYKIT_CITY}/${name}.bin`, `models/sim/${name}.bin`);
    if (gltfOk && binOk) out.push(`/hero/models/sim/${name}.gltf`);
    else errors.push(`sim kit: ${name} download failed`);
  }
  if (out.length) credits.push('KayKit City Builder Bits by Kay Lousberg (CC0)');
  return out;
}

async function resolveHdrUrl(slug) {
  const res = await fetch(`https://api.polyhaven.com/files/${slug}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.hdri?.['1k']?.hdr?.url ?? null;
}

async function fetchHdri(entry) {
  console.log(`[hdri] ${entry.phase}`);
  const outRel = `hdri/${entry.phase}.hdr`;
  if (!FORCE && (await exists(join(OUT, outRel)))) {
    console.log(`  skip (exists) ${outRel}`);
    credits.push(`HDRI ${entry.phase}: ${entry.slug} by Poly Haven (CC0)`);
    return outRel;
  }
  for (const [slug, tag] of [
    [entry.slug, ''],
    [entry.fallback, ' [fallback]'],
  ]) {
    const url = await resolveHdrUrl(slug);
    if (url && (await download(url, outRel))) {
      credits.push(`HDRI ${entry.phase}: ${slug} by Poly Haven (CC0)${tag}`);
      return outRel;
    }
  }
  errors.push(`hdri ${entry.phase}: could not resolve/download (${entry.slug} / ${entry.fallback})`);
  return null;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const manifest = { character: null, creatures: {}, hdris: {}, models: {} };

  const ch = await fetchGlb(CHARACTER);
  manifest.character = ch ? `/hero/${ch}` : null;

  for (const c of CREATURES) {
    const p = await fetchGlb(c);
    if (p) manifest.creatures[c.key] = `/hero/${p}`;
  }

  for (const h of HDRIS) {
    const p = await fetchHdri(h);
    if (p) manifest.hdris[h.phase] = `/hero/${p}`;
  }

  manifest.models.fantasy = await fetchFantasyKit();
  manifest.models.scifi = await fetchScifiKit();
  manifest.models.sim = await fetchSimKit();

  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('wrote manifest.json');

  const licenses =
    `# Hero cinematic assets — licenses\n\n` +
    `All third-party assets below are **CC0** (public domain). Remaining genre dressing\n` +
    `(trees, rocks, cacti, sci-fi modules) is generated procedurally at runtime.\n\n` +
    credits.map((c) => `- ${c}`).join('\n') +
    `\n`;
  await writeFile(join(OUT, 'LICENSES.md'), licenses);
  console.log('wrote LICENSES.md');

  if (errors.length) {
    console.error('\nFAILED — missing assets:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('\nAll hero assets present.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
