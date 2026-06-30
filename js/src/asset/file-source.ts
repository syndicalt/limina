// The FILE source — a glTF/GLB already on disk resolved as an AssetSource (types.ts: the
// "tests / offline" backend). No network, no generation: it maps a request to a path under the
// host's sandboxed asset root and returns those exact bytes. Useful offline (a curated library on
// disk), in tests (a known fixture), and as the deterministic floor under the cache — the bytes are
// a pure function of the path, so the same request resolves the same asset forever.
//
// Reads go through the host's `op_read_asset` (the SAME seam asset-registry.ts uses): it is sandboxed
// to `<cwd>/assets`, rejects absolute paths + `..` traversal + symlink escapes, and caps size. The
// constructor's `baseDir` is therefore a RELATIVE prefix WITHIN that root (e.g. "library/props"),
// never a host path — agents only ever name a relative asset id.

import { ops } from "../engine.ts";
import type { AssetRequest, AssetResult, AssetSource } from "./types.ts";

/** glb/gltf from the extension; defaults to glb (the common single-file binary form). */
function formatFromPath(path: string): "glb" | "gltf" {
  return path.toLowerCase().endsWith(".gltf") ? "gltf" : "glb";
}

/** Join a relative base prefix to a relative path, collapsing the separating slashes. Both parts stay
 *  relative (op_read_asset rejects absolute / `..`), so this only normalizes the join. */
function joinRel(base: string, rel: string): string {
  const b = base.replace(/^\/+|\/+$/g, "");
  const r = rel.replace(/^\/+/, "");
  return b ? `${b}/${r}` : r;
}

/** Map a request to its relative asset path: an explicit `params.path` string wins; otherwise the
 *  conventional `${kind}/${prompt ?? seed}.glb` (prompt names a curated file; seed is the fallback). */
function pathForRequest(req: AssetRequest): string {
  const explicit = req.params?.path;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return `${req.kind}/${req.prompt ?? req.seed}.glb`;
}

/** A glTF/GLB-on-disk AssetSource. Reads bytes (relative to `baseDir` within the host asset root) and
 *  returns them with `meta.source = "file"`. Throws a clear error when the file is missing. */
export class FileAssetSource implements AssetSource {
  readonly name = "file";

  /** @param baseDir relative prefix within the host asset root (default: the root itself). */
  constructor(private readonly baseDir = "") {}

  // async to satisfy the AssetSource contract; the host op_read_asset is synchronous (nothing to await).
  async generateAsset(req: AssetRequest): Promise<AssetResult> {
    const rel = joinRel(this.baseDir, pathForRequest(req));
    let bytes: Uint8Array;
    try {
      bytes = ops.op_read_asset(rel);
    } catch (e) {
      throw new Error(`FileAssetSource: cannot read asset '${rel}' (source=file): ${(e as Error).message}`);
    }
    return { format: formatFromPath(rel), bytes, meta: { source: this.name } };
  }
}
