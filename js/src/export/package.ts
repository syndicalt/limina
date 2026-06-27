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
import { bytesToBase64, base64ToBytes } from "../worldlog/snapshot.ts";
import { assetContentHash, type AssetBundleEntry } from "../asset-registry.ts";
import type { EngineOps } from "../engine.ts";
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
 *  `tiles.jsonl` is the Phase 9 terrain artifact (empty string when no terrain).
 *  `assets.jsonl` is the Phase 11 content-addressed asset payload — the GLTF BYTES
 *  (base64) keyed by id + hash, so the package is SELF-CONTAINED and a recorded
 *  asset.place replays without any host asset root (empty string when no assets). */
export interface ExportFiles {
  "manifest.json": string;
  "log.jsonl": string;
  "keyframes.jsonl": string;
  "tiles.jsonl": string;
  "assets.jsonl": string;
}

export interface AssembleExportInput {
  worldId: string;
  meta: WorldLogMeta;
  commands: WorldCommand[];
  keyframes: Keyframe[];
  keyframeInterval: number;
  createdAt: string;
  /** Phase 11: the content-addressed asset bundle to carry (id + path + hash +
   *  BYTES, e.g. AssetRegistry.bundle()). The manifest records id/path/hash refs;
   *  the bytes ride assets.jsonl so the package is self-contained. */
  assets?: AssetBundleEntry[];
  /** Phase 9: the content-addressed terrain tiles to carry (e.g. TileCache.entries()). */
  tiles?: { key: string; hash: string; tile: TerrainTile }[];
}

/** One serialized asset line in assets.jsonl (ASCII JSON: id + hash + base64 bytes). */
interface SerializedAsset {
  id: string;
  hash: string;
  b64: string;
}

/** A parsed + hash-verified package asset (the replay/browser load form). */
export interface ParsedAsset {
  id: string;
  hash: string;
  bytes: Uint8Array;
}

/** Serialize the content-addressed asset bundle as JSONL (one asset per line:
 *  id + content hash + base64 bytes). Empty input -> empty string (no artifact). */
export function serializeAssets(entries: AssetBundleEntry[]): string {
  if (entries.length === 0) return "";
  return entries.map((e) => {
    const line: SerializedAsset = { id: e.id, hash: e.hash, b64: bytesToBase64(e.bytes) };
    return JSON.stringify(line);
  }).join("\n") + "\n";
}

/** Parse assets.jsonl back into bytes, re-verifying each asset's content hash (on
 *  a real-sha256 host) so a corrupted/torn artifact fails loudly rather than
 *  mis-loading a model. A non-native host whose op_sha256 returns "" keeps the
 *  package's verified-at-authoring hash (the bytes were verified when assembled). */
