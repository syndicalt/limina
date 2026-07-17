#!/usr/bin/env bash
# AGGREGATE GATE RUNNER — the CI-in-a-script the repo lacked. Runs the full headless js/test suite
# through the limina binary (host-flavored js/test files run under bun — see runner dispatch below),
# then the host-side pipeline gates, and exits non-zero on ANY failure.
# Self-locating; run from anywhere:  bash tools/director/run-gates.sh [--quick]
#
#   --quick : run the game-director gates (p20..p27) plus the determinism core (p4_* and the
#             p7x determinism gates), skipping the rest of the js/test sweep.
#
# Tests that need external services we can't drive here (ollama, a model worker) are SKIPPED
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
HEADLESS_TESTS=" m0_seams p0_4_cube s4_window s3_offscreen p8_browser_runtime p3_fidelity_readback p3_showcase_window p3_textured_gltf_window p5_text_substrate p_material_surface_gpu p_grass_field_gpu p_grass_field_stream_gpu p_biome_surface_gpu p_gpu_surface_probe "

# Tests whose committed evidence records repo-root-relative asset paths ("assets/...")
# — they must run with the asset root at the REPO ROOT, matching the capture harnesses
# (tools/preview/*) that produced the evidence. Named allowlist, not error guessing.
REPO_ROOTED_TESTS=" p_building_production_review_scene p_asset_place_collider_lifecycle p_ktx2_production_prewarm p_building_production_review_authority p_building_production_review_site_fit p_building_production_package p_native_wasm_compile_sync p_native_wasm_compile p_native_basis_init p_building_fire_review_scene_v2 p_building_fire_volumetric_binding "

# The determinism core added to --quick: worldlog replay/durability/recovery, policy/audit/
# isolation, packaging, plus the p7x layout/geometry/scatter/grass determinism gates.
QUICK_DETERMINISM_GLOBS=(js/test/p4_*.ts
  js/test/p76_village_layout_determinism.ts
  js/test/p77_village_geometry_determinism.ts
  js/test/p78_scatter_exclusion_determinism.ts
  js/test/p79_grass_exclusion_determinism.ts
  js/test/p101_worldlog_chain_ops.ts
  js/test/p102_ctx_rng_context_independence.ts
  js/test/p103_partial_failure_atomicity.ts
  js/test/p104_snapshot_participants.ts)

pass=0; fail=0; skip=0; failed=(); skipped=()

# A SKIP is never silent: every skipped test is announced on stderr with the reason it matched, and the
# full list is echoed in the summary — so a real regression can't hide behind an environmental skip.
record_skip() { # <name> <reason>
  skip=$((skip+1)); skipped+=("$1")
  echo "   SKIP: $1 — $2" >&2
}

record_failure() { # <name> <captured output>
  fail=$((fail+1)); failed+=("$1")
  echo "   FAIL: $1" >&2
  printf '%s\n' "$2" | sed 's/^/      /' >&2
}

