// Shared, dependency-free helpers for the skills layer. Deliberately tiny: these were
// duplicated verbatim across several skill modules (num in combat/camera/animation;
// inertTransform in interaction/player), so they live here once. No THREE, no zod, no
// engine imports — safe for any skill module to pull in.

import type { Transformable } from "../ecs/world.ts";

/** Read a finite number from agent config, else a default. */
export function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/** Inert transform binding for a headless ECS entity (the visible mesh, if any, is mounted
 *  by the host render path; the ECS entity exists so it is a first-class, snapshot/replay-
 *  comparable entity even headless). Mirrors terrain.ts. */
export function inertTransform(): Transformable {
  return { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
}
