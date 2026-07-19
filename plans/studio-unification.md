# Studio Unification — One Surface for Design Space + 3D Editor

Merge the Design Space (`tools/design/serve-design.mjs` + `tools/design/frontend/`) and the
3D editor (`editor/`) into a single studio SPA over a single authority. The split survives
today only as integration tax: an iframe, a cross-origin handoff relay, two session tokens,
a byte-mirrored protocol file, and two state authorities that cannot see each other. The
agent-coordination requirement — *agents visualize context and provide input at every stage
of ideation → playable demo* — is blocked by that seam. This plan removes the seam, then
builds the coordination substrate on the unified surface.

- **Status:** PROPOSED 2026-07-18 — awaiting owner approval. Numbered gates (`pNNN_*`)
  assigned on landing to avoid collisions with the existing catalog.
- **Depends on:** recorder-seam fixes from the 2026-07-18 adversarial audit (§Prerequisites).
- **Supersedes:** the two-surface assumption in `plans/phase-7-authoring-surface-plan.md`
  (which specced a 2D dashboard; reality shipped a 3D editor) and the Atlas-iframe
  integration model. Does not touch the WB-W1/WB-B2 frozen water/terrain release surfaces
  or the functional-buildings lane (`js/src/architecture/**`, `tools/architecture/**`).

---

## Diagnosis (all confirmed file:line)

The "integration" is not an architecture; it is an admission that two things want to be one:

| Tax | Evidence |
|---|---|
| Atlas embedded via **iframe**, not shared code | `viewport-atlas-frame` in `editor/index.html` |
| One-shot **handoff relay** smuggling ws URL + token cross-origin via sessionStorage | `editor/atlas-handoff.html`, `editor/src/atlas-handoff-bootstrap.js` |
| **Two tokens, two auth models** | design session token (`serve-design.mjs:768`, issued unauthenticated, no Host validation — DNS-rebinding hole) vs kernel-lock token printed to a console banner and paste-carried into CLIs (`editor_host.ts:270`) |
| Protocol file **duplicated byte-for-byte** across both browser roots, kept honest by a drift test | `editor/src/atlas-editor-protocol.js:1` |
| Cross-messages just to focus/reveal an entity across the seam | atlas bridge protocol (`editor/test/atlas_bridge_*.test.cjs`) |
| **Two state authorities**: vault files (CAS `maps.json`, pull-only `/api/state`) vs worldlog (subscribe/push). Design Space never learns the world changed; the editor never learns docs changed | `tools/design/frontend/net.js`, `editor/src/viewport.js:1632-1678` |
| **Two agent stories with no shared context**: advisory, tool-less, non-streaming haiku experts capped at 1024 tokens (`serve-design.mjs:351-371`) vs the tool-equipped editor chat agent that cannot read the vault | `js/src/game/design-agents.ts`, `editor/server/editor_host.ts:168-217` |
| Per-request **engine respawn** (`spawnSync(limina)`) blocking the single-threaded design server on every save/state poll | `serve-design.mjs:235-270, 376-400` |

What the split legitimately owns today, and must be preserved: map compile, GPU peek
screenshots, pack import (ez-tree bake), cascade computation, expert context assembly
(`serve-design.mjs` endpoints); the Atlas save discipline (750 ms trailing debounce, CAS
revisions, exponential retry, beacon-on-unload — `frontend/net.js:48-123`); shared-engine
coast rendering (painted coast = compiled coast, `serve-design.mjs:56-61`); a docs/maps-only
usage mode. All preservable without a split *surface*.

## Target architecture

```
┌─────────────────────────── limina studio (one SPA, one shell) ──────────────────────────┐
│  Dock panels: Docs · Atlas · Places · Graph · Viewport · Outliner · History · Board ·   │
│               Approvals · Chat · Trace · Inspector · Content · Ship                     │
│  One net layer (McpClient + push) · one chat router · one task board ·                  │
│  one approval inbox (world holds + design proposals) · one trace                        │
└───────────────┬──────────────────────────────────────────┬──────────────────────────────┘
                │ ws (single token, kernel lock)            │ loopback HTTP (no UI, no own token)
   ┌────────────▼─────────────┐                ┌────────────▼────────────┐
   │  native limina host      │───owns proxy──▶│  design-service (headless│
   │  worldlog · approvals ·  │                │  ex-serve-design):       │
   │  design.* artifacts ·    │                │  compile-map · peek GPU  │
   │  trace · export          │                │  pack-import · cascade   │
   └──────────────────────────┘                └─────────────────────────┘
```

