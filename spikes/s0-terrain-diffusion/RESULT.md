# S0 RESULT — InfiniteDiffusion terrain probe

**Status:** RAN FOR REAL on the target GPU. Real measurements below.
**Verdict:** **GREENLIGHT S1** (Python `terrain.*` service behind the skill seam), with caveats.

- **Date:** 2026-06-26
- **Hardware:** NVIDIA GeForce RTX 3050 Laptop GPU, **4096 MiB** VRAM, driver 595.71.05
- **Stack:** Python 3.13, torch **2.12.0+cu130** (CUDA 13.0), torchvision 0.27.1+cu130
- **Model:** `xandergos/terrain-diffusion-30m` (InfiniteDiffusion, SIGGRAPH '26, MIT)

---

## What the candidate actually is (S0 step 1)

- **`pip install terrain-diffusion` is a decoy** — v0.0.1 is a 2.4 kB empty stub
  ("package under development"). The real system is the **GitHub repo**
  `xandergos/terrain-diffusion` (branch `master`); run via `python -m terrain_diffusion …`.
  There is no installable package / `pyproject` — you execute from the cloned repo root.
- **Weights:** HuggingFace, **public / not gated**, **~1.14 GB** total, three `.safetensors`:
  - `base_model` 1015 MB → **253.7 M** params (the latent diffusion UNet)
  - `decoder_model` 112 MB → 27.9 M params (laplacian residual decoder)
  - `coarse_model` 11 MB → 2.8 M params (coarse sketch model)
- **Native resolution 30 m/px.** Per tile output: `elev` (meters, fp→int16) + a
  **5-channel climate** tensor (temp, temp-seasonality, precip, precip-CV ≈ WorldClim
  BIO1/4/12/15). This is real perception data, not just visuals.
- **Conditioning input** is a Perlin "synthetic map" quantile-matched to global rasters.
  Needs `data/global/etopo_10m.tif` (**already committed in the repo**, 9.3 MB) plus
  WorldClim `wc2.1_10m_bio_{1,4,12,15}.tif` (auto-downloaded, 48 MB zip). First call
  computes & caches `synthetic_map_stats.json`. **This was the one real setup gotcha**
  (relative paths → must run with CWD = repo root); now resolved and documented.
- **Inference deps are a small curated subset** of the repo's 35-line `requirements.txt`
  (which is mostly training/data-pipeline: cartopy, earthengine, wandb, optuna, …).
  Inference needs: torch, torchvision, diffusers, h5py, numba, scikit-image, matplotlib,
  flask, ema-pytorch, **infinite-tensor** (the bespoke lazy/O(1) tiling lib, on PyPI 0.3.0),
  pyfastnoiselite, rasterio. All install cleanly against torch 2.12.

## Measurements (S0 step 2) — all real, measured by `run.py`

Tile = **256×256 px @ 30 m/px = 58.98 km²**. "Isolated" tiles are far apart (stride 4096),
which **forces a full fresh hierarchy each time** — the worst case, no cache reuse.

| dtype | isolated-tile latency (median) | peak VRAM |
|------|-------------------------------|-----------|
| fp32 | ~7.9–9.7 s/tile               | 2287 MB   |
| **fp16** | **~5.5 s/tile**           | **1155 MB** |
| bf16 | ~6.2 s/tile                   | 1155 MB   |

**Contiguous region (amortized — the real stream-as-you-move case),** fp16, one `get()`:

| region | area | wall time | per 256-tile-equiv |
|--------|------|-----------|--------------------|
| 512²   | 236 km²  | 7.8 s  | 1.95 s |
| 1024²  | 944 km²  | 13.9 s | **0.87 s** |

→ Contiguous generation is **~6× cheaper per km²** than scattered tiles, because
InfiniteDiffusion **shares the coarse/latent stages** across adjacent tiles (its whole point).
**VRAM stays flat at 1.16 GB** even for a 1024² region. Pipeline load ≈ 1.5–2.5 s.

## Determinism (S0 step 3) — the decisive result

**EXACT.** Same seed, **two separate cold processes**, byte-compared:

```
fp32: elev identical True  max|Δ| 0.0   |  climate identical True  max|Δ| 0.0
fp16: elev identical True  max|Δ| 0.0   |  climate identical True
```

Both elevation **and** all 5 climate channels are bit-for-bit identical across runs, at
fp32 **and** fp16. The determinism claim holds on this hardware — this is exactly the
contract limina's durable/replayable log needs.

> Not tested: **cross-device / cross-framework** parity (only same-machine cold runs).
> Keep the snapshot cache as the spike already plans — same caveat as Rapier float determinism.

---

## Go / No-Go for Phase 9 worldgen

**GREENLIGHT to S1** (wire the published Python service into the `terrain.*` skill seam).
The three unknowns this probe targeted all clear:

1. **Determinism is real and exact** (seed → bit-identical elev+climate, two cold runs). ✅
2. **VRAM fits with headroom** — 1.16 GB at fp16 on a 4 GB card, leaving room for Rapier +
   `deno_webgpu` renderer. ✅
3. **Latency is compatible with *off-loop, contiguous* streaming.** ✅ (with the caveats below)

**Latency reality check (load-bearing):**
- A 256² tile is **7.68 km across**. At amortized **~0.87 s/tile** for contiguous regions,
  a background worker prefetching ahead of a *walking/driving* agent stays comfortably
  ahead — this matches the spike's off-loop/async/streamed design (never inline in `render()`).
- It is **NOT** viable for per-frame/inline generation, instant teleport-and-see, or fast
  aerial traversal without aggressive prefetch + a warm tile cache. Worst-case random access
  (5.5 s/tile fp16) would visibly pop-in if an agent teleports far.

**Recommendations for S1:**
- Use **fp16** (≈2× faster than fp32, half the VRAM, still bit-exact here).
- Prefetch **contiguous** windows around the agent (LOD/stream via the Phase 3 spatial op);
  do not random-access isolated tiles — the coarse-cache amortization is the difference
  between 0.87 s and 5.5 s per tile.
- `torch.compile` was **left off** (`--no-compile`) for these numbers; it may improve further
  but is untested. ONNX export also exists (`terrain_diffusion onnx-export`) for the S2 path.
- The model emits **climate** for free alongside elevation — wire it straight into the
  perception substrate (`terrain.sampleClimate`).

**Shelve-instead-of-greenlight would apply only if** we needed inline/per-frame terrain or
fast free-flight without prefetch — neither is the spike's design. As a **bounded, off-loop,
deterministic** worldgen pillar, it earns its place.

---

## Reproduce / finish later

Everything is staged and validated under this directory. See `README.md` for the exact
from-scratch commands. Quick re-run:

```bash
TD_SRC=/tmp/terrain-diffusion-src ./run.sh          # 2 cold runs + determinism diff
# or directly:
cd /tmp/terrain-diffusion-src && TD_SRC=$PWD \
  /…/spikes/s0-terrain-diffusion/.venv/bin/python /…/run.py \
  --seed 4242 --tiles 4 --tile 256 --dtype fp16 --model /…/weights
```

Artifacts present: `.venv/` (cu130 torch + inference deps), `weights/` (1.1 GB snapshot),
`run.py`, `run.sh`, `README.md`. Cloned source + conditioning data at `/tmp/terrain-diffusion-src`
(re-clone + re-fetch WorldClim per README if that scratch dir is gone).
