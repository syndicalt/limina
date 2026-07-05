#!/usr/bin/env bash
# rig-character.sh — one-command wrapper for the non-Adobe Blender auto-rigger.
#   tools/rig/rig-character.sh <in.glb> <out.glb> [height=1.75]
# Turns a STATIC humanoid GLB (e.g. a 3D AI Studio image-to-3D body) into a RIGGED + ANIMATED GLB
# (Idle/Walk) that world/character-body.ts consumes. Set BLENDER_BIN to override the Blender binary.
set -euo pipefail
IN="${1:?usage: rig-character.sh <in.glb> <out.glb> [height]}"
OUT="${2:?usage: rig-character.sh <in.glb> <out.glb> [height]}"
HEIGHT="${3:-1.75}"
HERE="$(cd "$(dirname "$0")" && pwd)"

BLENDER="${BLENDER_BIN:-}"
if [ -z "$BLENDER" ]; then
  for cand in blender \
    "$HOME"/blender-*/blender \
    /opt/blender*/blender; do
    if command -v "$cand" >/dev/null 2>&1 || [ -x "$cand" ]; then BLENDER="$cand"; break; fi
  done
fi
[ -n "$BLENDER" ] || { echo "rig-character: no blender found (set BLENDER_BIN)"; exit 2; }

exec "$BLENDER" --background --factory-startup --python "$HERE/auto_rig.py" -- \
  --in "$IN" --out "$OUT" --height "$HEIGHT"
