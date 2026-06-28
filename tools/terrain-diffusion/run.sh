#!/usr/bin/env bash
# End-to-end launcher for the terrain-diffusion -> limina /tile path (S1 UAT).
#
#   1. start the real terrain-diffusion service  (GET /terrain, GET /health; fixed --seed)
#   2. start the reference shim                   (POST /tile, POST /health -> /terrain)
#   3. point a limina demo at the shim            (ModelTerrainSource baseUrl = the shim)
#
# Needs a GPU box where `terrain_diffusion` runs. The package is NOT pip-installable as a module;
# it runs IN-PLACE from its cloned repo (TD_REPO), so we launch the service with that as cwd.
# The chosen PYTHON must have the inference deps (torch+CUDA, flask, rasterio, diffusers, einops,
# omegaconf, infinite-tensor, … see $TD_REPO/requirements.txt). Override any knob via env, e.g.
#   TD_PYTHON=~/miniconda3/envs/td/bin/python SEED=42 SCALE=8 ./run.sh
set -euo pipefail

SEED="${SEED:-1234}"                 # the model world seed (== shim --region-seed == demo SEED)
SCALE="${SCALE:-1}"                  # model oversample at lod 0 (m/px = 30/SCALE)
# World-pixel origin: the model world is INFINITE and (0,0) for seed 1234 is open ocean (~-1000 m
# → flat). Anchor limina tile (0,0) on LAND. (8800,-6300) is the spike's terrain_big hero (coast +
# mountains). Override for a different locale, e.g. ORIGIN_I=0 ORIGIN_J=0 for the ocean.
ORIGIN_I="${ORIGIN_I:-8800}"
ORIGIN_J="${ORIGIN_J:--6300}"
MODEL="${MODEL:-xandergos/terrain-diffusion-30m}"
TD_HOST="${TD_HOST:-127.0.0.1}"
TD_PORT="${TD_PORT:-8000}"           # terrain-diffusion service
SHIM_HOST="${SHIM_HOST:-127.0.0.1}"
SHIM_PORT="${SHIM_PORT:-8917}"       # the shim == ModelTerrainSource default baseUrl
TD_REPO="${TD_REPO:-$HOME/terrain-diffusion}"   # the cloned model repo (cwd for the service)
# PYTHON runs the service (needs cwd=$TD_REPO + the inference deps); SHIM_PYTHON runs the shim
# (needs flask+numpy+requests only). Default both to PYTHON, default PYTHON to `python`.
PYTHON="${TD_PYTHON:-${PYTHON:-python}}"
SHIM_PYTHON="${SHIM_PYTHON:-$PYTHON}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

wait_health() { # url
  for _ in $(seq 1 120); do
    if curl -fsS "$1" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "timed out waiting for $1" >&2; return 1
}

# --- preflight: fail early + clearly on a bad env, instead of a deep traceback ----------------
[ -d "$TD_REPO/terrain_diffusion" ] || {
  echo "ERROR: terrain-diffusion repo not found at TD_REPO=$TD_REPO" >&2
  echo "       clone it (git clone https://github.com/xandergos/terrain-diffusion) and/or set TD_REPO=/path/to/it" >&2
  exit 1
}
if ! ( cd "$TD_REPO" && "$PYTHON" -c "import terrain_diffusion, flask, numpy" ) 2>/dev/null; then
  echo "ERROR: '$PYTHON' can't import the terrain-diffusion inference deps (run from $TD_REPO)." >&2
  echo "       Missing modules:" >&2
  ( cd "$TD_REPO" && "$PYTHON" - <<'PY' >&2
import importlib.util as u
need = ["torch","flask","numpy","rasterio","diffusers","einops","omegaconf","infinite_tensor",
        "pyfastnoiselite","click","safetensors","scipy","tqdm"]
miss = [m for m in need if u.find_spec(m) is None]
print("        " + (", ".join(miss) if miss else "(terrain_diffusion import itself failed — check $TD_REPO/cwd)"))
PY
  )
  echo "       Install into a CUDA-torch env, e.g.:" >&2
  echo "         conda create -n td python=3.11 && conda activate td" >&2
  echo "         pip install -r $TD_REPO/requirements.txt   # or the lean inference subset" >&2
  echo "       then re-run with  TD_PYTHON=\$(which python) $0" >&2
  exit 1
fi
echo "[run] preflight OK ($PYTHON can import terrain_diffusion from $TD_REPO)"

echo "[run] starting terrain-diffusion (seed=$SEED) on $TD_HOST:$TD_PORT  [cwd=$TD_REPO] …"
( cd "$TD_REPO" && exec "$PYTHON" -m terrain_diffusion.inference.api "$MODEL" \
    --seed "$SEED" --host "$TD_HOST" --port "$TD_PORT" ) &
pids+=($!)
wait_health "http://$TD_HOST:$TD_PORT/health"
echo "[run] terrain-diffusion healthy."

echo "[run] starting shim on $SHIM_HOST:$SHIM_PORT -> http://$TD_HOST:$TD_PORT …"
"$SHIM_PYTHON" "$HERE/shim.py" \
  --target-url "http://$TD_HOST:$TD_PORT" \
  --region-seed "$SEED" --scale "$SCALE" \
  --origin-i "$ORIGIN_I" --origin-j "$ORIGIN_J" \
  --host "$SHIM_HOST" --port "$SHIM_PORT" &
pids+=($!)
wait_health "http://$SHIM_HOST:$SHIM_PORT/health"
echo "[run] shim healthy."

echo "[run] launching limina demo (set its SEED=$SEED, METERS_PER_PX = 30/$SCALE)…"
cd "$REPO"
./target/release/limina --window js/src/demos/model_terrain_window.ts

# demo exit -> trap cleans up both services.
