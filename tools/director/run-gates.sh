#!/usr/bin/env bash
# AGGREGATE GATE RUNNER — the CI-in-a-script the repo lacked. Runs the full headless js/test suite
# through the limina binary, then the host-side pipeline gates, and exits non-zero on ANY failure.
# Self-locating; run from anywhere:  bash tools/director/run-gates.sh [--quick]
#
#   --quick : run only the game-director gates (p20..p27) + host gates, skipping the full js/test sweep.
#
# Tests that need external services we can't drive here (ollama, an MCP server, a WS peer) are SKIPPED
# and reported as such — never silently counted as passing.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"

BIN="./target/release/limina"
[ -x "$BIN" ] || { echo "FATAL: $BIN not built (cargo build --release)"; exit 1; }

QUICK=0; [ "${1:-}" = "--quick" ] && QUICK=1

pass=0; fail=0; skip=0; failed=()

run_test() {
  local t="$1" name out rc; name="$(basename "$t" .ts)"
  case "$name" in
    *ollama*|mcp_*|*_ws|*_ws_*|p4_multi_client*) skip=$((skip+1)); return;;  # need external services
  esac
  out="$(LIMINA_AUDIO=null timeout 240 "$BIN" "$t" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then pass=$((pass+1)); return; fi
  # A non-zero exit is NOT a regression when the test inherently can't run in this headless,
  # network-less environment, or is a deliberate negative test — classify those as SKIP, not FAIL:
  #   - GPU/windowed tests (createEngine → "no WindowTarget" / "no WebGPU adapter")
  #   - tests needing a local worker/service ("not ready after N tries")
  #   - the source-map probe that throws on purpose ("intentional failure for source-map")
  if echo "$out" | grep -qiE "no WindowTarget|no WebGPU adapter|not ready after [0-9]+ tries|intentional failure for source-map"; then
    skip=$((skip+1))
  else
    fail=$((fail+1)); failed+=("$name")
  fi
}

echo "== js/test suite =="
if [ "$QUICK" = "1" ]; then
  for t in js/test/p2[0-7]_*.ts; do [ -f "$t" ] && run_test "$t"; done
else
  for t in js/test/*.ts; do run_test "$t"; done
fi
echo "   js/test: $pass passed, $fail failed, $skip skipped"
[ ${#failed[@]} -gt 0 ] && printf '   FAILED: %s\n' "${failed[*]}"

# ---- host-side gates (skip gracefully when their tools are absent) ----
hostfail=0
echo "== host gates =="

if command -v bun >/dev/null 2>&1; then
  if bun run tools/director/check-gds.ts >/dev/null 2>&1; then echo "   check-gds: PASS"; else echo "   check-gds: FAIL"; hostfail=1; fi
else echo "   check-gds: SKIP (no bun)"; fi

if node tools/director/engine-browser-gate.mjs >/dev/null 2>&1; then echo "   engine-browser-gate: PASS"
else rc=$?; if [ $rc -eq 2 ]; then echo "   engine-browser-gate: SKIP (no chromium)"; else echo "   engine-browser-gate: FAIL"; hostfail=1; fi; fi

if [ -n "${LLMFF_BIN:-}" ] || command -v llmff >/dev/null 2>&1; then
  if node tools/director/check-slice-builder.mjs >/dev/null 2>&1; then echo "   check-slice-builder: PASS"
  else rc=$?; if [ $rc -eq 2 ]; then echo "   check-slice-builder: SKIP"; else echo "   check-slice-builder: FAIL"; hostfail=1; fi; fi
else echo "   check-slice-builder: SKIP (no llmff; set LLMFF_BIN)"; fi

# Design-quality gate (gamestack procgen-review, executed): the silhouette gate's own falsifiability —
# distinct assets PASS, a clone-heavy "oatmeal" set HARD-FAILS. Needs a real GPU + chromium.
if node gates/design/check.mjs >/dev/null 2>&1; then echo "   design-gate (silhouette): PASS"
else rc=$?; if [ $rc -eq 2 ]; then echo "   design-gate (silhouette): SKIP (no chromium)"; else echo "   design-gate (silhouette): FAIL"; hostfail=1; fi; fi
# GDS-level design gate: scores a game's content by tier (well-art-directed PASSES, samey HARD-FAILS).
if node gates/design/gds-gate-check.mjs >/dev/null 2>&1; then echo "   design-gate (gds tiers): PASS"
else rc=$?; if [ $rc -eq 2 ]; then echo "   design-gate (gds tiers): SKIP (no chromium)"; else echo "   design-gate (gds tiers): FAIL"; hostfail=1; fi; fi

echo "== summary =="
echo "   js/test: $pass passed / $fail failed / $skip skipped; host gates: $([ $hostfail -eq 0 ] && echo OK || echo FAIL)"
[ $fail -eq 0 ] && [ $hostfail -eq 0 ] && { echo "ALL GATES GREEN"; exit 0; } || { echo "GATES RED"; exit 1; }
