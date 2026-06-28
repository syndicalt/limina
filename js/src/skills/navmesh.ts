// navmesh.* skills — grid-based pathfinding and navigation.
// All inputs accept optional `meta` for agent-supplied extension data.
//
// CLOSURE WIRING (mirrors terrain.ts / combat.ts): the SkillDefinitions are built
// INSIDE registerNavmeshSkills, closing over ONE local NavmeshManager. There is no
// `ctx.world.navmeshManager` — the manager lives in the registry's closure (a fresh
// replay registry starts empty and rebuilds its state by re-invoking the recorded
// skills). registerNavmeshSkills returns `{ navmeshManager }` so the core wiring can
// expose it (core.nav.navmeshManager).
//
// HONEST BASELINE: the navmesh is a WALKABLE GRID over a world-XZ region (a CPU grid,
// no GPU/Rust). Cells are blocked by agent-supplied obstacle AABBs, explicit blocked
// cells, and/or a sampled height field (slope/height predicate). findPath/isReachable
// run a REAL deterministic A* over that grid — no straight-line cheat. This is a sound
// foundation that can later be upgraded to a polygon navmesh without changing the seam.
//
// DETERMINISM (CRITICAL — nav AFFECTS SIM): navmesh.moveTo changes entity positions, so
// it flows through the sim and MUST be deterministic. There is NO Date.now / new Date /
// Math.random / performance.now anywhere here. A* tie-breaks are deterministic: a fixed
// neighbour-expansion order plus a total ordering on the open set (f-score, then cell
// index). Movement integrates by an explicit `dt` (no wall-clock); ctx.tick is the sim
// time source surfaced on events. Same inputs ⇒ identical waypoints and identical final
// position on replay, bit-for-bit.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

/** Default integration timestep (seconds) when navmesh.moveTo is called without an
 *  explicit `dt`. A FIXED constant (never wall-clock) so movement stays deterministic. */
const DEFAULT_DT = 1 / 60;
/** Default per-entity navigation speed (world units / second). */
const DEFAULT_SPEED = 3;
/** Diagonal step cost for 8-connected grids. */
const SQRT2 = Math.SQRT2;
const EPS = 1e-9;

/** A walkable grid over a rectangular world-XZ region. Cell (col,row) covers world
 *  x∈[originX+col·cellSize, originX+(col+1)·cellSize], z∈[originZ+row·cellSize, …].
 *  `walkable[row*cols+col]` is 1 (walkable) or 0 (blocked). */
export interface NavGrid {
  originX: number;
  originZ: number;
  cellSize: number;
  cols: number;
  rows: number;
  walkable: Uint8Array;
  /** Per-cell surface Y (waypoint elevation), when a height field was supplied. */
  heights?: Float32Array;
  /** Whether A* may traverse diagonals (8-connected) or only orthogonally (4-connected). */
  diagonal: boolean;
}

/** Per-entity navigation state: the cached path it is following + its position. Lives
 *  in the manager's closure, so a fresh replay registry rebuilds it by re-invoking the
 *  recorded navmesh.setSpeed / navmesh.moveTo calls. */
export interface NavAgent {
  entity: string;
  speed: number;
  /** The manager's tracked position for this entity (transform-driven entities). */
  pos: [number, number, number];
  /** Whether `pos` has been seeded (first moveTo seeds it from the body / `from`). */
  posInit: boolean;
  /** The waypoint list currently being followed (world positions). */
  path: [number, number, number][];
  /** Index of the waypoint the agent has last reached (it walks toward path[pathIndex+1]). */
  pathIndex: number;
  /** Cell key of the active target, so a re-issued moveTo to the SAME cell keeps walking
   *  the cached path instead of replanning. Empty when there is no active target. */
  targetKey: string;
}

