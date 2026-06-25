# Limina Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fully implement Phase 3: one rich, high-density Limina instance where many Agent Builders and Agent Players can act in an interactive world with explicit budgets, measurable frame stability, richer visual output, and usable authoring/devtools.

**Architecture:** Finish Phase 2 prerequisites first because current code is Phase 1 plus basic Phase 0 runtime. Keep JS-owned bitECS TypedArrays as the canonical Phase 3 state model, introduce an ECS facade plus deterministic main-thread mutation queue, and add production-ready scheduler, indexing, tracing, and native batch-operation seams without rewriting ECS ownership prematurely. Treat QuickJS/V8-isolate sandboxing as a measured Phase 3 spike and implement the non-bypassable substrate/documented boundary before any third-party ecosystem work.

**Tech Stack:** Rust workspace (`deno_core`, `winit`, `wgpu`, `rapier3d`, `tokio`), TypeScript/JavaScript in V8, Three.js WebGPU bundle, bitECS, Zod schemas, EventLoom-shaped JSONL traces.

---

## Agent Assignments

- **Agent A — Phase 2 prerequisite engineer:** physics richness, collision events, spatial index, durable trace/replay, stdio MCP, bounded multi-turn.
- **Agent B — Agent runtime scale engineer:** scheduler, budgets, queue backpressure, multi-agent density harness.
- **Agent C — ECS/job-system engineer:** ECS facade, deterministic mutation queue, JS-owned TypedArray contract, native-compatible batch seams, deterministic chunked job runner, perf baselines.
- **Agent D — Visual/devtools engineer:** textured glTF path, richer lighting/material skills, inspector/devtool surfaces, hot reload.
- **Agent E — Integration/review engineer:** cross-milestone demos, acceptance harness, final audit against Phase 3 plan.

Agents must use disjoint write scopes where possible and must not revert each other's work. The coordinator reviews every worker output for spec compliance and code quality before integration.

## File Structure

- `crates/limina-physics/src/lib.rs`: sphere/capsule/static colliders, material params, transform readback, collision event drain.
- `crates/limina-ops/src/lib.rs`: durable trace/replay helpers, asset/runtime services, optional native batch ops.
- `crates/limina-runtime/src/*`: stdio MCP server mode and host integration points.
- `js/src/agents/*`: bounded multi-turn, scheduler, budgets, queue metrics, density harness support.
- `js/src/ecs/*`: spatial index and deterministic chunked job utilities.
- `js/src/mcp/*`: JSON-RPC transport adapter while preserving the in-process contract.
- `js/src/observability/*`: durable trace sink, replay loader, richer inspector snapshots.
- `js/src/skills/*`: expanded scene/physics/three/system/devtool skills.
- `js/src/demos/*` and `js/test/*`: acceptance demos and regression coverage.

## Task 0: Baseline And Evidence Gate

**Owner:** Coordinator

- [ ] Run `cargo test --workspace`.
- [ ] Run all existing JS headless tests with the runtime binary, including `js/test/m0_seams.ts`, `m7_agents.ts`, and `m11_m12_tracing.ts`.
- [ ] Record current failures or missing harness gaps in `docs/superpowers/plans/phase-3-baseline.md`.
- [ ] Do not begin Phase 3 feature claims until baseline state is known.

## Task 1: Phase 2 Prerequisites

**Owner:** Agent A

- [ ] Implement `op_physics_add_sphere`, `op_physics_add_capsule`, `op_physics_add_static_box`, friction/restitution params, and `op_physics_body_transform(id, out[7])`.
- [ ] Extend `scene.createEntity` with `collider`, `static`, `friction`, and `restitution` fields while keeping existing calls backward compatible.
- [ ] Add collision collection via Rapier `ChannelEventCollector`, `op_physics_drain_collisions`, and a `physics.collisionEvents` skill.
- [ ] Add a uniform-grid spatial index used by `buildPerception` and `scene.queryEntities`; keep brute-force comparison tests.
- [ ] Add durable trace streaming and replay verification from disk; current `exportJsonl()` is not enough for Phase 3.
- [ ] Add stdio JSON-RPC MCP transport first. Define request/response ids, JSON-RPC error mapping, session initialize/profile binding, lifecycle, and integration tests that drive the engine from an external process.
- [ ] Keep WebSocket out of the first prerequisite worker unless stdio is green; it is a follow-on transport over the same protocol adapter.
- [ ] Add bounded multi-turn orchestration with per-session transcript/tool-result state, max steps, max tool calls, wall-time timeout, optional token budget when provider reports usage, and trace edges for every perception -> decision -> tool result -> next decision link.
- [ ] Make trace durability append-on-emit or periodic flush with explicit crash-safe segment handling; add import/replay from persisted JSONL and tests for restart/replay, partial-write handling, and integrity-chain verification after restart.
- [ ] Verify with billiards, external stdio agent, replay, and existing Phase 1 tests.

