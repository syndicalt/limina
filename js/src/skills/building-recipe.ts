// Declarative building RECIPE + the single tested ASSEMBLER — now composing the BUILDING MODULE-KIT.
//
// The recipe describes STRUCTURE (footprint, openings, roof) — not art style. assembleBuilding is the
// ONE place that owns transforms (yaw about the centre + each wall's outward-facing orientation) and
// the ONLY thing that emits entities, so the position/rotation math lives + is tested in exactly one
// spot (p15c_recipe). Openings (door AND windows) stay first-class on any wall: a wall with openings
// emits solid pillars between them, a sill panel below a window, and a lintel above each opening —
// leaving a genuine void the structural harness verifies.
//
// WHAT CHANGED FOR THE KIT: each structural slot is now filled by a KitPart (js/src/skills/building/
// kit.ts) instead of a flat tinted box — full-height wall pillars get the RELIEF wall-panel (recessed
// plaster behind a proud timber frame), oriented so the frame faces OUTWARD; sills/lintels/floor/roof/
// plinth get on-brief procedural-PBR parts. Materials resolve from the active DesignDirection (palette
// role → colour + recipe). Every part is parented under a transform-only BUILDING-ROOT, so a structure
// is one selectable / snapshot / exportable unit. Part `kind` names + the structural decomposition are
// preserved byte-for-byte, so the assembler's geometry contract (p15c) is unchanged; only the surface
// (and the parenting) is richer.
//
// A caller may override any part kind (opts.parts) — e.g. hand a GLB-backed part for one slot — which
// is how the source-agnostic KitPart contract reaches non-procedural sources without the assembler
// changing. Deterministic + replay-safe: the same (recipe, position, opts) yields the same parts in the
// same order with byte-identical geometry.

import * as THREE from "../../build/three.bundle.mjs";
import { type Part, type V3, gableRoofGeometry, gableTriangleGeometry, spawnStaticMesh } from "./architecture.ts";
import { MAX_ENTITIES, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import { computeLocalOffset } from "../ecs/hierarchy.ts";
import { KIT, type KitPart, type PartContext, type PartKind, kitMaterial, kitPlasterMaterial } from "./building/kit.ts";
import { type DesignDirection, DEFAULT_DESIGN_DIRECTION, type PaletteRole } from "../game/design-direction.ts";
import type { BuildingBrief } from "../game/building-brief.ts";
import type { WorldContext } from "./registry.ts";

export type WallSide = "north" | "south" | "east" | "west";
/** An opening cut into a wall. `offset` is the centre along the wall axis (0 = wall centre); `sill` is
 *  the height of the solid panel below it (0 for a door, >0 for a window). */
export type Opening = { wall: WallSide; kind: "door" | "window"; offset?: number; width: number; height: number; sill?: number };
export type RoofSpec = {
  type: "gable" | "flat"; pitch?: number; overhang?: number;
  /** Palette role the roof cover (shingles/thatch/tile) resolves its material from. Default "slate". */
  cover?: PaletteRole;
  /** Timber bargeboards up the gable rakes + an eave fascia — the texture-orientation principle (keeps
   *  the cover on the SLOPES and frames every exposed roof edge so no vertical face shows wrapped cover). */
  bargeboards?: boolean;
};
/** The structural SYSTEM a building is raised in — drives the wall part choice + the base course, per the
 *  building-craft construction-material-logic principle. Mirrors game/building-brief.ts Construction. */
export type Construction = "timber-frame-daub" | "stone-base-timber-upper" | "cut-stone" | "cob" | "log";
export type BuildingRecipe = {
  width: number; depth: number; height: number;
  wallThickness?: number;
  openings?: Opening[];
  roof?: RoofSpec | null;
  rotation?: number;
  /** Optional legacy colour overrides. When omitted (the norm now), materials come from the DD. */
  colors?: { wall?: number; floor?: number; roof?: number };
  /** A plinth/foundation course under the footprint (a PG-style base the walls sit on). Default on. */
  plinth?: boolean;
  // ── Craft fields (all OPTIONAL — omitted means the legacy timber-frame look, so the tested assembler
  //    contract (p15c) is byte-identical for callers that don't set them; only briefs opt in). ──
  /** How the shell is built. Chooses the wall part: timber-framed types get the RELIEF timber wall-panel;
   *  masonry types (cut-stone / cob) get a solid stone wall. Absent = timber-frame (legacy). */
  construction?: Construction;
  /** Height of a masonry base course wrapping the footprint (a low stone footing under a timber frame, or
   *  a full stone ground storey under a jettied upper). 0 / absent = none. Gapped at door openings. */
  baseCourse?: number;
  /** Palette role the masonry base course resolves from (default "stone"). */
  baseRole?: PaletteRole;
};

/** Options steering the kit composition (all optional — sensible defaults keep old callers working). */
export interface AssembleOptions {
  /** Art direction the parts resolve colours/materials from. Defaults to the shipped direction. */
  dd?: DesignDirection;
  /** Deterministic variation seed for the parts. */
  seed?: number;
  /** Per-kind part overrides — e.g. a GLB-backed part for one slot (source-agnostic contract). */
  parts?: Partial<Record<PartKind, KitPart>>;
}

export type AssembledBuilding = {
  /** The transform-only building-root every part is parented under (one selectable/exportable unit). */
  root: string;
  parts: Part[];
  bounds: { min: V3; max: V3 };
  entityCount: number;
};

const EPS = 1e-3;

/** A no-op Transformable for a LOGICAL entity (the building-root) that has no mesh of its own. Mirrors
 *  the terrain-layer root pattern (skills/terrain-edit.ts). */
const inertTransform = () => ({ position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } });

