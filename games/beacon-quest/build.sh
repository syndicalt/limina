#!/usr/bin/env bash
# Build the beacon-quest web target: export the scene world, relocate it, bundle the entry.
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root
BUILDER="${1:-games/beacon-quest/build/scene.ts}"
echo "[1/2] export scene → $BUILDER"
./target/release/limina "$BUILDER"
mkdir -p games/beacon-quest/web/public/worlds/beacon
rm -f games/beacon-quest/web/public/worlds/beacon/*
for f in traces/beacon.*; do base=$(basename "$f" | sed 's/^beacon\.//'); cp -f "$f" games/beacon-quest/web/public/worlds/beacon/"$base"; done
echo "[2/2] bundle entry"
js/node_modules/.bin/esbuild games/beacon-quest/web/main.ts --bundle --format=esm --platform=browser \
  --outfile=games/beacon-quest/web/public/main.js --loader:.ts=ts --log-level=warning
echo "done → games/beacon-quest/web"
