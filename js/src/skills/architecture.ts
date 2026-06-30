// architecture.* skills — PROCEDURAL ARCHITECTURE (the missing "buildings/interiors" primitive).
//
// architecture.building deterministically emits a hollow, enterable structure as REAL collidable
// entities: a floor slab, four walls, a centered doorway (two jamb segments + a lintel) cut into one
// wall, and a roof — a custom-geometry GABLED prism by default (or a flat slab). Surfaces use the
// procedural-PBR material palette (triplanar stone walls + timber-shingle roof), tinted by `color`.
// Everything is parametric and replay-safe — the same input yields byte-identical geometry + entity
// creation order, so a recorded session replays bit-identically.
//
// This is the generative LAYOUT primitive an agent (or the AI director) composes into towns: call it
// N times with different footprints/rotations to populate a settlement. It owns no rendering of its
// own; it creates standard entities the existing render-sync + physics paths drive.

import * as THREE from "../../build/three.bundle.mjs";
import { z } from "../../build/zod.bundle.mjs";
import { MAX_ENTITIES, Rotation, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import { applyProceduralPbr } from "../materials/procedural-pbr.ts";
import type { SkillDefinition, SkillRegistry, WorldContext } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type V3 = [number, number, number];

/** Darken a packed RGB by a factor (per channel). Deterministic — used for floor/roof tints. */
export function shade(color: number, f: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * f));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * f));
  const b = Math.min(255, Math.round((color & 0xff) * f));
  return (r << 16) | (g << 8) | b;
}

/** A procedural-PBR material (triplanar grain, no UVs needed — works on boxes AND custom geometry),
 *  tinted to `color`. `grain` selects the surface style (stone / plank / wood). */
export function pbrMat(grain: string, color: number, roughness: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ color, roughness, metalness: 0.0 });
  applyProceduralPbr(m, { color, roughness }, grain);
  return m;
}

/** Register a pre-built static mesh as a collidable entity with a box collider of half-extents `half`
 *  centered at `pos`. Generalizes the box path so custom geometry (the gabled roof) is a real entity. */
export function spawnStaticMesh(world: WorldContext, mesh: THREE.Mesh, pos: V3, half: V3, yaw = 0): string {
  const [x, y, z] = pos;
  world.scene.add(mesh);
  const eid = spawnRenderable(world.ecs, mesh, x, y, z);
  if (eid >= MAX_ENTITIES) {
    despawnRenderable(world.ecs, eid);
    world.scene.remove(mesh);
    throw new Error("architecture: entity capacity exceeded (MAX_ENTITIES)");
  }
  // Store the yaw in the ECS Rotation quaternion — renderSyncSystem applies it each frame (setting
  // mesh.rotation directly is overwritten). Box collider stays axis-aligned (an AABB approximation).
  if (yaw !== 0) { Rotation.y[eid] = Math.sin(yaw / 2); Rotation.w[eid] = Math.cos(yaw / 2); }
  const bodyId = world.ops.op_physics_add_static_box(x, y, z, half[0], half[1], half[2], 0.85, 0);
  return world.entities.create({ eid, mesh, bodyId });
}

/** A static box mesh + collider, with a given material. */
function spawnStaticBox(world: WorldContext, pos: V3, size: V3, material: THREE.Material): string {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  return spawnStaticMesh(world, mesh, pos, [size[0] / 2, size[1] / 2, size[2] / 2]);
}

/** Build a GABLED roof as a triangular prism (flat-shaded, crisp ridge), centered on the X/Z origin
 *  with its eaves at y=0 and the ridge at y=pitch. The ridge runs along the LONGER footprint axis.
 *  Returns the geometry + the collider half-extents of its bounding box. */
