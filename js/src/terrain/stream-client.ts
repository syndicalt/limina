// Map Phase 3.3 — CLIENT-SIDE terrain streaming for the LIVE viewport (runLive).
//
// THE VIEW/RECORD SPLIT (this module's determinism contract):
//   • RECORDED terrain state = the world.setTerrainSource / world.generateRegion /
//     world.streamFollow commands in the world log. Those mutate the AUTHORITATIVE
//     world (tile entities + colliders, server-side) and replay deterministically.
//   • THIS module is pure VIEW state: which tiles the LOCAL camera can currently
//     see. It follows the active camera, generates tiles by PURE MATH from the
//     already-bound terrain source (no fetch, no I/O — the map IR was resolved ONCE
//     at boot), and mounts/unmounts render meshes + local colliders through injected
//     callbacks. It NEVER invokes a skill, NEVER touches the EntityTable/ECS (no
//     entity slots per tile — MAX_ENTITIES is untouched), and NEVER writes to the
//     world log. Two clients looking at different places stream different windows
//     over the SAME recorded world; replay is unaffected either way.
//
// BUDGETED: update() mounts at most `maxLoadsPerUpdate` tiles per call (default 2)
// so a large diff (first fill, a teleport) amortizes across frames instead of
// hitching the render loop; the not-yet-mounted remainder waits in a pending queue
// drained NEAREST-FIRST, so the ground under the camera appears before the horizon.
// Unloads are cheap (dispose) and apply immediately. Deterministic: the same anchor
// sequence produces the same mount/unmount sequence (StreamFollower's set math plus
// a stable nearest-first tie-break).
//
// EXTERNAL OWNERSHIP: a tile the RECORDED world already covers (a generateRegion /
// streamFollow region tile, or an editable terrain.create slab footprint) must not
// be double-mounted by the view stream (coplanar z-fighting). `isExternal` marks
// such tiles handled-without-mounting; `reconcileExternal()` re-syncs after live
// authoring changes recorded ownership (a mid-session world.streamFollow).

import { StreamFollower, tileKey, type StreamFollowOptions, type TileCoord, type TileKey } from "./stream.ts";
import type { TerrainTile } from "./types.ts";

export interface ClientStreamOptions extends StreamFollowOptions {
  /** Max tiles GENERATED + MOUNTED per update() call (the per-frame budget so a big
   *  diff never hitches the render loop). Default 2. */
  maxLoadsPerUpdate?: number;
  /** Pure, synchronous tile generator (MapTerrainSource.generateTile — math over the
   *  rasterized master field; no fetch, no cache dependency). */
  getTile(coord: TileCoord): TerrainTile;
  /** Mount one tile (mesh + collider). Called at most `maxLoadsPerUpdate` times per update. */
  mount(key: TileKey, coord: TileCoord, tile: TerrainTile): void;
  /** Unmount a previously-mounted tile (dispose mesh, remove collider). */
  unmount(key: TileKey, coord: TileCoord): void;
  /** True when RECORDED world state already covers this tile (region tile / editable
   *  slab). Externally-owned tiles are treated as resident but never client-mounted. */
  isExternal?(coord: TileCoord): boolean;
}

export interface ClientStreamUpdate {
  /** Tiles mounted THIS update (≤ maxLoadsPerUpdate). */
  mounted: number;
  /** Tiles unmounted THIS update. */
  unmounted: number;
  /** Tiles still queued for a later update (inside the window, not yet mounted). */
  pending: number;
  /** Client-mounted tiles currently resident. */
  resident: number;
}

export class ClientTerrainStream {
  private readonly follower: StreamFollower;
  private readonly getTile: (coord: TileCoord) => TerrainTile;
  private readonly mountCb: (key: TileKey, coord: TileCoord, tile: TerrainTile) => void;
  private readonly unmountCb: (key: TileKey, coord: TileCoord) => void;
  private readonly isExternal?: (coord: TileCoord) => boolean;
  private readonly budget: number;
  /** Client-mounted tiles (mesh + collider live). */
  private readonly mounted = new Map<TileKey, TileCoord>();
  /** In-window tiles the RECORDED world owns (handled; never client-mounted). */
  private readonly external = new Map<TileKey, TileCoord>();
  /** In-window tiles awaiting a budget slot (drained nearest-to-anchor first). */
  private readonly pending = new Map<TileKey, TileCoord>();
  private cleared = false;

