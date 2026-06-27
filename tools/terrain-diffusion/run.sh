#!/usr/bin/env bash
# End-to-end launcher for the terrain-diffusion -> limina /tile path (S1 UAT).
#
#   1. start the real terrain-diffusion service  (GET /terrain, GET /health; fixed --seed)
#   2. start the reference shim                   (POST /tile, POST /health -> /terrain)
#   3. point a limina demo at the shim            (ModelTerrainSource baseUrl = the shim)
#
# Needs a GPU box with `terrain_diffusion` installed (UAT — not runnable here). Override any
# knob via env, e.g.  SEED=42 SCALE=8 ./run.sh
set -euo pipefail

SEED="${SEED:-1234}"                 # the model world seed (== shim --region-seed == demo SEED)
SCALE="${SCALE:-1}"                  # model oversample at lod 0 (m/px = 30/SCALE)
MODEL="${MODEL:-xandergos/terrain-diffusion-30m}"
TD_HOST="${TD_HOST:-127.0.0.1}"
TD_PORT="${TD_PORT:-8000}"           # terrain-diffusion service
SHIM_HOST="${SHIM_HOST:-127.0.0.1}"
SHIM_PORT="${SHIM_PORT:-8917}"       # the shim == ModelTerrainSource default baseUrl
PYTHON="${PYTHON:-python}"
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

echo "[run] starting terrain-diffusion (seed=$SEED) on $TD_HOST:$TD_PORT …"
$PYTHON -m terrain_diffusion.inference.api "$MODEL" \
  --seed "$SEED" --host "$TD_HOST" --port "$TD_PORT" &
pids+=($!)
wait_health "http://$TD_HOST:$TD_PORT/health"
echo "[run] terrain-diffusion healthy."

echo "[run] starting shim on $SHIM_HOST:$SHIM_PORT -> http://$TD_HOST:$TD_PORT …"
$PYTHON "$HERE/shim.py" \
  --target-url "http://$TD_HOST:$TD_PORT" \
  --region-seed "$SEED" --scale "$SCALE" \
  --host "$SHIM_HOST" --port "$SHIM_PORT" &
pids+=($!)
wait_health "http://$SHIM_HOST:$SHIM_PORT/health"
echo "[run] shim healthy."

echo "[run] launching limina demo (set its SEED=$SEED, METERS_PER_PX = 30/$SCALE)…"
cd "$REPO"
./target/release/limina --window js/src/demos/model_terrain_window.ts

# demo exit -> trap cleans up both services.