/** A world-XZ axis-aligned bounding box (blocked region / region bounds). */
export interface AABB2D {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface BuildOptions {
  bounds: AABB2D;
  cellSize: number;
  diagonal?: boolean;
  /** Inflate every obstacle by this radius (agent footprint) before rasterising. */
  agentRadius?: number;
  /** World-XZ AABBs to mark blocked (cells that overlap any are non-walkable). */
  obstacles?: AABB2D[];
  /** Explicit [col,row] cells to mark blocked. */
  blockedCells?: [number, number][];
  /** A row-major (cols×rows) height field. Cells whose surface is too steep (|Δh| to a
   *  walkable orthogonal neighbour > maxSlope·cellSize) or out of [minY,maxY] are blocked.
   *  `heights.length` must equal cols×rows. Cell elevations also feed waypoint Y. */
  heightField?: { heights: number[]; maxSlope?: number; minY?: number; maxY?: number };
}

export interface BuildResult {
  ok: boolean;
  cols: number;
  rows: number;
  walkable: number;
  blocked: number;
}

/** Open-set entry for A*: a cell index and its f-score. The heap orders by (f, idx) —
 *  a TOTAL order, so expansion is fully deterministic across runs. */
interface HeapNode {
  idx: number;
  f: number;
}

/** A tiny binary min-heap keyed by (f, idx) — deterministic total ordering. Lazy
 *  deletion (stale entries are skipped on pop via the closed set in A*). */
class NodeHeap {
  private readonly data: HeapNode[] = [];

  get size(): number {
    return this.data.length;
  }

  private less(a: HeapNode, b: HeapNode): boolean {
    return a.f < b.f || (a.f === b.f && a.idx < b.idx);
  }

  push(node: HeapNode): void {
    const d = this.data;
    d.push(node);
    let i = d.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(d[i], d[parent])) {
        [d[i], d[parent]] = [d[parent], d[i]];
        i = parent;
      } else break;
    }
  }

  pop(): HeapNode | undefined {
    const d = this.data;
    if (d.length === 0) return undefined;
    const top = d[0];
    const last = d.pop()!;
    if (d.length > 0) {
      d[0] = last;
      let i = 0;
      const n = d.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < n && this.less(d[l], d[smallest])) smallest = l;
        if (r < n && this.less(d[r], d[smallest])) smallest = r;
        if (smallest === i) break;
        [d[i], d[smallest]] = [d[smallest], d[i]];
        i = smallest;
      }
    }
    return top;
  }
}

