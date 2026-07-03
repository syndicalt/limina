// GeometrySpec — the DECLARATIVE, recorded wire format for custom entity geometry.
//
// This is the "general building hand": an agent describes a shape as DATA (a parameterized
// primitive OR a 2D profile extruded to a depth) and the deterministic builder turns it into a
// THREE.BufferGeometry. It is written into the world log by scene.createMesh and replayed/exported,
// so its shape is EXPENSIVE to change later — it is designed once, here, as a clean versioned schema.
//
// It follows js/src/world/world-config.ts EXACTLY:
//   • a `version` literal on every spec (migration hook — bump when the wire format changes),
//   • a discriminated union on `kind` (the primitives + `extrude`),
//   • `.strict()` sub-objects (an unknown key is REJECTED, never silently dropped),
//   • parse* / canonical* / serialize* with a byte-stable canonical JSON round-trip,
//   • NO Date / Math.random anywhere — geometry construction is pure THREE math, so the same spec
//     always yields byte-identical vertex buffers (deterministic + replay-safe + headless).
//
// The geometry BUILDER lives here too (buildGeometry), colocated with the schema so the wire format
// and the math that realizes it can never drift apart.

import * as THREE from "../../build/three.bundle.mjs";
import { z } from "../../build/zod.bundle.mjs";

/** Bump when the wire format changes. Every spec carries it so a replayer can route by version. */
export const GEOMETRY_SPEC_VERSION = 1;

const Ver = z.literal(GEOMETRY_SPEC_VERSION);
const Positive = z.number().positive();
const NonNeg = z.number().min(0);
// A radial/tessellation segment count: a small, bounded, deterministic integer.
const Radial = z.number().int().min(3).max(256);
const HeightSeg = z.number().int().min(1).max(256);

// ── the variants (each strict, each version-stamped, discriminated on `kind`) ─────────────
const BoxSpec = z.object({
  version: Ver,
  kind: z.literal("box"),
  width: Positive,
  height: Positive,
  depth: Positive,
}).strict();

const SphereSpec = z.object({
  version: Ver,
  kind: z.literal("sphere"),
  radius: Positive,
  widthSegments: Radial.default(24),
  heightSegments: z.number().int().min(2).max(256).default(16),
}).strict();

const CylinderSpec = z.object({
  version: Ver,
  kind: z.literal("cylinder"),
  radiusTop: NonNeg,     // 0 collapses the top to a point (a cone) — allowed
  radiusBottom: NonNeg,
  height: Positive,
  radialSegments: Radial.default(24),
}).strict();

const ConeSpec = z.object({
  version: Ver,
  kind: z.literal("cone"),
  radius: Positive,
  height: Positive,
  radialSegments: Radial.default(24),
}).strict();

const PlaneSpec = z.object({
  version: Ver,
  kind: z.literal("plane"),
  width: Positive,
  height: Positive,
  widthSegments: HeightSeg.default(1),
  heightSegments: HeightSeg.default(1),
}).strict();

const CapsuleSpec = z.object({
  version: Ver,
  kind: z.literal("capsule"),
  radius: Positive,
  length: Positive, // length of the cylindrical middle section (total height = length + 2*radius)
  capSegments: HeightSeg.default(8),
  radialSegments: Radial.default(16),
}).strict();

const TorusSpec = z.object({
  version: Ver,
  kind: z.literal("torus"),
  radius: Positive, // center of the tube to the center of the torus
  tube: Positive,   // radius of the tube
  radialSegments: Radial.default(12),
  tubularSegments: Radial.default(24),
}).strict();

// EXTRUDE — the escape hatch to genuinely custom shapes: a closed 2D profile (>=3 points in the XY
// plane) swept `depth` along +Z. bevel is intentionally OFF (deterministic, no rounded seams).
const ExtrudeSpec = z.object({
  version: Ver,
  kind: z.literal("extrude"),
  profile: z.array(z.tuple([z.number(), z.number()])).min(3),
  depth: Positive,
  steps: HeightSeg.default(1),
}).strict();

