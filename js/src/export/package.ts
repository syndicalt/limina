// Phase 8 EXPORT PACKAGE — the portable, browser-loadable form of a native-
// authored world. Three text files (no native bytes, the standing invariant):
//   manifest.json   — world id, versions, keyframe interval, tick/command counts,
//                      content-addressed asset refs.
//   log.jsonl       — the authoritative command stream (seed + skill + physics).
//   keyframes.jsonl — periodic body transforms so the browser replays motion
//                     without re-simulating physics (W0 contract).
// A browser runtime replayCommands(log) into a fresh world whose PhysicsOps are
// keyframe-driven, and renders via WebGPU.

import { LOG_VERSION, parseWorldLog, serializeWorldLog, type WorldCommand, type WorldLogMeta } from "../worldlog/log.ts";
import { parseKeyframes, serializeKeyframes, type Keyframe } from "../worldlog/keyframes.ts";
import { parseTiles, serializeTiles, type ParsedTile } from "../terrain/tilecache.ts";
import type { TerrainTile } from "../terrain/types.ts";

export const EXPORT_VERSION = 1;

export interface ExportAsset {
  id: string;
  path: string;
  /** sha256 content hash ("sha256:..."); integrity-checked on load. */
  hash: string;
}

export interface ExportManifest {
  kind: "limina.export";
  exportVersion: number;
  worldId: string;
  logVersion: number;
  keyframeInterval: number;
  ticks: number;
  commands: number;
  keyframes: number;
  /** Phase 9: count of content-addressed terrain tiles carried in tiles.jsonl.
   *  0 (and an absent tiles.jsonl) for a terrain-free world — back-compatible. */
  tiles: number;
  assets: ExportAsset[];
  createdAt: string;
}

/** The serialized export — exactly the files written to disk / served / cached.
 *  `tiles.jsonl` is the Phase 9 terrain artifact (empty string when no terrain). */
export interface ExportFiles {
  "manifest.json": string;
  "log.jsonl": string;
  "keyframes.jsonl": string;
  "tiles.jsonl": string;
}

export interface AssembleExportInput {
  worldId: string;
  meta: WorldLogMeta;
  commands: WorldCommand[];
  keyframes: Keyframe[];
  keyframeInterval: number;
  createdAt: string;
  assets?: ExportAsset[];
  /** Phase 9: the content-addressed terrain tiles to carry (e.g. TileCache.entries()). */
  tiles?: { key: string; hash: string; tile: TerrainTile }[];
}

/** Assemble the portable export files from a recorded session + its keyframes
 *  (+ optional terrain tiles). */
export function assembleExport(input: AssembleExportInput): ExportFiles {
  const tiles = input.tiles ?? [];
  const manifest: ExportManifest = {
    kind: "limina.export",
    exportVersion: EXPORT_VERSION,
    worldId: input.worldId,
    logVersion: input.meta.logVersion,
    keyframeInterval: input.keyframeInterval,
    ticks: input.meta.ticks,
    commands: input.commands.length,
    keyframes: input.keyframes.length,
    tiles: tiles.length,
    assets: input.assets ?? [],
    createdAt: input.createdAt,
  };
  return {
    "manifest.json": JSON.stringify(manifest, null, 2) + "\n",
    "log.jsonl": serializeWorldLog(input.meta, input.commands),
    "keyframes.jsonl": serializeKeyframes(input.keyframes),
    "tiles.jsonl": serializeTiles(tiles),
  };
}

export interface LoadedExport {
  manifest: ExportManifest;
  commands: WorldCommand[];
  keyframes: Keyframe[];
  /** Phase 9: the content-addressed terrain tiles (hash-verified on load). Empty
   *  for a terrain-free world. Feed these to a CachedTerrainSource for playback. */
  tiles: ParsedTile[];
}

/** Parse + validate an export package (the browser runtime entry point). Fails
 *  loudly on a bad kind / version / torn line rather than silently mis-loading.
 *  `tiles.jsonl` is optional for back-compat with pre-Phase-9 packages. */
export function loadExport(files: { "manifest.json": string; "log.jsonl": string; "keyframes.jsonl": string; "tiles.jsonl"?: string }): LoadedExport {
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(files["manifest.json"]) as ExportManifest;
  } catch (err) {
    throw new Error(`export: invalid manifest.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (manifest.kind !== "limina.export") throw new Error(`export: not a limina export (kind=${String(manifest.kind)})`);
  if (manifest.exportVersion !== EXPORT_VERSION) throw new Error(`export: unsupported exportVersion ${manifest.exportVersion} (expected ${EXPORT_VERSION})`);
  if (manifest.logVersion !== LOG_VERSION) throw new Error(`export: unsupported logVersion ${manifest.logVersion} (expected ${LOG_VERSION})`);
  const { commands } = parseWorldLog(files["log.jsonl"]);
  const keyframes = parseKeyframes(files["keyframes.jsonl"]);
  const tiles = parseTiles(files["tiles.jsonl"]);
  // Cross-check against the manifest so a cleanly-truncated log/keyframe/tile file
  // (whole lines lost — e.g. an interrupted write) fails loudly instead of
  // silently playing back a short, wrong world.
  if (commands.length !== manifest.commands) throw new Error(`export: command count mismatch (manifest ${manifest.commands}, parsed ${commands.length})`);
  if (keyframes.length !== manifest.keyframes) throw new Error(`export: keyframe count mismatch (manifest ${manifest.keyframes}, parsed ${keyframes.length})`);
  // `tiles` may be undefined in a pre-Phase-9 manifest; treat missing as 0.
  const manifestTiles = manifest.tiles ?? 0;
  if (tiles.length !== manifestTiles) throw new Error(`export: tile count mismatch (manifest ${manifestTiles}, parsed ${tiles.length})`);
  return { manifest, commands, keyframes, tiles };
}
