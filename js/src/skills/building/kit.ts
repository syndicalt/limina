// Building MODULE-KIT — the source-agnostic PART CONTRACT + the procedural part library.
//
// A KitPart is a PURE, DETERMINISTIC generator: (spec, ctx) -> { mesh, colliderHalf }. It owns NO
// world state and performs NO host ops — the assembler (building-recipe.ts) is the only thing that
// turns a PartOutput into a collidable entity (spawnStaticMesh) and parents it under a building-root.
// That split is what keeps parts trivially testable and replay-safe: the same (spec, ctx) always
// yields byte-identical geometry + materials, so a recorded build re-assembles bit-for-bit.
//
// SOURCE-AGNOSTIC (the hard-to-reverse bet): `KitPart` is just a function to a mesh + collider. A
// procedural generator satisfies it today; an authored-GLB part (loaded via AssetSource) or a
// generative-3D part can satisfy the SAME signature later WITHOUT the assembler changing. This is
// limina's asset-priority rule expressed as a type (tailored skill > project asset > build-from-
// geometry): the assembler asks the kit for a part; where the geometry comes from is the kit's
// concern, not the assembler's.
//
// The library here is the BUILD-FROM-GEOMETRY tier. Its job vs. the old flat boxes is SURFACE, not
// shape: real geometric relief (a wall's plaster recessed BEHIND a timber frame that stands proud)
// skinned with the procedural-PBR material, tinted on-brief from the active DesignDirection.

import * as THREE from "../../../build/three.bundle.mjs";
import type { V3 } from "../architecture.ts";
import { applyProceduralPbr } from "../../materials/procedural-pbr.ts";
import { texturedRoleMaterial } from "../../materials/building-textures.ts";
import { resolveRoleMaterial } from "../../materials/palette.ts";
import type { DesignDirection, PaletteRole } from "../../game/design-direction.ts";

// ── The contract ──────────────────────────────────────────────────────────────────────────────────

/** The kinds of part the assembler can request for a structural slot. The list is closed so the
 *  assembler and the registry cannot drift; extend deliberately when a new element is authored. */
export const PART_KINDS = [
  "wall-panel", // an infill wall: recessed plaster behind a proud timber frame (the relief hero)
  "wall-solid", // a solid masonry wall (cut-stone / cob construction) — no timber frame
  "window-unit", // a framed opening with a reveal + sill (upgraded in the full-kit slice)
  "doorway", // a framed door opening
  "sill", // the solid panel below a window
  "lintel", // the beam spanning above an opening
  "plinth", // the foundation course a building sits on
  "roof-section", // a pitched, tiled roof span
  "stair", // a stepped connective run
  "beam", // a standalone structural timber
] as const;
export type PartKind = (typeof PART_KINDS)[number];

/** What the assembler asks the kit to fill: a slot of a given `size`, expressing a palette `role`,
 *  with optional per-kind numeric `params` (reveal depth, frame proudness, tile pitch, …). `size` is
 *  the LOCAL slot extent [x, y, z]; the part is authored centred on the origin, front face toward +Z. */
export interface KitPartSpec {
  kind: PartKind;
  size: V3;
  role: PaletteRole;
  params?: Record<string, number>;
}

/** Everything a part needs from the build beyond its own spec: the active art direction (palette
 *  roles → colours, per-role material recipes, proportion) and a deterministic `seed` for variation. */
export interface PartContext {
  dd: DesignDirection;
  seed: number;
}

/** A part's geometry + material, plus the AABB half-extents the assembler gives its static collider.
 *  The collider stays an axis-aligned box (the existing cheap path); proud relief is cosmetic. */
export interface PartOutput {
  mesh: THREE.Mesh;
  colliderHalf: V3;
}

/** A part generator. Pure + deterministic: no world, no host ops, no Date/Math.random. */
export type KitPart = (spec: KitPartSpec, ctx: PartContext) => PartOutput;

// ── Deterministic variation ─────────────────────────────────────────────────────────────────────

/** A stable 32-bit mix of a seed and a salt (finalizer of splitmix/murmur). Deterministic + pure —
 *  the ONLY source of per-part variation, so a replay reproduces every part exactly. Never Math.random. */