## Task 2: Agent Runtime Scheduler And Budgets

**Owner:** Agent B

- [ ] Add `AgentBudget` fields for decision wall time, max queued actions, max tool calls per turn, and cooldown/backpressure state.
- [ ] Add `js/src/agents/scheduler.ts` with `AgentBudget`, `SchedulerBudget`, and `AgentRuntimeState`.
- [ ] Replace the current one-pass `decisionSystem`/`actionSystem` behavior with deterministic weighted deficit round-robin over stable `agent.id` order.
- [ ] Split scheduling into decision admission and action execution. Provider decisions stay off-loop, but the scheduler gates starts, stamps a decision generation, and ignores late timed-out results.
- [ ] Cap returned tool calls before enqueue. Overflow emits drops instead of growing unbounded queues.
- [ ] Bound action execution globally and per agent per tick before invoking the existing registry path.
- [ ] Route external builder/MCP tool calls through scheduled enqueue mode instead of direct `registry.invoke` once the stdio transport exists.
- [ ] Close MCP attribution spoofing: external requests cannot override `agentId`/`sessionId`; trace actor remains the bound session agent.
- [ ] Emit trace events for `agent.scheduled`, `agent.backpressure.applied`, `agent.queue.dropped`, `agent.budget.exceeded`, and `agent.action.executed`.
- [ ] Add density tests with many scripted Agent Players and several simulated builder sessions; assert frame-step work remains bounded and queue limits are enforced.
- [ ] Add a Phase 3 demo that reports p95 frame-step time, p95 decision latency, queue saturation, and permission denials.

## Task 3: ECS Data Ownership And Job-System Path

**Owner:** Agent C

- [ ] Keep JS-owned `Position`, `Rotation`, and `Scale` TypedArrays as canonical for Phase 3.
- [ ] Add an ECS storage facade for transform reads/writes, entity iteration, dirty transform ranges, and snapshot creation; keep the raw arrays temporarily exported for compatibility but migrate Phase 3 code through the facade.
- [ ] Add a deterministic main-thread mutation queue. External MCP sessions, player actions, and jobs submit commands; the fixed step drains commands in stable order by tick, phase, entity id, and command sequence.
- [ ] Add a small deterministic job runner for chunked ECS/spatial work that can yield between chunks in JS and can call native batch ops through zero-copy buffers where available.
- [ ] Add native-compatible batch APIs only for pure computations first, such as distance filtering, spatial-grid rebuild/query, transform readback batching, or transform copy preparation; do not move authoritative mutation into Rust until replay/determinism tests prove it.
- [ ] Add a Rust `limina-jobs` crate only after the facade/command/snapshot contract exists; it must not touch V8 or Three and must return sorted result buffers or command proposals.
- [ ] Add performance tests comparing single-threaded/brute-force paths with indexed/chunked/batch paths.
- [ ] Add determinism tests that replay the same fixed-step scenario and compare transforms, collision event ordering, and trace causality.

## Task 4: Visual Fidelity For Agent-Built Worlds

**Owner:** Agent D

