// Asset contract — the seam between the asset.* skills and a 3D-asset GENERATOR. The generator is
// PLUGGABLE and always behind the skill (never an engine runtime dependency), mirroring TerrainSource:
//   - blockout / layout -> the PROCEDURAL source (the building-recipe assembler),
//   - retrieval         -> the LIBRARY source (Sketchfab CC catalog),
//   - authoring         -> the GENERATIVE source (3D AI Studio / Hunyuan3D over HTTP),
//   - replay / playback -> the asset CACHE carried in the snapshot/export,
//   - tests / offline   -> the FILE source (a glTF on disk).
// Output is a PURE function of the request (the determinism + replay contract): the durable log records
// the REQUEST (+ a content hash), never the asset bytes — exactly like terrain tiles. A stochastic
// generator is made replay-safe by the cache: generate once, then every later resolve (incl. replay)
// returns the same cached bytes.

/** What an agent/skill asks for. These fields are exactly what the durable log records — the
 *  deterministic input that keys the cache. `seed` anchors any stochastic backend. */
export interface AssetRequest {
  /** What the asset is, so a resolver can route + a backend can specialize. */
  kind: "prop" | "building" | "character" | "vegetation" | "model";
  /** Determinism anchor for stochastic backends; folded into the cache key. */
  seed: number;
  /** Text — a library search query OR a text-to-3D prompt (backend decides which). */
  prompt?: string;
  /** Image-to-3D / image-search input: a path or content hash of an art-direction reference image. */
  referenceImage?: string;
  /** Backend-specific knobs (style, polycount, pbr, rig, license filter…). Part of the cache key. */
  params?: Record<string, unknown>;
}

/** A resolved asset — pure data: the glb/gltf bytes plus provenance. Serializable + content-addressable;
 *  the bytes ride the snapshot/export so replay reproduces the asset without re-hitting a backend. */
export interface AssetResult {
  format: "glb" | "gltf";
  /** The asset bytes. The single source of truth a loader consumes; rides the cache + export. */
  bytes: Uint8Array;
  meta: {
    /** Which source produced it (provenance), e.g. "procedural", "library:sketchfab", "generative:3daistudio". */
    source: string;
    /** SPDX-ish license id for retrieved assets, e.g. "CC0-1.0" | "CC-BY-4.0". */
    license?: string;
    /** Required credit string for attribution licenses (CC-BY); surfaced in an in-app credits roll. */
    attribution?: string;
    /** Provenance URL (e.g. the Sketchfab model page). */
    sourceUrl?: string;
    polycount?: number;
    /** World-space bounding extent [x, y, z] (meters), for placement + the structural gate. */
    bounds?: [number, number, number];
    rigged?: boolean;
  };
}

/** A pluggable 3D-asset source. Implementations behind the cache need not be deterministic themselves
 *  (a generative model is stochastic); the cache makes the PIPELINE deterministic. `name` is recorded
 *  for provenance and folded into the cache key, so swapping sources is a clean re-key, not a silent
 *  collision. */
export interface AssetSource {
  /** Stable identifier recorded for provenance (e.g. "library:sketchfab", "generative:3daistudio"). */
  readonly name: string;
  /** Produce the asset bytes for a request. Called only on a cache MISS. */
  generateAsset(req: AssetRequest): Promise<AssetResult>;
}
