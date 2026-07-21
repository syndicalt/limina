import type { ScatterExclusion } from "../terrain/asset-scatter.ts";
import type { GrassFieldPlacement } from "./grass-field-plan.ts";

export type GrassFieldQualityTier = "performance" | "balanced" | "cinematic";

export interface GrassFieldSourceOptions {
  readonly seed: number;
  readonly spacing?: number;
  readonly elevationMin?: number;
  readonly elevationMax?: number;
  readonly slopeMax?: number;
  readonly sizeRange?: readonly [number, number];
  readonly exclusions?: readonly ScatterExclusion[];
  readonly densityAt?: (x: number, z: number) => number;
  /** Published continuous packages use their authenticated biome density directly. Editable
   * terrain may instead merge authored grass/non-grass paint with the base field. */
  readonly paintPolicy?: "merge" | "ignore";
  /** Final semantic veto evaluated after biome density and terrain paint. Water, roads, and other
   * authoritative footprints use this channel when paint must never reintroduce vegetation. */
  readonly hardExclusionAt?: (x: number, z: number) => boolean;
  /** Optional package-selected world distribution. Engine placement remains representation-agnostic. */
  readonly placement?: GrassFieldPlacement;
}