function dist3(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function aabbOverlap(a: AABB2D, b: AABB2D): boolean {
  // Strict overlap: touching at an edge (zero-area intersection) does NOT block.
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

export class NavmeshManager {
  private grid: NavGrid | null = null;
  private readonly agents = new Map<string, NavAgent>();

  /** Build a walkable grid over a world-XZ region. Returns the grid dimensions and the
   *  walkable/blocked cell counts. Replaces any existing grid (and leaves agents, whose
   *  paths are re-planned on the next moveTo). */
  build(opts: BuildOptions): BuildResult {
    const { bounds, cellSize } = opts;
    if (!(cellSize > 0) || bounds.maxX <= bounds.minX || bounds.maxZ <= bounds.minZ) {
      this.grid = null;
      return { ok: false, cols: 0, rows: 0, walkable: 0, blocked: 0 };
    }
    const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellSize));
    const rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cellSize));
    const walkable = new Uint8Array(cols * rows).fill(1);
    const diagonal = opts.diagonal === true;
    const radius = Math.max(0, opts.agentRadius ?? 0);

    let heights: Float32Array | undefined;
    if (opts.heightField !== undefined && opts.heightField.heights.length === cols * rows) {
      heights = Float32Array.from(opts.heightField.heights);
    }

    // Obstacle AABBs (inflated by the agent radius) → blocked cells.
    if (opts.obstacles !== undefined) {
      for (const obRaw of opts.obstacles) {
        const ob: AABB2D = {
          minX: obRaw.minX - radius, minZ: obRaw.minZ - radius,
          maxX: obRaw.maxX + radius, maxZ: obRaw.maxZ + radius,
        };
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const cell: AABB2D = {
              minX: bounds.minX + c * cellSize, minZ: bounds.minZ + r * cellSize,
              maxX: bounds.minX + (c + 1) * cellSize, maxZ: bounds.minZ + (r + 1) * cellSize,
            };
            if (aabbOverlap(cell, ob)) walkable[r * cols + c] = 0;
          }
        }
      }
    }

    // Explicit blocked cells.
    if (opts.blockedCells !== undefined) {
      for (const [c, r] of opts.blockedCells) {
        if (c >= 0 && c < cols && r >= 0 && r < rows) walkable[r * cols + c] = 0;
      }
    }

    // Height-field gating: out-of-band elevation, then steepness vs walkable neighbours.
    if (heights !== undefined && opts.heightField !== undefined) {
      const { minY, maxY, maxSlope } = opts.heightField;
      if (minY !== undefined || maxY !== undefined) {
        for (let i = 0; i < heights.length; i++) {
          if ((minY !== undefined && heights[i] < minY) || (maxY !== undefined && heights[i] > maxY)) {
            walkable[i] = 0;
          }
        }
      }
      if (maxSlope !== undefined) {
        const maxDelta = maxSlope * cellSize;
        const base = walkable.slice(); // gate against the PRE-slope walkability (stable)
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            if (base[i] === 0) continue;
            let steep = false;
            const orth = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            for (const [dc, dr] of orth) {
              const nc = c + dc, nr = r + dr;
              if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
              const ni = nr * cols + nc;
              if (base[ni] === 0) continue;
              if (Math.abs(heights[i] - heights[ni]) > maxDelta) { steep = true; break; }
            }
            if (steep) walkable[i] = 0;
          }
        }
      }
    }

    let blocked = 0;
    for (let i = 0; i < walkable.length; i++) if (walkable[i] === 0) blocked++;
    this.grid = { originX: bounds.minX, originZ: bounds.minZ, cellSize, cols, rows, walkable, heights, diagonal };
    return { ok: true, cols, rows, walkable: walkable.length - blocked, blocked };
  }

  isBuilt(): boolean {
    return this.grid !== null;
  }

  getGrid(): NavGrid | null {
    return this.grid;
  }

  // ---- cell ⇄ world helpers ----

  private worldToCell(x: number, z: number): { col: number; row: number } {
    const g = this.grid!;
    let col = Math.floor((x - g.originX) / g.cellSize);
    let row = Math.floor((z - g.originZ) / g.cellSize);
    if (col < 0) col = 0; else if (col >= g.cols) col = g.cols - 1;
    if (row < 0) row = 0; else if (row >= g.rows) row = g.rows - 1;
    return { col, row };
  }

  private cellCenterByIndex(idx: number): [number, number, number] {
    const g = this.grid!;
    const col = idx % g.cols;
    const row = (idx - col) / g.cols;
    const x = g.originX + (col + 0.5) * g.cellSize;
    const z = g.originZ + (row + 0.5) * g.cellSize;
    const y = g.heights !== undefined ? g.heights[idx] : 0;
    return [x, y, z];
  }

  /** Heuristic in cell-distance units: octile (8-conn) or Manhattan (4-conn). Admissible. */
  private heuristic(a: number, b: number): number {
    const g = this.grid!;
    const ac = a % g.cols, ar = (a - ac) / g.cols;
    const bc = b % g.cols, br = (b - bc) / g.cols;
    const dc = Math.abs(ac - bc), dr = Math.abs(ar - br);
    if (g.diagonal) {
      const dmin = Math.min(dc, dr), dmax = Math.max(dc, dr);
      return dmax + (SQRT2 - 1) * dmin;
    }
    return dc + dr;
  }

  /** Deterministic A* over the grid. Returns the list of cell indices (start..goal) or
   *  null when no path exists. Fixed neighbour order + (f,idx) heap ordering ⇒ identical
   *  result every run. Diagonal moves never cut blocked corners. */
  private aStar(startIdx: number, goalIdx: number): number[] | null {
    const g = this.grid!;
    if (g.walkable[startIdx] === 0 || g.walkable[goalIdx] === 0) return null;
    if (startIdx === goalIdx) return [startIdx];

    const n = g.cols * g.rows;
    const gScore = new Float64Array(n).fill(Infinity);
    const cameFrom = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const open = new NodeHeap();
    gScore[startIdx] = 0;
    open.push({ idx: startIdx, f: this.heuristic(startIdx, goalIdx) });

    // Fixed expansion order (orthogonals first, then diagonals) for determinism.
    const orth: [number, number, number][] = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1]];
    const diag: [number, number, number][] = [[1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]];
    const moves = g.diagonal ? [...orth, ...diag] : orth;

    while (open.size > 0) {
      const cur = open.pop()!;
      if (closed[cur.idx] === 1) continue;
      if (cur.idx === goalIdx) {
        const path: number[] = [];
        let p = goalIdx;
        while (p !== -1) { path.push(p); p = cameFrom[p]; }
        path.reverse();
        return path;
      }
      closed[cur.idx] = 1;
      const cc = cur.idx % g.cols;
      const cr = (cur.idx - cc) / g.cols;
      for (const [dc, dr, cost] of moves) {
        const nc = cc + dc, nr = cr + dr;
        if (nc < 0 || nc >= g.cols || nr < 0 || nr >= g.rows) continue;
        const ni = nr * g.cols + nc;
        if (g.walkable[ni] === 0 || closed[ni] === 1) continue;
        // No corner-cutting: a diagonal step needs both shared orthogonal cells open.
        if (dc !== 0 && dr !== 0) {
          if (g.walkable[cr * g.cols + nc] === 0 || g.walkable[nr * g.cols + cc] === 0) continue;
        }
        const tentative = gScore[cur.idx] + cost;
        if (tentative < gScore[ni]) {
          gScore[ni] = tentative;
          cameFrom[ni] = cur.idx;
          open.push({ idx: ni, f: tentative + this.heuristic(ni, goalIdx) });
        }
      }
    }
    return null;
  }

  /** Deterministic A* path as world waypoints. Returns [] when there is no grid or no
   *  path (start/goal blocked or disconnected). Endpoints are the exact from/to; interior
   *  waypoints are walkable cell centres. */
  findPath(from: [number, number, number], to: [number, number, number]): [number, number, number][] {
    if (this.grid === null) return [];
    const g = this.grid;
    const sc = this.worldToCell(from[0], from[2]);
    const gc = this.worldToCell(to[0], to[2]);
    const si = sc.row * g.cols + sc.col;
    const gi = gc.row * g.cols + gc.col;
    if (g.walkable[si] === 0 || g.walkable[gi] === 0) return [];
    const cells = this.aStar(si, gi);
    if (cells === null) return [];
    if (cells.length === 1) {
      // Same cell: a straight hop within one walkable cell.
      return dist3(from, to) <= EPS ? [[from[0], from[1], from[2]]] : [[from[0], from[1], from[2]], [to[0], to[1], to[2]]];
    }
    const wp = cells.map((ci) => this.cellCenterByIndex(ci));
    wp[0] = [from[0], from[1], from[2]];
    wp[wp.length - 1] = [to[0], to[1], to[2]];
    return wp;
  }

  /** A* existence test (real reachability, not always-true). */
  isReachable(from: [number, number, number], to: [number, number, number]): boolean {
    if (this.grid === null) return false;
    const g = this.grid;
    const sc = this.worldToCell(from[0], from[2]);
    const gc = this.worldToCell(to[0], to[2]);
    const si = sc.row * g.cols + sc.col;
    const gi = gc.row * g.cols + gc.col;
    if (g.walkable[si] === 0 || g.walkable[gi] === 0) return false;
    return this.aStar(si, gi) !== null;
  }

  // ---- per-entity navigation ----

  private ensureAgent(entity: string): NavAgent {
    let a = this.agents.get(entity);
    if (a === undefined) {
      a = { entity, speed: DEFAULT_SPEED, pos: [0, 0, 0], posInit: false, path: [], pathIndex: 0, targetKey: "" };
      this.agents.set(entity, a);
    }
    return a;
  }

  getAgent(entity: string): NavAgent | undefined {
    return this.agents.get(entity);
  }

  setSpeed(entity: string, speed: number): boolean {
    if (!(speed > 0)) return false;
    this.ensureAgent(entity).speed = speed;
    return true;
  }

  /** Seed the agent's tracked position once (first move), if not already seeded. */
  seedPos(entity: string, pos: [number, number, number]): [number, number, number] {
    const a = this.ensureAgent(entity);
    if (!a.posInit) { a.pos = [pos[0], pos[1], pos[2]]; a.posInit = true; }
    return a.pos;
  }

  setAgentPos(entity: string, pos: [number, number, number]): void {
    const a = this.ensureAgent(entity);
    a.pos = [pos[0], pos[1], pos[2]];
    a.posInit = true;
  }

  /** (Re)plan the agent's path toward `target` from `from`. Keeps the cached path when the
   *  target still resolves to the same cell (so the agent keeps walking it); otherwise runs
   *  A* afresh. Returns false (and clears the path) when there is no grid or no route. */
  planPath(entity: string, from: [number, number, number], target: [number, number, number], speed?: number): boolean {
    const a = this.ensureAgent(entity);
    if (speed !== undefined && speed > 0) a.speed = speed;
    if (this.grid === null) { a.path = []; a.pathIndex = 0; a.targetKey = ""; return false; }
    const tc = this.worldToCell(target[0], target[2]);
    const key = `${tc.col}_${tc.row}`;
    if (a.targetKey === key && a.path.length > 0) return true;
    const path = this.findPath(from, target);
    if (path.length === 0) { a.path = []; a.pathIndex = 0; a.targetKey = ""; return false; }
    a.path = path;
    a.pathIndex = 0;
    a.targetKey = key;
    return true;
  }

  /** Advance the agent one integration step (`speed·dt`) along its cached path, starting
   *  from `from` (the entity's authoritative current position). PURE w.r.t. time — no
   *  wall-clock — so replay reproduces the identical walk. Returns the desired new position,
   *  whether the path end is reached, and the remaining path distance. */
  stepAgent(entity: string, from: [number, number, number], dt: number): { pos: [number, number, number]; arrived: boolean; remaining: number } {
    const a = this.agents.get(entity);
    if (a === undefined || a.path.length === 0) return { pos: [from[0], from[1], from[2]], arrived: true, remaining: 0 };
    let budget = a.speed * dt;
    const cur: [number, number, number] = [from[0], from[1], from[2]];
    while (budget > EPS && a.pathIndex < a.path.length - 1) {
      const next = a.path[a.pathIndex + 1];
      const d = dist3(cur, next);
      if (d <= budget + EPS) {
        cur[0] = next[0]; cur[1] = next[1]; cur[2] = next[2];
        a.pathIndex++;
        budget -= d;
      } else {
        const t = budget / d;
        cur[0] += (next[0] - cur[0]) * t;
        cur[1] += (next[1] - cur[1]) * t;
        cur[2] += (next[2] - cur[2]) * t;
        budget = 0;
      }
    }
    const arrived = a.pathIndex >= a.path.length - 1;
    let remaining = 0;
    if (!arrived) {
      remaining += dist3(cur, a.path[a.pathIndex + 1]);
      for (let i = a.pathIndex + 2; i < a.path.length; i++) remaining += dist3(a.path[i - 1], a.path[i]);
    }
    return { pos: cur, arrived, remaining };
  }
}