Decisions:

1. **One SPA.** Design Space tabs (Docs/Atlas/Places/Packs/Graph/Build) become dock panels
   in the editor shell. Merge direction: absorb into the editor — it owns the harder
   infrastructure (viewport, workers, worldlog subscribe, virtualized lists).
2. **One authority.** The native host remains single writer (kernel lock already enforces
   this). The design backend survives as a **headless sidecar** — compile/peek/pack are
   node-land jobs (GPU chromium, ez-tree) that do not belong in the native binary — but it
   loses its UI, its session token, and direct browser access. The browser talks only to
   the host; the host proxies. This deletes the second auth model and the rebinding hole
   in the same move.
3. **Vault docs migrate to engine `design.*` artifacts** (Chunk U3). The engine already has
   first-class replayable design artifacts (`js/src/skills/design.ts:56-110`,
   `DESIGN_ARTIFACT_KINDS`, canonicalized, replayed as ordinary SkillCommands). Once docs
   are artifacts: proposal mode, approval gates, cascade-as-trace-events, and replay come
   free. Vault files become a persistence/export format, not the truth.
4. **Delete, in order:** the iframe, the handoff relay, the `/atlas/*` proxy, the
   byte-mirrored protocol file + drift test, the second token.
5. **Preserve:** the Atlas save discipline as the panel save coordinator; the shared-engine
   coast rendering; the peek pipeline (it becomes the agent vision backchannel). The
   docs/maps-only usage becomes a **layout profile** in the same shell, not a separate app.

## Non-goals

- No framework migration. Both frontends stay dependency-free vanilla ES modules; the fix
  for full-`innerHTML` rebuilds is a small keyed-render helper, not a build step.
- No new permission/approval machinery — the coordination substrate composes the existing
  gates (`registry.ts:565-604`, `orchestration.ts:74-181`, `runBoundedMultiTurn`).
- No multi-human realtime collaboration, no visual org-chart UI (both previously deferred
  with reasons that still hold).
- Not Mode B promotion / web-interactive playback — the Ship panel ships honest-label
  bundles ("orbit replay" until input is gated); that is a separate program.

## Prerequisites (phase zero, before any chunk)

Unification puts *more* mutations through the recording seam; it must be correct first.
From the 2026-07-18 adversarial audit:

1. `js/src/worldlog/recorder.ts:374` — forged/stale `chainId` classifies a top-level invoke
   as nested → silently unrecorded. Fix: `liveChains` membership check.
2. `recorder.ts:392` — seq minted before `cloneInput` can throw → permanent seq gap →
   `assertReplayable` bricks boot. Fix: clone before mint.
3. `recorder.ts:241-245` — non-step physics ops recorded+finalized before apply → phantom
   commands on native throw. Fix: apply-then-record (mirror the step path).
4. `js/src/observability/event.ts:275-281` — append-mode `tail()` re-reads + re-verifies
   the whole durable trace per poll; the unified studio reads traces hot. Fix: incremental
   replay index.
5. Token broker: kernel-lock file (already holds port+token) becomes the discovery
   mechanism for every CLI (`build-world.mjs`, `propose-asset.mjs`); console-banner
   paste-carry dies.

Each with a `pNNN` gate leg and falsifiability arm in the existing style.

## Chunk U0 — One launcher, one token, headless design service (days)

`serve-design.mjs` gains `--headless` (no static SPA serving, no `/api/session`); the
editor host proxies its endpoints; the editor UI's `/atlas/*` proxy flips to the host;
`scripts/editor.mjs` supervises the sidecar under the kernel lock. Host-header validation
(`#validateHost` pattern from `derived-runtime-server.mjs:286`) lands on the sidecar
regardless. No UI changes yet. **Kills:** second token, rebinding hole, direct browser
access to the design backend.

- Gate: `p_studio_proxy` — every previously-public design endpoint reachable via the host
  proxy with the kernel token; direct sidecar access without Host validation refused
  (falsifiability: request against the sidecar port directly must fail).

