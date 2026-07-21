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

1. ~~Settle check.~~ DONE — audit lane committed `a986c59` and went quiet.
2. ~~Register gates.~~ DONE — both `p_studio_*` gates in `QUICK_DETERMINISM_GLOBS`.
3. ~~P5 closeout.~~ DONE — capability reader + CLI wiring + propose-asset rewrite
   (see plan Status & outcomes, 2026-07-19 entry).
4. **Contract decision (owner).** Recorder commit-back: a `cloneInput` throw AFTER a
   successful handler rejects the invoke yet leaves the command recorded + finalized
   without its commit fields (live==log holds; replay loses pinned identity).
   Options: (a) accept + document; (b) discardCommand + structured `contract_error`
   (mutation already applied — becomes an undo-ledger question); (c) pre-validate
   commitFields before invoking. Default recommendation: (a) documented, revisit in U3.
5. ~~U0a.~~ DONE — `serve-design.mjs --headless` + `serve-design-headless.test.mjs`.
6. ~~U0b.~~ DONE — single HTTP entry in `serve.mjs` (local Atlas SPA + token-injected
   API proxy), `editor.mjs` supervises the sidecar `--headless`; `p_studio_proxy` gate
   (`serve.studio-proxy.test.mjs`). NOTE: any running dev stack predates this — restart
   it to pick up the headless sidecar.
7. **U1.** Dock shell: instantiate `panel-registry` profiles (`studio`, `design`),
   port Design Space tabs in order Docs → Places → Graph → Packs → Build, convert their
   list renders to `keyed-render`. Chat router + `design.review` gate per plan Chunk U1.
   FIRST SLICE DONE (2026-07-19): studio-shell + profiles, design-api, design-markdown
   (byte-parity), design-docs panel + cascade + styles, index.html/app.js wiring, and
   the `studio_docs_panel_browser` behavioral twin — all green. ALSO: U0 placeholder
   contract fix (sweep-found) + generated-water fixture now provisions via the proxy.
   REMAINING: Places/Graph/Packs/Build panels, chat router (expert personas onto
   `runBoundedMultiTurn` + context packs + streaming), `design.review` gate.
8. **Sweep.** `bash tools/director/run-gates.sh --quick` (needs a quiet window — the
   live stack holds 4321/5173/8787), tsc, lints; update the plan's Status & outcomes.

## Standing constraints

- No commits without owner approval. No edits to audit-lane-active files.
- `editor/styles.css` is functional-buildings-lane territory: panel styling goes in a NEW
  stylesheet or inline-style scoping until that lane settles.