// ---- Schemas (closure-free; the SkillDefinitions that use them live in the register fn) ----

const aabbSchema = z.object({
  minX: z.number(), minZ: z.number(), maxX: z.number(), maxZ: z.number(),
});

const buildNavmeshInput = z.object({
  bounds: aabbSchema.describe("World-XZ region the grid covers."),
  cellSize: z.number().positive().describe("Grid cell edge length (world units)."),
  diagonal: z.boolean().default(false).describe("Allow diagonal (8-connected) movement (no corner-cutting)."),
  agentRadius: z.number().min(0).default(0).describe("Inflate obstacles by this footprint radius."),
  obstacles: z.array(aabbSchema).optional().describe("World-XZ AABBs to mark non-walkable."),
  blockedCells: z.array(z.tuple([z.number().int(), z.number().int()])).optional().describe("Explicit [col,row] blocked cells."),
  heightField: z.object({
    heights: z.array(z.number()).describe("Row-major cols×rows surface heights."),
    maxSlope: z.number().optional().describe("Max walkable |Δh|/cellSize to an open neighbour."),
    minY: z.number().optional(),
    maxY: z.number().optional(),
  }).optional().describe("Optional sampled height field for slope/elevation gating + waypoint Y."),
  meta: MetaField,
});

const findPathInput = z.object({
  from: Vec3.describe("Start position."),
  to: Vec3.describe("Target position."),
  meta: MetaField,
});

