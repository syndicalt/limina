# Limina Phase 3 Audit

This checklist tracks direct evidence for Phase 3 completion. A row is not
complete until it has both file evidence and runtime verification. The repo at
this path is not a Git worktree, so evidence is recorded by file path and
command output rather than commits.

## Current Verified Evidence

- Baseline and implementation plan:
  - `docs/superpowers/plans/phase-3-baseline.md`
  - `docs/superpowers/plans/2026-06-23-limina-phase-3-implementation.md`
- Physics richness:
  - `crates/limina-physics/src/lib.rs`
  - `js/src/skills/scene.ts`
  - `js/src/skills/physics.ts`
  - `js/test/phase3_physics_richness.ts`
  - `js/test/p3_physics_transform_sync.ts`
- Durable trace/replay:
  - `js/src/observability/event.ts`
  - `js/src/skills/system.ts`
  - `js/test/p3_trace_durable.ts`
- Stdio MCP and bounded multi-turn:
  - `crates/limina-runtime/src/mcp_stdio.rs`
  - `crates/limina-runtime/src/main.rs`
  - `js/src/mcp/mcp.ts`
  - `js/src/mcp/stdio_runtime.ts`
  - `js/src/agents/systems.ts`
  - `js/test/mcp_stdio.ts`
  - `js/test/agent_multiturn.ts`
- Scheduler and budgets:
  - `js/src/agents/scheduler.ts`
  - `js/src/agents/systems.ts`
  - `js/test/p3_scheduler_density.ts`
  - `js/test/p3_scheduler_timeout.ts`
- ECS facade and job foundation:
  - `js/src/ecs/facade.ts`
  - `js/src/engine.ts`
  - `js/src/skills/ecs.ts`
  - `js/test/p3_ecs_facade_jobs.ts`
- Visual/devtools foundation:
  - `js/src/skills/system.ts`
  - `js/src/skills/three.ts`
  - `js/src/skills/scene.ts`
  - `js/test/p3_visual_devtools.ts`
  - `js/test/p3_textured_gltf.ts`
  - `js/test/p3_textured_gltf_window.ts`
  - `assets/textured-triangle.gltf`
  - `docs/superpowers/plans/phase-3-textured-gltf-headless-note.md`
- Spatial index:
  - `js/src/spatial/index.ts`
  - `js/src/agents/systems.ts`
  - `js/src/skills/scene.ts`
  - `js/test/p3_spatial_index.ts`
- Crash-safe trace durability:
  - `js/src/observability/event.ts`
  - `crates/limina-ops/src/lib.rs`
  - `js/test/p3_trace_crash_safe.ts`
- Acceptance and isolation:
  - `js/test/p3_acceptance_runner.ts`
  - `plans/limina-phase-3-isolation-decision.md`

## Verification Run

- `cargo fmt --all --check`: passed.
- `cargo test --workspace`: passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- Headless JS runtime tests passed:
  - `agent_multiturn.ts`
  - `m0_seams.ts`
  - `m10_player_ollama.ts`
  - `m11_m12_tracing.ts`
  - `m1_registry.ts`
  - `m3_skills.ts`
  - `m7_agents.ts`
  - `m8_ollama.ts`
  - `mcp_stdio.ts`
  - `p0_2_ops.ts`
  - `p0_5_physics.ts`
  - `p0_7_ecs.ts`
  - `p3_physics_transform_sync.ts`
  - `p3_scheduler_density.ts`
  - `p3_scheduler_timeout.ts`
  - `p3_trace_durable.ts`
  - `p3_trace_crash_safe.ts`
  - `p3_ecs_facade_jobs.ts`
  - `p3_acceptance_runner.ts`
  - `p3_spatial_index.ts`
  - `p3_visual_devtools.ts`
  - `p3_textured_gltf.ts`
  - `phase3_physics_richness.ts`
  - `s3_offscreen.ts`
- Phase 3 acceptance runner measured:
  - 6 bound MCP builder sessions.
  - 24 MCP-created builder entities.
  - 48 in-world Agent Players.
  - 72 inspected entities.
  - p95 frame-step 34 ms, p95 decision 5 ms, p95 queue depth 36,
    p95 MCP call-boundary 6 ms in the latest coordinator run.
  - Process elapsed wall time 0.54 s; maximum resident set size 139,360 KB.
- Spatial index comparison measured:
  - `p3_spatial_index.ts` returned exact brute-force-equivalent results while
    visiting 4 indexed candidates versus 160 brute-force candidates.
- Runtime web-surface probe:
  - `fetch`, `Blob`, `Response`, `Request`, `Headers`, `URL`,
    `createImageBitmap`, and `ImageBitmap` are now available through a narrow
    asset-only shim plus `deno_image`. `HTMLImageElement` and `document` remain
    intentionally undefined.
- Windowed smoke tests passed:
  - `target/debug/limina --window --frames 5 js/test/p0_4_cube.ts`
  - `target/debug/limina --window --frames 5 js/test/s4_window.ts`
  - `target/debug/limina --window --frames 5 js/test/p3_textured_gltf_window.ts`
  - `target/debug/limina --window --frames 5 js/src/demo.ts`
  - `target/debug/limina --window --frames 5 js/src/demos/player.ts`
- External stdio smoke passed with spoofed context ignored under bound
  `agt_ext` session:
  - `printf ... | target/debug/limina --mcp-stdio`

## Open Phase 3 Gaps

- Scheduler and budgets:
  - Scheduler core is implemented and tested. `p3_acceptance_runner.ts` now wires
    explicit finite budgets and reports p95 metrics from runtime paths. Product
    demos may still need finite budget defaults before they are presented as
    production examples.
- ECS and job path:
  - Facade, deterministic mutation queue, chunked jobs, and snapshot batch seam
    are implemented. Spatial index integration and brute-force comparison are
    implemented for perception and `scene.queryEntities`.
- Visual fidelity and devtools:
  - `inspector.snapshot`, trace query surfaces, glTF metadata/lifecycle, and
    dev reload request events are implemented. Textured glTF is implemented for
    sandboxed/data assets and verified in headless and windowed smoke tests.
    Arbitrary network fetching and DOM image elements remain non-goals.
- Spatial index:
  - Indexed perception/query path is implemented with brute-force comparison
    tests and query stats.
- Crash durability:
  - Append-on-emit durability with `sync_data`, restart hydration, and torn final
    line recovery is implemented. High-frequency production tracing may still
    need batching or segment tuning.
- Isolation substrate:
  - Decision record is checked in with measured startup/memory/call-boundary
    data. No arbitrary third-party code may touch `Deno.core.ops`, exported ECS
    arrays, or `WorldContext` directly. A real sandbox substrate is still a
    future milestone.
- Acceptance:
  - Scripted acceptance runner now covers many agents, simulated concurrent MCP
    builder sessions, finite budgets, inspector snapshot, trace explanation, and
    p95 metrics. It does not claim textured glTF or arbitrary-code sandboxing.
