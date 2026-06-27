// Phase 11 — a content-addressed asset registry: the lookup layer over the host's
// op_read_asset (authoring) OR a package-carried asset bundle (replay). It mirrors
// the terrain TileCache (js/src/terrain/tilecache.ts): an asset id resolves to its
// GLTF bytes + a stable content hash, cached for the life of the session, with
// integrity verification.
//
// The determinism invariant is the same as the tile cache + the world log: the
// durable LOG records only the place REQUEST (assetId + transform + the committed
// content hash); the heavy asset BYTES are content-addressed and ride the export
// package's `assets.jsonl` (and, at authoring, the host's sandboxed asset root).
// A given assetId always resolves the same bytes -> the same content address, and
// the recorded hash PINS that identity across replay (a swapped asset fails loudly).

import { ops as defaultOps, type EngineOps } from "./engine.ts";

// Precomputed byte -> 2-hex-chars table so hashing a multi-MB glb is a single
// pass with no per-byte string formatting.
const HEX = (() => {
  const t = new Array<string>(256);
  for (let i = 0; i < 256; i++) t[i] = i.toString(16).padStart(2, "0");
  return t;
})();

/** Lower-case hex of a byte buffer (lossless, ASCII — safe to feed op_sha256). */
function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

/** A content address over an asset's raw bytes: "sha256:" + the host sha256 of a
 *  HEX ENCODING of the bytes. (op_sha256 takes a string; the hex injection is a
 *  lossless, deterministic, host-portable mapping of the bytes — exactly how
 *  tileContentHash hashes a tile's bytes-as-string.) Same bytes -> same address;
 *  any byte change -> a different address. A non-native host whose op_sha256
 *  returns "" yields the "sha256:" sentinel (callers skip the sync verify for it,
 *  mirroring the tile cache). */
export function assetContentHash(bytes: Uint8Array, ops: EngineOps = defaultOps): string {
  return "sha256:" + ops.op_sha256(bytesToHex(bytes));
}

/** A resolved asset: its id, raw bytes, and content address. */
export interface ResolvedAsset {
  assetId: string;
  bytes: Uint8Array;
  /** "sha256:..." content address of `bytes`. */
  hash: string;
}

/** A content-addressed asset bundle entry — id + assets/ path + hash + bytes. The
 *  unit the export package serializes (assets.jsonl) and a package-backed registry
 *  is built from. */
export interface AssetBundleEntry {
  id: string;
  path: string;
  hash: string;
  bytes: Uint8Array;
}

/** A content-addressed asset ref for the export manifest (id + path + hash; the
 *  bytes ride assets.jsonl, addressed by this hash). */
export interface AssetRef {
  id: string;
  path: string;
  hash: string;
}

/** A content-addressed store over the host's op_read_asset (authoring) or a
 *  package-carried bundle (replay): an asset id resolves to its bytes + a stable
 *  content hash, cached + integrity-checked for the life of the session. The
 *  single seam where "place by id" turns into real, verified bytes. */
export class AssetRegistry {
  private readonly cache = new Map<string, ResolvedAsset>();
  /** Ids whose bytes came from a package bundle (NOT the host asset root): resolve
   *  must NEVER fall back to op_read_asset for these — a replay whose package
   *  dropped a needed asset fails loudly rather than silently reading a host file. */
  private readonly packaged = new Set<string>();
  private readonly ops: EngineOps;

  constructor(ops: EngineOps = defaultOps) {
    this.ops = ops;
  }

  /** Build a registry pre-loaded from a package's asset bundle (the replay/browser
   *  path — NO op_read_asset). Each entry's bytes are integrity-checked against its
   *  stated hash on a real-sha256 host. */
  static fromBundle(entries: AssetBundleEntry[], ops: EngineOps = defaultOps): AssetRegistry {
    const reg = new AssetRegistry(ops);
    reg.loadBundle(entries);
    return reg;
  }

  /** Pre-load package-carried asset bytes (content-addressed). Verifies each
   *  entry's bytes against its stated hash (when the host sha256 is real) and pins
   *  the id as package-sourced so resolve() serves these bytes without ever
   *  touching the host asset root. */
  loadBundle(entries: AssetBundleEntry[]): void {
    for (const e of entries) {
      const hash = assetContentHash(e.bytes, this.ops);
      if (hash !== "sha256:" && hash !== e.hash) {
        throw new Error(`asset '${e.id}': bundle content hash mismatch (declared ${e.hash}, computed ${hash})`);
      }
      // Trust the declared hash as the content address (verified above when sha256
      // is real); a sentinel-only host carries the package's verified-at-authoring hash.
      this.cache.set(e.id, { assetId: e.id, bytes: e.bytes, hash: e.hash });
      this.packaged.add(e.id);
    }
  }

  /** Resolve an asset id -> bytes + content hash. A cache hit (or package-loaded
   *  entry) returns the same resolved asset; a miss reads the bytes from the host
   *  (op_read_asset), hashes them, caches, and returns. Same id -> same address. */
  resolve(assetId: string): ResolvedAsset {
    const hit = this.cache.get(assetId);
    if (hit !== undefined) return hit;
    if (this.packaged.has(assetId)) {
      // Should be unreachable (packaged ids are cached), but never silently fall
      // back to the host root for a package-sourced id.
      throw new Error(`asset '${assetId}': package-sourced but missing from the bundle`);
    }
    const bytes = this.ops.op_read_asset(assetId);
    const hash = assetContentHash(bytes, this.ops);
    const resolved: ResolvedAsset = { assetId, bytes, hash };
    this.cache.set(assetId, resolved);
    return resolved;
  }

  /** The content address of an asset id (resolving it if needed). */
  hashOf(assetId: string): string {
    return this.resolve(assetId).hash;
  }

  /** Whether `bytes` match `expectedHash` — the falsifiable integrity check the
   *  export round-trip uses to prove an asset was not swapped/corrupted. */
  verify(bytes: Uint8Array, expectedHash: string): boolean {
    return assetContentHash(bytes, this.ops) === expectedHash;
  }

  /** A content-addressed export ref for one resolved id (id + assets/ path + hash). */
  toRef(assetId: string): AssetRef {
    const r = this.resolve(assetId);
    return { id: assetId, path: `assets/${assetId}`, hash: r.hash };
  }

  /** Refs for every asset resolved this session, for the export manifest's
   *  content-addressed `assets` list. */
  refs(): AssetRef[] {
    return [...this.cache.keys()].map((id) => this.toRef(id));
  }

  /** The full content-addressed bundle (refs + bytes) for every resolved asset —
   *  what assembleExport serializes into assets.jsonl so the package is
   *  SELF-CONTAINED (replay loads these bytes, never the host asset root). */
  bundle(): AssetBundleEntry[] {
    return [...this.cache.values()].map((r) => ({ id: r.assetId, path: `assets/${r.assetId}`, hash: r.hash, bytes: r.bytes }));
  }

  get size(): number {
    return this.cache.size;
  }
}