run_test() {
  local t="$1" name out rc skipline reason; name="$(basename "$t" .ts)"
  case "$name" in
    *ollama*) record_skip "$name" "needs external service (ollama)"; return;;
    p9_model_real_tile|p9_model_source_http) record_skip "$name" "needs external terrain-model worker"; return;;
    # Authoring utilities that live in js/test but are not gates: sweeping them as
    # passing tests inflated the pass count with vacuous greens.
    _dump_quest_scene|_dump_siege_scene|w0_native_dump) record_skip "$name" "authoring utility, not a gate"; return;;
    # Parameterized authoring gates: they REQUIRE argv (a candidate GLB/authority) and
    # print usage + exit 1 without one. Run them from their authoring pipelines.
    p_architecture_shell_artifact|p_architecture_furniture_pack|p_furniture_pack_review_scene)
      record_skip "$name" "parameterized authoring gate (requires argv); run from its pipeline"; return;;
    # bun:test-shaped review scenes whose filenames the bun test runner refuses; they
    # have no working harness today. Announced so the gap stays visible.
    p_staged_material_review_scene|p_staged_interior_proxy_review_scene)
      record_skip "$name" "needs a bun test harness (filename not *test*); runner wiring pending"; return;;
    # Vegetation-scatter gates: their real prerequisite is the ACCEPTED oak asset trio
    # (source + LOD + Blender-baked impostor), not Blender itself. When the trio exists
    # they run right here; tree-scatter-integration (host gate below) additionally
    # exercises them against a freshly baked chain when Blender IS present.
    p_tree_asset_scatter|p_tree_vegetation_scatter|p_tree_biome_scatter)
      if [ ! -f assets/oak.glb ] || [ ! -f assets/oak-lod.glb ] || [ ! -f assets/oak-impostor.glb ]; then
        record_skip "$name" "accepted oak inputs absent (assets/oak{,-lod,-impostor}.glb; bake via tools/asset/tree-scatter-integration.test.mjs)"; return
      fi;;
  esac
  if [ "$HEADLESS" = 1 ] && [[ "$HEADLESS_TESTS" == *" $name "* ]]; then
    record_skip "$name" "needs GPU/window (headless runner)"; return
  fi

  # RUNNER DISPATCH: js/test/*.ts that import node: builtins are HOST-flavored authoring
  # gates (bun/node), which the limina binary's module loader cannot load ("Only file://
  # URLs are supported" — they exited 1 forever and read as sweep regressions). Run them
  # under bun; announce the environmental skip when bun is absent.
  #
  # KNOWN-RED, PENDING OWNER ADJUDICATION (do NOT re-pin or skip — the failures are
  # honest, and all were verified red at checkpoint ca4c77a, i.e. authored-content
  # drift from the in-flight FB/temperate push, not engine regressions):
  # p_architecture_lod_package, p_functional_hall_house_v4_{asset,quality,rendered_door},
  # p_functional_building_{closure,gorgon_asset,door,iteration,native_traversal},
  # p_fb4_multi_room_review_candidate, p_building_fire_review_scene (v1 byte-pin;
  # v2 + volumetric are repo-rooted and green), p_biome_field_artifact, p_world_terrain_compile
  # pin an earlier authoring cycle; the tree carries a later, mid-review state (the
  # FB-4 candidate's own authority records humanDecision=pending). Re-pinning is the
  # asset owner's decision (CLAUDE.md §7.1); until then these report as real FAILs.
  # Window/GPU family (m0_seams, p0_4_cube, s4_window, p3_*_window, p_*_gpu,
  # p_gpu_surface_probe): red on boxes whose display can't present a wgpu surface —
  # run with LIMINA_HEADLESS=1 there (announced skips), green where presentation works.
  if grep -q 'from "node:' "$t"; then
    if ! command -v bun >/dev/null 2>&1; then
      record_skip "$name" "host-flavored (node:*) authoring gate and bun is absent"; return
    fi
    local cwd="$ROOT"
    [ "$name" = "p_architecture_staged_partition" ] && cwd="$ROOT/js"  # reads ../assets/**
    out="$(cd "$cwd" && timeout 240 bun run "$ROOT/$t" 2>&1)"; rc=$?
  else
    local -a env_extra=()
    [[ "$REPO_ROOTED_TESTS" == *" $name "* ]] && env_extra=(LIMINA_ASSET_ROOT="$ROOT")
    out="$(env LIMINA_AUDIO=null "${env_extra[@]}" timeout 240 "$BIN" "$t" 2>&1)"; rc=$?
  fi

  if [ "$name" = "throw" ]; then
    if [ "$rc" -ne 0 ] \
      && grep -Fq 'Error: intentional failure for source-map check' <<<"$out" \
      && grep -Eq 'throw\.ts:5:[0-9]+' <<<"$out" \
      && grep -Eq 'throw\.ts:9:[0-9]+' <<<"$out" \
      && grep -Eq 'throw\.ts:12:[0-9]+' <<<"$out"; then
      pass=$((pass+1))
    else
      record_failure "$name" "$out"
    fi
    return
  fi
  # Explicit opt-in skip: a test that prints a __LIMINA_SKIP__ line self-declares an
  # environmental skip. The marker alone is NOT enough — the process must also have
  # terminated cleanly (exit 0; the binary cannot emit 2, node/bun gates may): a crash
  # AFTER printing the marker is a FAILURE, not a skip. This is auditable (the marker
  # is grep-able in the test source) and can't be satisfied by a regression's stack.
  skipline="$(printf '%s\n' "$out" | grep -m1 '__LIMINA_SKIP__' || true)"
  if [ -n "$skipline" ]; then
    reason="${skipline#*__LIMINA_SKIP__}"; reason="${reason# }"
    if [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ]; then
      record_skip "$name" "self-declared: ${reason:-no reason given}"
    else
      record_failure "$name" "declared __LIMINA_SKIP__ but exited $rc (a crash cannot self-skip):
