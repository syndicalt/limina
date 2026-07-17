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

_(filled as chunks land)_
