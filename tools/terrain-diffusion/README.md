# terrain-diffusion → limina `/tile` shim

The reference adapter that wires the S0-greenlit **terrain-diffusion** model end-to-end
behind limina's `ModelTerrainSource`. limina's `/tile` protocol is the **stable seam**;
each model gets its own thin shim that translates to it. This is that shim for
`terrain-diffusion` (`xandergos/terrain-diffusion-30m`).

```
limina ModelTerrainSource ──POST /tile──▶ shim.py ──GET /terrain──▶ terrain_diffusion.inference.api
   (js/src/terrain/             (this dir)                              (the real model service)
    model-source.ts)
```

## The two protocols

**limina (stable contract — `js/src/terrain/model-source.ts`):**
- `POST {baseUrl}/tile {seed,tx,tz,lod,tile,hints}` →
  `{ nrows, ncols, elev:{dtype:"int16",b64}, climate:{channels,dtype:"float32",b64} }`
  — elevation int16-LE metres (row-major); climate **channel-major (C,H,W)** float32-LE.
- `POST {baseUrl}/health` → `{ ok }`.

**terrain-diffusion (the real model — verified against the installed `api.py`):**
- `GET {target}/terrain?i1&j1&i2&j2&scale` → **raw bytes**: int16-LE elevation
  (`h*w*2` bytes, metres) **then** float32-LE climate **INTERLEAVED `(H,W,4)`**
  (`h*w*4*4` bytes), channels `[temp(BIO1), t_season(BIO4), precip(BIO12), p_cv(BIO15)]`.
  Dimensions are returned in the `X-Height` / `X-Width` response headers.
- `GET {target}/health` → `{"status":"ok"}`.
- **Seed is FIXED at server start** (`--seed S`), not per request.

## What the shim translates

| field | model `/terrain` | limina `/tile` |
|------|------------------|----------------|
| elevation | int16-LE `(h,w)` metres | int16-LE b64, passthrough (optional clamp) |
| climate layout | interleaved `(H,W,4)` | **transposed to channel-major `(4,H,W)`** |
| climate channels | `[temp@0, t_season@1, precip@2, p_cv@3]` | **same, faithfully** (no drop/reorder, no biome) |
| dims | `X-Height`/`X-Width` | `nrows`/`ncols` |

The shim emits the climate **faithfully**: the model's channels in the model's order,
transposed interleaved→channel-major. **`model-source.ts` is the single source of truth for
biome** — it reads `tempC` from channel 0 and `precipMm` from channel 2 (its **defaults**)
and classifies the canonical `Biome` itself from temp+precip. So a **default-configured
`ModelTerrainSource` decodes this wire out of the box — NO `climateChannels`/`tempChannel`/
`precipChannel` override needed** (it's decode-count-agnostic as long as temp@0 / precip@2
hold, which the shim guarantees). The wire carries **no biome channel**.

> This is the SAME wire `tools/terrain-service/worker.py` (the in-process backend) emits —
> same axis (x→j, z→i), same 4 channels (precip@2), same 30 m/px, same floor-quantized elev —
> so a consumer gets the **same world** from either deployment.

### tile → pixel / lod → scale

The model's `scale` is an integer oversample of its native resolution
(`m/px = NATIVE/scale`; `NATIVE = 30` m/px for terrain-diffusion-30m at scale 1).

```
base_scale  = --scale                       (model scale at lod 0)
scale       = clamp(base_scale << lod, .., --max-scale)   (lod = oversample level)
factor      = scale // base_scale
px_per_tile = tile * factor
i1 = tz*px_per_tile, i2 = i1+px_per_tile     (z → i = rows = height)
j1 = tx*px_per_tile, j2 = j1+px_per_tile     (x → j = cols = width)
```

World metres per tile stay **constant** across lods
(`ground = px_per_tile * NATIVE/scale = tile * NATIVE/base_scale`), so this matches the
limina source's fixed extent and only the heightfield resolution grows with lod. Adjacent
tiles share a pixel edge → seam-consistent. **Set the limina source's
`metersPerPx = NATIVE / base_scale`** (e.g. 30 for `--scale 1`, 3.75 for `--scale 8`).

### seed

The model's launch seed is the region seed (`--region-seed`, set to the model's `--seed`).
A `/tile` with a different seed is **rejected** with an error envelope and is a **no-op**
against the model (the shim never forwards `seed` to `/terrain`, so it can never trigger
the model's expensive per-request rebuild). To change worlds, relaunch both services.

## Run (end-to-end, UAT — needs a GPU box with `terrain_diffusion`)

```bash
# one shot: launches model + shim, then the limina demo (override via env, e.g. SCALE=8)
tools/terrain-diffusion/run.sh

# or by hand:
python -m terrain_diffusion.inference.api xandergos/terrain-diffusion-30m \
    --seed 1234 --host 127.0.0.1 --port 8000
python tools/terrain-diffusion/shim.py \
    --target-url http://127.0.0.1:8000 --region-seed 1234 --scale 1 --port 8917
./target/release/limina --window js/src/demos/model_terrain_window.ts
```

The shim listens on `127.0.0.1:8917` — the `ModelTerrainSource` default `baseUrl`.

## Test (no GPU, no network)

```bash
python tools/terrain-diffusion/test_shim.py    # or: pytest tools/terrain-diffusion/test_shim.py
```

Feeds a synthetic `/terrain` body in the exact real byte format through the shim's
translation and asserts the `/tile` envelope is byte-exact (elev round-trip, faithful
channel-major climate, tile→pixel/scale `z→i`/`x→j`, seed gate, elev clamp, 30 m/px), plus
the **cross-component contract**: decoding the wire the way a default `ModelTerrainSource`
does (temp@0, precip@2, biome from temp+precip) yields the right temp/precip and a sane
biome. Byte layout / endianness / channel order is where bugs hide, so this is exhaustive.

The consumer side of that seam is pinned in TypeScript too:
`js/test/p9_shim_contract.ts` feeds a shim-format envelope through a **default-configured**
`ModelTerrainSource` and asserts temp/precip/biome decode correctly (run via
`./target/release/limina js/test/p9_shim_contract.ts`).

## Files

- `shim.py` — the HTTP shim + the pure translation (`translate_terrain`, `tile_to_box`).
- `test_shim.py` — the byte-exact + cross-component unit test.
- `run.sh` — the end-to-end launcher.

> Sibling `tools/terrain-service/worker.py` is the **other** backend: an **in-process** worker
> that imports the model directly and serves `/tile` itself. This shim instead adapts the
> model's **own shipped HTTP service**, so the model runs unmodified behind its native API.
> Both emit the **same wire** (axis, channels, 30 m/px, floor-quantized elev), so a consumer
> gets the same world from either — pick by deployment, not by output.