/** Assemble a building from a recipe at `position` (the floor sits at position.y). See the file header. */
export function assembleBuilding(recipe: BuildingRecipe, position: V3, world: WorldContext, opts?: AssembleOptions): AssembledBuilding {
  const [px, py, pz] = position;
  const W = recipe.width, D = recipe.depth, H = recipe.height;
  const t = recipe.wallThickness ?? 0.25;
  const yaw = recipe.rotation ?? 0;
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);

  const dd = opts?.dd ?? DEFAULT_DESIGN_DIRECTION;
  const ctx: PartContext = { dd, seed: opts?.seed ?? 0 };
  const gen = (kind: PartKind): KitPart => opts?.parts?.[kind] ?? KIT[kind];

  // Construction drives the WALL part (material-logic principle): masonry types get a solid stone wall;
  // timber-framed types keep the RELIEF timber wall-panel. Absent = timber-frame (legacy, byte-identical).
  const masonryWalls = recipe.construction === "cut-stone" || recipe.construction === "cob";

  // ── The building-root: a transform-only entity that owns the whole structure via parenting. Its
  // origin is the SELF-SUFFICIENT recipe (+ position + seed) under the registered `building.assemble`
  // skill, so a bounded-tail viewer / prefab stamp rebuilds the whole building by re-invoking it. ───
  const rootEid = spawnRenderable(world.ecs, inertTransform() as never, px, py, pz);
  if (rootEid >= MAX_ENTITIES) { despawnRenderable(world.ecs, rootEid); throw new Error("assembleBuilding: entity capacity exceeded (root)"); }
  const rootOrigin = { tool: "building.assemble", input: { ...recipe, position: [px, py, pz] as V3, ...(opts?.seed !== undefined ? { seed: opts.seed } : {}) } };
  const root = world.entities.create({ eid: rootEid, origin: rootOrigin });

  const parts: Part[] = [];

  // Rotate a building-local point about the centre by the building yaw → world position.
  const toWorld = (local: V3): V3 => [px + local[0] * cosY + local[2] * sinY, py + local[1], pz - local[0] * sinY + local[2] * cosY];

  // Per-side outward orientation: yaw (about Y) that turns a part's local +Z (its front / proud face)
  // to point OUTWARD from the given wall. N/S run along X (thickness ±Z); E/W run along Z (thickness ±X).
  const SIDE_YAW: Record<WallSide, number> = { north: 0, south: Math.PI, east: Math.PI / 2, west: -Math.PI / 2 };

  /** Place ONE kit part filling a structural slot. `local` is the slot centre in building-local space
   *  BEFORE the building yaw; `partLocalSize` is [lengthAlongWall, height, thickness] in the part's own
   *  frame (the part authors +Z as its outward/front face); `sideYaw` is the extra yaw that points the
   *  part's +Z the right way; `swapXZ` swaps the collider's length/thickness axes for a ±90° yaw. */
  const placePart = (structuralKind: string, partKind: PartKind, role: Parameters<KitPart>[0]["role"], local: V3, partLocalSize: V3, sideYaw: number, swapXZ: boolean): { entity: string } | undefined => {
    const [lx, ly, lz] = partLocalSize;
    if (lx <= EPS || ly <= EPS || lz <= EPS) return undefined;
    const out = gen(partKind)({ kind: partKind, size: [lx, ly, lz], role }, ctx);
    const partYaw = yaw + sideYaw;
    const ch = out.colliderHalf;
    const half: V3 = swapXZ ? [ch[2], ch[1], ch[0]] : [ch[0], ch[1], ch[2]];
    const wpos = toWorld(local);
    const entity = spawnStaticMesh(world, out.mesh, wpos, half, partYaw);
    const eid = world.entities.resolve(entity)?.eid;
    if (eid !== undefined) world.entities.setParent(entity, root, computeLocalOffset(world, root, eid));
    parts.push({ kind: structuralKind, entity, position: wpos, size: partLocalSize });
    return { entity };
  };

  // ── PLINTH: a foundation course the walls sit on (top flush with the floor at py). ───────────────
  if (recipe.plinth !== false) {
    const ph = 0.35, over = 0.18;
    placePart("plinth", "plinth", "stone", [0, -ph / 2, 0], [W + over * 2, ph, D + over * 2], 0, false);
  }

  // ── FLOOR slab (top surface at py). Dark structural "trim" reads as a stone/earth floor. ─────────
  placePart("floor", "sill", "trim", [0, -t / 2, 0], [W, t, D], 0, false);

  // Along-axis wall segment → a part. N/S sit at ±Z running along X; E/W at ±X running along Z (inset
  // by t so corners don't double up). We author the part-local size as [length, height, thickness] and
  // let SIDE_YAW orient it; the world footprint matches the legacy box exactly.
  const seg = (side: WallSide, structuralKind: string, partKind: PartKind, axisC: number, axisLen: number, yC: number, ySize: number, role: PaletteRole = "stone", thick: number = t): void => {
    if (axisLen <= EPS || ySize <= EPS) return;
    // Keep the segment CENTRED on the wall plane (inset by t) even when `thick` is proud, so a proud base
    // course fronts the wall face rather than shifting the whole wall.
    const local: V3 = side === "north" ? [axisC, yC, D / 2 - t / 2]
      : side === "south" ? [axisC, yC, -D / 2 + t / 2]
        : side === "east" ? [W / 2 - t / 2, yC, axisC]
          : [-W / 2 + t / 2, yC, axisC];
    placePart(structuralKind, partKind, role, local, [axisLen, ySize, thick], SIDE_YAW[side], side === "east" || side === "west");
  };

  // Emit one wall with its openings: solid pillars between/around openings (full height, RELIEF panel
  // when wide enough), a sill panel below each window, a lintel above each opening — the gap is the void.
  const WALL_PANEL_MIN = 0.8; // narrower solid runs use a plain box (a timber frame would be cramped)
  const emitWall = (side: WallSide): void => {
    const axisLen = (side === "north" || side === "south") ? W : D - 2 * t;
    const half = axisLen / 2;
    const ops = (recipe.openings ?? [])
      .filter((o) => o.wall === side)
      .map((o) => { const c = o.offset ?? 0; return { lo: Math.max(-half, c - o.width / 2), hi: Math.min(half, c + o.width / 2), sill: o.sill ?? 0, height: o.height }; })
      .filter((o) => o.hi - o.lo > EPS)
      .sort((a, b) => a.lo - b.lo);
    const pillar = (lo: number, hi: number): PartKind => (hi - lo < WALL_PANEL_MIN ? "beam" : masonryWalls ? "wall-solid" : "wall-panel");
    let cursor = -half;
    for (const o of ops) {
      if (o.lo - cursor > EPS) seg(side, `wall_${side}`, pillar(cursor, o.lo), (cursor + o.lo) / 2, o.lo - cursor, H / 2, H); // pillar
      if (o.sill > EPS) seg(side, `sill_${side}`, "sill", (o.lo + o.hi) / 2, o.hi - o.lo, o.sill / 2, o.sill); // under window
      const top = o.sill + o.height;
      if (H - top > EPS) seg(side, `lintel_${side}`, "lintel", (o.lo + o.hi) / 2, o.hi - o.lo, top + (H - top) / 2, H - top); // over opening
      cursor = Math.max(cursor, o.hi);
    }
    if (half - cursor > EPS) seg(side, `wall_${side}`, pillar(cursor, half), (cursor + half) / 2, half - cursor, H / 2, H); // trailing pillar
  };
  for (const side of ["north", "south", "east", "west"] as WallSide[]) emitWall(side);

  // ── BASE COURSE: a masonry band wrapping the footprint (construction-material-logic principle) — a low
  // stone footing under a timber frame (cottage), or a full stone ground storey under a jettied timber
  // upper (manor/longhall). It stands PROUD of the wall face so it reads as stone the frame sits on, is
  // gapped at DOOR openings so the doorway stays clear, and stops below the window sills. Opt-in via the
  // recipe; masonry (cut-stone) buildings set baseCourse 0 because the whole wall is already stone. ────
  const bc = recipe.baseCourse ?? 0;
  if (bc > EPS) {
    const baseRole: PaletteRole = recipe.baseRole ?? "stone";
    const bcH = Math.min(bc, H);
    const bcThick = t + 0.12; // proud of the wall face
    for (const side of ["north", "south", "east", "west"] as WallSide[]) {
      const axisLen = (side === "north" || side === "south") ? W : D - 2 * t;
      const half = axisLen / 2;
      const doors = (recipe.openings ?? [])
        .filter((o) => o.wall === side && o.kind === "door")
        .map((o) => { const c = o.offset ?? 0; return { lo: Math.max(-half, c - o.width / 2), hi: Math.min(half, c + o.width / 2) }; })
        .filter((o) => o.hi - o.lo > EPS)
        .sort((a, b) => a.lo - b.lo);
      const span = (lo: number, hi: number): void => { if (hi - lo > EPS) seg(side, `base_${side}`, "wall-solid", (lo + hi) / 2, hi - lo, bcH / 2, bcH, baseRole, bcThick); };
      let cursor = -half;
      for (const d of doors) { span(cursor, d.lo); cursor = Math.max(cursor, d.hi); }
      span(cursor, half);
    }
  }

  // ── DOORSTEP: a stepped stoop just OUTSIDE each door (connective — "walk up to the door"). It sits
  // beyond the footprint at grade, so it never intrudes on the interior voids the structural gate
  // measures. The stair authors its rise toward +Z, so we yaw it to climb toward the wall (inward). ──
  for (const o of recipe.openings ?? []) {
    if (o.kind !== "door") continue;
    const side = o.wall;
    const off = o.offset ?? 0;
    const sw = side === "east" || side === "west";
    const stoopW = Math.min(o.width + 0.7, (sw ? D : W) - t);
    const rise = 0.24, run = 0.8;
    // Wall-plane centre at the door offset, pushed OUT by run/2 along the outward normal.
    const oN: V3 = side === "north" ? [0, 0, 1] : side === "south" ? [0, 0, -1] : side === "east" ? [1, 0, 0] : [-1, 0, 0];
    const wall: V3 = side === "north" ? [off, 0, D / 2] : side === "south" ? [off, 0, -D / 2] : side === "east" ? [W / 2, 0, off] : [-W / 2, 0, off];
    const local: V3 = [wall[0] + oN[0] * (run / 2), rise / 2, wall[2] + oN[2] * (run / 2)];
    placePart("doorstep", "stair", "stone", local, [stoopW, rise, run], SIDE_YAW[side] + Math.PI, sw);
  }

  // ── ROOF: a custom-geometry gabled prism (kept — structurally load-bearing for p15c's eave check),
  // skinned with the DD's timber material. One entity. ─────────────────────────────────────────────
  const roof = recipe.roof === undefined ? { type: "gable" as const } : recipe.roof;
  // The roof COVER resolves its material from the recipe's cover role (slate shingles by default) — the
  // texture-orientation principle keeps it on the SLOPES only (gable ends are OPEN, closed by the plaster
  // infill below), so no vertical face shows a triplanar-wrapped shingle.
  const coverRole: PaletteRole = (roof as RoofSpec).cover ?? "slate";
  let roofTop = 0;
  if (roof) {
    if (roof.type === "gable") {
      const pitch = roof.pitch ?? 2.4;
      const { geo, half } = gableRoofGeometry(W, D, pitch, roof.overhang ?? 0.5, false);
      const roofMat = kitMaterial(ctx, coverRole);
      // The roof is an OPEN prism (no underside) on an ENTERABLE building — render both faces so no
      // slope backface-culls (reads as a "missing half") and the underside shows from inside.
      (roofMat as THREE.Material).side = THREE.DoubleSide;
      const mesh = new THREE.Mesh(geo, roofMat);
      const wpos = toWorld([0, H, 0]);
      const entity = spawnStaticMesh(world, mesh, wpos, [half[0], half[1], half[2]], yaw);
      const reid = world.entities.resolve(entity)?.eid;
      if (reid !== undefined) world.entities.setParent(entity, root, computeLocalOffset(world, root, reid));
      parts.push({ kind: "roof", entity, position: wpos, size: [half[0] * 2, pitch, half[2] * 2] });
      roofTop = pitch;

      // GABLE-END INFILL: close the triangular pediment between the flat end-wall tops and the roof, so
      // the shell is actually sealed (not open to the sky at the ends). Ridge runs along the LONGER axis
      // (gableRoofGeometry), so the gable walls are the two perpendicular to it. Base flush with the
      // wall (D or W), apex at the ridge; double-sided (seen from outside + interior).
      const ridgeAlongX = W >= D;
      const gBaseW = ridgeAlongX ? D : W;
      const ends: { x: number; z: number; yaw: number }[] = ridgeAlongX
        ? [{ x: W / 2 - t / 2, z: 0, yaw: Math.PI / 2 }, { x: -(W / 2 - t / 2), z: 0, yaw: Math.PI / 2 }]
        : [{ x: 0, z: D / 2 - t / 2, yaw: 0 }, { x: 0, z: -(D / 2 - t / 2), yaw: 0 }];
      for (const e of ends) {
        const g = gableTriangleGeometry(gBaseW, pitch, t);
        const gMat = kitPlasterMaterial(ctx);
        (gMat as THREE.Material).side = THREE.DoubleSide;
        const gMesh = new THREE.Mesh(g.geo, gMat);
        const gpos = toWorld([e.x, H, e.z]);
        const gHalf: V3 = ridgeAlongX ? [g.half[2], g.half[1], g.half[0]] : [g.half[0], g.half[1], g.half[2]];
        const gEnt = spawnStaticMesh(world, gMesh, gpos, gHalf, yaw + e.yaw);
        const gEid = world.entities.resolve(gEnt)?.eid;
        if (gEid !== undefined) world.entities.setParent(gEnt, root, computeLocalOffset(world, root, gEid));
        parts.push({ kind: "gable", entity: gEnt, position: gpos, size: [gBaseW, pitch, t] });
      }
    } else {
      placePart("roof", "roof-section", coverRole, [0, H + t / 2, 0], [W, t, D], 0, false);
      roofTop = t;
    }
  }

  return {
    root,
    parts,
    bounds: { min: [px - W / 2, py - t, pz - D / 2], max: [px + W / 2, py + H + roofTop, pz + D / 2] },
    entityCount: parts.length,
  };
}