## Chunk U1 — Docs/Places/Graph/Packs/Build as native panels (1–2 wks)

Port the five simple tabs into the editor shell against the host proxy. This chunk
introduces the **dock/panel layout system** and the **keyed-render helper** (the
full-`innerHTML`-rebuild pattern — `frontend/app.js:94-117`, per-keystroke markdown preview
at `:396-397` — does not survive six new panels) and deletes one of the two hand-rolled
markdown renderers. The **chat router** lands with the Docs panel: the six
`design-agents.ts` personas move onto `runBoundedMultiTurn` with streaming and per-stage
context packs (doc text + cascade impacts + map raster thumbnail + peek images — images as
first-class provider input), ending the advisory-only, 1024-token expert chat.
`design.review` proposal mode: a `design.review` profile + auto-installed review gate on
`design.*` writes (mirror `orchestration.ts:88`), proposals rendered as diffs in the Docs
panel. **Kills:** the two-agent-story split; advisory-only experts; prompt-says-propose /
code-applies gap.

- Gates: `p_studio_design_panels` (panel CRUD round-trips through the host proxy; CAS save
  discipline preserved — concurrent-edit conflict still resolves per `net.js` semantics);
  `p_studio_design_review` (a `design.*` write from an expert is HELD, diff-rendered,
  grant applies with replay byte-identity; falsifiability arm: with the gate removed the
  same write applies silently).

## Chunk U2 — Atlas native; the iframe dies (2–3 wks)

Port `frontend/map.js` (1627 LOC) + `map-commands.js` into the editor shell on the editor's
net layer. Keep `maps.json` CAS as a file artifact behind the save coordinator (the MapDoc
→ design-artifact migration is U3 — do not do both at once). Focus/reveal across Atlas ↔
viewport becomes a function call. **Deletes:** `viewport-atlas-frame`, `atlas-handoff.html`,
`atlas-handoff-bootstrap.js`, the `/atlas/*` proxy, both copies of
`atlas-editor-protocol.js` + its drift test. **Preserve:** undo command stack, paint
rasters, water authoring, beacon-flush save.

- Gate: `p_studio_atlas_native` — paint → save → compile → derived revision → viewport
  mount, with the same raster round-trips the iframe path gates today
  (`atlas_bridge_*` behavioral legs re-pointed at the native panel); falsifiability: a
  paint op that skips the save coordinator must be rejected by CAS.
- Landing strategy: behind a layout flag with the iframe fallback intact until the gate
  passes in a real browser; fallback deleted in the same PR that lands the gate green.

## Chunk U3 — Vault → design artifacts (2 wks)

Docs become replayable `design.*` state; cascade computed engine-side and emitted as trace
events; vault files become a persistence/export format (round-trip byte-identity). The
approval inbox unifies: world holds and design proposals in one queue with diffs, grant/
deny from panel, chat thread, or (later) board. **Kills:** the second state authority;
"editor never learns docs changed".

- Gate: `p_studio_vault_artifacts` — vault ↔ artifacts round-trip byte-identity; doc edit
  recorded as an ordinary SkillCommand and replayed; cascade events appear on the trace;
  proposal → grant applies at tick boundary with provenance; falsifiability arm: edit a
  doc bypassing the artifact seam and replay must diverge loudly.

## Chunk U4 — Headless retirement + Ship panel (1 wk)

`serve-design.mjs` SPA deleted; sidecar reduced to compile/peek/pack. The peek pipeline
becomes the agent **vision op** (native render → PNG → content-addressed store → tool
input), replacing the architect daemon's out-of-band PNG read. **Ship panel:** "Build
world" and "Export demo" become panel actions driving the same skills agents call —
`op_write_export(dir)` replaces the four bespoke `traces/`-relocate wrappers
(`export:demo` shell, `beacon-quest/build.sh`, `write-relic-hunt-bundle.mjs`, scaffold
stdout-marker protocol); export auto-records keyframes whenever dynamic bodies exist
(closes the `keyframes: []` silent-fidelity cliff, `tools/scaffold/scripts/export.mjs:173`)
and refuses `/assets/**` external deps without bundling. **Kills:** CLI token pasting;
manual export; the last reason to open two UIs.