$out"
    fi
    return
  fi
  if [ "$rc" -eq 0 ]; then pass=$((pass+1)); return; fi
  # Exit code 2 is the reserved "can't run here" signal. Any other non-zero is a real failure.
  if [ "$rc" -eq 2 ]; then
    record_skip "$name" "exit code 2 (environmental)"
    return
  fi
  record_failure "$name" "$out"
}

echo "== js/test suite =="
if [ "$QUICK" = "1" ]; then
  for t in js/test/p2[0-7]_*.ts "${QUICK_DETERMINISM_GLOBS[@]}"; do [ -f "$t" ] && run_test "$t"; done
else
  for t in js/test/*.ts; do run_test "$t"; done
fi
echo "   js/test: $pass passed, $fail failed, $skip skipped"
[ ${#failed[@]} -gt 0 ] && printf '   FAILED: %s\n' "${failed[*]}"
[ ${#skipped[@]} -gt 0 ] && printf '   SKIPPED: %s\n' "${skipped[*]}"

# ---- host-side gates (skip gracefully when their tools are absent) ----
hostfail=0
echo "== host gates =="

# Uniform host-gate contract: exit 0 = PASS, exit 2 = announced SKIP, anything else =
# FAIL **with the gate's captured output shown** — a failing gate whose evidence goes
# to /dev/null cannot be diagnosed and was the "invisible red" failure mode.
host_gate() { # <label> <skip-note> <cmd...>
  local label="$1" skipnote="$2"; shift 2
  local out rc=0
  out="$("$@" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then echo "   $label: PASS"
  elif [ "$rc" -eq 2 ]; then echo "   $label: SKIP${skipnote:+ ($skipnote)}"
  else
    echo "   $label: FAIL (exit $rc)"
    printf '%s\n' "$out" | tail -n 25 | sed 's/^/      /'
    hostfail=1
  fi
}

# Determinism guard: the skills layer must stay RNG-/wall-clock-free (recursive scan of
# js/src/skills/**/*.ts). Pure lexical scan — always runnable, no display needed.
host_gate "check-determinism" "" node js/scripts/check-determinism.mjs
# ...and the guard's own falsifiability fixture: planted violations must FAIL it.
host_gate "check-determinism (falsifiability)" "" node js/scripts/check-determinism-check.mjs

# Nested-invoke chainId guard: a skill handler that builds a registry invoke base from its
# ctx.* MUST thread `chainId: ctx.chainId`, or the WorldRecorder double-records the nested
# call (replay would apply it twice). Pure lexical scan — always runnable, no display needed.
host_gate "check-nested-invoke" "" node js/scripts/check-nested-invoke.mjs

# Pack-import gate: path safety (rejects traversal/absolute), manifest validation, the three manifest
# merges, recipe expansion, and an end-to-end aethon-conifers recipe bake. Exit 2 = baker deps absent.
host_gate "pack-import-check" "baker deps absent" node tools/design/pack-import-check.mjs

host_gate "check-portability" "" npm --prefix js run check:portability --silent
host_gate "check-live-composition" "" npm --prefix js run check:live --silent
host_gate "check-coordinator-demo" "" npm --prefix js run check:coordinator-demo --silent

# Node-native TypeScript module gate. This file is .mjs and therefore is not part
# of the limina-driven js/test/*.ts sweep above.
host_gate "p69-tree-source" "" node js/test/p69_tree_source.mjs

# Grass strategy guard: old TileGrass/grassSoup/renamed micro-tuft implementations may not return
# in source or any shipped runtime. Mechanical density remains evidence, never a visual verdict.
host_gate "grass-strategy-static" "" node --test tools/material/grass-strategy-static.test.mjs

# js/test static suites (node --test): map/axis-convention (cardinal rule #7), design refs,
# navigation/world-overview artifacts, building material palette, browser wiring statics,
# and the KTX2 package runtime. Previously orphaned from every runner.
host_gate "js static suites (node --test)" "" node --test \
  js/test/browser_camera_framing_static.test.cjs \
  js/test/browser_derived_transaction_static.test.cjs \
  js/test/browser_derived_verify_static.test.cjs \
  js/test/browser_editor_navigation_static.test.cjs \
  js/test/design_ref.test.mjs \
  js/test/map_coordinate_frame.test.mjs \
  js/test/navigation_index_artifact.test.mjs \
  js/test/p_building_material_palette.test.mjs \
  js/test/world_overview_artifact.test.mjs

