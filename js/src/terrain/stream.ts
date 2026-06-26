// Phase 9 / workstream D — LOD/stream bookkeeping for `world.streamFollow`.
//
// PURE set math: given an anchor (the agent/camera world position), a tile size,
// and a radius (in tiles), decide which tile coords should be RESIDENT, and — as
// the anchor moves — the precise LOAD / UNLOAD diff that keeps the resident window
// centered with no thrash and no gaps. No rendering, no physics: this just drives
// which tiles a follower generates/keeps/drops. The render mesh (mesh.ts) and the
// Rapier heightfield are applied/removed off the back of this diff.

export interface TileCoord {
  tx: number;
  tz: number;
}

/** "tx,tz" — stable string key for set membership / diffing. */
export type TileKey = string;

export function tileKey(tx: number, tz: number): TileKey {
  return `${tx},${tz}`;
}

export function parseTileKey(key: TileKey): TileCoord {
  const comma = key.indexOf(",");
  return { tx: Number(key.slice(0, comma)), tz: Number(key.slice(comma + 1)) };
}

/** Residency window shape around the anchor tile. */
export type StreamShape = "square" | "disc";

export interface StreamFollowOptions {
  /** World-space edge length of one tile (meters); the tile grid is axis-aligned. */
  tileSize: number;
  /** Residency radius in TILES (>= 0). square -> Chebyshev, disc -> Euclidean. */
  radius: number;
  /** Window shape. "square" = (2r+1)^2 block; "disc" = circle of tile-index radius r. */
  shape?: StreamShape;
  /** Extra keep-margin in tiles: load at `radius`, unload only beyond `radius+hysteresis`.
   *  Prevents thrash when the anchor jitters across a tile boundary. Default 0. */
  hysteresis?: number;
}

/** The diff produced by advancing the anchor. */
export interface StreamDiff {
  /** Tile coord the anchor now sits in. */
  anchor: TileCoord;
  /** Tiles to START generating/showing this step (were not resident, now are). */
  load: TileCoord[];
  /** Tiles to STOP / drop this step (were resident, now outside the keep window). */
  unload: TileCoord[];
  /** The full resident set after applying this diff. */
  resident: TileCoord[];
  /** True iff load or unload is non-empty. */
  changed: boolean;
}

/** World (x,z) -> the tile coord that contains it (rows->z, cols->x, like the mesh). */
export function worldToTile(x: number, z: number, tileSize: number): TileCoord {
  return { tx: Math.floor(x / tileSize), tz: Math.floor(z / tileSize) };
}

/** World-space center of tile (tx,tz). */
export function tileCenter(tx: number, tz: number, tileSize: number): [number, number] {
  return [(tx + 0.5) * tileSize, (tz + 0.5) * tileSize];
}

/** Is tile (tx,tz) inside the window of `radius` around (ax,az) for the given shape? */
function inWindow(dtx: number, dtz: number, radius: number, shape: StreamShape): boolean {
  if (shape === "disc") return dtx * dtx + dtz * dtz <= radius * radius;
  return Math.max(Math.abs(dtx), Math.abs(dtz)) <= radius; // square / Chebyshev
}

/**
 * PURE: the set of tiles that should be resident for an anchor tile + radius.
 * Returned in a stable order (tz-major, then tx) so callers/tests are deterministic.
 */
export function desiredTiles(anchor: TileCoord, radius: number, shape: StreamShape = "square"): TileCoord[] {
  if (!(radius >= 0)) throw new Error(`desiredTiles: radius must be >= 0 (got ${radius})`);
  const out: TileCoord[] = [];
  const r = Math.floor(radius);
  for (let dtz = -r; dtz <= r; dtz++) {
    for (let dtx = -r; dtx <= r; dtx++) {
      if (inWindow(dtx, dtz, radius, shape)) out.push({ tx: anchor.tx + dtx, tz: anchor.tz + dtz });
    }
  }
  return out;
}

/**
 * Stateful follower: tracks the resident tile set and emits load/unload diffs as the
 * anchor moves. Pure logic — no I/O. Tile generation/mesh/collider application is the
 * caller's job, driven entirely by the returned diff.
 */
export class StreamFollower {
  readonly tileSize: number;
  readonly radius: number;
  readonly shape: StreamShape;
  readonly hysteresis: number;
  private resident = new Map<TileKey, TileCoord>();
  private anchor: TileCoord | undefined;

  constructor(opts: StreamFollowOptions) {
    if (!(opts.tileSize > 0)) throw new Error(`StreamFollower: tileSize must be > 0 (got ${opts.tileSize})`);
    if (!(opts.radius >= 0)) throw new Error(`StreamFollower: radius must be >= 0 (got ${opts.radius})`);
    this.tileSize = opts.tileSize;
    this.radius = opts.radius;
    this.shape = opts.shape ?? "square";
    this.hysteresis = opts.hysteresis ?? 0;
    if (!(this.hysteresis >= 0)) throw new Error(`StreamFollower: hysteresis must be >= 0 (got ${this.hysteresis})`);
  }

  /** Current resident tiles (stable insertion-free order: sorted tz then tx). */
  residentTiles(): TileCoord[] {
    return [...this.resident.values()].sort((a, b) => (a.tz - b.tz) || (a.tx - b.tx));
  }

  residentKeys(): Set<TileKey> {
    return new Set(this.resident.keys());
  }

  /** The tile the anchor currently sits in (undefined before the first update). */
  anchorTile(): TileCoord | undefined {
    return this.anchor;
  }

  /** Advance to a new anchor WORLD position; returns the load/unload diff. */
  update(anchorX: number, anchorZ: number): StreamDiff {
    return this.updateTile(worldToTile(anchorX, anchorZ, this.tileSize));
  }

  /** Advance to a new anchor TILE; returns the load/unload diff. */
  updateTile(anchor: TileCoord): StreamDiff {
    this.anchor = anchor;
    // LOAD: tiles inside the load window (radius) that aren't already resident.
    const desired = desiredTiles(anchor, this.radius, this.shape);
    const load: TileCoord[] = [];
    for (const t of desired) {
      const k = tileKey(t.tx, t.tz);
      if (!this.resident.has(k)) {
        load.push(t);
        this.resident.set(k, t);
      }
    }
    // UNLOAD: resident tiles outside the KEEP window (radius + hysteresis). With
    // hysteresis 0 this is exactly "outside radius".
    const keepR = this.radius + this.hysteresis;
    const unload: TileCoord[] = [];
    for (const [k, t] of this.resident) {
      if (!inWindow(t.tx - anchor.tx, t.tz - anchor.tz, keepR, this.shape)) {
        unload.push(t);
        this.resident.delete(k);
      }
    }
    load.sort((a, b) => (a.tz - b.tz) || (a.tx - b.tx));
    unload.sort((a, b) => (a.tz - b.tz) || (a.tx - b.tx));
    return { anchor, load, unload, resident: this.residentTiles(), changed: load.length > 0 || unload.length > 0 };
  }
}