const moveToInput = z.object({
  entity: z.string(),
  target: Vec3.describe("Target position to navigate to."),
  speed: z.number().positive().optional().describe("Movement speed (world units/second)."),
  dt: z.number().positive().optional().describe("Integration timestep in seconds (default 1/60). Deterministic — never wall-clock."),
  from: Vec3.optional().describe("Seed position for the FIRST step (when the entity has no body and no tracked position)."),
  meta: MetaField,
});

const setNavSpeedInput = z.object({
  entity: z.string(),
  speed: z.number().positive(),
  meta: MetaField,
});

const isReachableInput = z.object({
  entity: z.string().optional().describe("Entity to check from (uses its body/tracked position). Ignored if `from` is given."),
  from: Vec3.optional(),
  to: Vec3,
  meta: MetaField,
});

/**
 * Register the navmesh.* skills bound to ONE NavmeshManager. The skill handlers CLOSE
 * OVER the manager (there is no ctx.world.navmeshManager). Returns the manager so the
 * core wiring can expose it (core.nav.navmeshManager).
 */
export function registerNavmeshSkills(registry: SkillRegistry, opts?: { navmeshManager?: NavmeshManager }): { navmeshManager: NavmeshManager } {
  const mgr = opts?.navmeshManager ?? new NavmeshManager();

  /** Read an entity's current world position: its physics body if it has one (the sim
   *  truth), else its manager-tracked position, else the supplied fallback. */
  function currentPos(
    ctx: Parameters<SkillDefinition["handler"]>[1],
    entity: string | undefined,
    fallback: [number, number, number],
  ): [number, number, number] {
    if (entity !== undefined) {
      const entry = ctx.world.entities.resolve(entity);
      if (entry !== undefined && entry.bodyId !== undefined) {
        const out = new Float32Array(3);
        ctx.world.ops.op_physics_body_pos(entry.bodyId, out);
        return [out[0], out[1], out[2]];
      }
      const agent = mgr.getAgent(entity);
      if (agent !== undefined && agent.posInit) return [agent.pos[0], agent.pos[1], agent.pos[2]];
    }
    return fallback;
  }

  const buildNavmesh: SkillDefinition<z.infer<typeof buildNavmeshInput>, BuildResult> = {
    name: "navmesh.build",
    version: "1.0.0",
    description: "Build a WALKABLE GRID navmesh over a world-XZ region: rasterise obstacle AABBs / explicit blocked cells / a sampled height field (slope+elevation gating) into a cell grid that findPath/isReachable A* over. CPU grid baseline (no GPU/Rust) — deterministic and replay-safe; upgradeable to a polygon navmesh later. Returns the grid dimensions and walkable/blocked cell counts.",
    category: "nav",
    permissions: ["nav.configure"],
    input: buildNavmeshInput,
    output: z.object({ ok: z.boolean(), cols: z.number().int(), rows: z.number().int(), walkable: z.number().int(), blocked: z.number().int() }),
    handler: (input, ctx) => {
      const res = mgr.build({
        bounds: input.bounds,
        cellSize: input.cellSize,
        diagonal: input.diagonal,
        agentRadius: input.agentRadius,
        obstacles: input.obstacles,
        blockedCells: input.blockedCells,
        heightField: input.heightField,
      });
      ctx.emit("navmesh.built", { ...res, cellSize: input.cellSize, diagonal: input.diagonal, ...input.meta });
      return res;
    },
  };

  const findPath: SkillDefinition<z.infer<typeof findPathInput>, { path: [number, number, number][]; reachable: boolean }> = {
    name: "navmesh.findPath",
    version: "1.0.0",
    description: "Find a path between two world positions with deterministic A* over the grid navmesh. Returns the waypoint list (endpoints exact, interior = walkable cell centres) and whether the goal is reachable. Empty path when there is no grid or no route — NO straight-line cheat.",
    category: "nav",
    permissions: ["nav.read"],
    input: findPathInput,
    output: z.object({ path: z.array(Vec3), reachable: z.boolean() }),
    handler: (input, ctx) => {
      const path = mgr.findPath(input.from, input.to);
      ctx.emit("navmesh.pathFound", { from: input.from, to: input.to, waypoints: path.length, reachable: path.length > 0, ...input.meta });
      return { path, reachable: path.length > 0 };
    },
  };

  const moveTo: SkillDefinition<z.infer<typeof moveToInput>, { ok: boolean; arrived: boolean; position?: [number, number, number]; remaining?: number }> = {
    name: "navmesh.moveTo",
    version: "1.0.0",
    description: "Advance an entity ONE deterministic step (speed·dt) along an A* path toward a target. Drives op_physics_move_character (kinematic CCT) when the entity has a character body; otherwise steps the ECS transform directly. (Re)plans via A* when the target cell changes. Deterministic — fixed dt (default 1/60), no wall-clock — so a replayed move sequence reaches the identical position. Fails cleanly (ok:false) when there is no grid or no route.",
    category: "nav",
    permissions: ["nav.write"],
    input: moveToInput,
    output: z.object({ ok: z.boolean(), arrived: z.boolean(), position: Vec3.optional(), remaining: z.number().optional() }),
    handler: (input, ctx) => {
      if (!mgr.isBuilt()) return { ok: false, arrived: false };
      const entry = ctx.world.entities.resolve(input.entity);
      const bodyId = entry?.bodyId;

      // Authoritative current position: body (sim truth) > tracked > seed `from` > origin.
      let cur: [number, number, number];
      if (bodyId !== undefined) {
        const out = new Float32Array(3);
        ctx.world.ops.op_physics_body_pos(bodyId, out);
        cur = [out[0], out[1], out[2]];
        mgr.setAgentPos(input.entity, cur);
      } else {
        cur = mgr.seedPos(input.entity, input.from ?? [0, 0, 0]);
        cur = [cur[0], cur[1], cur[2]];
      }

      const planned = mgr.planPath(input.entity, cur, input.target, input.speed);
      if (!planned) {
        ctx.emit("navmesh.moveTo.failed", { entity: input.entity, target: input.target, reason: "no path", tick: ctx.tick, ...input.meta });
        return { ok: false, arrived: false };
      }

      const dt = input.dt ?? DEFAULT_DT;
      const step = mgr.stepAgent(input.entity, cur, dt);

      let newPos = step.pos;
      if (bodyId !== undefined) {
        // Drive the kinematic character controller by the net desired delta this step.
        const out = new Float32Array(4);
        ctx.world.ops.op_physics_move_character(bodyId, step.pos[0] - cur[0], step.pos[1] - cur[1], step.pos[2] - cur[2], out);
        newPos = [out[0], out[1], out[2]];
      } else if (entry !== undefined && ctx.world.transforms !== undefined) {
        ctx.world.transforms.writePosition(entry.eid, step.pos[0], step.pos[1], step.pos[2]);
      }
      mgr.setAgentPos(input.entity, newPos);

      ctx.emit("navmesh.moved", { entity: input.entity, position: newPos, arrived: step.arrived, remaining: step.remaining, tick: ctx.tick, ...input.meta });
      return { ok: true, arrived: step.arrived, position: newPos, remaining: step.remaining };
    },
  };

  const setNavSpeed: SkillDefinition<z.infer<typeof setNavSpeedInput>, { ok: boolean }> = {
    name: "navmesh.setSpeed",
    version: "1.0.0",
    description: "Set an entity's movement speed (world units/second) for subsequent navmesh.moveTo steps.",
    category: "nav",
    permissions: ["nav.write"],
    input: setNavSpeedInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.setSpeed(input.entity, input.speed);
      ctx.emit("navmesh.speedSet", { entity: input.entity, speed: input.speed, ok, ...input.meta });
      return { ok };
    },
  };

  const isReachable: SkillDefinition<z.infer<typeof isReachableInput>, { reachable: boolean }> = {
    name: "navmesh.isReachable",
    version: "1.0.0",
    description: "Check (via real A* existence) whether a target is reachable from an entity's current position (body/tracked) or an explicit `from`. Returns false when there is no grid, an endpoint is blocked, or the cells are disconnected.",
    category: "nav",
    permissions: ["nav.read"],
    input: isReachableInput,
    output: z.object({ reachable: z.boolean() }),
    handler: (input, ctx) => {
      const from = input.from ?? currentPos(ctx, input.entity, [0, 0, 0]);
      const reachable = mgr.isReachable(from, input.to);
      ctx.emit("navmesh.reachability", { from, to: input.to, entity: input.entity, reachable, ...input.meta });
      return { reachable };
    },
  };

  registry.register(buildNavmesh);
  registry.register(findPath);
  registry.register(moveTo);
  registry.register(setNavSpeed);
  registry.register(isReachable);

  return { navmeshManager: mgr };
}