export function parseAssets(jsonl: string | undefined, ops?: EngineOps): ParsedAsset[] {
  const out: ParsedAsset[] = [];
  if (jsonl === undefined || jsonl.length === 0) return out;
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    let raw: SerializedAsset;
    try {
      raw = JSON.parse(line) as SerializedAsset;
    } catch (err) {
      throw new Error(`assets: invalid JSON on line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof raw.id !== "string" || typeof raw.hash !== "string" || typeof raw.b64 !== "string") {
      throw new Error(`assets: malformed asset on line ${i + 1}`);
    }
    const bytes = base64ToBytes(raw.b64);
    const hash = assetContentHash(bytes, ops);
    if (hash !== "sha256:" && hash !== raw.hash) {
      throw new Error(`assets: content hash mismatch on line ${i + 1} (stored ${raw.hash}, computed ${hash})`);
    }
    out.push({ id: raw.id, hash: raw.hash, bytes });
  }
  return out;
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
    "assets.jsonl": serializeAssets(input.assets ?? []),
  };
}

export interface LoadedExport {
  manifest: ExportManifest;
  commands: WorldCommand[];
  keyframes: Keyframe[];
  /** Phase 9: the content-addressed terrain tiles (hash-verified on load). Empty
   *  for a terrain-free world. Feed these to a CachedTerrainSource for playback. */
  tiles: ParsedTile[];
  /** Phase 11: the content-addressed asset bytes (hash-verified on load + cross-
   *  checked against the manifest refs). Empty for an asset-free world. Feed these
   *  to AssetRegistry.fromBundle so a replayed asset.place loads from the PACKAGE,
   *  never the host asset root. */
  assets: ParsedAsset[];
}

/** Parse + validate an export package (the browser runtime entry point). Fails
 *  loudly on a bad kind / version / torn line rather than silently mis-loading.
 *  `tiles.jsonl` / `assets.jsonl` are optional for back-compat with pre-Phase-9/11
 *  packages. `ops` supplies the host sha256 used to re-verify asset bytes. */
export function loadExport(
  files: { "manifest.json": string; "log.jsonl": string; "keyframes.jsonl": string; "tiles.jsonl"?: string; "assets.jsonl"?: string },
  ops?: EngineOps,
): LoadedExport {
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
  const assets = parseAssets(files["assets.jsonl"], ops);
  // Cross-check against the manifest so a cleanly-truncated log/keyframe/tile/asset
  // file (whole lines lost — e.g. an interrupted write) fails loudly instead of
  // silently playing back a short, wrong world.
  if (commands.length !== manifest.commands) throw new Error(`export: command count mismatch (manifest ${manifest.commands}, parsed ${commands.length})`);
  if (keyframes.length !== manifest.keyframes) throw new Error(`export: keyframe count mismatch (manifest ${manifest.keyframes}, parsed ${keyframes.length})`);
  // `tiles` may be undefined in a pre-Phase-9 manifest; treat missing as 0.
  const manifestTiles = manifest.tiles ?? 0;
  if (tiles.length !== manifestTiles) throw new Error(`export: tile count mismatch (manifest ${manifestTiles}, parsed ${tiles.length})`);
  // Assets: count must match the manifest refs, and each shipped asset's content
  // address must equal the ref the manifest committed (a swapped/torn assets.jsonl
  // fails loudly). The manifest ref hash is the authored, log-committed identity.
  const manifestAssets = manifest.assets ?? [];
  if (assets.length !== manifestAssets.length) throw new Error(`export: asset count mismatch (manifest ${manifestAssets.length}, parsed ${assets.length})`);
  for (const a of assets) {
    const ref = manifestAssets.find((r) => r.id === a.id);
    if (ref === undefined) throw new Error(`export: asset '${a.id}' carried in assets.jsonl but absent from the manifest`);
    if (ref.hash !== a.hash) throw new Error(`export: asset '${a.id}' hash disagrees (manifest ${ref.hash}, assets.jsonl ${a.hash})`);
  }
  return { manifest, commands, keyframes, tiles, assets };
}

/** The content-addressed bundle entries from a loaded export, for AssetRegistry.
 *  fromBundle — the package-backed replay/browser registry (no host asset root). */
export function exportAssetBundle(loaded: LoadedExport): AssetBundleEntry[] {
  return loaded.assets.map((a) => ({ id: a.id, path: `assets/${a.id}`, hash: a.hash, bytes: a.bytes }));
}

/** Re-verify each manifest asset against its shipped bytes — the content-addressed
 *  integrity check that closes the export round-trip for placed assets. `readBytes`
 *  resolves an asset id -> the bytes carried for it (e.g. the package bundle or
 *  op_read_asset). Recomputes the content hash and THROWS on the first mismatch (a
 *  swapped/corrupted asset fails loudly rather than loading a wrong model); returns
 *  the count of verified assets. A non-native host whose op_sha256 returns the
 *  "sha256:" sentinel is skipped (mirrors tile loading). */
export function verifyExportAssets(
  manifest: ExportManifest,
  readBytes: (id: string) => Uint8Array,
  ops?: EngineOps,
): number {
  let verified = 0;
  for (const asset of manifest.assets) {
    const hash = assetContentHash(readBytes(asset.id), ops);
    if (hash === "sha256:") continue; // non-native host stub — skip sync verify
    if (hash !== asset.hash) {
      throw new Error(`export: asset '${asset.id}' content hash mismatch (manifest ${asset.hash}, computed ${hash})`);
    }
    verified++;
  }
  return verified;
}
