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

QUICK=0; for a in "$@"; do [ "$a" = "--quick" ] && QUICK=1; done

# HEADLESS: on a runner with no GPU/window/chromium (CI), a NAMED allowlist of
# hardware-requiring checks is skipped — announced, never silent. Every logic /
# replay / determinism gate still runs and must pass, so a real regression cannot
# hide here (this is a specific hardware allowlist, not error-text guessing).
# Triggered by --headless, LIMINA_HEADLESS, or CI (GitHub sets CI=true).
HEADLESS=0
for a in "$@"; do [ "$a" = "--headless" ] && HEADLESS=1; done
[ -n "${LIMINA_HEADLESS:-}" ] && HEADLESS=1
[ -n "${CI:-}" ] && HEADLESS=1
# js/test that open a native window or need a real WebGPU adapter / readback:
HEADLESS_TESTS=" m0_seams p0_4_cube s4_window s3_offscreen p8_browser_runtime p3_fidelity_readback p3_showcase_window p3_textured_gltf_window p5_text_substrate "

pass=0; fail=0; skip=0; failed=(); skipped=()

# A SKIP is never silent: every skipped test is announced on stderr with the reason it matched, and the
# full list is echoed in the summary — so a real regression can't hide behind an environmental skip.
record_skip() { # <name> <reason>
  skip=$((skip+1)); skipped+=("$1")
  echo "   SKIP: $1 — $2" >&2
}

run_test() {
  local t="$1" name out rc reason mline; name="$(basename "$t" .ts)"
  case "$name" in
    *ollama*|mcp_*|*_ws|*_ws_*|p4_multi_client*) record_skip "$name" "needs external service (ollama/mcp/ws)"; return;;
  esac
  if [ "$HEADLESS" = 1 ] && [[ "$HEADLESS_TESTS" == *" $name "* ]]; then
    record_skip "$name" "needs GPU/window (headless runner)"; return
  fi
  out="$(LIMINA_AUDIO=null timeout 240 "$BIN" "$t" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then pass=$((pass+1)); return; fi
  # (c) EXPLICIT opt-in skip: a test that prints a line starting with __LIMINA_SKIP__ self-declares an
  # environmental skip. PREFER this over error-text matching — it's auditable and can't be forged by a
  # regression that merely happens to print a known startup phrase.
  if reason="$(echo "$out" | grep -m1 '^__LIMINA_SKIP__')"; then
    record_skip "$name" "self-declared${reason#__LIMINA_SKIP__}"
    return
  fi
  # (d) exit code 2 is the reserved "can't run here" signal → SKIP; any other non-zero is a real FAIL,
  # unless it matches one of the specific, ANCHORED startup lines below.
  if [ "$rc" -eq 2 ]; then
    record_skip "$name" "exit code 2 (environmental)"
    return
  fi
  # (a) Legacy environmental/negative startup failures classified as SKIP. The patterns are ANCHORED to
  # the specific startup lines (createEngine GPU/window, the model worker not coming up, the source-map
  # probe) — line start or a "prefix: " boundary — so a regression whose message merely CONTAINS one of
  # these phrases mid-sentence still counts as a FAIL, not a silent SKIP.
  if mline="$(echo "$out" | grep -m1 -iE '(^|: )no (WindowTarget|WebGPU adapter)|worker at .+ not ready after [0-9]+ tries|(^|: )intentional failure for source-map')"; then
    record_skip "$name" "matched startup line: ${mline}"
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
[ ${#skipped[@]} -gt 0 ] && printf '   SKIPPED: %s\n' "${skipped[*]}"

# ---- host-side gates (skip gracefully when their tools are absent) ----
hostfail=0
echo "== host gates =="

# Determinism guard: the skills layer must stay RNG-/wall-clock-free (no Date.now/Math.random/
# performance.now in js/src/skills/*.ts). Pure lexical scan — always runnable, no display needed.
if node js/scripts/check-determinism.mjs >/dev/null 2>&1; then echo "   check-determinism: PASS"; else echo "   check-determinism: FAIL"; hostfail=1; fi

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
if [ "$HEADLESS" = 1 ]; then echo "   design-gate (silhouette): SKIP (headless: needs GPU/chromium)"
elif node gates/design/check.mjs >/dev/null 2>&1; then echo "   design-gate (silhouette): PASS"
else rc=$?; if [ $rc -eq 2 ]; then echo "   design-gate (silhouette): SKIP (no chromium)"; else echo "   design-gate (silhouette): FAIL"; hostfail=1; fi; fi
# GDS-level design gate: scores a game's content by tier (well-art-directed PASSES, samey HARD-FAILS).
if [ "$HEADLESS" = 1 ]; then echo "   design-gate (gds tiers): SKIP (headless: needs GPU/chromium)"
elif node gates/design/gds-gate-check.mjs >/dev/null 2>&1; then echo "   design-gate (gds tiers): PASS"
else rc=$?; if [ $rc -eq 2 ]; then echo "   design-gate (gds tiers): SKIP (no chromium)"; else echo "   design-gate (gds tiers): FAIL"; hostfail=1; fi; fi
# Packager: a direct-path game is rejected; a record+export world packs into a self-contained release
# that RENDERS non-blank in the real engine.
if node packager/check.mjs >/dev/null 2>&1; then echo "   packager: PASS"
else rc=$?; if [ $rc -eq 2 ]; then echo "   packager: SKIP (no chromium/demo world)"; else echo "   packager: FAIL"; hostfail=1; fi; fi

# Playable-build smoke: the pipeline gates the thing you actually PLAY (the native window build loads
# its full graph + game + shared dressed field), not just the headless sim. Display-independent.
if [ "$HEADLESS" = 1 ]; then echo "   playable-smoke (beacon window): SKIP (headless: needs GPU)"
elif node games/beacon-quest/smoke-playable.mjs >/dev/null 2>&1; then echo "   playable-smoke (beacon window): PASS"
else echo "   playable-smoke (beacon window): FAIL"; hostfail=1; fi

# DOGFOOD (the integration capstone): one real game (Beacon Run) through EVERY stage —
# functional gate → design gate → export → package → render-verified release. Heavy (renders +
# replays), so it's last and SKIPs without chromium/GPU. This is the end-to-end "the machine works" gate.
if node games/beacon-quest/dogfood.mjs >/dev/null 2>&1; then echo "   dogfood (beacon end-to-end): PASS"
else rc=$?; if [ $rc -eq 2 ]; then echo "   dogfood (beacon end-to-end): SKIP (no chromium/GPU)"; else echo "   dogfood (beacon end-to-end): FAIL"; hostfail=1; fi; fi

echo "== summary =="
echo "   js/test: $pass passed / $fail failed / $skip skipped; host gates: $([ $hostfail -eq 0 ] && echo OK || echo FAIL)"
[ ${#skipped[@]} -gt 0 ] && printf '   SKIPPED (%d): %s\n' "$skip" "${skipped[*]}"
[ $fail -eq 0 ] && [ $hostfail -eq 0 ] && { echo "ALL GATES GREEN"; exit 0; } || { echo "GATES RED"; exit 1; }
