#!/usr/bin/env bash
# S0 probe driver for InfiniteDiffusion (xandergos/terrain-diffusion-30m).
# Runs the harness TWICE with the same seed in two separate (cold) processes,
# then byte-compares the dumped first tile to verify determinism.
#
# Prereqs (see README.md): .venv built, weights/ downloaded, and the cloned repo
# at TD_SRC providing the conditioning data under data/global/ (etopo_10m.tif +
# WorldClim bio tifs). The conditioning code reads those via RELATIVE paths, so
# the harness MUST run with CWD = TD_SRC.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

SEED="${SEED:-1234}"
TILES="${TILES:-8}"
TILE="${TILE:-256}"
export TD_SRC="${TD_SRC:-/tmp/terrain-diffusion-src}"
PY="$HERE/.venv/bin/python"
WEIGHTS="$HERE/weights"

run() {  # $1 = out-prefix
  ( cd "$TD_SRC" && TD_SRC="$TD_SRC" "$PY" "$HERE/run.py" \
      --seed "$SEED" --tiles "$TILES" --tile "$TILE" \
      --model "$WEIGHTS" --out "$HERE/$1" )
}

echo "=== RUN A (seed=$SEED) ===" ; run runA | tee "$HERE/runA.log"
echo "=== RUN B (seed=$SEED, cold reload) ===" ; run runB | tee "$HERE/runB.log"

echo "=== DETERMINISM (same seed, two cold runs) ==="
"$PY" - "$HERE" <<'PY'
import sys, numpy as np
h = sys.argv[1]
a = np.load(f"{h}/runA.npz"); b = np.load(f"{h}/runB.npz")
ea, eb = a["elev"], b["elev"]
print(f"elev identical: {np.array_equal(ea, eb)}   "
      f"max|Δ|: {float(np.max(np.abs(ea-eb))) if ea.shape==eb.shape else 'shape-mismatch'}   "
      f"shape: {ea.shape}")
if "climate" in a and a["climate"].size:
    ca, cb = a["climate"], b["climate"]
    print(f"climate identical: {np.array_equal(ca, cb)}   max|Δ|: {float(np.max(np.abs(ca-cb)))}")
PY
