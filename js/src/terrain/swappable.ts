// Map Phase 3.2 — the mutable terrain-source holder. registerCoreSkills wraps whatever
// initial TerrainSource it binds (procedural by default; model/cache when injected) in ONE
// SwappableTerrainSource, and every consumer — world.generateRegion / world.streamFollow /
// terrain.sample* (skills/terrain.ts), asset.scatter (skills/asset.ts), world.addWater
// (skills/water.ts), biome-content surveys — closes over that SAME object, delegating each
// call to `current`. The RECORDED world.setTerrainSource skill swaps `current`, and the
// rebind propagates everywhere at once with no signature changes; a world whose log never
// issues the command behaves byte-identically to before (the wrapper is pure delegation).

import type { ClimateSample, TerrainSource, TerrainTile, TileRequest } from "./types.ts";

export class SwappableTerrainSource implements TerrainSource {
  private inner: TerrainSource;

  constructor(initial: TerrainSource) {
    this.inner = initial;
  }

  /** The source currently bound (inspection/tests). */
  get current(): TerrainSource {
    return this.inner;
  }

  /** Rebind the active source. ONLY the recorded world.setTerrainSource skill should
   *  call this — the swap must be in the world log so replay is self-describing. */
  swap(next: TerrainSource): void {
    this.inner = next;
  }

  get name(): string {
    return this.inner.name;
  }

  /** Delegated, so TileCache's retention exemption follows the ACTIVE source. */
  get derived(): boolean | undefined {
    return this.inner.derived;
  }

  generateTile(req: TileRequest): TerrainTile | Promise<TerrainTile> {
    return this.inner.generateTile(req);
  }

  sampleHeight(seed: number, x: number, z: number, lod: number, hints?: Record<string, number>): number {
    return this.inner.sampleHeight(seed, x, z, lod, hints);
  }

  sampleClimate(seed: number, x: number, z: number, hints?: Record<string, number>): ClimateSample {
    return this.inner.sampleClimate(seed, x, z, hints);
  }
}