export function partSeed(seed: number, salt: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ (salt | 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// ── Material resolution (DesignDirection → procedural-PBR node material) ───────────────────────────

/** Which procedural-PBR grain recipe a palette role reaches for (see materials/procedural-pbr.ts).
 *  Roles without a bespoke grain fall back to "stone" (a neutral craggy dielectric). */
const ROLE_GRAIN: Record<PaletteRole, string> = {
  stone: "stone",
  wood: "wood",
  foliage: "foliage",
  ground: "stone",
  water: "water",
  metal: "metal",
  accent: "plank",
  trim: "rock",
  skin: "stone",
  sky: "stone",
};

/** Roles that resolve to a PURPOSE-BUILT tiled texture (building-textures.ts) instead of the generic
 *  noise grain: slate shingles for the roof, wood grain for timber. Other roles (stone, trim, …) keep
 *  the craggy procedural — correct for cut-stone plinths/steps/sills. */
const ROLE_TEXTURE: Partial<Record<PaletteRole, "slate" | "wood">> = { slate: "slate", wood: "wood" };

/** Build a node material for a palette role, tinted on-brief from the active DesignDirection. Roles in
 *  ROLE_TEXTURE get their believable tiled texture (slate/wood); everything else keeps the procedural
 *  triplanar grain. The visible albedo stays a variation around the role's palette colour (so the
 *  conformance gate, which reads material.color, still sees the on-brief base). */
export function kitMaterial(ctx: PartContext, role: PaletteRole, grainOverride?: string): THREE.MeshStandardNodeMaterial {
  const p = resolveRoleMaterial(ctx.dd, role);
  const tk = ROLE_TEXTURE[role];
  if (tk !== undefined) return texturedRoleMaterial(tk, p.color, p.roughness, { metalness: p.metalness });
  const grain = grainOverride ?? ROLE_GRAIN[role] ?? "stone";
  const m = new THREE.MeshStandardNodeMaterial({ color: p.color, roughness: p.roughness, metalness: p.metalness ?? 0 });
  applyProceduralPbr(m, { color: p.color, roughness: p.roughness }, grain);
  return m;
}

/** The rough PLASTER daub material for wall infill (and gable pediments): the plaster texture tinted to
 *  the DD's stone colour. Distinct from cut-stone parts, which keep the craggy procedural stone. */
export function kitPlasterMaterial(ctx: PartContext): THREE.MeshStandardNodeMaterial {
  const p = resolveRoleMaterial(ctx.dd, "stone");
  return texturedRoleMaterial("plaster", p.color, Math.max(p.roughness, 0.88));
}

// ── Geometry helpers (dependency-free multi-material merge) ────────────────────────────────────────

interface Piece { geo: THREE.BufferGeometry; mat: number; }

/** A unit-normal axis-aligned box as a NON-INDEXED geometry, translated so its centre is (cx,cy,cz).
 *  Non-indexed keeps the merge trivial (concatenate; no index rebasing) at the cost of a few verts —
 *  negligible for building parts. */
function boxGeo(w: number, h: number, d: number, cx: number, cy: number, cz: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(Math.max(w, 1e-4), Math.max(h, 1e-4), Math.max(d, 1e-4)).toNonIndexed();
  g.translate(cx, cy, cz);
  return g;
}

/** A box rotated about Z (in the panel's XY plane) then translated — for diagonal timber braces. */
function boxGeoRot(w: number, h: number, d: number, cx: number, cy: number, cz: number, angleZ: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(Math.max(w, 1e-4), Math.max(h, 1e-4), Math.max(d, 1e-4)).toNonIndexed();
  g.rotateZ(angleZ);
  g.translate(cx, cy, cz);
  return g;
}

/** Merge positioned box pieces into ONE mesh with a per-piece material index (a material array).
 *  Groups are coalesced by material so the draw stays cheap. Positions + normals only (triplanar PBR
 *  needs no UVs); GLTFExporter reads both, so the export round-trip carries the relief faithfully. */
function mergedMesh(pieces: Piece[], materials: THREE.Material[]): THREE.Mesh {
  let total = 0;
  for (const p of pieces) total += p.geo.attributes.position.count;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const geometry = new THREE.BufferGeometry();
  const raw: { start: number; count: number; mat: number }[] = [];
  let vstart = 0;
  for (const p of pieces) {
    const pa = p.geo.attributes.position.array as ArrayLike<number>;
    const na = p.geo.attributes.normal.array as ArrayLike<number>;
    positions.set(pa, vstart * 3);
    normals.set(na, vstart * 3);
    const count = p.geo.attributes.position.count;
    raw.push({ start: vstart, count, mat: p.mat });
    vstart += count;
    p.geo.dispose();
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  // Coalesce consecutive same-material runs into single groups.
  for (const g of raw) {
    const last = geometry.groups[geometry.groups.length - 1];
    if (last !== undefined && last.materialIndex === g.mat && last.start + last.count === g.start) {
      last.count += g.count;
    } else {
      geometry.addGroup(g.start, g.count, g.mat);
    }
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return new THREE.Mesh(geometry, materials);
}

// ── The parts ─────────────────────────────────────────────────────────────────────────────────────

/** WALL PANEL — the "surface not shape" hero. A recessed plaster infill behind a timber frame whose
 *  members (corner posts, top/bottom rails, a centre stud) stand PROUD of the plaster, giving genuine
 *  geometric relief + self-shadowing that a flat tinted box can never read as. Front face is +Z; the
 *  assembler yaws the part so +Z points outward. Two materials: plaster (spec.role, default stone-as-
 *  daub) and timber (the DD's `wood` role). */
export const wallPanel: KitPart = (spec, ctx) => {
  const [W, H, T] = spec.size;
  const pm = spec.params ?? {};
  const reveal = Math.min(pm.reveal ?? 0.06, T * 0.6); // plaster recessed behind the frame front
  const proud = pm.proud ?? 0.05; // frame stands this far proud of the nominal +Z face
  const frameW = Math.min(pm.frameW ?? 0.19, W * 0.28, H * 0.25); // member width (substantial timber)
  const fd = reveal + proud + 0.02; // frame depth (spans from proud front to just behind plaster face)
  const fz = T / 2 + proud - fd / 2; // frame centre z
  const half = (v: number) => v / 2;

  const plasterMat = kitPlasterMaterial(ctx); // rough daub/plaster infill
  const timberMat = kitMaterial(ctx, "wood"); // wood-grain timber frame

  const pieces: Piece[] = [];
  // Plaster infill: full panel face, depth T-reveal, its front recessed by `reveal`.
  pieces.push({ geo: boxGeo(W, H, T - reveal, 0, 0, -reveal / 2), mat: 0 });

  // Timber frame (mat 1) — laid out like real half-timber construction so it reads as STRUCTURE:
  // corner posts (full height), a top plate + a sill beam (full width), vertical studs dividing the
  // wall into bays, and diagonal corner braces (the characteristic load-path timbers).
  const postX = half(W) - half(frameW);
  const railY = half(H) - half(frameW);
  pieces.push({ geo: boxGeo(frameW, H, fd, -postX, 0, fz), mat: 1 });   // left post
  pieces.push({ geo: boxGeo(frameW, H, fd, postX, 0, fz), mat: 1 });    // right post
  pieces.push({ geo: boxGeo(W, frameW, fd, 0, railY, fz), mat: 1 });    // top plate
  pieces.push({ geo: boxGeo(W, frameW, fd, 0, -railY, fz), mat: 1 });   // sill beam
  // A MID-RAIL splits the wall into upper + lower panels (the characteristic Tudor grid). Only on
  // panels tall + wide enough to warrant it.
  const midRail = H >= 2.4 && W >= 1.0;
  if (midRail) pieces.push({ geo: boxGeo(W, frameW, fd, 0, 0, fz), mat: 1 });
  // Vertical studs divide the wall into believable bays. On a mid-railed wall the studs run the FULL
  // height (crossing the rail) so the grid reads as coherent posts-and-panels, not scattered sticks.
  const bays = W >= 3.2 ? 3 : W >= 2.0 ? 2 : W >= 1.1 ? 1 : 0;
  for (let i = 1; i <= bays; i++) {
    pieces.push({ geo: boxGeo(frameW * 0.9, H, fd, -half(W) + (W * i) / (bays + 1), 0, fz), mat: 1 });
  }
  // A single clean corner brace in each LOWER panel of a WIDE wall — a proper 45° knee from the sill
  // corner up to the mid-rail, fully contained in the lower panel so it reads structural, not stray.
  if (midRail && W >= 3.0) {
    const braceW = frameW * 0.8;
    const reach = Math.min(half(H) * 0.9, (W / (bays + 1)) * 0.85); // fit inside a bay, up to the rail
    const L = reach * Math.SQRT2;
    const cx0 = half(W) - frameW, cy0 = -railY + half(frameW);      // just inside the bottom corner joints
    pieces.push({ geo: boxGeoRot(braceW, L, fd, -cx0 + reach / 2, cy0 + reach / 2, fz, -Math.PI / 4), mat: 1 });
    pieces.push({ geo: boxGeoRot(braceW, L, fd, cx0 - reach / 2, cy0 + reach / 2, fz, Math.PI / 4), mat: 1 });
  }

  const mesh = mergedMesh(pieces, [plasterMat, timberMat]);
  return { mesh, colliderHalf: [half(W), half(H), half(T) + proud] };
};

/** STAIR — a real stepped run (connective architecture), not a ramp block. Steps rise along the part's
 *  +Z (front low → back high), each a solid box up to its tread, merged into one mesh. `size` is
 *  [width, totalRise, totalRun]; step count derives from the rise (~0.17 m risers) or `params.steps`.
 *  Used for a doorstep/stoop and free-standing stairs. Single on-brief material (spec.role). */
export const stairPart: KitPart = (spec, ctx) => {
  const [W, H, Dep] = spec.size;
  const pm = spec.params ?? {};
  const steps = Math.max(1, Math.round(pm.steps ?? Math.max(1, H / 0.17)));
  const riser = H / steps, tread = Dep / steps;
  const mat = kitMaterial(ctx, spec.role);
  const pieces: Piece[] = [];
  for (let i = 0; i < steps; i++) {
    // Step i is solid from the ground up to (i+1) risers, one tread deep, marching toward +Z.
    const h = (i + 1) * riser;
    pieces.push({ geo: boxGeo(W, h, tread, 0, h / 2 - H / 2, -Dep / 2 + (i + 0.5) * tread), mat: 0 });
  }
  const mesh = mergedMesh(pieces, [mat]);
  return { mesh, colliderHalf: [W / 2, H / 2, Dep / 2] };
};

/** A single-material box part — the honest, functional default for slots whose element is a solid
 *  member (sill, lintel, plinth, beam) or a not-yet-relief-authored kind. Real geometry + on-brief
 *  procedural-PBR, just without composite relief; the full-kit slice upgrades the richer kinds. */
export const boxPart: KitPart = (spec, ctx) => {
  const [w, h, d] = spec.size;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), kitMaterial(ctx, spec.role));
  mesh.geometry.computeBoundingBox();
  return { mesh, colliderHalf: [w / 2, h / 2, d / 2] };
};

/** The part registry. Every `PartKind` resolves to a generator — no gaps, no runtime "unknown kind".
 *  Composite/relief kinds not yet specialised fall back to `boxPart` (a real part, not a stub); the
 *  full-kit slice replaces those entries with authored generators. */
export const KIT: Record<PartKind, KitPart> = {
  "wall-panel": wallPanel,
  "wall-solid": boxPart,
  "window-unit": boxPart,
  "doorway": boxPart,
  "sill": boxPart,
  "lintel": boxPart,
  "plinth": boxPart,
  "roof-section": boxPart,
  "stair": stairPart,
  "beam": boxPart,
};

/** Resolve + invoke a part by spec. Throws on an unknown kind (defensive — the enum should prevent it).
 *  This is the one call the assembler makes per structural slot. */
export function makePart(spec: KitPartSpec, ctx: PartContext): PartOutput {
  const gen = KIT[spec.kind];
  if (gen === undefined) throw new Error(`building kit: no generator for part kind "${spec.kind}"`);
  return gen(spec, ctx);
}
