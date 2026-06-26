# S0 — InfiniteDiffusion terrain probe (RTX 3050)

Time-boxed S0 probe for **Phase 9 worldgen** (see
`plans/worldgen-terrain-diffusion-spike.md`). Goal: run `xandergos/terrain-diffusion-30m`
(*InfiniteDiffusion*, SIGGRAPH '26) **as published**, out of process, on the real
target GPU, and measure **ms/tile, VRAM, and determinism**. No engine integration.

See **`RESULT.md`** for measurements / blocker and the go/no-go.

## What the candidate actually is

- `pip install terrain-diffusion` is a **2.4 kB empty stub** (v0.0.1, "under development") — ignore it.
- Real code: the GitHub repo **`xandergos/terrain-diffusion`** (default branch `master`).
  Run via `python -m terrain_diffusion <subcommand>` (`api`, `generate`, `explore`,
  `tiff-export`, …). There is **no installable package / pyproject** — you run it
  from the cloned repo root (it reads conditioning data via *relative* paths).
- Weights (HF, **not gated**, ~1.14 GB total): `base_model` 1015 MB +
  `decoder_model` 112 MB + `coarse_model` 11 MB (`.safetensors`).
- Native resolution **30 m/px**. Output per tile: `elev` (meters, int16) +
  4-channel climate (temp, temp-seasonality, precip, precip-CV ≈ WorldClim BIO1/4/12/15).
- Conditioning: a Perlin **synthetic map** quantile-matched to global rasters.
  Requires `data/global/etopo_10m.tif` (**committed in the repo**, 9.3 MB) and the
  WorldClim `wc2.1_10m_bio_{1,4,12,15}.tif` (auto-downloaded, ~48 MB zip from UC Davis).
  First run computes `data/global/synthetic_map_stats.json` and caches it.

## Layout

```
run.py      # harness: drives WorldPipeline.get(), measures ms/tile + VRAM, dumps a tile
run.sh      # runs run.py twice (same seed, cold) and byte-compares for determinism
weights/    # HF snapshot of terrain-diffusion-30m (download step below)
.venv/      # python env (inherits system cu130 torch via --system-site-packages)
RESULT.md   # findings + go/no-go
```

## Reproduce from scratch

```bash
# 0. target box already has: NVIDIA RTX 3050 (4 GB), CUDA torch 2.12.0+cu130
#    at /home/cheapseatsecon/miniconda3/bin/python3 (Python 3.13)

# 1. clone the real repo (provides the CLI + conditioning data under data/global)
git clone https://github.com/xandergos/terrain-diffusion /tmp/terrain-diffusion-src

# 2. fetch WorldClim conditioning rasters (etopo is already in the repo)
cd /tmp/terrain-diffusion-src/data/global
curl -sL https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_10m_bio.zip -o wc.zip
python -m zipfile -e wc.zip . && rm wc.zip   # -> wc2.1_10m_bio_{1,4,12,15}.tif

# 3. env: reuse the system cu130 torch, add the inference-only deps
cd <this dir>
/home/cheapseatsecon/miniconda3/bin/python3 -m venv --system-site-packages .venv
. .venv/bin/activate
pip install --no-deps --index-url https://download.pytorch.org/whl/cu130 torchvision  # 0.27.x+cu130
pip install flask h5py diffusers numba scikit-image matplotlib \
            ema-pytorch infinite-tensor "pyfastnoiselite==0.0.6" rasterio

# 4. weights (~1.14 GB, not gated)
python -c "from huggingface_hub import snapshot_download as s; \
           s('xandergos/terrain-diffusion-30m', local_dir='weights')"

# 5. measure (runs twice, same seed, cold -> determinism check)
TD_SRC=/tmp/terrain-diffusion-src ./run.sh
```

NOTE: requirements.txt in the repo lists ~35 packages incl. cartopy / rasterio /
earthengine-api / wandb / optuna — those are **training + data-pipeline** deps.
The inference path needs only the curated subset in step 3 (rasterio + pyfastnoiselite
are pulled transitively by the conditioning module `synthetic_map.py`).

## Knobs

`SEED`, `TILES`, `TILE` (native px) env vars for `run.sh`; `run.py --help` for the rest
(`--dtype fp32|bf16|fp16`, `--stride`, `--device`).
