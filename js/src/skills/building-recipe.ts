// Declarative building RECIPE + the single tested ASSEMBLER (modeling-loop spike, piece #2).
//
// The recipe describes STRUCTURE (footprint, openings, roof type) — not art style. assembleBuilding is
// the ONE place that owns transforms (yaw about the centre) and the ONLY thing that emits entities, so
// the position/rotation math lives + is tested in exactly one spot. Openings (door AND windows) are
// first-class on any wall: a wall with openings emits solid pillars between them, a sill panel below a
// window, and a lintel above each opening — leaving a genuine void the structural harness can verify.
//
// Reuses the transform + material + roof helpers exported from architecture.ts (single source of truth
// for how a part becomes a collidable entity). architecture.building will become a thin recipe→assemble
// call once this is proven.

import * as THREE from "../../build/three.bundle.mjs";
import type { WorldContext } from "./registry.ts";
import { type Part, type V3, gableRoofGeometry, pbrMat, shade, spawnStaticMesh } from "./architecture.ts";

export type WallSide = "north" | "south" | "east" | "west";
/** An opening cut into a wall. `offset` is the centre along the wall axis (0 = wall centre); `sill` is
 *  the height of the solid panel below it (0 for a door, >0 for a window). */
export type Opening = { wall: WallSide; kind: "door" | "window"; offset?: number; width: number; height: number; sill?: number };
export type RoofSpec = { type: "gable" | "flat"; pitch?: number; overhang?: number };
export type BuildingRecipe = {
  width: number; depth: number; height: number;
  wallThickness?: number;
  openings?: Opening[];
  roof?: RoofSpec | null;
  rotation?: number;
  colors?: { wall?: number; floor?: number; roof?: number };
};

export type AssembledBuilding = { parts: Part[]; bounds: { min: V3; max: V3 }; entityCount: number };

const EPS = 1e-3;

/** Assemble a building from a recipe at `position` (the floor sits at position.y). Deterministic +
 *  replay-safe: the same recipe yields the same parts in the same order. */
export function assembleBuilding(recipe: BuildingRecipe, position: V3, world: WorldContext): AssembledBuilding {
  const [px, py, pz] = position;
  const W = recipe.width, D = recipe.depth, H = recipe.height;
  const t = recipe.wallThickness ?? 0.25;
  const yaw = recipe.rotation ?? 0;
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  const wallCol = recipe.colors?.wall ?? 0x9a8c7a;
  const wallMat = pbrMat("stone", wallCol, 0.85);
  const floorMat = pbrMat("stone", recipe.colors?.floor ?? shade(wallCol, 0.55), 0.92);
  const roofMat = pbrMat("plank", recipe.colors?.roof ?? 0x6b4a30, 0.7);

  const parts: Part[] = [];
  // The ONE transform site: a local offset from the centre, rotated by yaw about it, becomes an entity.
  const place = (kind: string, local: V3, size: V3, mat: THREE.Material): void => {
    const wx = px + local[0] * cosY + local[2] * sinY;
    const wz = pz - local[0] * sinY + local[2] * cosY;
    const pos: V3 = [wx, py + local[1], wz];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
    parts.push({ kind, entity: spawnStaticMesh(world, mesh, pos, [size[0] / 2, size[1] / 2, size[2] / 2], yaw), position: pos, size });
  };

  // Floor (top surface at py).
  place("floor", [0, -t / 2, 0], [W, t, D], floorMat);

  // Convert an along-axis segment on a wall into a local box and place it. North/South run along X at
  // ±Z; East/West run along Z at ±X (inset by t so corners don't double up).
  const seg = (side: WallSide, kind: string, axisC: number, axisLen: number, yC: number, ySize: number): void => {
    if (axisLen <= EPS || ySize <= EPS) return;
    if (side === "north") place(kind, [axisC, yC, D / 2 - t / 2], [axisLen, ySize, t], wallMat);
    else if (side === "south") place(kind, [axisC, yC, -D / 2 + t / 2], [axisLen, ySize, t], wallMat);
    else if (side === "east") place(kind, [W / 2 - t / 2, yC, axisC], [t, ySize, axisLen], wallMat);
    else place(kind, [-W / 2 + t / 2, yC, axisC], [t, ySize, axisLen], wallMat);
  };

  // Emit one wall with its openings: solid pillars between/around openings (full height), a sill panel
  // below each window, a lintel above each opening — the gap left is the genuine opening void.
  const emitWall = (side: WallSide): void => {
    const axisLen = (side === "north" || side === "south") ? W : D - 2 * t;
    const half = axisLen / 2;
    const ops = (recipe.openings ?? [])
      .filter((o) => o.wall === side)
      .map((o) => { const c = o.offset ?? 0; return { lo: Math.max(-half, c - o.width / 2), hi: Math.min(half, c + o.width / 2), sill: o.sill ?? 0, height: o.height }; })
      .filter((o) => o.hi - o.lo > EPS)
      .sort((a, b) => a.lo - b.lo);
    let cursor = -half;
    for (const o of ops) {
      if (o.lo - cursor > EPS) seg(side, `wall_${side}`, (cursor + o.lo) / 2, o.lo - cursor, H / 2, H); // pillar
      if (o.sill > EPS) seg(side, `sill_${side}`, (o.lo + o.hi) / 2, o.hi - o.lo, o.sill / 2, o.sill);    // under window
      const top = o.sill + o.height;
      if (H - top > EPS) seg(side, `lintel_${side}`, (o.lo + o.hi) / 2, o.hi - o.lo, top + (H - top) / 2, H - top); // over opening
      cursor = Math.max(cursor, o.hi);
    }
    if (half - cursor > EPS) seg(side, `wall_${side}`, (cursor + half) / 2, half - cursor, H / 2, H); // trailing pillar
  };
  for (const side of ["north", "south", "east", "west"] as WallSide[]) emitWall(side);

  // Roof.
  const roof = recipe.roof === undefined ? { type: "gable" as const } : recipe.roof;
  let roofTop = 0;
  if (roof) {
    if (roof.type === "gable") {
      const pitch = roof.pitch ?? 2.4;
      const { geo, half } = gableRoofGeometry(W, D, pitch, roof.overhang ?? 0.5);
      const mesh = new THREE.Mesh(geo, roofMat);
      const pos: V3 = [px, py + H, pz];
      parts.push({ kind: "roof", entity: spawnStaticMesh(world, mesh, pos, [half[0], half[1], half[2]], yaw), position: pos, size: [half[0] * 2, pitch, half[2] * 2] });
      roofTop = pitch;
    } else {
      place("roof", [0, H + t / 2, 0], [W, t, D], roofMat);
      roofTop = t;
    }
  }

  return {
    parts,
    bounds: { min: [px - W / 2, py - t, pz - D / 2], max: [px + W / 2, py + H + roofTop, pz + D / 2] },
    entityCount: parts.length,
  };
}