// ── brief → recipe: the seam from PER-TYPE ART DIRECTION (the GDD-planning building brief) to STRUCTURE ──
// A BuildingBrief says WHAT the building is (construction, storeys, roof, ornament, materials); this turns
// that into the geometric recipe the assembler raises. The build agent authors/edits a BRIEF and never a
// bespoke model — a cottage and a monastery diverge purely by their briefs through this one mapping.

/** Ridge height as a fraction of the short half-span, per the brief's named pitch. */
const PITCH_RATIO: Record<string, number> = { shallow: 0.5, medium: 0.9, steep: 1.4 };

/** Masonry base-course height for each construction system (metres). Timber-framed types get a low stone
 *  footing; a stone-base-timber-upper gets a full stone ground storey; cut-stone needs none (all stone). */
function baseCourseFor(brief: BuildingBrief): number {
  switch (brief.construction) {
    case "timber-frame-daub": return 0.5;
    case "stone-base-timber-upper": return brief.storeyHeightM; // the whole ground storey in stone
    case "cut-stone": return 0;
    case "cob": return 0.4;
    case "log": return 0.3;
  }
}

export interface BriefToRecipeOptions {
  /** Site-fit footprint override (the village planner picks this); falls back to the brief's own hint. */
  footprint?: { width: number; depth: number };
  rotation?: number;
}