- [ ] Make `three.loadGLTF` support textured glTF/glb assets through the actual skill path, including required image/blob/ImageBitmap shims or a documented equivalent supported by this embedder.
- [ ] Add a sandboxed asset URL/loading contract for `limina-asset://<relative-id>` or equivalent. Use a Three `LoadingManager.setURLModifier` path so sidecar `.bin`/`.png` assets resolve through `op_read_asset` without weakening path sandboxing.
- [ ] Add the minimum browser API shims needed for texture loading: asset-scoped `fetch`/`Request`/`Headers`/`Response`, `Blob`/object URL or a controlled bypass for embedded images, and `createImageBitmap` or an image element shim backed by a safe decoder.
- [ ] Add real textured fixtures: one embedded-texture GLB and one external `.gltf` with sidecar `.bin` and `.png`.
- [ ] Extend `three.loadGLTF` output to include root entity, child mesh metadata, source asset id, node names, mesh/material/texture counts, and animation count.
- [ ] Add resource lifecycle disposal on destroy/reload by traversing loaded `Object3D`s and disposing geometries, materials, and textures with trace events.
- [ ] Extend material and lighting skills for shadows, stable light ids, environment configuration where feasible, tone mapping, antialiasing configuration, and richer PBR fields.
- [ ] Add `three.setRenderQuality` with explicit performance-first profiles for antialiasing, tone mapping, exposure, shadow map settings, and render scale.
- [ ] Add a skill-built fidelity demo rather than a handwritten-only scene.
- [ ] Add headless validation for asset loading/material graph creation and a bounded windowed smoke for rendered scene stability.
- [ ] Preserve asset sandboxing and size limits.

## Task 5: Authoring And Devtools Surface

**Owner:** Agent D, reviewed by Agent E

- [ ] Add `inspector.snapshot` skill with bounded/paginated entities, transforms, tags, physics bodies, object/source asset metadata, agents, queues, budgets, skills, permissions, renderer dimensions, quality profile, lights, and loaded resource counts.
- [ ] Add trace query skills/APIs: `trace.tail({ afterSeq, limit, actorId?, type? })`, `trace.explainEvent({ eventId })`, and `trace.export({ name })`.
- [ ] Add CLI/devtool output modes for live trace tail and world-state inspection, backed by the same bounded query APIs.
- [ ] Add hot-reload for scenes/data first, with `dev.reload.requested`, `dev.reload.applied`, and `dev.reload.failed` events.
- [ ] Add skill-module reload only after the registry supports versioned replacement and active calls are drained; reject reloads with incompatible schema/permission changes.
- [ ] Add tests proving a reviewer can trace perception -> decision -> action -> world mutation and explain denied/delayed/dropped actions.

## Task 6: Isolation Substrate Spike

**Owner:** Agent B with Agent C review

- [ ] Implement a measured sandbox spike for untrusted code outside the privileged engine isolate.
- [ ] Compare QuickJS, additional V8 isolate, worker/process, or a minimal host-mediated sandbox only if the dependency/build surface is acceptable.
- [ ] Produce a checked-in decision record under `plans/` that records measured startup cost, per-agent memory, call latency, capability boundary, and why the selected substrate is or is not adopted for Phase 3.
- [ ] Do not let arbitrary third-party code touch `Deno.core.ops`, exported ECS arrays, or `WorldContext` directly.

## Task 7: Phase 3 Acceptance Demos

**Owner:** Agent E

- [ ] Create a many-agent demo with concurrent MCP builder sessions and in-world Agent Players acting in one world.
- [ ] Create a skill-built rich-world demo using textured assets, lighting/materials, physics interactions, and traceable agent modifications.
- [ ] Create a devtools walkthrough command that inspects live world state and explains a specific agent action chain.
- [ ] Add a scripted acceptance runner that executes the demos in deterministic mode and reports the Phase 3 metrics.

## Task 8: Final Audit

**Owner:** Coordinator, with Agent E review

- [ ] Re-read `plans/limina-phase-3-scale-fidelity/plan.md` and this implementation plan.
- [ ] Build a requirement-by-requirement checklist.
- [ ] For every item, cite file evidence, command output, or runtime demo output.
- [ ] Run `cargo test --workspace`, all JS headless tests, and all Phase 3 demos.
- [ ] Only mark Phase 3 complete if every Phase 3 acceptance item has direct evidence.

## Verification Commands

- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- Existing JS tests through `target/debug/limina js/test/<name>.ts`
- Phase 3 acceptance runner, to be added by Task 7
- Targeted `rg` checks for risky assumptions: `QuickJS`, `source of truth`, `TODO`, `stub`, `placeholder`

## Production Constraints

- No reward hacking: tests must exercise real runtime paths, not mocked success.
- No hidden bypasses: agent-initiated world mutation must go through skill/registry/host capability boundaries.
- No frame-loop model calls: provider calls stay off-loop and budgeted.
- No unmeasured architecture swaps: ECS ownership and sandbox substrate changes require measured evidence and a checked-in decision record.
- No README/plan claims without demos and command evidence.
