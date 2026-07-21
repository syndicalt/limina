# Editor + Engine Foundation Pass

Close the editor/planner/general-engine backlog that accumulated behind the world-builder
program: host-capability gaps that skip whole test families, the editor's full-replay boot
(hung a real 7k-command session), realm/permission asymmetries, and the director-surface
polish items. Runs parallel to (and strictly clear of) the codex functional-buildings lane
(`js/src/architecture/**`, `js/src/skills/functional-building*.ts`, `tools/architecture/**`)
and the frozen WB-W1/WB-B2 water/terrain release surfaces.

## Chunk A — Host capabilities (timers, structuredClone, async wasm)

The limina host exposes no `setTimeout`/`setInterval`, no `structuredClone`, and never
resolves async `WebAssembly.compile`. That is six announced-skips in `run-gates.sh`
(`p8_sim_worker_pause`, `p_native_basis_init`, `p_functional_building_contract`,
`p_architecture_compiler`, `p_architecture_building_program_synthesizer`,
`p_native_wasm_compile`) and a standing wall for any host-side tool that assumes a web-ish
runtime. Fix host-side (the runner comment is explicit: never a test edit): timer ops wired
into the deno_core event loop + bootstrap shim, `structuredClone` via V8
ValueSerializer (or deno_core's serializer ops if this version ships them), and an
event-loop diagnosis for async wasm compile. Timers must not leak into
`js/src/skills/` determinism (lint stays green). New gate: `p106_host_capabilities.ts`.

## Chunk B — Editor session fast-boot (snapshot + bounded tail)

The viewport re-authors every command at connect; large sessions hang the browser. All the
machinery exists — self-sufficient v3 snapshots, the H2 SnapshotParticipant registry (16
managers), `recoverWorld`, physics blobs — but the editor path doesn't use it. Ship: host
serves `{snapshot, tail}` past a command-count threshold; both browser realms (render +
sim worker) restore identically, including both RNG streams; realm-divergence guard holds.
Full-replay path stays as the small-session fallback. Native→wasm physics-blob
compatibility is verified, not assumed — if blobs don't cross, the worker boots by
tail-replay from snapshot entities and the plan records that truth. New gate:
`p107_editor_snapshot_boot.ts` (bit-identical vs full-replay boot + in-code
falsifiability) plus a measured boot-time comparison on a synthetic large session,
verified in a real browser with own-eyes screenshots.

## Chunk C — Consistency & security shortlist

Small, sharp items each with a known defect:
- **Worker grant parity**: the sim worker's default grants deny `terrain.generate` that the
  render realm allows — realm asymmetry by drift, not decision. Align and gate.
- **CSPRNG editor token**: retire the documented non-CSPRNG fallback with a
  getrandom-backed host op (waits for Chunk A's crate churn to land).
- **Snapshot participants**: the two declared F-rows (behavior/dialogue managers) join the
  participant registry so snapshots capture them.
- **p103 catch-all leg**: the compensation-ledger gate gets its dedicated
  catch-all-rollback fail-case (recorded as debt during the remediation campaign).
- **Atlas bridge timeout**: `atlas_bridge_browser` locator timeout — diagnose whether the
  panel regression is real or a harness/service-wiring issue, fix accordingly.

## Chunk D — Director/planner surface

The editor's describe→plan→coordinate→gate→publish loop (game-director pipeline +
"Describe what to build" panel). Scope intentionally thin until the owner picks direction
(see Risks): candidate items are coordinator observability in the editor (plan/gate state
visible, not just chat), planner failure surfacing, and threading the C2 derived-mounting
measurement now that chromium tooling exists.

## Sequencing (landable PRs)

1. **A ∥ B** (independent file sets: `crates/**` + bootstrap + runner vs. net/editor/browser
   boot path) — both in flight.
2. **C** after A and B land — its items touch `editor_host.ts`, `sim-worker.ts`,
   `snapshot.ts`, and new crate ops, all owned by A/B while they run.
3. **D** after owner direction.

Each chunk is its own vertical-slice commit (implementation + gate + evidence).

## Verification

- Per-chunk: `deno check`-clean, determinism/portability/nested-invoke lints,
  the chunk's new `pNN` gate with in-code falsifiability, affected regression gates.
- Integration: `bash tools/director/run-gates.sh --quick` green after every chunk;
  full sweep before the final report.
- Chunk B additionally: real-browser boot on the playwright rig, screenshots read with
  own eyes, boot-time numbers reported (snapshot vs replay), and user UAT over the SSH
  tunnel before the slice is called done.

## Risks / open questions

- **"Planner" scope (Chunk D)**: owner said "editor + planner + general engine" — awaiting
  whether planner means the game-director pipeline surface or the layout/settlement
  planner (the latter brushes codex's FB-5 lane; default assumption here is the director
  pipeline).
- **Native→wasm physics-blob portability** (Chunk B): if Rapier snapshot blobs are not
  compatible across native/wasm builds, worker restore degrades to entity-level rebuild —
  functional but a weaker parity story; the gate will pin whichever truth holds.
- **Async wasm compile** (Chunk A): may be a deep V8 platform/task-pumping issue; the
  chunk is allowed to close with a precise infeasibility write-up instead of a fix.
- Host timers must stay out of deterministic paths; the determinism lint only scans
  `js/src/skills/` — reviewers watch for clock-backed scheduling leaking elsewhere.

## Status & outcomes

**2026-07-17 — all four chunks landed.** Six commits on `feat/gamestack-refactor`:
`cc4181b` (A: host capabilities), `b483836` (A: CSPRNG crypto global), `86edda0` (B:
fast-boot), `637eea4` (C), `a7941e3` (D1–3), `0cd3fb6` (D4), plus `c8be750` (p103
catch-all leg, authored by zai) and `6dd2869`/`cd13e79` (two source-pin fallouts from
B: check-live M3 and the camera-framing static — both pins updated to the intended
fast-boot shape, neither weakened).

Final consolidated `run-gates.sh --quick` after all commits: js/test 29 passed /
0 failed / 1 pre-declared skip; every remaining host-gate red attributed — grass-field +
biome-surface forceWebGL (pre-existing, pre-campaign), playable-smoke ×2 (known-red
window/GPU family on a headless sweep), atlas_bridge Play leg (the documented
derived-build-sidecar frontier above). generated_water_workflow's one sweep red
reproduced as a teardown-race flake (exit 0 in isolation, green in the final sweep).

- **Chunk A** — timers (deno_core timer wheel), `structuredClone` (V8 ValueSerializer),
  and async `WebAssembly.compile` (root cause: isolate platform registration needed the
  tokio context entered before `JsRuntime::new`, else V8's background-compile completion
  tasks were dropped) all live as host globals; bare-specifier nearest-node_modules
  resolution added. The six announced skips became running gates. `crypto.getRandomValues`
  backed by a getrandom host op (`op_crypto_random_hex`, 1..=4096 bytes); the editor
  host's auth token is CSPRNG-grade on next restart. Gate: `p106_host_capabilities`
  (falsifiability in-code: string timer callbacks, function clone, transfer lists,
  float/quota crypto draws all must throw). Skills determinism lint untouched and green.
- **Chunk B** — `worldlog.snapshotBoot` skill + `snapshot-boot.ts` PROGRAM/FINALIZE
  builder; both browser realms boot from the v3 snapshot + bounded tail with an
  allocation-parity verify that throws on drift. Native→wasm physics blobs confirmed
  incompatible (bincode vs rapier.js format) — worker realms rebuild via origin replay +
  re-pose, recorded as designed truth, not a workaround. Measured: 8k-command session
  boot 240 s+ (hung) → 2.1 s in a real browser, own-eyes verified. Eligibility is
  honest: carried-tools allowlist + structural checks; terrain sessions answer
  `eligible:false` (terrain participant is the named next slice). Gate: `p107`.
- **Chunk C** — realm default grants now derive from ONE source
  (`REALM_DEFAULT_PROFILE`/`realmDefaultGrants()`; the drifted worker list granted seven
  nonexistent permissions and denied ~40 real ones incl. `terrain.generate`). Behavior +
  dialogue managers joined the snapshot participants (goal-id sequence rides the
  snapshot; fast-boot carried-tools extended). `atlas_bridge_browser` root-caused across
  four layers: run-gates never spawned the Atlas service (fixed), serve.mjs proxy
  allowlist missed the shared world-IR module family (fixed + pinned), chromium-1228
  software-GL flag for the non-pixel Play leg (fixed), and an honest residual red: the
  Play leg needs the derived-build sidecar wired into run-gates (next slice; it now
  fails at a real frontier, not a harness artifact). Gates: `p108` (parity + known-universe
  + falsifiable comparators), `p104`/`p107` extended, `p103` Part 6 (catch-all leg).
- **Chunk D** — D1: every chat tool invoke pushes a completion `chat.step`
  (ok/failed/held/rejected + detail/result) and `chat.done` carries a cut-reason, so
  bound-terminated turns never read as silence; editor chips/summary/Approval link
  render it. D2: `director.pipeline.*` events (plan.created with previously-silent
  unknown mappings, slice.started, gate.report with per-DoD failures, slice.failed with
  the previously-swallowed error, run.halted/passed) emitted causally-chained through an
  optional `PipelineTrace` seam — absent, behavior is byte-identical. D3: `gds.plan`
  skill (read-computation over the registry catalog; `game.plan` permission) + editor
  plan card; scaffold authoring golden refreshed (exactly the `game.plan` token per
  recorded command, verified). D4: C2 measured (225-chunk window, 4× CPU throttle,
  hardware-GL chromium): monolithic mount 367–488 ms main-thread task → over the
  pre-declared ~50 ms rule → `createWithFrameBudget` sliced mounting (~8 ms slices,
  MessageChannel yields) under the activation gate; after: mounting tasks ~10–12 ms,
  zero ≥50 ms longtasks at 1× throttle. Gates: `p58` extended, `p109`, `p110`, both
  chat static tests, both derived static pins updated + proven falsifiable.

Verified vs not: every gate above run green by the coordinator independently of the
authoring agents (exit codes in the commit messages); tsc/determinism/portability/
nested-invoke clean; live-editor evidence for B (fast-boot) and D1/D3 (plan card,
failed-step chip, pipeline trace node) captured on hardware-GL chromium and read.
NOT verified: user UAT on their own editor session; a live `held` step in the browser
(proven by p58 + static test only); `coordinate` driven end-to-end from the editor
(nothing invokes it there yet — D2 is events-at-the-source); `atlas_bridge_browser`
full green (blocked on the derived-build sidecar). `createWithFrameBudget` has no
dedicated pNN gate (exercised by the measurement harness + static pins); recommend a
sliced-vs-sync equivalence + mid-slice cancellation gate as a follow-up. Follow-ups
also noted: plan.created renders as its own root in the trace forest on the skill path
(needs ctx to expose causal parents); chat window layout cramps pasted GDS JSON.