# Static-opaque retopo funnel: real pinned Blender/Cycles CPU build, deterministic duplicate build,
# fail-closed input boundary, asset-sanity/QC integration, and atomic publication rollback.
if command -v bun >/dev/null 2>&1 && [ -x "${BLENDER_BIN:-$HOME/blender-5.1.2-linux-x64/blender}" ]; then
  host_gate "retopo-static" "" bash -c 'cd tools && bun run test:retopo'
else echo "   retopo-static: SKIP (bun or pinned Blender 5.1.2 absent)"; fi

# A3 force-WebGL proof: compile the bounded TSL POM against the real CC0 pack and compare it to
# an otherwise-identical control from two camera angles. SwiftShader keeps this CI-safe.
host_gate "material-surface-forceWebGL" "no Chromium/Playwright" node tools/material/material-surface-browser-gate.mjs
host_gate "grass-field-forceWebGL" "no Chromium/Playwright" node tools/material/grass-field-browser-gate.mjs

# B2 tree proof: the browser gate compiles the pure-TSL foliage/impostor graph through the real
# forceWebGL backend; the accepted-asset gate CPU-bakes a real oak chain and drives both scatter skills.
host_gate "tree-population-forceWebGL" "no Chromium/Playwright" node tools/material/tree-population-browser-gate.mjs
host_gate "biome-surface-forceWebGL" "no Chromium/Playwright" node tools/material/biome-surface-browser-gate.mjs

# Real generated-river pixel proof: the exact mount/depth-bake/material path must animate, respond
# to shallow/deep terrain, and stay below the measured repetitive-rib autocorrelation ceiling.
host_gate "generated-river-forceWebGL" "no Chromium/Playwright" node tools/material/generated-river-browser-gate.mjs

host_gate "tree-scatter-integration" "accepted oak inputs or pinned Blender absent" node tools/asset/tree-scatter-integration.test.mjs

# Genuine Zaxy/EventLoom integration. It is external by definition, so its absence
# is announced; when available, incompatibility or round-trip failure is fatal.
zaxy_bin="${ZAXY_BIN:-zaxy}"
if command -v "$zaxy_bin" >/dev/null 2>&1; then
  host_gate "eventloom-roundtrip" "" env ZAXY_BIN="$zaxy_bin" LIMINA_BIN="$BIN" node js/test/eventloom_bridge_roundtrip.mjs
else echo "   eventloom-roundtrip: SKIP (no zaxy; set ZAXY_BIN)"; fi

if command -v bun >/dev/null 2>&1; then
  host_gate "check-gds" "" bun run tools/director/check-gds.ts
else echo "   check-gds: SKIP (no bun)"; fi

host_gate "engine-browser-gate" "no chromium" node tools/director/engine-browser-gate.mjs

# Editor gates: the DOM binding is display-independent; live/browser tests run against
# a real editor host and static editor server. Browser tests self-SKIP with exit 2 when
# playwright/chromium is unavailable, but the headless history data-path test still runs.
editor_bundle_ok=0
if npm --prefix js run bundle:editor --silent >/dev/null 2>&1; then
  editor_bundle_ok=1
  echo "   editor bundle: PASS"
else
  echo "   editor bundle: FAIL"
  hostfail=1
fi
if [ "$editor_bundle_ok" = 1 ]; then
  host_gate "editor history panel" "" node editor/test/history_panel.test.mjs
  # Needs the freshly built editor/vendor + web/public basis runtimes, so it runs
  # after the bundle step (it was orphaned from every runner before this).
  host_gate "ktx2 package runtime" "" node --test js/test/p_ktx2_package_runtime.mjs
else
  echo "   editor history panel: FAIL (editor bundle missing)"; hostfail=1
fi
host_gate "scaffold editor lifecycle" "" node tools/scaffold-editor-bundle.test.mjs
host_gate "scaffold Atlas proxy" "" node tools/scaffold-serve.test.mjs
host_gate "Atlas editor launch config" "" node tools/design/editor-launch.test.mjs
host_gate "Atlas editor bridge/workspace" "" node --test \
  editor/test/atlas_editor_protocol.test.mjs \
  editor/test/atlas_handoff.test.mjs \
  editor/test/atlas_workspace_state.test.mjs \
  editor/test/atlas_bridge_wiring_static.test.mjs