- Gate: `p_studio_ship` — one panel action from a saved vault to a portable bundle;
  `loadExport` round-trip; keyframe coverage asserted when dynamic bodies exist;
  packager render-non-blank gate (`packager/check.mjs`) attached; honest label ("orbit
  replay") in the generated page.

## Follow-on coordination program (separate plan, enabled by this one)

Ordered, each now ~⅔ its two-surface cost because there is no seam to federate across:

1. **C2 task ledger** — persistent `coord.*` task board as replayable artifacts
   (claim/heartbeat/expiry), replacing `architect-daemon.mjs`'s JSON state file; daemon
   rewritten onto it while retaining the digest-pinned isolated generation/Blender/QC broker
   (the former permissionless Claude CLI path has been removed).
2. **C3 in-context review** — coordinator-demo ghost markers ported into the main viewport;
   held edits visible in-world; approve from viewport/chat; batch + policy approval.
3. **C4 pipeline stage machine** — `game/coordinator.ts` gains pause/resume, per-stage
   approval hooks, mid-pipeline input seams, ledger streaming over push.
4. **C5 live memory bridge** — two-way EventLoom: live trace subscription + `memory.query`
   skill.

## Sequencing (landable PRs)

1. **Prerequisites** (recorder + tracer + token broker) — one slice, blocks everything.
2. **U0** — same week; no UI risk.
3. **U1** — lands the shell infrastructure (dock + keyed render) everything else uses.
4. **U2** — the only real porting risk; flag-gated with iframe fallback.
5. **U3 ∥ U4** — independent file sets (artifacts/cascade vs export/ship); may run in
   parallel once U1's shell exists, but U3 must not start before U2's save-coordinator
   semantics stabilize.
6. Follow-on program after U3 (approvals inbox) and U4 (ship path) exist.

Each chunk is its own vertical-slice commit (implementation + gate + evidence).

## Verification

- Per chunk: `tsc -p js/tsconfig.check.json` clean, determinism/portability/nested-invoke
  lints green, the chunk's `p_studio_*` gate with in-code falsifiability, affected
  regression gates re-run (`atlas_bridge_*`, `atlas_editor_protocol`, design/editor
  suites).
- Integration: `bash tools/director/run-gates.sh --quick` green after every chunk; full
  sweep before the final report.
- U2 additionally: real-browser UAT over the SSH tunnel — paint in Atlas, watch the
  viewport mount, confirm own-eyes screenshots; iframe fallback exercised once before
  deletion.
- U4 additionally: the beacon-quest export gate re-run against the panel-driven path;
  packed release renders non-blank in real chromium.
- The whole program's acceptance echo of Phase 7: a human and two agents co-author from
  doc → map → world → export in the unified studio, every proposal visible before apply,
  session replays byte-identical.

## Risks / open questions

- **U2 save-model reconciliation.** Atlas's undo/CAS meets the editor's save models; the
  chunk keeps `maps.json` CAS deliberately. If the owner prefers MapDoc-as-artifact
  earlier, U3 absorbs it — but never both models in one chunk.
- **U3 source-of-truth flip.** Doc state moves from files to the worldlog; external tools
  reading the vault directory directly (firecrawl-cache workflows, hand edits) need the
  export-on-save mirroring to stay lossless. Mitigation: vault files remain written on
  every artifact commit for one full release before read-path deprecation.
- **Sidecar lifetime.** If compile/peek/pack later move into the native host (ops exist
  for most pieces), the sidecar shrinks to ez-tree pack import; the plan does not depend
  on that migration either way.
- **Design-only users.** Layout profile must be verified as a first-class layout, or the
  old standalone SPA becomes a support burden by nostalgia. Owner call at U1 review.
- **Doc rot noted during analysis** (fix in Prerequisites or a hygiene commit): ROADMAP
  self-contradicts Mode B (lines 24 vs 42) and cites two nonexistent plan files
  (`map-driven-worlds-shipped.md`, `kernel-plan.md`); three completed plans still say
  "Status: not started"; `docs/mvp-spec.md:298` ends with an unanswered assistant prompt.

## Status & outcomes

**2026-07-18 — PROPOSED.** Written after a four-track exploration (Design Space/editor
workflow map, coordination-primitive inventory, plans/docs intent extraction, export-path
map) and an adversarial audit of the full codebase; every load-bearing claim herein is
confirmed file:line. Awaiting owner approval to sequence against the functional-buildings
lane and the editor-engine-foundation pass.

**2026-07-18 — Phase zero (Prerequisites) execution, two-lane.** An audit-remediation lane
(working the 2026-07-18 adversarial findings) and the studio lane executed concurrently;
file ownership was split to avoid collisions, verified by gates on both sides.

- **Recorder seam (audit lane, verified by studio lane).** `recorder.ts` now classifies
  head-vs-nested by chain-id + object-identity `chainToken` capability (a forged/stale id
  folds to a recorded head), clones before minting seqs against zod-normalized input
  (`registry.prepareInvocation` + `worldlog/replay-value.ts`), applies physics ops before
  recording them, clones commit-back fields, and fails closed on unmapped `op_physics_*`
  mutators reaching the recording proxy. Verification: NEW `js/test/p_studio_recorder_seam.ts`
  (5 legs, falsifiability documented in header) + audit lane's `p111/p112` + 11 worldlog
  regression gates (p101, p30, p57, p58, p45, p48, p98, p_record_result_filter,
  p4_worldlog_replay, p4_worldlog_durable, p42) — all green; `tsc` clean.
- **Tracer incremental replay index (studio lane).** `observability/event.ts`: append-mode
  tracers keep an incremental index (verified boot prefix + own appends) instead of
  re-reading + re-verifying the whole durable trace per `tail()`/`explainEvent()`/
  `durableEventCount()` — the quadratic long-lived-host cost. Static
  `LiminaTracer.replayTrace` remains the full verifier for audit surfaces. Verification:
  NEW `js/test/p_studio_trace_append_replay.ts` (parity per emit, zero post-boot file
  reads, tamper rejection, torn-tail recovery, explain linkage) + trace regressions
  (p42, p49, p3, p50, p55) — all green; `tsc` clean.
- **Token broker (audit lane, in flight at this writing).** `editor_host.ts` fails closed
  on a missing/invalid `LIMINA_EDITOR_TOKEN` (no more Math.random fallback, no token in
  console banners); the launcher (`tools/scaffold/scripts/editor.mjs`) generates the
  OS-random capability and hands it off via a private 0600 file. CLI discovery
  (`build-world.mjs`, `propose-asset.mjs`) not yet wired to it.
- **Design-server Host validation (audit lane).** `serve-design.mjs` rejects non-loopback
  `Host` headers before every route via shared `tools/design/loopback-request-host.mjs` —
  the DNS-rebinding half of Chunk U0a is landed. `--headless` mode and the U0b host-proxy
  remain open, blocked on the token work settling.
- **Doc hygiene (studio lane).** ROADMAP Mode-B self-contradiction resolved; dangling
  `map-driven-worlds-shipped.md` / `kernel-plan.md` refs removed; stale "Status: not
  started" headers corrected on the phase-7/8/10 plans; `docs/mvp-spec.md` marked
  HISTORICAL and its trailing chat artifact removed.
- **Integration debt recorded:** (1) register `p_studio_recorder_seam` and
  `p_studio_trace_append_replay` in `run-gates.sh` `QUICK_DETERMINISM_GLOBS` (the file was
  mid-edit by the audit lane; deferred to avoid a mid-air collision — full sweep
  auto-discovers `js/test/*.ts` regardless); (2) review note: a commit-back `cloneInput`
  throw after a successful handler rejects the invoke yet leaves the command recorded +
  finalized without its commit fields — live==log holds, but the caller-visible contract
  deserves a decision; (3) P5 completion check and U0a `--headless` + U0b proxy resume
  once `editor.mjs`/`editor_host.ts` settle.
- **U1 shell foundations landed ahead of sequence (collision-free paths only).**
  `editor/src/keyed-render.js` (keyed DOM reconciliation replacing innerHTML rebuilds;
  per-container WeakMap registry; O(n) with call-count proofs) and
  `editor/src/panel-registry.js` (pure-state panel registry: layout profiles incl. the
  docs/maps-only "design" profile, canonical ordering, strict snapshot restore,
  dependency-injected storage). Each with a `node:test` suite (11+11 green) and a
  studio-lane integration review on record. The mechanical resume checklist for U0/U1
  lives in `plans/handoffs/studio-u0-u1-resume.md`.
