# Studio Unification — U0/U1 Resume Handoff (2026-07-18)

State after the phase-zero two-lane session. Full lane accounting lives in
`plans/studio-unification.md` → Status & outcomes. This note is the mechanical resume
checklist for whoever (studio lane or owner) continues once the audit-remediation lane
settles on `editor_host.ts` / `tools/scaffold/scripts/editor.mjs`.

## Landed and gated (do not redo)

- Recorder seam: chain-id + `chainToken` capability classification, clone-before-mint on
  zod-normalized input, physics apply-then-record, commit-back clones, fail-closed
  unmapped `op_physics_*` (audit lane; verified by `p_studio_recorder_seam`, `p111`, `p112`
  + 11 regressions).
- Tracer incremental append-mode replay index (`js/src/observability/event.ts`;
  `p_studio_trace_append_replay`). Static `LiminaTracer.replayTrace` stays the full
  verifier.
- Design-server Host validation (audit lane, `tools/design/loopback-request-host.mjs`).
- Doc hygiene (ROADMAP, phase-7/8/10 status headers, mvp-spec banner + artifact).
- U1 shell foundations: `editor/src/keyed-render.js`, `editor/src/panel-registry.js`
  (+ node tests, 11+11 green) — reviewed and accepted by the studio lane. Integrator note:
  `keyedList` reconciles element children only — keep containers whitespace-free.

## Landed since this note was first written

- `editor/src/keyed-render.js` + `editor/test/keyed_render.test.mjs` (59 LOC, 11 tests):
  keyed DOM reconciliation, WeakMap per-container registry, single-pass O(n) with call-count
  proofs, duplicate-key TypeError, no innerHTML. REVIEWED: accept.
- `editor/src/panel-registry.js` + `editor/test/panel_registry.test.mjs` (201 LOC, 11 tests):
  pure-state panel registry with profiles (studio/design), canonical visibleIds ordering,
  strict snapshot restore (restore(state()) is an identity), injected storage. REVIEWED: accept.

## Resume checklist (in order)

1. **Settle check.** `git status --porcelain` + file mtimes on `editor/server/editor_host.ts`,
   `tools/scaffold/scripts/editor.mjs`, `tools/design/serve-design.mjs`,
   `js/src/worldlog/recorder.ts`, `tools/director/run-gates.sh`. Proceed only when the
   audit lane is quiet (no edits in ~15 min) or explicitly hands off.
2. **Register gates.** Add `js/test/p_studio_recorder_seam.ts` and
   `js/test/p_studio_trace_append_replay.ts` to `QUICK_DETERMINISM_GLOBS` in
   `tools/director/run-gates.sh` (full sweep already auto-discovers `js/test/*.ts`).
3. **P5 closeout.** Verify the launcher's 0600 capability handoff
   (`writePrivateEditorCapability` in `editor.mjs`); then wire `tools/design/build-world.mjs`
   and `tools/design/propose-asset.mjs` to read that capability file instead of a pasted
   token. Delete the "paste token" UX remnants from README/docs after.
4. **Contract decision (owner).** Recorder commit-back: a `cloneInput` throw AFTER a
   successful handler currently rejects the invoke yet leaves the command recorded +
   finalized without its commit fields (live==log holds; replay loses pinned identity).
   Options: (a) accept + document; (b) discardCommand + structured `contract_error`
   (mutation already applied — becomes an undo-ledger question); (c) pre-validate
   commitFields before invoking. Default recommendation: (a) documented, revisit in U3.
5. **U0a.** `serve-design.mjs --headless`: no static SPA, no `/api/session` issuance;
   mutation auth via the launcher-issued internal capability (align with whatever the
   audit lane's handoff format is — read it first).
6. **U0b.** Single HTTP entry: the launcher-supervised static server proxies ALL
   `/api/*` design endpoints (not just `/atlas/*`); browser never reaches the sidecar.
   Gate `p_studio_proxy`: every proxied endpoint reachable via the entry; direct sidecar
   access without Host/capability refused (falsifiability leg required).
7. **U1.** Dock shell: instantiate `panel-registry` profiles (`studio`, `design`),
   port Design Space tabs in order Docs → Places → Graph → Packs → Build, convert their
   list renders to `keyed-render`. Chat router + `design.review` gate per plan Chunk U1.
8. **Sweep.** `bash tools/director/run-gates.sh --quick`, tsc, lints; update the plan's
   Status & outcomes.

## Standing constraints

- No commits without owner approval. No edits to audit-lane-active files.
- `editor/styles.css` is functional-buildings-lane territory: panel styling goes in a NEW
  stylesheet or inline-style scoping until that lane settles.
