// tools/derived/mount-cost-measure.mjs — C2 measurement harness (D4).
//
// Measures the per-phase MAIN-THREAD cost of derived-revision mounting — the work
// `activateDerivedRevision` (js/src/browser-entry.ts) runs under the
// `derivedActivationInProgress` gate — for a full radius-7 (15x15, 225-chunk)
// residency window, in real chromium on hardware GL, under 4x CDP CPU throttle
// (Emulation.setCPUThrottlingRate). Phases mirror the permanent
// performance.mark/measure instrumentation (DERIVED_MOUNT_PHASE in
// js/src/browser/derived-runtime-render-candidate.ts) and use the SAME mark names:
//
//   construct     new DetachedDerivedRenderCandidate (225 terrain meshes + surface
//                 materials + world overview + water mounts)
//   stagePrep     DerivedSimStageSnapshot transfer prep (heights copies + literal)
//   stagePost     postMessage serialize/transfer of the stage snapshot (worker stub)
//   heightfields  op_physics_add_heightfield x225 (wasm Rapier, the live backend)
//   sceneAdd      scene.add(candidate.root)
//
// Pre-declared decision rule (plans/review-remediation-architectural.md, C2):
// residual main-thread mounting under ~50 ms => C2 (frame-budgeted sliced
// mounting) closes as unnecessary; over => implement ~8 ms slices.
//
// Honest scope limits, by design:
//   - populationPlan is null in the fixture, so biome-population mounting
//     (authenticated content transport) is EXCLUDED — this measures exactly the
//     residency-window mounting C2 was scoped to.
//   - Snapshot verification is measured but excluded from the verdict: C1 moved
//     it off the main thread (here it runs inline, unthrottled, before the runs).
//   - First-frame GPU material compile/upload after activation is render-loop
//     work, not gated mounting, and is out of scope.
//
// The harness serves everything itself (esbuild bundle + static server on an
// ephemeral port) and never touches the live editor host (8787/5173). It REFUSES
// to run while an editor browser client is attached (established connections on
// 8787/5173) — heavy headless GPU work has OOM-killed a live editor's WebGPU
// context before.
//
// Usage: node tools/derived/mount-cost-measure.mjs [--runs N] [--throttle R] [--json out.json]
//   exit 0 = measured · 2 = no chromium/playwright-core · 3 = editor client attached

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolvePwc, resolveChrome } from "../_pw-resolve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const runs = Math.max(1, Number(argOf("--runs", "5")));
const throttle = Math.max(1, Number(argOf("--throttle", "4")));
const jsonOut = argOf("--json", null);
// "sliced" measures the live path (createWithFrameBudget, C2); "sync" measures the
// monolithic constructor (the pre-C2 behavior) for before/after comparison.
const mode = argOf("--mode", "sliced");
if (mode !== "sliced" && mode !== "sync") { console.error("mount-cost-measure: --mode must be sliced|sync"); process.exit(1); }
// Optional slice-budget override (ms) forwarded to createWithFrameBudget in sliced mode.
const budgetMs = argOf("--budget", null);

// ── Refuse to run while a live editor browser client is attached (failure mode #14).
//    Our own sockets never touch 8787/5173 (server binds an ephemeral port).
try {
  const ss = execFileSync("ss", ["-tn"], { encoding: "utf8" });
  const attached = ss.split("\n").filter((line) => /:(8787|5173)\b/.test(line) && /ESTAB/.test(line));
  if (attached.length > 0) {
    console.error("mount-cost-measure: REFUSING to run — editor client(s) attached on 8787/5173:");
    for (const line of attached) console.error("  " + line.trim());
    console.error("Close the editor tab (or run later) and retry.");
    process.exit(3);
  }
} catch (error) {
  if (error?.status !== undefined && error.stdout !== undefined) throw error;
  console.error("mount-cost-measure: could not check for attached editor clients (ss missing?); proceeding is NOT safe — aborting.");
  process.exit(3);
}

// ── Resolve chromium + playwright-core (js/node_modules first, then the shared resolver).
let pwc = null;
try { pwc = require.resolve("playwright-core", { paths: [join(repo, "js")] }); } catch { pwc = resolvePwc(); }
const chrome = resolveChrome();
if (!pwc || !chrome) {
  console.error("mount-cost-measure: no chromium/playwright-core (set CHROME_BIN / PWC_PATH)");
  process.exit(2);
}
const { chromium } = require(pwc);