host_gate "editor event retention" "" node editor/test/app_event_retention.test.mjs
host_gate "editor artifacts" "" node editor/test/artifacts.test.cjs

# Editor static/unit suites (previously orphaned from every runner): pure node, no
# chromium — panel state, gateways, navigation state machines, source-wiring statics.
host_gate "editor static suites (node --test)" "" node --test \
  editor/test/authoring_gateway.test.mjs \
  editor/test/content_browser.test.mjs \
  editor/test/derived_runtime_client.test.mjs \
  editor/test/graphics_settings.test.mjs \
  editor/test/navigation_destination.test.mjs \
  editor/test/navigation_state.test.mjs \
  editor/test/navigation_ui_static.test.mjs \
  editor/test/outliner.test.mjs \
  editor/test/viewport_derived_wiring_static.test.cjs \
  editor/test/viewport_navigation_wiring_static.test.cjs \
  editor/test/derived_population_activation_static.test.cjs
for eu in authoring_editor_wiring.test.mjs orbit_controls_static.test.cjs outliner_view.test.mjs play_lifecycle.test.mjs scene_graph.test.mjs; do
  host_gate "editor $(basename "$eu" | sed 's/\.test\..*$//')" "" node "editor/test/$eu"
done

editor_host_log="$(mktemp)"
editor_static_log="$(mktemp)"
editor_host_pid=""
editor_static_pid=""
free_port() {
  node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
editor_static_port="$(free_port)"
editor_host_port="$(free_port)"
cleanup_editor_gates() {
  [ -n "$editor_host_pid" ] && kill "$editor_host_pid" >/dev/null 2>&1 || true
  [ -n "$editor_static_pid" ] && kill "$editor_static_pid" >/dev/null 2>&1 || true
  rm -f "$editor_host_log" "$editor_static_log"
}
trap cleanup_editor_gates EXIT
node tools/scaffold/scripts/serve.mjs editor "$editor_static_port" >"$editor_static_log" 2>&1 &
editor_static_pid=$!
LIMINA_EDITOR_PORT="$editor_host_port" LIMINA_EDITOR_STATIC_PORT="$editor_static_port" \
  LIMINA_PROJECT_ID="limina" \
  LIMINA_DERIVED_RUNTIME_BASE_URL="http://127.0.0.1:$editor_static_port" \
  LIMINA_DERIVED_RUNTIME_TOKEN="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" \
  LIMINA_DERIVED_RUNTIME_BRANCH_ID="main" \
  LIMINA_EDITOR_WORLDLOG="editor_gate_${editor_host_port}_worldlog.jsonl" \
  LIMINA_EDITOR_TRACE="editor_gate_${editor_host_port}_trace.jsonl" \
  LIMINA_EDITOR_KERNEL_LOCK="editor_gate_${editor_host_port}_kernel.lock.json" \
  "$BIN" editor/server/editor_host.ts >"$editor_host_log" 2>&1 &
editor_host_pid=$!
editor_token=""
for _ in $(seq 1 50); do
  editor_token="$(sed -n 's/.*Paste token \([0-9a-f][0-9a-f]*\) into.*/\1/p' "$editor_host_log" | tail -n 1)"
  [ -n "$editor_token" ] && break
  if ! kill -0 "$editor_host_pid" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
if [ -z "$editor_token" ]; then
  echo "   editor live/browser gates: FAIL (editor host did not publish an auth token)"
  sed 's/^/      /' "$editor_host_log" | tail -n 12
  hostfail=1
else
  host_gate "editor history live" "self-declared exit 2" \
    env EDITOR_AUTH_TOKEN="$editor_token" EDITOR_HOST_URL="ws://localhost:$editor_host_port/" \
    node editor/test/history_live.test.mjs
  # Browser suites against the live host + static server. All self-SKIP with exit 2 via
  # editor/test/browser-env.cjs when chromium is absent. The list now carries every
  # editor/test/*_browser.test.cjs (33 were orphaned from all runners before this).
  # atlas_standalone_handoff needs the separate Astro site app (site/: npm run dev,
  # port 4321) — an external service this runner does not manage; announced skip
  # unless something is already listening there (LIMINA_ATLAS_URL overrides).
  if node -e 'const s=require("node:net").connect(4321,"127.0.0.1");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),1500)' 2>/dev/null; then
    ATLAS_SITE_UP=1
  else
    ATLAS_SITE_UP=0
    echo "   SKIP: editor atlas_standalone_handoff_browser — needs the site dev server (site/: npm run dev, :4321)" >&2
    skip=$((skip+1)); skipped+=("atlas_standalone_handoff_browser")
  fi
  for et in \
    editor/test/fidelity_frame.test.cjs \
    editor/test/viewport_render.test.cjs \
    editor/test/archetype_render.test.cjs \
    editor/test/visual_refine.test.cjs \
    editor/test/history_browser.test.cjs \
    editor/test/atlas_bridge_browser.test.cjs \
    editor/test/atlas_water_authoring_browser.test.cjs \
    editor/test/camera_navigation_browser.test.cjs \
    editor/test/content_browser_browser.test.cjs \
    editor/test/generated_water_workflow_browser.test.cjs \
    editor/test/graphics_ui_browser.test.cjs \
    editor/test/graphics_workflow_browser.test.cjs \
    editor/test/navigation_ui_browser.test.cjs \
    editor/test/outliner_browser.test.cjs \
    editor/test/play_ui_browser.test.cjs \
    editor/test/play_workflow_browser.test.cjs \
    editor/test/project_navigation_browser.test.cjs \
    editor/test/render_lifecycle_browser.test.cjs \
    editor/test/run_live_teardown_browser.test.cjs \
    editor/test/underwater_render_browser.test.cjs \
    editor/test/water_render_browser.test.cjs
  do
    ename="$(basename "$et" .test.cjs)"
    host_gate "editor $ename" "no chromium (self-declared exit 2)" \
      env EDITOR_AUTH_TOKEN="$editor_token" LIMINA_EDITOR_TOKEN="$editor_token" \
      EDITOR_BASE_URL="http://localhost:$editor_static_port" \
      EDITOR_HOST_URL="ws://localhost:$editor_host_port/" \
      LIMINA_EDITOR_URL="ws://127.0.0.1:$editor_host_port/" node "$et"
  done
  if [ "$ATLAS_SITE_UP" = 1 ]; then
    host_gate "editor atlas_standalone_handoff_browser" "no chromium (self-declared exit 2)" \
      env EDITOR_AUTH_TOKEN="$editor_token" LIMINA_EDITOR_TOKEN="$editor_token" \
      EDITOR_BASE_URL="http://localhost:$editor_static_port" \
      EDITOR_HOST_URL="ws://localhost:$editor_host_port/" \
      LIMINA_EDITOR_URL="ws://127.0.0.1:$editor_host_port/" node editor/test/atlas_standalone_handoff_browser.test.cjs
  fi
fi
cleanup_editor_gates
trap - EXIT

if [ -n "${LLMFF_BIN:-}" ] || command -v llmff >/dev/null 2>&1; then
  host_gate "check-slice-builder" "" node tools/director/check-slice-builder.mjs
else echo "   check-slice-builder: SKIP (no llmff; set LLMFF_BIN)"; fi

# Design-quality gate (gamestack procgen-review, executed): the silhouette gate's own falsifiability —
# distinct assets PASS, a clone-heavy "oatmeal" set HARD-FAILS. Needs a real GPU + chromium;
# gates/design/check.mjs exits 2 (announced) when they are absent.
if [ "$HEADLESS" = 1 ]; then echo "   design-gate (silhouette): SKIP (headless: needs GPU/chromium)"
else host_gate "design-gate (silhouette)" "no chromium" node gates/design/check.mjs; fi
# Style-conformance gate (design direction): a build whose materials stay inside the Design Direction's
# declared palette + surface envelope PASSES; an off-brief build (off-palette color / off-envelope
# roughness) HARD-FAILS. Pure color/param geometry — no GPU/chromium, so it runs even headless.
host_gate "design-gate (style conformance)" "" node gates/design/style-conformance-check.mjs
# Map Studio gate: MapDoc v2 migration round-trip + undo-command inversion property + the v2->
# WorldMap compile bridge, each with a falsifiability self-check. Pure Node — runs even headless.
host_gate "design-gate (map studio)" "" node gates/design/mapstudio-gate.mjs
# GDS-level design gate: scores a game's content by tier (well-art-directed PASSES, samey HARD-FAILS,
# and a GDS resolving ZERO assets FAILS — no vacuous green). Exit 2 = no chromium.
if [ "$HEADLESS" = 1 ]; then echo "   design-gate (gds tiers): SKIP (headless: needs GPU/chromium)"
else host_gate "design-gate (gds tiers)" "no chromium" node gates/design/gds-gate-check.mjs; fi
# Packager: a direct-path game is rejected; a record+export world packs into a self-contained release
# that RENDERS non-blank in the real engine.
host_gate "packager" "no chromium/demo world" node packager/check.mjs

# Compile & Run (World Designer): a GDS `world` slice compiles → packages → RENDERS non-blank in the
# real engine (compileWorldToExport → packRelease → engine-browser-gate).
host_gate "check-compile-run" "no chromium" node tools/director/check-compile-run.mjs

# Playable-build smoke: the pipeline gates the thing you actually PLAY (the native window build loads
# its full graph + game + shared dressed field), not just the headless sim. Display-independent.
if [ "$HEADLESS" = 1 ]; then echo "   playable-smoke (beacon window): SKIP (headless: needs GPU)"
else host_gate "playable-smoke (beacon window)" "" node games/beacon-quest/smoke-playable.mjs; fi

# Beacon Quest playable-render smoke: the "Light the Eastern Beacon" capstone on the MAP-PAINTER
# world renders clean (painted terrain source + rigged models + HUD, N frames, zero errors). The
# render sibling of js/test/p14_beacon_quest.ts (which proves the SIM + replay). Exit 2 = no GPU.
if [ "$HEADLESS" = 1 ]; then echo "   playable-smoke (beacon quest): SKIP (headless: needs GPU)"
else host_gate "playable-smoke (beacon quest)" "no GPU surface" node games/beacon-quest/smoke-quest.mjs; fi

# Beacon Quest headless determinism gate, PROJECT-LOCAL: the game is a self-contained project whose
# assets live under games/beacon-quest/assets/. Run FROM the project dir so op_read_asset roots there
# (the js/test sweep no longer picks this up — it moved out of js/test into the project's gates/).
host_gate "beacon-quest gate (project-local)" "" \
  bash -c "cd games/beacon-quest && LIMINA_AUDIO=null '../../$BIN' gates/p14_beacon_quest.ts"

# Asset-repository X0 gate (Phase 13 / Track 4): a QC-passed asset publishes to a content-addressed
# store + resolves back byte-identical with its CatalogEntry intact (engine-scheme parity), and a
# tampered object / malformed entry is rejected. Headless + fast, host-side (marketplace ≠ engine dep).
host_gate "x0-roundtrip (asset repository)" "sample asset missing" node gates/exchange/x0-roundtrip-check.mjs

# On-ramp scaffold gate: create-limina-app produces a complete, BOOTABLE project — real file tree +
# prebuilt sample world + a classic-script-safe (import.meta-free) player exposing window.LiminaPlayer.
# Headless + fast (no GPU), catches the DOA-sample regression. Runs in CI.
host_gate "scaffold-gate (create-limina-app)" "" node tools/create-limina-app/scaffold-gate.mjs

# Beacon Quest W5 export gate: the painted-world Mode-A export (the /examples deliverable) is real +
# replay-complete — peek scene replayed, stamped buildings placed, keyframes + asset bundle written,
# package files parse. HEADLESS (the export needs no GPU), so it runs in CI where the dogfood SKIPs.
host_gate "export-gate (beacon painted world)" "no engine binary" node games/beacon-quest/export-gate.mjs

# DOGFOOD (the integration capstone): one real game (Beacon Run) through EVERY stage —
# functional gate → design gate → export → package → render-verified release. Heavy (renders +
# replays), so it's last and SKIPs without chromium/GPU. This is the end-to-end "the machine works" gate.
host_gate "dogfood (beacon end-to-end)" "no chromium/GPU" node games/beacon-quest/dogfood.mjs

echo "== summary =="
echo "   js/test: $pass passed / $fail failed / $skip skipped; host gates: $([ $hostfail -eq 0 ] && echo OK || echo FAIL)"
[ ${#skipped[@]} -gt 0 ] && printf '   SKIPPED (%d): %s\n' "$skip" "${skipped[*]}"
[ $fail -eq 0 ] && [ $hostfail -eq 0 ] && { echo "ALL GATES GREEN"; exit 0; } || { echo "GATES RED"; exit 1; }
