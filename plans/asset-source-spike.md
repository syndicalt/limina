# AssetSource — pluggable 3D asset generation (engine = Option A)

> Strategy boundary (2026-07-17): this remains valid for props, characters, vegetation, experiments,
> and cached user-supplied models. It is superseded for production building architecture. A generated
> whole-building GLB may be reference/blockout evidence only and cannot enter ArchitectureSpec,
> functional-building packaging, capture, or approval authority. Production buildings must use the
> BuildingProgram → rulebook → compiler → engine/HITL path.

## Decision (locked)

- **limina the engine stays an engine** (Option A): it gains ONE abstraction — a pluggable
  `AssetSource` — and consumes whatever mesh it returns. It does not host, price, moderate, or own
  generated assets. North-star intact: *"the engine consumes assets, never becomes a modeler."*
- **The marketplace is a SEPARATE product** — a self-hosted **Hunyuan3D-on-a-VPS** generation service
  (and, later, a catalog/store). limina talks to it as ONE backend behind `AssetSource`. It is NOT in
  the engine repo; limina is a *client*.

This mirrors `TerrainSource` exactly: terrain isn't generated *by* the engine — it's pulled from a
pluggable source (`ProceduralTerrainSource` for replay, `ModelTerrainSource` for authoring) injected via
`registerTerrainSkills(registry, source, cache)` with a `TileCache`. Assets get the same treatment.

## The interface (mirror `terrain/types.ts` `TerrainSource`)

```ts
// asset/types.ts
export type AssetKind = "prop" | "building" | "character" | "vegetation" | "model";
export type AssetRequest = {
  kind: AssetKind;
  seed: number;                         // determinism anchor
  prompt?: string;                      // text-to-3D
  referenceImage?: string;              // image-to-3D — an art-direction card image (path/hash)
  params?: Record<string, unknown>;     // backend-specific: style, polycount, pbr, rig…
};
export type AssetResult = {
  format: "glb" | "gltf";
  bytes: Uint8Array;                    // the asset bytes — ride the cache/export
  meta: { source: string; polycount?: number; bounds?: [number, number, number]; rigged?: boolean };
};
export interface AssetSource {
  name: string;
  generateAsset(req: AssetRequest): Promise<AssetResult>;
}
```

## Backends (all implement `AssetSource`)

- **`ProceduralAssetSource`** — the recipe/assembler we already built (`building-recipe.ts`). Instant,
  deterministic, free; the BLOCKOUT / fallback tier (and still ideal for layout-driven structures).
- **`FileAssetSource`** — maps a request → a glTF on disk (hand-authored or pre-generated). Zero-cost,
  fully deterministic; the "bring your own assets" tier.
- **`GenerativeAssetSource`** — calls a backend over HTTP → glTF: text/image → game-ready mesh + PBR.
  Config = `{ endpoint, model, auth }`. The **VPS Hunyuan3D service is just this, pointed at your URL.**
  Higher-quality API backends (Meshy/Rodin) are the same source with a different endpoint.

The engine picks a source (or a small resolver that routes by `kind`/quality) and consumes the result —
blind to whether it came from a recipe, a file, your VPS, or a paid API.

## Determinism via the cache (mirror `TileCache`)

`AssetCache.resolve(req, source)`: key = hash(`source.name` + kind + prompt + referenceImage-hash +
seed + params). First call generates + stores the glb bytes; every later call (incl. **replay**)
re-resolves the SAME bytes from cache — never re-hits the generator. The **world-log records the
REQUEST**; the **bytes ride the cache/export** — identical to terrain tiles (and to the parked bmap
pipeline). So a generated asset is replay-safe and a one-time cost even though the model is stochastic.

## How it plugs into what exists

- **`asset.place` / `asset.scatter`** already load glTF — they consume `AssetResult.bytes`. Minimal
  rewire: resolve the request → glb → existing loader.
- **For non-building asset lanes**, the reference library may supply a `referenceImage`. Production
  building architecture instead extracts source-neutral measurable cues and never imports generated
  whole-building geometry.
- **The modeling loop** stays — its *author* step changes from "hand-write a recipe" to
  "`generateAsset(req)`"; critique/refine tunes prompt/params/seed; the structural gate still validates
  the consumed mesh (bounds, collision, no degenerate geometry).

## The marketplace (separate product — design note, not engine work)

A Hunyuan3D service on a VPS implementing the `GenerativeAssetSource` HTTP contract
(`POST /generate {kind,prompt,referenceImage,seed,params} → glb`), with a job queue (generation is
slow), an asset store/cache, and optionally a catalog/browse/share/sell layer. limina never depends on
it — it's one configurable endpoint. Hardware: Hunyuan3D 2.1 textured needs ≥6 GB VRAM (the 4 GB laptop
can't; a VPS GPU or the 2GP fork can), so the VPS is where generation actually lives.

## Build order (engine side)

1. **`asset/types.ts`** — `AssetSource` + `AssetRequest`/`AssetResult` + `AssetCache` (mirror terrain).
2. **`FileAssetSource`** + `registerAssetSkills(registry, source, cache)` — prove the path on existing
   glTF, deterministic, no network. (Lowest risk; unblocks everything.)
3. **`GenerativeAssetSource`** — the HTTP backend contract, tested against a mock, then the VPS.
4. **`ProceduralAssetSource`** — wrap `building-recipe.ts` as a source (blockout tier).
5. (separate repo) the **VPS Hunyuan3D service**.

Step 1–2 are pure engine, additive, and don't touch the marketplace at all.