// ── Page entry: fixture builders generalized from js/test/p_derived_runtime_render_candidate.ts
//    (its radius-7 budget fixture), at production fidelity: 33x33 terrain samples
//    (MAP_FIELD_CHUNK_SAMPLES) and 256px surface composites (SURFACE_COMPOSITE_LIMITS.interior,
//    the value tools/world/build-temperate-fidelity-surfaces.ts compiles). No template
//    literals below (the source is embedded in this string).
const pageEntry = String.raw`
import * as THREE from "@limina/three";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  DetachedDerivedRenderCandidate,
  DERIVED_MOUNT_FRAME_BUDGET_MS,
  DERIVED_MOUNT_PHASE,
  beginDerivedMountPhase,
  endDerivedMountPhase,
  parseTransferredDerivedRuntimeSnapshot,
} from "@limina/src/browser/derived-runtime-render-candidate.ts";
import { DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA } from "@limina/src/browser/derived-runtime-verify.ts";
import { DERIVED_TERRAIN_RESIDENCY_SCHEMA } from "@limina/src/browser/derived-terrain-residency.ts";
import { WasmRapierPhysics } from "@limina/src/browser/wasm-rapier-physics.ts";
import { createTerrainGridSpec, terrainChunkId } from "@limina/src/terrain/grid.mjs";
import {
  DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  createDerivedRevisionManifest,
  derivedArtifactContentHash,
} from "@limina/src/world/compiler/manifest.mjs";
import {
  TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
  decodeTerrainChunkArtifact,
  encodeTerrainChunkArtifact,
} from "@limina/src/world/compiler/terrain-artifact.mjs";
import {
  WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE,
  WORLD_OVERVIEW_ARTIFACT_TYPE,
  decodeWorldOverviewArtifact,
  encodeWorldOverviewArtifact,
} from "@limina/src/world/compiler/world-overview-artifact.mjs";
import {
  NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE,
  NAVIGATION_INDEX_ARTIFACT_TYPE,
  encodeNavigationIndexArtifact,
} from "@limina/src/world/compiler/navigation-index-artifact.mjs";
import {
  BIOME_FIELD_ARTIFACT_MEDIA_TYPE,
  BIOME_FIELD_ARTIFACT_TYPE,
  encodeBiomeFieldArtifact,
} from "@limina/src/world/compiler/biome-field-artifact.mjs";
import { compileBiomeField } from "@limina/src/world/biome-field.mjs";
import { BIOME_LIBRARY_V1 } from "@limina/src/world/biome-library-v1.mjs";
import {
  HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_FIELD_ARTIFACT_TYPE,
  decodeHydrologyFieldArtifact,
  encodeHydrologyFieldArtifact,
} from "@limina/src/world/hydrology-artifact.mjs";
import { createHydrologyTopology } from "@limina/src/world/hydrology-topology.mjs";
import {
  HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
  encodeHydrologyWaterArtifact,
} from "@limina/src/world/hydrology-water-artifact.mjs";
import { HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA } from "@limina/src/world/hydrology-water-topology.mjs";
import { prepareGeneratedWaterFieldInput } from "@limina/src/world/water-field.mjs";
import {
  SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE,
  SURFACE_COMPOSITE_ARTIFACT_TYPE,
  encodeSurfaceCompositeArtifact,
} from "@limina/src/world/compiler/surface-composite-artifact.mjs";
import {
  SURFACE_COMPOSITE_POLICY_VERSION,
  SURFACE_COMPOSITE_TILE_SCHEMA,
} from "@limina/src/world/surface-composite-tile.mjs";

const report = (state, extra) => {
  window.__fixtureState = state;
  if (extra !== undefined) window.__fixtureInfo = extra;
};
const fail = (error) => {
  console.error("HARNESS FAIL:", error && error.stack || error);
  window.__fixtureError = String(error && error.message || error);
  report("failed");
};

const hash = (label) => derivedArtifactContentHash(new TextEncoder().encode(label));
const FAR = 9000000;
const RADIUS = 7;
const SIDE = RADIUS * 2 + 1;           // 15
const CHUNK_M = 64;
const SAMPLES = 33;                     // MAP_FIELD_CHUNK_SAMPLES (production)
const SURFACE_TOTAL = 256;              // SURFACE_COMPOSITE_LIMITS.interior (production), gutter 0
const graphHash = hash("graph");
const grid = createTerrainGridSpec({ gridId: "mount-cost.radius7", origin: [FAR, FAR], chunkSizeM: CHUNK_M, defaultSamples: SAMPLES });

function terrain(tx, tz) {
  const cells = SAMPLES * SAMPLES;
  const heights = new Float32Array(cells);
  for (let r = 0; r < SAMPLES; r++) {
    for (let c = 0; c < SAMPLES; c++) {
      heights[r * SAMPLES + c] = 0.5 + 0.35 * Math.sin((tx * SAMPLES + c) * 0.31) * Math.cos((tz * SAMPLES + r) * 0.27);
    }
  }
  const climate = new Float32Array(cells * 3);
  const blight = new Float32Array(cells);
  for (let index = 0; index < cells; index++) {
    climate[index * 3] = -8 + (index % 32);
    climate[index * 3 + 1] = 200 + (index % 16) * 40;
    climate[index * 3 + 2] = index % 7;
    blight[index] = (index % 9) / 8;
  }
  const bytes = encodeTerrainChunkArtifact({
    nrows: SAMPLES,
    ncols: SAMPLES,
    origin: [FAR + (tx + 0.5) * CHUNK_M, 100, FAR + (tz + 0.5) * CHUNK_M],
    scale: [CHUNK_M, 10, CHUNK_M],
    heights,
    paintMat: new Uint8Array(cells).fill(2),
    paintW: new Float32Array(cells).fill(0.5),
    climate,
    climateChannels: 3,
    blight,
  });
  return {
    bytes,
    descriptor: {
      artifactType: "terrain-chunk/v1",
      contentHash: derivedArtifactContentHash(bytes),
      byteLength: bytes.byteLength,
      mediaType: TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
    },
  };
}

function surface(tx, tz, terrainHash, biomeFieldHash, packHash) {
  const total = SURFACE_TOTAL;
  const pixels = total * total;
  const albedo = new Uint8Array(pixels * 4);
  const normal = new Uint8Array(pixels * 4);
  const orm = new Uint8Array(pixels * 4);
  for (let offset = 0; offset < pixels * 4; offset += 4) {
    albedo[offset] = (72 + tx * 3 + (offset >> 6)) & 0xff;
    albedo[offset + 1] = (96 + tz * 3) & 0xff;
    albedo[offset + 2] = 64;
    albedo[offset + 3] = 255;
    normal[offset] = 128; normal[offset + 1] = 128; normal[offset + 2] = 255; normal[offset + 3] = 255;
    orm[offset] = 255; orm[offset + 1] = 192; orm[offset + 2] = 0; orm[offset + 3] = 255;
  }
  const decoded = {
    schema: SURFACE_COMPOSITE_TILE_SCHEMA,
    source: { biomeFieldHash, biomePackHash: packHash, terrainChunkHash: terrainHash, policyVersion: SURFACE_COMPOSITE_POLICY_VERSION },
    coord: { tx, tz, lod: 0 },
    placement: { origin: [FAR + tx * CHUNK_M, FAR + tz * CHUNK_M], sizeM: CHUNK_M, featureOrigin: [FAR, FAR] },
    resolution: { interior: total, gutter: 0, total },
    maps: {
      albedo: { data: albedo, contentHash: derivedArtifactContentHash(albedo), colorSpace: "srgb" },
      normal: { data: normal, contentHash: derivedArtifactContentHash(normal), colorSpace: "none", convention: "opengl-y-plus" },
      orm: { data: orm, contentHash: derivedArtifactContentHash(orm), colorSpace: "none", channels: "ao-roughness-metalness-grass-density" },
    },
    edgeHashes: { north: hash("north-" + tx + "-" + tz), east: hash("east-" + tx + "-" + tz), south: hash("south-" + tx + "-" + tz), west: hash("west-" + tx + "-" + tz) },
    diagnostics: { roles: 1, runtimeTextureSamples: 3, outputBytes: pixels * 4 * 3 },
  };
  const bytes = encodeSurfaceCompositeArtifact(decoded);
  return {
    decoded,
    descriptor: {
      artifactType: SURFACE_COMPOSITE_ARTIFACT_TYPE,
      contentHash: derivedArtifactContentHash(bytes),
      byteLength: bytes.byteLength,
      mediaType: SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE,
    },
  };
}

function buildFixture() {
  // Globals (biome field + hydrology + water + navigation + overview), sized like
  // the p_derived_runtime_render_candidate fixtures.
  const biomeFieldSource = compileBiomeField({
    pack: BIOME_LIBRARY_V1,
    grid: { origin: [FAR, FAR], rows: 2, cols: 2, cellSizeM: CHUNK_M },
    samples: {
      temperatureC: new Float32Array([12, 18, -8, 4]),
      moisture01: new Float32Array([0.6, 0.2, 0.8, 0.4]),
      elevationM: new Float32Array([100, 120, 180, 140]),
      slope01: new Float32Array([0.1, 0.2, 0.4, 0.3]),
      waterDistanceM: new Float32Array([10, 40, 80, 20]),
    },
    influences: [],
    modifiers: [],
    topN: 4,
    climateFeather: { temperatureC: 6, moisture01: 0.2 },
  });
  const biomeFieldBytes = encodeBiomeFieldArtifact(biomeFieldSource);
  const biomeFieldDescriptor = {
    artifactType: BIOME_FIELD_ARTIFACT_TYPE,
    contentHash: derivedArtifactContentHash(biomeFieldBytes),
    byteLength: biomeFieldBytes.byteLength,
    mediaType: BIOME_FIELD_ARTIFACT_MEDIA_TYPE,
  };
  const fieldTopology = createHydrologyTopology({
    rows: 16, cols: 16,
    heightsM: new Float64Array(16 * 16).fill(100),
    cellSizeM: 1, seaLevelM: 90, precipitationMmPerYear: 800,
  });
  const fieldBytes = encodeHydrologyFieldArtifact(fieldTopology, { originX: FAR, originZ: FAR });
  const fieldDescriptor = {
    artifactType: HYDROLOGY_FIELD_ARTIFACT_TYPE,
    contentHash: derivedArtifactContentHash(fieldBytes),
    byteLength: fieldBytes.byteLength,
    mediaType: HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
  };
  const waterBindings = Object.freeze({
    hydrologyFieldContentHash: fieldDescriptor.contentHash,
    recipeHash: hash("recipe"),
    erosionStageKey: hash("erosion"),
    compilerGraphHash: graphHash,
  });
  const waterBytes = encodeHydrologyWaterArtifact({
    schema: HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
    version: 1,
    placement: { originX: FAR, originZ: FAR },
    rows: 16, cols: 16, cellSizeM: 1,
    basins: [{
      id: "gen-b-6-5", kind: "lake", spillLevelM: 108, maxDepthM: 4, areaM2: 100, cellCount: 100,
      seedCell: 5, spillInsideCell: 5, spillOutsideCell: 6, spillOutsideDrainageRank: 6,
      footprint: { points: [[FAR, FAR], [FAR + 10, FAR], [FAR + 10, FAR + 10], [FAR, FAR + 10]] },
    }],
    reaches: [],
    diagnostics: {},
  }, waterBindings);
  const waterDescriptor = {
    artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE,
    contentHash: derivedArtifactContentHash(waterBytes),
    byteLength: waterBytes.byteLength,
    mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  };
  const preparedWater = prepareGeneratedWaterFieldInput({ bytes: waterBytes, descriptor: waterDescriptor, expectedBindings: waterBindings });
  const navigationBytes = encodeNavigationIndexArtifact({
    worldBounds: { minX: FAR - 512, minZ: FAR - 512, maxX: FAR + 25600, maxZ: FAR + 25600 },
    entries: [{
      designRef: { schema: "limina.atlas-design-ref/v1", mapId: "primary", kind: "place", id: "old-mill" },
      position: [FAR + 320, FAR + 640], radiusM: 24, label: "Old Mill", kind: "village", searchKeys: ["old mill", "mill"],
    }],
  });
  const navigationDescriptor = {
    artifactType: NAVIGATION_INDEX_ARTIFACT_TYPE,
    contentHash: derivedArtifactContentHash(navigationBytes),
    byteLength: navigationBytes.byteLength,
    mediaType: NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE,
  };
  const overviewCells = 129 * 129;
  const overviewBytes = encodeWorldOverviewArtifact({
    rows: 129, cols: 129, origin: [FAR - 12800, FAR - 12800], stepM: 200,
    heights: new Float32Array(overviewCells).fill(100),
    paintMaterial: new Uint8Array(overviewCells).fill(2),
    paintWeight: new Uint8Array(overviewCells).fill(128),
  });
  const overviewDescriptor = {
    artifactType: WORLD_OVERVIEW_ARTIFACT_TYPE,
    contentHash: derivedArtifactContentHash(overviewBytes),
    byteLength: overviewBytes.byteLength,
    mediaType: WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE,
  };

  // 15x15 chunks at radius 7 around anchor (0,0), each with a production-resolution
  // surface composite bound to its terrain artifact.
  const packHash = hash("mount-cost-runtime-pack");
  const coords = [];
  for (let tz = -RADIUS; tz <= RADIUS; tz++) for (let tx = -RADIUS; tx <= RADIUS; tx++) coords.push({ tx, tz });
  const built = coords.map(({ tx, tz }) => {
    const t = terrain(tx, tz);
    const s = surface(tx, tz, t.descriptor.contentHash, biomeFieldDescriptor.contentHash, packHash);
    return {
      tx, tz,
      chunk: {
        chunkId: terrainChunkId(grid.gridId, 0, tx, tz),
        gridId: grid.gridId, lod: 0, tx, tz,
        topologyHash: hash("topology-" + tx + "-" + tz),
        sourceSliceHashes: [],
        artifacts: [s.descriptor, t.descriptor],
      },
      terrain: t,
      surface: s,
    };
  });
  built.sort((left, right) => left.chunk.chunkId < right.chunk.chunkId ? -1 : left.chunk.chunkId > right.chunk.chunkId ? 1 : 0);
  const manifest = createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
    projectId: "mount-cost", branchId: "main",
    source: {
      revision: 12, headHash: hash("head"),
      contentRefs: [{ refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "maps/mount-cost.mapdoc.json", contentHash: hash("map") }],
    },
    compiler: { version: "1.2.0", configHash: hash("config"), graphHash, snapshotHash: hash("snapshot") },
    grid,
    globalArtifacts: [biomeFieldDescriptor, fieldDescriptor, waterDescriptor, navigationDescriptor, overviewDescriptor],
    chunks: built.map((entry) => entry.chunk),
  });
  const snapshot = {
    schema: DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA,
    projectId: manifest.projectId,
    branchId: manifest.branchId,
    manifestHash: manifest.manifestHash,
    source: manifest.source,
    manifest,
    residency: { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [FAR + 32, FAR + 32], lod: 0, radius: RADIUS },
    chunks: built.map((entry) => ({
      chunkId: entry.chunk.chunkId,
      chunk: manifest.chunks.find((chunk) => chunk.chunkId === entry.chunk.chunkId),
      resource: {
        kind: "terrain-chunk/v1",
        decoded: decodeTerrainChunkArtifact(entry.terrain.bytes),
        surface: entry.surface.decoded,
        artifacts: { terrain: entry.terrain.descriptor, surface: entry.surface.descriptor },
      },
    })),
    globals: [
      { artifactType: BIOME_FIELD_ARTIFACT_TYPE, artifact: biomeFieldDescriptor, resource: { kind: BIOME_FIELD_ARTIFACT_TYPE, bytes: biomeFieldBytes } },
      { artifactType: HYDROLOGY_FIELD_ARTIFACT_TYPE, artifact: fieldDescriptor, resource: { kind: HYDROLOGY_FIELD_ARTIFACT_TYPE, decoded: decodeHydrologyFieldArtifact(fieldBytes) } },
      { artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE, artifact: waterDescriptor, resource: { kind: HYDROLOGY_WATER_ARTIFACT_TYPE, artifact: waterDescriptor, bytes: waterBytes, bindings: waterBindings, prepared: preparedWater } },
      { artifactType: NAVIGATION_INDEX_ARTIFACT_TYPE, artifact: navigationDescriptor, resource: { kind: NAVIGATION_INDEX_ARTIFACT_TYPE, bytes: navigationBytes } },
      { artifactType: WORLD_OVERVIEW_ARTIFACT_TYPE, artifact: overviewDescriptor, resource: { kind: WORLD_OVERVIEW_ARTIFACT_TYPE, decoded: decodeWorldOverviewArtifact(overviewBytes) } },
    ],
  };
  const surfaceBytes = built.reduce((sum, entry) => sum + entry.surface.descriptor.byteLength, 0);
  const terrainBytes = built.reduce((sum, entry) => sum + entry.terrain.descriptor.byteLength, 0);
  return { snapshot, stats: { chunks: built.length, surfaceBytes, terrainBytes } };
}

const stubWorker = new Worker(URL.createObjectURL(new Blob(
  ["onmessage = () => postMessage(0);"], { type: "text/javascript" },
)));
const stubRoundtrip = (message, transfer) => new Promise((resolveAck) => {
  stubWorker.onmessage = () => resolveAck();
  stubWorker.postMessage(message, transfer);
});

let verified = null;
let physics = null;
const scene = new THREE.Scene();

async function runOnce(mode) {
  // Task A mirrors the real activation task that runs from the verify-await
  // resume to the activation-pause await: construct + stage prep (+ post).
  // "sliced" is the live path (C2); the construct measure then reports ELAPSED
  // time including yields — the longtask ceiling is the number that matters.
  beginDerivedMountPhase("construct");
  const sliceMarks = [];
  const candidate = mode === "sync"
    ? new DetachedDerivedRenderCandidate(verified, { quality: "balanced" })
    : await DetachedDerivedRenderCandidate.createWithFrameBudget(verified, { quality: "balanced" },
        { frameBudgetMs: window.__frameBudgetMs, onSlice: () => sliceMarks.push(performance.now()) });
  endDerivedMountPhase("construct");
  beginDerivedMountPhase("stagePrep");
  const transfer = [];
  const terrainWindow = candidate.terrainWindow().map((entry) => {
    const heights = entry.tile.heights.slice();
    transfer.push(heights.buffer);
    return {
      key: entry.key, tx: entry.tx, tz: entry.tz,
      tile: {
        nrows: entry.tile.nrows, ncols: entry.tile.ncols,
        origin: [entry.tile.origin[0], entry.tile.origin[1], entry.tile.origin[2]],
        scale: [entry.tile.scale[0], entry.tile.scale[1], entry.tile.scale[2]],
        heights,
      },
    };
  });
  const generated = candidate.snapshot.generatedWater;
  const generatedBytes = generated === null ? undefined : generated.bytes.slice();
  if (generatedBytes !== undefined) transfer.push(generatedBytes.buffer);
  const stageSnapshot = {
    schema: "limina.derived-sim-stage/v1",
    projectId: candidate.snapshot.projectId,
    branchId: candidate.snapshot.branchId,
    source: candidate.snapshot.source,
    manifestHash: candidate.snapshot.manifestHash,
    grid: candidate.snapshot.manifest.grid,
    terrainWindow,
    ...(generated === null ? {} : { generatedWater: { artifact: generated.artifact, bytes: generatedBytes, bindings: generated.bindings } }),
  };
  endDerivedMountPhase("stagePrep");
  const postStart = performance.now();
  const ack = stubRoundtrip({ snapshot: stageSnapshot }, transfer);
  const stagePostMs = performance.now() - postStart;
  await ack;
  // Task B mirrors the real activation task from the stage ack to the commit
  // dispatch: heightfield colliders + scene attach.
  beginDerivedMountPhase("heightfields");
  const bodies = [];
  for (const entry of candidate.terrainWindow()) {
    const tile = entry.tile;
    bodies.push(physics.op_physics_add_heightfield(
      tile.origin[0], tile.origin[1], tile.origin[2], tile.nrows, tile.ncols,
      tile.scale[0], tile.scale[1], tile.scale[2], tile.heights,
    ));
  }
  endDerivedMountPhase("heightfields");
  candidate.setQuality("balanced");
  beginDerivedMountPhase("sceneAdd");
  scene.add(candidate.root);
  endDerivedMountPhase("sceneAdd");

  const phases = { stagePost: stagePostMs };
  const spans = { stagePost: [postStart, postStart + stagePostMs] };
  for (const [key, name] of Object.entries(DERIVED_MOUNT_PHASE)) {
    const entries = performance.getEntriesByName(name, "measure");
    if (entries.length > 0) {
      const entry = entries[entries.length - 1];
      phases[key] = entry.duration;
      spans[key] = [entry.startTime, entry.startTime + entry.duration];
    }
  }
  // Retire the candidate exactly as browser-entry does on revision replacement.
  const disposeStart = performance.now();
  scene.remove(candidate.root);
  for (const id of bodies) physics.op_physics_remove_body(id);
  candidate.dispose();
  spans.retire = [disposeStart, performance.now()];
  phases.spans = spans;
  phases.sliceMarks = sliceMarks;
  return phases;
}

window.__runMounts = async (count, mode) => {
  const longtasks = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longtasks.push({ startTime: entry.startTime, duration: entry.duration });
  });
  observer.observe({ type: "longtask", buffered: false });
  const results = [];
  for (let index = 0; index < count; index++) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
    const started = performance.now();
    const phases = await runOnce(mode);
    phases.wallMs = performance.now() - started;
    results.push(phases);
  }
  await new Promise((resolveTick) => setTimeout(resolveTick, 300));
  observer.disconnect();
  return { results, longtasks };
};

(async () => {
  try {
    const buildStart = performance.now();
    const { snapshot, stats } = buildFixture();
    const buildMs = performance.now() - buildStart;
    // Verification runs inline here (unthrottled, pre-measurement). In the live
    // path C1 moved it off the main thread; it is EXCLUDED from the C2 verdict.
    beginDerivedMountPhase("verifyAwait");
    const verifyStart = performance.now();
    verified = parseTransferredDerivedRuntimeSnapshot(snapshot);
    const verifyMs = performance.now() - verifyStart;
    endDerivedMountPhase("verifyAwait");
    physics = await WasmRapierPhysics.create(RAPIER, { gravityY: -9.81 });
    report("ready", { ...stats, buildMs, verifyInlineMs: verifyMs, populationPlan: verified.populationPlan === null ? "null (biome-population mounting excluded)" : "present" });
  } catch (error) {
    fail(error);
  }
})();
`;

