// CONTENT STAGE (the pipeline's missing half) — places the GDS content manifest's assets into the
// scene, GROUNDED, via the asset pipeline. The functional gate proves the loop works; this stage +
// the render baseline's atmosphere are what make the result look like a GAME rather than a void.
//
// Given a list of resolved placements (a content manifest entry → a sourced glb id + a layout
// position), it grounds each through asset.place (base sits at the surface height). Reusable across
// games: a windowed build calls it after the render baseline + ground are set.

import type { GameContext } from "./context.ts";

export interface ContentPlacement {
  /** The sourced asset id (a glb under assets/, fetched by the asset pipeline / committed). */
  assetId: string;
  /** World XZ. */
  position: readonly [number, number];
  /** Real-world height to normalize the asset to (meters). */
  height: number;
  /** Yaw (radians). */
  rotY?: number;
  /** Ground height at this XZ (default 0 = flat ground). */
  surfaceY?: number;
}

/** Place a content manifest's assets into the scene, grounded (each base sits at surfaceY). Returns
 *  the count placed; logs (does not throw) on a per-asset failure so one bad asset never kills the
 *  whole dressing. */
export async function placeContent(ctx: GameContext, placements: readonly ContentPlacement[]): Promise<number> {
  let placed = 0;
  for (const pl of placements) {
    const res = await ctx.registry.invoke(
      "asset.place",
      {
        assetId: pl.assetId,
        position: [pl.position[0], pl.surfaceY ?? 0, pl.position[1]],
        normalizeHeight: pl.height,
        rotation: [0, pl.rotY ?? 0, 0],
      },
      ctx.base,
    );
    if (res.success) placed++;
    else ctx.ops.op_log(`placeContent: asset.place FAILED ${pl.assetId}: ${JSON.stringify(res.error)}`);
  }
  return placed;
}