/** Map a per-type BuildingBrief to the structural BuildingRecipe. Deterministic + pure. */
export function briefToRecipe(brief: BuildingBrief, opts?: BriefToRecipeOptions): BuildingRecipe {
  const fw = opts?.footprint?.width ?? brief.footprintM?.width ?? 8;
  const fd = opts?.footprint?.depth ?? brief.footprintM?.depth ?? 6;
  const H = brief.storeyHeightM * brief.storeys;
  const t = 0.25;
  const shortHalf = Math.min(fw, fd) / 2;
  const baseCourse = baseCourseFor(brief);

  // Openings: a door on the SOUTH front + windows scaled to the walls; sills clear the base course.
  const winSill = Math.max(baseCourse + 0.1, 0.9);
  const winH = brief.openingStyle === "arched" ? Math.max(1.2, Math.min(2.4, H - winSill - 0.4)) : 1.0;
  const win = (wall: WallSide, offset: number, w = 1.0): Opening => ({ wall, kind: "window", offset, width: w, height: winH, sill: winSill });
  const openings: Opening[] = [
    { wall: "south", kind: "door", width: Math.min(1.4, fw * 0.26), height: Math.min(2.2, H - t - 0.3), sill: 0 },
  ];
  if (fw >= 5) openings.push(win("south", fw * 0.32), win("south", -fw * 0.32));
  if (fw >= 6) openings.push(win("north", fw * 0.22), win("north", -fw * 0.22)); else openings.push(win("north", 0, Math.min(1.4, fw * 0.3)));
  if (fd >= 4) openings.push(win("east", 0), win("west", 0));
  if (fd >= 12) openings.push(win("east", fd * 0.28), win("east", -fd * 0.28), win("west", fd * 0.28), win("west", -fd * 0.28));

  const gable = brief.roof.shape !== "flat";
  const pitch = gable ? (PITCH_RATIO[brief.roof.pitch] ?? 0.9) * shortHalf : 0;
  return {
    width: fw, depth: fd, height: H, wallThickness: t,
    rotation: opts?.rotation,
    openings,
    roof: gable
      ? { type: "gable", pitch, overhang: 0.4, cover: brief.material.roofCover, bargeboards: brief.roof.bargeboards }
      : { type: "flat", cover: brief.material.roofCover, bargeboards: brief.roof.bargeboards },
    construction: brief.construction,
    baseCourse,
    baseRole: brief.material.base,
    plinth: true,
  };
}