// ── Bundle with esbuild (js/node_modules), alias @limina/* to absolute repo paths.
const work = mkdtempSync(join(tmpdir(), "limina-mount-cost-"));
const entryPath = join(work, "entry.mjs");
writeFileSync(entryPath, pageEntry);
writeFileSync(join(work, "index.html"), [
  "<!doctype html><meta charset=\"utf-8\"><title>derived mount cost</title>",
  "<body><script type=\"module\" src=\"./bundle.js\"></script></body>",
].join("\n"));
const esbuildBin = join(repo, "js", "node_modules", ".bin", "esbuild");
const bundle = spawnSync(esbuildBin, [
  entryPath,
  "--bundle",
  "--format=esm",
  "--outfile=" + join(work, "bundle.js"),
  "--alias:@limina/three=" + join(repo, "js", "build", "three.bundle.mjs"),
  "--alias:@limina/src=" + join(repo, "js", "src"),
  "--log-level=warning",
], { encoding: "utf8", env: { ...process.env, NODE_PATH: join(repo, "js", "node_modules") }, maxBuffer: 64 * 1024 * 1024 });
if (bundle.status !== 0) {
  console.error("mount-cost-measure: esbuild failed\n" + (bundle.stderr || bundle.stdout || ""));
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

// ── Ephemeral static server (never the editor's ports).
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
const server = createServer((req, res) => {
  let path = decodeURIComponent(req.url.split("?")[0]);
  if (path === "/") path = "/index.html";
  const file = join(work, "." + path);
  let body;
  try { body = readFileSync(file); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] || "application/octet-stream",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
  });
  res.end(body);
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  // Hardware GL flags per tools/shoot.mjs — never swiftshader.
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"],
});
let exitCode = 1;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") console.error("  [page]", message.text()); });
  page.on("pageerror", (error) => console.error("  [pageerror]", error.message));
  await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__fixtureState === "ready" || window.__fixtureState === "failed", null, { timeout: 600000, polling: 500 });
  const state = await page.evaluate(() => window.__fixtureState);
  if (state !== "ready") {
    console.error("mount-cost-measure: fixture failed: " + await page.evaluate(() => window.__fixtureError));
    process.exit(1);
  }
  const info = await page.evaluate(() => window.__fixtureInfo);
  console.log("fixture: " + info.chunks + " chunks, " + (info.surfaceBytes / 1048576).toFixed(1) + " MiB surfaces, "
    + (info.terrainBytes / 1048576).toFixed(1) + " MiB terrain; build " + info.buildMs.toFixed(0) + " ms, inline verify "
    + info.verifyInlineMs.toFixed(0) + " ms (off-thread in prod; excluded from verdict); populationPlan: " + info.populationPlan);

  if (budgetMs !== null) await page.evaluate((value) => { window.__frameBudgetMs = value; }, Number(budgetMs));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  console.log("cpu throttle: " + throttle + "x (CDP Emulation.setCPUThrottlingRate); runs: " + runs + "; mode: " + mode
    + (mode === "sliced" ? " (createWithFrameBudget — construct column is ELAPSED incl. yields; judge the longtask max)" : " (monolithic constructor, pre-C2)"));
  const { results, longtasks } = await page.evaluate(([count, runMode]) => window.__runMounts(count, runMode), [runs, mode]);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  const phaseKeys = ["construct", "stagePrep", "stagePost", "heightfields", "sceneAdd"];
  const fmt = (value) => value === undefined ? "  n/a" : value.toFixed(1).padStart(8);
  console.log("\nper-run phase durations (ms, main thread, " + throttle + "x throttle):");
  console.log(["run".padEnd(4), ...phaseKeys.map((key) => key.padStart(12)), "mountTotal".padStart(12), "wall".padStart(9)].join(""));
  const totals = [];
  results.forEach((phases, index) => {
    const total = phaseKeys.reduce((sum, key) => sum + (phases[key] ?? 0), 0);
    totals.push(total);
    console.log([String(index + 1).padEnd(4), ...phaseKeys.map((key) => (phases[key] ?? NaN).toFixed(1).padStart(12)), total.toFixed(1).padStart(12), (phases.wallMs ?? NaN).toFixed(0).padStart(9)].join(""));
  });
  const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
  const medians = Object.fromEntries(phaseKeys.map((key) => [key, median(results.map((phases) => phases[key] ?? 0))]));
  console.log(["med ".padEnd(4), ...phaseKeys.map((key) => medians[key].toFixed(1).padStart(12)), median(totals).toFixed(1).padStart(12), "".padStart(9)].join(""));
  const longtaskMax = longtasks.reduce((max, task) => Math.max(max, task.duration), 0);
  console.log("\nlongtasks during runs: " + longtasks.length + "; max " + longtaskMax.toFixed(1) + " ms"
    + (longtasks.length > 0 ? " (all: " + longtasks.map((task) => task.duration.toFixed(0)).join(", ") + ")" : ""));

  // In sliced mode the construct/total columns are elapsed time (yields included);
  // the decision metric is the longest uninterrupted main-thread task.
  const verdictOver = mode === "sliced" ? longtaskMax > 50 : (median(totals) > 50 || longtaskMax > 50);
  console.log("\nC2 decision rule (plans/review-remediation-architectural.md): residual main-thread mounting under ~50 ms => C2 unnecessary.");
  console.log("verdict (" + mode + "): median mount total " + median(totals).toFixed(1) + " ms, longtask max " + longtaskMax.toFixed(1) + " ms => "
    + (verdictOver ? "OVER threshold: mounting must be (further) frame-budgeted" : "UNDER threshold: longest mounting task within budget"));
  console.log("scope: verification off-thread (C1) excluded; biome-population mounting excluded (populationPlan null); first-frame GPU compile excluded (render loop, not gated mounting).");
  if (jsonOut) {
    writeFileSync(resolve(jsonOut), JSON.stringify({ mode, throttle, runs, fixture: info, results, longtasks, medians, medianTotal: median(totals), longtaskMax, verdictOver }, null, 2));
    console.log("json: " + resolve(jsonOut));
  }
  exitCode = 0;
} finally {
  await browser.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
