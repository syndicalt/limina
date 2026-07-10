export type RenderQualityTier = "performance" | "balanced" | "cinematic";

export interface RenderPostQuality {
  enabled: boolean;
  aoSamples: number;
  aoResolutionScale: number;
  bloom: boolean;
}

export interface RenderQualityProfile {
  tier: RenderQualityTier;
  resolutionScale: number;
  maxPixelRatio: number;
  pixelRatio: number;
  shadowMapSize: number;
  shadowHalfExtent: number;
  post: Readonly<RenderPostQuality>;
  telemetryIntervalFrames: number;
}

export interface RenderQualityOverride {
  resolutionScale?: number;
  maxPixelRatio?: number;
  shadowMapSize?: number;
  shadowHalfExtent?: number;
  post?: Partial<RenderPostQuality>;
  telemetryIntervalFrames?: number;
}

interface TierDefaults extends Omit<RenderQualityProfile, "tier" | "pixelRatio"> {}

const QUALITY_TIERS = new Set<RenderQualityTier>(["performance", "balanced", "cinematic"]);
const OVERRIDE_KEYS = new Set(["resolutionScale", "maxPixelRatio", "shadowMapSize", "shadowHalfExtent", "post", "telemetryIntervalFrames"]);
const POST_KEYS = new Set(["enabled", "aoSamples", "aoResolutionScale", "bloom"]);

const DEFAULTS: Readonly<Record<RenderQualityTier, Readonly<TierDefaults>>> = Object.freeze({
  performance: Object.freeze({
    resolutionScale: 0.75,
    maxPixelRatio: 1,
    shadowMapSize: 1024,
    shadowHalfExtent: 128,
    post: Object.freeze({ enabled: false, aoSamples: 4, aoResolutionScale: 0.5, bloom: false }),
    telemetryIntervalFrames: 30,
  }),
  balanced: Object.freeze({
    resolutionScale: 1,
    maxPixelRatio: 1.5,
    shadowMapSize: 2048,
    shadowHalfExtent: 96,
    post: Object.freeze({ enabled: true, aoSamples: 8, aoResolutionScale: 0.5, bloom: true }),
    telemetryIntervalFrames: 30,
  }),
  cinematic: Object.freeze({
    resolutionScale: 1.25,
    maxPixelRatio: 2,
    shadowMapSize: 4096,
    shadowHalfExtent: 96,
    post: Object.freeze({ enabled: true, aoSamples: 16, aoResolutionScale: 1, bloom: true }),
    telemetryIntervalFrames: 30,
  }),
});

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactOptionalKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${label} has symbol fields`);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!allowed.has(key)) throw new TypeError(`${label}.${key} is unsupported`);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined || descriptor?.enumerable !== true) {
      throw new TypeError(`${label}.${key} must be an enumerable data field`);
    }
  }
}

function finiteRange(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be finite and in [${minimum}, ${maximum}]`);
  }
  return value;
}

function integerRange(value: unknown, minimum: number, maximum: number, label: string): number {
  const number = finiteRange(value, minimum, maximum, label);
  if (!Number.isSafeInteger(number)) throw new RangeError(`${label} must be an integer`);
  return number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function powerOfTwo(value: unknown, minimum: number, maximum: number, label: string): number {
  const number = integerRange(value, minimum, maximum, label);
  if ((number & (number - 1)) !== 0) throw new RangeError(`${label} must be a power of two`);
  return number;
}

export function isRenderQualityTier(value: unknown): value is RenderQualityTier {
  return typeof value === "string" && QUALITY_TIERS.has(value as RenderQualityTier);
}

export function resolveRenderQuality(
  tier: RenderQualityTier,
  devicePixelRatio: number,
  override?: RenderQualityOverride,
): Readonly<RenderQualityProfile> {
  if (!isRenderQualityTier(tier)) throw new TypeError("render quality tier is unsupported");
  const dpr = finiteRange(devicePixelRatio, 0.25, 16, "devicePixelRatio");
  const defaults = DEFAULTS[tier];
  let source: Record<string, unknown> = {};
  if (override !== undefined) {
    source = plainObject(override, "render quality override");
    exactOptionalKeys(source, OVERRIDE_KEYS, "render quality override");
  }

  const resolutionScale = source.resolutionScale === undefined
    ? defaults.resolutionScale
    : finiteRange(source.resolutionScale, 0.25, 2, "render quality resolutionScale");
  const maxPixelRatio = source.maxPixelRatio === undefined
    ? defaults.maxPixelRatio
    : finiteRange(source.maxPixelRatio, 0.5, 4, "render quality maxPixelRatio");
  const shadowMapSize = source.shadowMapSize === undefined
    ? defaults.shadowMapSize
    : powerOfTwo(source.shadowMapSize, 256, 8192, "render quality shadowMapSize");
  const shadowHalfExtent = source.shadowHalfExtent === undefined
    ? defaults.shadowHalfExtent
    : finiteRange(source.shadowHalfExtent, 8, 2048, "render quality shadowHalfExtent");
  const telemetryIntervalFrames = source.telemetryIntervalFrames === undefined
    ? defaults.telemetryIntervalFrames
    : integerRange(source.telemetryIntervalFrames, 1, 600, "render quality telemetryIntervalFrames");

  let postSource: Record<string, unknown> = {};
  if (source.post !== undefined) {
    postSource = plainObject(source.post, "render quality post override");
    exactOptionalKeys(postSource, POST_KEYS, "render quality post override");
  }
  const post = Object.freeze({
    enabled: postSource.enabled === undefined ? defaults.post.enabled : boolean(postSource.enabled, "render quality post.enabled"),
    aoSamples: postSource.aoSamples === undefined
      ? defaults.post.aoSamples
      : integerRange(postSource.aoSamples, 1, 32, "render quality post.aoSamples"),
    aoResolutionScale: postSource.aoResolutionScale === undefined
      ? defaults.post.aoResolutionScale
      : finiteRange(postSource.aoResolutionScale, 0.25, 1, "render quality post.aoResolutionScale"),
    bloom: postSource.bloom === undefined ? defaults.post.bloom : boolean(postSource.bloom, "render quality post.bloom"),
  });
  return Object.freeze({
    tier,
    resolutionScale,
    maxPixelRatio,
    pixelRatio: Math.min(dpr * resolutionScale, maxPixelRatio),
    shadowMapSize,
    shadowHalfExtent,
    post,
    telemetryIntervalFrames,
  });
}

export const DEFAULT_RENDER_QUALITY_PROFILES = DEFAULTS;
