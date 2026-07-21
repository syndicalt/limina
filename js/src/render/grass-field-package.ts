import type * as THREE from "../../build/three.bundle.mjs";
import type { GrassFieldQualityTier } from "./grass-field-config.ts";
import type { GrassFieldPlacement } from "./grass-field-plan.ts";

export const GRASS_FIELD_VISUAL_PACKAGE_SCHEMA = "limina.grass-field-visual-package/v1" as const;
/** Engine-wide geometry-to-surface handoff. Terrain and continuous grass import the same object so
 * a package profile cannot silently drift from the material that consumes its density channel. */
export const CONTINUOUS_GRASS_FAR_SURFACE_FADE_M = Object.freeze({ start: 8, end: 20 });
export type GrassFieldLod = 0 | 1;

/** Renderer-facing bounds only. Geometry, materials, silhouettes, and animation controls remain
 * content-package concerns; the engine must not require one particular blade/card strategy. */
export interface GrassFieldVisualLodProfile {
  readonly maxHeight: number;
  readonly maxHorizontalDisplacement: number;
  readonly footprintRadius: number;
  readonly fade?: Readonly<{ start: number; end: number }>;
}

export type GrassFieldVisualBounds = Readonly<Pick<GrassFieldVisualLodProfile,
  "maxHeight" | "maxHorizontalDisplacement" | "footprintRadius">>;

export interface GrassFieldInstanceAttributes {
  // TSL storage-backed attributes are deliberately opaque at this package boundary.
  readonly rootYaw: unknown;
  readonly scale: unknown;
}

export interface GrassFieldVisualProfile {
  readonly maxResidentBlades: number;
  /** Actual modeled blades represented by one placement instance at each LOD. */
  readonly bladesPerInstance: readonly [number, number];
  /** Package-authored continuous-field density target. Sparse object placement must not stand in
   * for this value; residency may reduce area, never silently dilute the near field. */
  readonly bladesPerSquareMeter: readonly [number, number];
  readonly radius: number;
  readonly fineRadius: number;
  readonly spacingMultipliers: readonly [number, number];
  readonly lod: readonly [Readonly<GrassFieldVisualLodProfile>, Readonly<GrassFieldVisualLodProfile>];
  /** Optional package-owned, all-distance geometry bands. The engine supplies generic residency;
   * packages choose representation, density, range, and material transition identity. */
  readonly additionalContinuousBands?: readonly Readonly<{
    readonly id: string;
    readonly cellSizeDivisor: number;
    readonly radius: number;
    readonly lod: GrassFieldLod;
    /** Actual modeled blades represented by one placement in this presentation band. */
    readonly bladesPerInstance: number;
    readonly bladesPerSquareMeter: number;
    readonly maxResidentBlades: number;
    readonly fadeIn: Readonly<{ start: number; end: number }>;
    readonly fadeOut: Readonly<{ start: number; end: number }>;
    /** Package-measured mean opaque projected area of one instance across representative yaw. */
    readonly projectedAreaPerInstanceM2: number;
    /** Desired unsaturated opaque area per square metre of ground at full band weight. */
    readonly targetProjectedCoverage: number;
    readonly placement?: GrassFieldPlacement;
    /** Conservative bounds for this representation when it differs from its source LOD geometry.
     * Wide cards, impostors, and procedural deformation must not inherit a narrower base envelope. */
    readonly visualBounds?: GrassFieldVisualBounds;
    /** Optional primary representation whose fade-out must exactly complement this fade-in. */
    readonly complementsLod?: GrassFieldLod;
  }>[];
  /** Density-aware terrain representation used after explicit geometry becomes sub-pixel. */
  readonly farSurfaceProxy?: Readonly<{
    readonly fadeIn: Readonly<{ start: number; end: number }>;
    readonly coverageEnd: number;
  }>; 
}

export interface GrassFieldVisualBuildContext {
  readonly quality: GrassFieldQualityTier;
  readonly lod: GrassFieldLod;
  readonly maxBlades: number;
  readonly featureOrigin?: readonly [number, number, number];
  readonly fieldAttributes?: GrassFieldInstanceAttributes;
  readonly variant?: string;
  readonly presentationBand?: string;
}

export function grassFieldVisualBounds(profile: GrassFieldVisualProfile, lod: GrassFieldLod,
  presentationBand?: string): GrassFieldVisualBounds {
  if (presentationBand !== undefined) {
    const band = profile.additionalContinuousBands?.find((candidate) => candidate.id === presentationBand);
    if (band?.visualBounds !== undefined) return band.visualBounds;
  }
  return profile.lod[lod];
}

/** Resolve honest modeled-blade accounting for either a base LOD or a package-owned presentation
 * band. Additional bands may reuse an LOD's material parameters without reusing its topology. */
export function grassFieldBladesPerInstance(profile: GrassFieldVisualProfile, lod: GrassFieldLod,
  presentationBand?: string): number {
  const blades = presentationBand === undefined ? profile.bladesPerInstance[lod]
    : profile.additionalContinuousBands?.find((candidate) => candidate.id === presentationBand)?.bladesPerInstance;
  if (blades === undefined || !Number.isSafeInteger(blades) || blades < 1 || blades > 64) {
    throw new RangeError(`grass presentation '${presentationBand ?? `lod-${lod}`}' has invalid bladesPerInstance`);
  }
  return blades;
}

/** Content-owned grass presentation. The engine owns placement/residency; packages own appearance. */
export interface GrassFieldVisualPackage {
  readonly schema: typeof GRASS_FIELD_VISUAL_PACKAGE_SCHEMA;
  readonly id: string;
  readonly version: string;
  readonly variants: readonly string[];
  profile(quality: GrassFieldQualityTier): Readonly<GrassFieldVisualProfile>;
  createGeometry(context: GrassFieldVisualBuildContext): THREE.BufferGeometry;
  createMaterial(context: GrassFieldVisualBuildContext): THREE.Material;
}

/** Resolve the world-grid pitch that delivers the package's declared ACTUAL blade density.
 * Packages may group several modeled blades into one placement; residency budgets count blades,
 * while the placement lattice counts instances. */
export function grassFieldInstanceSpacing(
  pkg: GrassFieldVisualPackage,
  quality: GrassFieldQualityTier,
  lod: GrassFieldLod,
): number {
  const profile = pkg.profile(quality);
  const blades = profile.bladesPerInstance[lod];
  const density = profile.bladesPerSquareMeter[lod];
  if (!Number.isSafeInteger(blades) || blades < 1 || blades > 64) {
    throw new RangeError(`grass package '${pkg.id}' has invalid bladesPerInstance for lod ${lod}`);
  }
  if (!Number.isFinite(density) || density <= 0 || density > 1_000) {
    throw new RangeError(`grass package '${pkg.id}' has invalid bladesPerSquareMeter for lod ${lod}`);
  }
  return Math.sqrt(blades / density);
}

export class GrassFieldVisualPackageRegistry {
  readonly #packages = new Map<string, GrassFieldVisualPackage>();

  register(pkg: GrassFieldVisualPackage): void {
    if (pkg.schema !== GRASS_FIELD_VISUAL_PACKAGE_SCHEMA) throw new TypeError("unsupported grass-field visual package schema");
    if (this.#packages.has(pkg.id)) throw new Error(`grass-field visual package '${pkg.id}' is already registered`);
    this.#packages.set(pkg.id, pkg);
  }

  get(id: string): GrassFieldVisualPackage {
    const pkg = this.#packages.get(id);
    if (pkg === undefined) throw new Error(`grass-field visual package '${id}' is not registered`);
    return pkg;
  }
}