export const GeometrySpecSchema = z.discriminatedUnion("kind", [
  BoxSpec, SphereSpec, CylinderSpec, ConeSpec, PlaneSpec, CapsuleSpec, TorusSpec, ExtrudeSpec,
]);

export type GeometrySpec = z.infer<typeof GeometrySpecSchema>;

export function parseGeometrySpec(json: string): GeometrySpec {
  return GeometrySpecSchema.parse(JSON.parse(json));
}

// ── Canonicalization: a stable, key-ordered clone so serialize() is byte-identical for equal
// values. Every field (incl. defaulted segments) is emitted in a fixed slot, matching world-config. ─
function canonicalGeometrySpec(s: GeometrySpec): GeometrySpec {
  switch (s.kind) {
    case "box":
      return { version: s.version, kind: "box", width: s.width, height: s.height, depth: s.depth };
    case "sphere":
      return { version: s.version, kind: "sphere", radius: s.radius, widthSegments: s.widthSegments, heightSegments: s.heightSegments };
    case "cylinder":
      return { version: s.version, kind: "cylinder", radiusTop: s.radiusTop, radiusBottom: s.radiusBottom, height: s.height, radialSegments: s.radialSegments };
    case "cone":
      return { version: s.version, kind: "cone", radius: s.radius, height: s.height, radialSegments: s.radialSegments };
    case "plane":
      return { version: s.version, kind: "plane", width: s.width, height: s.height, widthSegments: s.widthSegments, heightSegments: s.heightSegments };
    case "capsule":
      return { version: s.version, kind: "capsule", radius: s.radius, length: s.length, capSegments: s.capSegments, radialSegments: s.radialSegments };
    case "torus":
      return { version: s.version, kind: "torus", radius: s.radius, tube: s.tube, radialSegments: s.radialSegments, tubularSegments: s.tubularSegments };
    case "extrude":
      return { version: s.version, kind: "extrude", profile: s.profile.map(([x, y]) => [x, y] as [number, number]), depth: s.depth, steps: s.steps };
  }
}

export function canonicalizeGeometrySpec(s: GeometrySpec): GeometrySpec {
  return canonicalGeometrySpec(s);
}

export function serializeGeometrySpec(s: GeometrySpec): string {
  return JSON.stringify(canonicalGeometrySpec(s));
}

/** Realize a spec as a THREE.BufferGeometry. Pure, deterministic, headless-safe (geometry
 *  construction is CPU math — no GL context). The same spec always yields identical vertex buffers. */
export function buildGeometry(spec: GeometrySpec): THREE.BufferGeometry {
  switch (spec.kind) {
    case "box":
      return new THREE.BoxGeometry(spec.width, spec.height, spec.depth);
    case "sphere":
      return new THREE.SphereGeometry(spec.radius, spec.widthSegments, spec.heightSegments);
    case "cylinder":
      return new THREE.CylinderGeometry(spec.radiusTop, spec.radiusBottom, spec.height, spec.radialSegments);
    case "cone":
      return new THREE.ConeGeometry(spec.radius, spec.height, spec.radialSegments);
    case "plane":
      return new THREE.PlaneGeometry(spec.width, spec.height, spec.widthSegments, spec.heightSegments);
    case "capsule":
      return new THREE.CapsuleGeometry(spec.radius, spec.length, spec.capSegments, spec.radialSegments);
    case "torus":
      return new THREE.TorusGeometry(spec.radius, spec.tube, spec.radialSegments, spec.tubularSegments);
    case "extrude": {
      const shape = new THREE.Shape();
      const [x0, y0] = spec.profile[0];
      shape.moveTo(x0, y0);
      for (let i = 1; i < spec.profile.length; i++) shape.lineTo(spec.profile[i][0], spec.profile[i][1]);
      shape.closePath();
      // bevelEnabled:false + fixed steps → a clean, deterministic prism from the profile.
      return new THREE.ExtrudeGeometry(shape, { depth: spec.depth, steps: spec.steps, bevelEnabled: false });
    }
  }
}
