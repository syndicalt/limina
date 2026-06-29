#!/usr/bin/env bash
# Assemble a self-contained desktop distributable of a limina game: the native binary + the engine
# sources (the runtime transpiles .ts at launch) + a chosen game entry + a launcher. Produces dist/desktop/.
# Usage: tools/package-desktop.sh [js/src/demos/<game>_window.ts]
set -euo pipefail
GAME="${1:-js/src/demos/capstone_window.ts}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/desktop"
[ -x "$ROOT/target/release/limina" ] || { echo "build first: cargo build --release" >&2; exit 1; }
[ -f "$ROOT/$GAME" ] || { echo "no such game: $GAME" >&2; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT/app"
cp "$ROOT/target/release/limina" "$OUT/limina"
[ -d "$ROOT/assets" ] && cp -r "$ROOT/assets" "$OUT/assets"
# engine sources the runtime imports/transpiles at launch (exclude tests + node_modules to stay lean)
rsync -a --exclude node_modules --exclude test "$ROOT/js/" "$OUT/app/js/" 2>/dev/null || cp -r "$ROOT/js" "$OUT/app/js"
cat > "$OUT/run.sh" <<EOF
#!/usr/bin/env bash
cd "\$(dirname "\$0")"
exec ./limina --window "app/$GAME"
EOF
chmod +x "$OUT/run.sh" "$OUT/limina"
echo "packaged $GAME → $OUT ($(du -sh "$OUT" | cut -f1)); launch: $OUT/run.sh"
