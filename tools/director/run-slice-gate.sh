#!/usr/bin/env bash
# llmff op:tool shim — runs the REAL limina functional gate for a slice and emits ONLY the JSON
# verdict on stdout (so llmff's validate_json stage can consume it). Self-locating: resolves the
# repo root from its own path, so it works regardless of llmff's working directory.
#
# The codegen text llmff pipes on stdin is consumed + ignored (in production it would be the written
# game code; here the gate runs the reference game). SLICE_GATE_SCRIPT selects the passing or broken
# gate (for the falsifiability check).
set -euo pipefail
# llmff runs tool commands with a minimal environment; restore a usable PATH so the coreutils +
# the limina binary resolve.
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

# Drain stdin (the upstream codegen output) without failing if it's empty/closed.
cat >/dev/null 2>&1 || true

SCRIPT="${SLICE_GATE_SCRIPT:-js/scripts/slice-gate.ts}"
OUT="$(cd "$ROOT" && ./target/release/limina "$SCRIPT" 2>/dev/null || true)"

# Extract the single sentinel-wrapped verdict line and strip the sentinel → bare JSON.
echo "$OUT" | grep -o '__SLICE_VERDICT__.*' | sed 's/__SLICE_VERDICT__//' | head -1