  constructor(opts: ClientStreamOptions) {
    this.follower = new StreamFollower(opts);
    this.getTile = opts.getTile;
    this.mountCb = opts.mount;
    this.unmountCb = opts.unmount;
    this.isExternal = opts.isExternal;
    this.budget = Math.max(1, Math.floor(opts.maxLoadsPerUpdate ?? 2));
  }

  /** Keys of the client-mounted tiles (introspection / gates / editor debug). */
  mountedKeys(): Set<TileKey> {
    return new Set(this.mounted.keys());
  }

  pendingCount(): number {
    return this.pending.size;
  }

  externalCount(): number {
    return this.external.size;
  }

  /** Advance the stream to a new anchor WORLD position (the camera), applying the
   *  load/unload diff within the per-update mount budget. */
  update(anchorX: number, anchorZ: number): ClientStreamUpdate {
    if (this.cleared) return { mounted: 0, unmounted: 0, pending: 0, resident: this.mounted.size };
    const diff = this.follower.update(anchorX, anchorZ);
    // UNLOADS first (cheap, immediate): free the mesh/collider — or just forget a tile
    // that never mounted (still pending / externally owned).
    let unmounted = 0;
    for (const t of diff.unload) {
      const k = tileKey(t.tx, t.tz);
      this.pending.delete(k);
      this.external.delete(k);
      if (this.mounted.delete(k)) {
        this.unmountCb(k, t);
        unmounted++;
      }
    }
    // NEW in-window tiles queue up; the budget drain below decides how many mount now.
    for (const t of diff.load) {
      const k = tileKey(t.tx, t.tz);
      if (!this.mounted.has(k) && !this.external.has(k)) this.pending.set(k, t);
    }
    // Drain ≤ budget pending tiles, NEAREST to the anchor tile first (Chebyshev, with the
    // stream.ts (tz, tx) order as the deterministic tie-break). An externally-owned tile
    // costs no budget (no work done) — it just moves to the external set.
    const anchor = diff.anchor;
    let mounted = 0;
    while (mounted < this.budget && this.pending.size > 0) {
      let bestKey: TileKey | undefined;
      let bestCoord: TileCoord | undefined;
      let bestDist = Infinity;
      for (const [k, c] of this.pending) {
        const d = Math.max(Math.abs(c.tx - anchor.tx), Math.abs(c.tz - anchor.tz));
        if (d < bestDist || (d === bestDist && bestCoord !== undefined && (c.tz < bestCoord.tz || (c.tz === bestCoord.tz && c.tx < bestCoord.tx)))) {
          bestDist = d;
          bestKey = k;
          bestCoord = c;
        }
      }
      if (bestKey === undefined || bestCoord === undefined) break;
      this.pending.delete(bestKey);
      if (this.isExternal !== undefined && this.isExternal(bestCoord)) {
        this.external.set(bestKey, bestCoord);
        continue;
      }
      this.mountCb(bestKey, bestCoord, this.getTile(bestCoord));
      this.mounted.set(bestKey, bestCoord);
      mounted++;
    }
    return { mounted, unmounted, pending: this.pending.size, resident: this.mounted.size };
  }

  /** Re-sync against RECORDED ownership after live authoring changed it (a mid-session
   *  world.streamFollow applied in place): unmount client tiles a region now owns
   *  (no coplanar double-mount), and re-queue external tiles a region released. */
  reconcileExternal(): void {
    if (this.isExternal === undefined || this.cleared) return;
    for (const [k, c] of [...this.mounted]) {
      if (this.isExternal(c)) {
        this.mounted.delete(k);
        this.unmountCb(k, c);
        this.external.set(k, c);
      }
    }
    for (const [k, c] of [...this.external]) {
      if (!this.isExternal(c)) {
        this.external.delete(k);
        this.pending.set(k, c);
      }
    }
  }

  /** Terminal teardown (viewport stop/reboot): unmount everything. The instance is
   *  dead afterwards — a rebooted viewport constructs a fresh stream. */
  clear(): void {
    if (this.cleared) return;
    this.cleared = true;
    const errors: unknown[] = [];
    for (const [k, c] of this.mounted) {
      try { this.unmountCb(k, c); }
      catch (error) { errors.push(error); }
    }
    this.mounted.clear();
    this.pending.clear();
    this.external.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, `failed to unmount ${errors.length} client terrain tiles during teardown`);
    }
  }
}