export function gableRoofGeometry(W: number, D: number, pitch: number, overhang: number): { geo: THREE.BufferGeometry; half: V3 } {
  const ridgeAlongX = W >= D;
  const long = (ridgeAlongX ? W : D) / 2 + overhang; // L: half-length along the ridge
  const short = (ridgeAlongX ? D : W) / 2 + overhang; // B: half-span across the slopes
  // Ridge along local X. Corners: base near/far (±Z) at each end (±X), apex at the centre line.
  const bNL: V3 = [-long, 0, -short], bFL: V3 = [-long, 0, short], aL: V3 = [-long, pitch, 0];
  const bNR: V3 = [long, 0, -short], bFR: V3 = [long, 0, short], aR: V3 = [long, pitch, 0];
  const tri = (...vs: V3[]): number[] => vs.flat();
  const pos = new Float32Array([
    ...tri(bNL, bNR, aR), ...tri(bNL, aR, aL),   // -Z slope
    ...tri(bFL, aL, aR), ...tri(bFL, aR, bFR),   // +Z slope
    ...tri(bNL, aL, bFL),                        // -X gable end
    ...tri(bNR, bFR, aR),                        // +X gable end
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  if (!ridgeAlongX) geo.rotateY(Math.PI / 2); // re-orient so the ridge follows the longer (Z) axis
  const half: V3 = ridgeAlongX ? [long, pitch / 2, short] : [short, pitch / 2, long];
  return { geo, half };
}

export interface Part { kind: string; entity: string; position: V3; size: V3; }

const buildingInput = z.object({
  position: Vec3.default([0, 0, 0]).describe("Building CENTER on the ground (the floor sits at position.y)."),
  width: z.number().positive().max(200).default(8).describe("Footprint extent along X (meters)."),
  depth: z.number().positive().max(200).default(6).describe("Footprint extent along Z (meters)."),
  height: z.number().positive().max(80).default(3.2).describe("Wall height (meters)."),
  rotation: z.number().default(0).describe("Yaw in radians about the building centre — face the door toward a path/commons. Applied to all parts."),
  wallThickness: z.number().positive().max(5).default(0.25).describe("Wall/floor/roof slab thickness."),
  doorWidth: z.number().positive().max(50).default(1.4).describe("Doorway opening width (centered on the -Z wall)."),
  doorHeight: z.number().positive().max(70).default(2.2).describe("Doorway opening height (lintel sits above it)."),
  withRoof: z.boolean().default(true).describe("Cap the structure with a roof."),
  roofStyle: z.enum(["gable", "flat"]).default("gable").describe("'gable' = a pitched prism roof (custom geometry); 'flat' = a slab (legacy)."),
  roofPitch: z.number().positive().max(40).default(2.4).describe("Ridge height above the eaves for a gable roof (meters)."),
  roofOverhang: z.number().min(0).max(5).default(0.5).describe("Eave overhang beyond the walls (meters)."),
  color: z.number().int().min(0).max(0xffffff).default(0x9a8c7a).describe("Wall albedo tint (the procedural-PBR stone is tinted to this; floor + roof derive from it)."),
  meta: z.record(z.string(), z.unknown()).optional(),
});

type BuildingResult = {
  entities: string[];
  parts: Part[];
  bounds: { min: V3; max: V3 };
  entityCount: number;
};

function makeBuilding(): SkillDefinition<z.infer<typeof buildingInput>, BuildingResult> {
  return {
    name: "architecture.building",
    version: "1.1.0",
    description: "Procedurally generate an enterable building (floor, 4 walls, a doorway with lintel, a pitched gabled roof) as real collidable entities with procedural-PBR surfaces. Rotatable; deterministic + replay-safe. Compose repeatedly to build settlements.",
    category: "scene",
    permissions: ["scene.write"],
    input: buildingInput,
    output: z.object({
      entities: z.array(z.string()),
      parts: z.array(z.object({ kind: z.string(), entity: z.string(), position: Vec3, size: Vec3 })),
      bounds: z.object({ min: Vec3, max: Vec3 }),
      entityCount: z.number(),
    }),
    handler: (input, ctx) => {
      const [cx, cy, cz] = input.position;
      const W = input.width, D = input.depth, H = input.height, t = input.wallThickness;
      const dw = Math.min(input.doorWidth, W - 2 * t);
      const dh = Math.min(input.doorHeight, H - t);
      const yaw = input.rotation;
      const cosY = Math.cos(yaw), sinY = Math.sin(yaw);

      // Materials (shared across this building's parts): triplanar stone walls tinted to `color`,
      // a darker stone floor, a warm timber-shingle roof.
      const wallMat = pbrMat("stone", input.color, 0.85);
      const floorMat = pbrMat("stone", shade(input.color, 0.55), 0.92);
      const roofMat = pbrMat("plank", 0x6b4a30, 0.7);

      const parts: Part[] = [];
      // Place a part at a LOCAL offset from the building centre, rotated by `yaw` about that centre.
      const addBox = (kind: string, local: V3, size: V3, mat: THREE.Material): void => {
        const wx = cx + local[0] * cosY + local[2] * sinY;
        const wz = cz - local[0] * sinY + local[2] * cosY;
        const pos: V3 = [wx, cy + local[1], wz];
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
        const half: V3 = [size[0] / 2, size[1] / 2, size[2] / 2];
        parts.push({ kind, entity: spawnStaticMesh(ctx.world, mesh, pos, half, yaw), position: pos, size });
      };

      // Floor slab (top surface at cy).
      addBox("floor", [0, -t / 2, 0], [W, t, D], floorMat);
      const wy = H / 2; // wall centre height (local)
      const zPos = D / 2 - t / 2, zNeg = -D / 2 + t / 2;
      addBox("wall_north", [0, wy, zPos], [W, H, t], wallMat);
      const sideD = D - 2 * t;
      addBox("wall_east", [W / 2 - t / 2, wy, 0], [t, H, sideD], wallMat);
      addBox("wall_west", [-W / 2 + t / 2, wy, 0], [t, H, sideD], wallMat);
      // -Z wall with a centered doorway: left jamb, right jamb, and a lintel above the opening.
      const jambW = (W - dw) / 2;
      if (jambW > 1e-3) {
        addBox("wall_south_left", [-(dw / 2 + jambW / 2), wy, zNeg], [jambW, H, t], wallMat);
        addBox("wall_south_right", [dw / 2 + jambW / 2, wy, zNeg], [jambW, H, t], wallMat);
      }
      const lintelH = H - dh;
      if (lintelH > 1e-3) addBox("lintel", [0, dh + lintelH / 2, zNeg], [dw, lintelH, t], wallMat);

      // Roof: a custom-geometry gabled prism (default) or a flat slab. One entity either way.
      if (input.withRoof) {
        if (input.roofStyle === "gable") {
          const { geo, half } = gableRoofGeometry(W, D, input.roofPitch, input.roofOverhang);
          const mesh = new THREE.Mesh(geo, roofMat);
          const pos: V3 = [cx, cy + H, cz];
          const colHalf: V3 = [half[0], half[1], half[2]];
          parts.push({ kind: "roof", entity: spawnStaticMesh(ctx.world, mesh, pos, colHalf, yaw), position: pos, size: [half[0] * 2, input.roofPitch, half[2] * 2] });
        } else {
          addBox("roof", [0, H + t / 2, 0], [W, t, D], roofMat);
        }
      }

      const entities = parts.map((p) => p.entity);
      // bounds = the structural WALL footprint (placement/spacing use this; the eaves overhang it).
      const roofTop = input.withRoof ? (input.roofStyle === "gable" ? input.roofPitch : t) : 0;
      const bounds = {
        min: [cx - W / 2, cy - t, cz - D / 2] as V3,
        max: [cx + W / 2, cy + H + roofTop, cz + D / 2] as V3,
      };
      ctx.emit("architecture.built", {
        kind: "building", center: input.position, width: W, depth: D, height: H, rotation: yaw,
        roofStyle: input.withRoof ? input.roofStyle : "none",
        entityCount: entities.length, hasDoor: jambW > 1e-3, hasRoof: input.withRoof, ...input.meta,
      });
      return { entities, parts, bounds, entityCount: entities.length };
    },
  };
}

export function registerArchitectureSkills(registry: SkillRegistry): void {
  registry.register(makeBuilding());
}
