# Review remediation — architectural findings (C3, H1, H2+M18, H8, M4)

Source: `../limina-notes/adversarial-review-2026-07-16.md` (adversarial review, 2026-07-16).
This plan covers the five findings the review classed **architectural** — the ones that
change a seam rather than a line. Quick/medium findings are being fixed separately; this
plan deliberately anchors on symbols, not line numbers, because those fixes are landing
in the same files.

All five findings attack the same invariant: **a world is a pure function of
(seed + command log + snapshots)**. C3 and M4 make the recorded stream untruthful, H1
makes the live world diverge from the log on failure, H2+M18 make snapshots incomplete,
and H8 is the one efficiency item whose fix crosses a trust-boundary seam
(verify-before-use) and therefore needs a design, not a patch.

---

## Chunk A — Truthful recording under async interleave (C3 + M4)

Both findings are the same disease: the recorder classifies events by **ambient module
state** (a shared depth counter; a global RNG slot) that async interleaving and
context-dependent consumers can perturb. The fix in both cases is the fix the codebase
already applied once for skill commands: carry identity **in the data**
(`recorder.ts:WorldRecorder.attach` — "Classification is by CHAIN ID, not a depth/flag
counter"). Chunk A extends that principle to physics ops and to randomness.

### A1 — Chain-tagged ops recording (C3)

**The bug, precisely.** `WorldRecorder.wrapOps` records a mutating physics op iff
`rec.depth === 0`; `attach`'s patched `invoke` does `++rec.depth` before calling the
handler and `--rec.depth` in `.finally()`. `depth` therefore spans a handler's entire
**async lifetime**. In a direct-path game (`game/context.ts:assemble` wires
`recorder.wrapOps(p.baseOps)` into `ctx.ops` and the game loop steps it directly), a
fixed-step loop that calls `ctx.ops.op_physics_step()` while an async skill
(`asset.place` awaiting `parseGltfScene`, an agent chain awaiting a provider) is in
flight sees `depth > 0` — the step is misclassified as in-skill and **never recorded**.
Replay then runs fewer steps than the live world: silent divergence. The file's own
comment (`recorder.ts` chainId block) condemns depth-counting for exactly this reason,
then retains it "solely for the ops proxy". Note: `net/server.ts:doTickExclusive` is
NOT exposed today — it awaits every `registry.invoke` under `withAuthorityLock` before
`this.recOps.op_physics_step()`, and read skills also take the lock — so the bite is the
direct-path/windowed loops and `game/world-compile.ts`. Design for all of them.

**Design.**
1. **The recording proxy always records.** Delete the `rec.depth === 0` conditions in
   `wrapOps` (both the `step` branch and the generic mutating-op branch). Whatever
   arrives at the recording proxy is, by construction, a top-level op. The idle-step
   filter logic (`IdleStepFilter`) is unchanged — it already observes at every depth.
2. **Skills get a chain-scoped, non-recording ops facade.** Add
   `WorldRecorder.chainOps(ops): EngineOps` — same Proxy shape as `wrapOps` but it never
   appends commands; it only calls through and feeds `stepFilter.observe(...)` (the
   filter's body-set completeness currently depends on seeing in-skill ops — preserve
   that, it is the existing `filter?.observe` call at every depth).
3. **Thread it via the world, per chain.** In the patched `invoke` (`attach`), build
   `childBase.world` as a `Proxy` over `base.world` whose `get` traps only `ops`
   (returning the chain facade) and forwards everything else — **not** an object spread:
   skills mutate shared `WorldContext` fields in place (`world.post` per
   `registry.ts:WorldContext`, `world.lods` in `asset.placeLod`) and those writes must
   land on the one shared object. Nested invokes already forward `ctx.world` +
   `ctx.chainId`, so the facade propagates down the chain for free.
4. **Delete `depth` entirely.** Nothing else uses it.
5. **Tripwire for stray paths.** The one hazard this design introduces: code inside a
   handler that reaches the *recording* proxy by a captured reference (module `ops`, a
   manager constructed over the wrapped ops) would now double-record (recorded + also
   reproduced by the skill command on replay). Before landing: audit every physics-op
   call site under `js/src/skills/` and the CoreSkills managers for ops references that
   don't come from `ctx.world.ops` (today managers receive ops per-call; verify). After
   landing: while any head chain is unsettled (`recorder` keeps a `Set<string>` of live
   chain ids — data, not a counter), a mutating op arriving at the recording proxy emits
   a `worldlog.ops.recordedDuringChain` trace event. That is diagnosis, not behavior:
   the op IS recorded (the tick loop is the legitimate issuer); the event makes a stray
   in-skill path visible instead of silent.

**Rejected alternative:** queue/assert physics steps while a chain is in flight. It
serializes the tick loop behind arbitrary skill latency (an `asset.place` parse would
stall simulation), and "assert" turns a recording bug into a runtime crash in the live
loop. The facade records the truth without changing execution.

### A2 — Ctx-owned skill RNG (M4)

**The bug, precisely.** `installSeededRandom` (`worldlog/log.ts`) replaces the global
`Math.random` with one mulberry32 stream, and `captureRandomState()` snapshots that
single stream into `WorldSnapshot.rngState`. Three.js consumes `Math.random` for UUID
generation (`generateUUID`) **only when meshes are created**, i.e. only in
render-capable contexts. So the stream position at any tick — and therefore the captured
`rngState` and every skill draw after a mesh-creating call — is a function of *which
context* ran, not of the command stream. Headless record vs windowed record of the same
commands produce different snapshots. Latent today; fatal for cross-context snapshot
recovery.

**Design.**
1. **Two streams from one seed.** `recorder.seed(seed)` keeps installing the global
   generator (three/legacy consumers keep working, byte-identical to today) AND creates
   a second, world-owned stream: `world.rng = statefulMulberry32((seed ^ 0x9e3779b9) >>> 0)`
   (constant fixed and documented in `log.ts`; any constant works, it must never change).
   `WorldContext` gains `rng: SeededRng` (`log.ts` already exports the interface).
   Replay (`replay.ts:replayCommands`) and recovery (`snapshot.ts:recoverWorld`) install
   both streams the same way.
2. **Skills draw from `ctx.world.rng.next()`, never `Math.random()`.** Migrate the
   skill modules (grep `Math.random` under `js/src/skills/` — the determinism lint
   allow-list tells you the surface). Extend `js/scripts/check-determinism.mjs` to flag
   `Math.random` in skills once migration completes — it becomes a forbidden token like
   `Date.now()`, with a falsifiability fixture per the review's M7 note.
3. **Snapshot capture.** `WorldSnapshot` gains `skillRngState: int` — **additive
   optional within v3**, following the exact precedent of `characters[].swimming`
   (`snapshot.ts`: "Additive within schema v3: old v3 snapshots default to the legacy
   dry state"). Absent → restore seeds the skill stream from the legacy global
   `rngState` (old snapshots predate any skill draw from the new stream, so this is
   exact, not approximate). `restoreSnapshot` installs both.
4. **Compat statement (decide, don't drift).** Log line shapes are unchanged
   (`SkillCommand` carries no RNG), so `LOG_VERSION` stays 1 and `parseWorldLog` is
   untouched. But replaying a log recorded *before* this change under *new* skills
   yields a different (internally consistent) world wherever a skill drew randomness.
   Determinism gates all re-record, so they stay green. Position: recorded dev logs are
   session artifacts, not shipped saves; accept the break, note it in the commit body.
   If any existing log/snapshot is load-bearing for a user workflow, that is an
   escalation before landing (see Risks).

**Why A2 lives in Chunk A:** H1's rollback (Chunk B) needs to restore RNG state consumed
by a failed chain, which is only possible with a world-owned stream it can capture at
chain start — restoring the global slot is unsafe under interleaved chains and blind to
three's draws.

---

## Chunk B — Failure atomicity and restore completeness (H1 + H2 + M18)

One theme: the world log and the snapshot each claim to be authoritative over state that
today has a second, unrecoverable owner (live-only partial mutations; manager maps;
collider-owning closures). Both fixes introduce a **registration seam** so every owner
of world state declares itself to the machinery, instead of the machinery hard-coding
the owners it knows about (the pattern `SnapshotableEventRegistry` and
`registerWorldReconciler` already prototype).

### B1/B2 — Compensation for multi-step skills (H1)

**The bug, precisely.** `recorder.ts:WorldRecorder.attach` discards the recorded
command on failure (`discardCommand` on `!res.success` and on throw), and
`replay.ts:replayCommands` throws if a replayed command fails. That contract is only
sound if a failed skill left the world untouched. `village.build` violates it wholesale:
it awaits nested `terrain.deform` (two flatten passes per placement), then per-placement
`building.assemble` / `architecture.building` / `asset.place`, and throws on the first
nested failure (`village.ts`: `if (!res.success) throw new Error(...)`) — leaving
terraces cut, buildings placed, colliders added, and **no command in the log**. The same
hole opens without any throw via `registry.ts:applyHandler`'s output-schema
`contract_error` path: handler succeeded (world mutated), output failed Zod, response is
`success:false`, command discarded.

**Decision: compensation (undo-on-failure), not failed-command markers.** Recording
failed commands with a `failed` marker and replay-skip-but-verify was considered and
rejected: (a) real failure causes here are environment-dependent — asset resolution on a
bare checkout (`village.ts` skips unresolvable deco assets; a *building* asset absent
fails), canvas availability (`hasCanvas` branch) — so "replay must fail at the same
point" is not a cross-host invariant; (b) it canonizes half-built worlds; (c) it needs a
`LOG_VERSION` bump and touches every log consumer. Compensation makes discard-on-failure
*correct*: on failure the world is restored, so live == log == replay == "it never
happened". This is also the house pattern three times over: `asset.place` already rolls
back via `teardownEntity` when its material override fails; `AuthoringTransactionKernel`
(`authoring/kernel.ts:#rollback`) does capture → apply → rollback-or-poison;
`net/server.ts` already consumes poison (`poisonAuthority` on `kernel.poisoned`).

**Design (B1 — the seam).**
1. **Per-chain undo ledger.** `ExecutionContext` gains
   `undo(label: string, fn: () => void): void`. The registry keeps one LIFO ledger per
   **head** chain (keyed by `chainId`); nested invokes append to their head's ledger —
   this is what makes `village.build` work: each successful nested `asset.place`
   registers its own teardown, and when the *parent* fails, the whole chain unwinds.
2. **Unwind triggers**, all in `registry.ts` around `applyHandler`/`invoke` for the
   head invocation: handler throw, output `contract_error`, `hooks.after` throw. On
   success the ledger is dropped.
3. **Head-frame state capture.** At head start, capture: `world.rng` state (A2), the
   EntityTable `seq`/`version`, and the bitECS entity-index allocator state (reuse
   `snapshot.ts:captureEntityIndex`/`restoreEntityIndex` — they are exactly this).
   Restore all three on unwind. This is load-bearing: `ent_` ids and eids are allocated
   monotonically (`log.ts` contract), so a failed chain that created-then-tore-down
   entities would otherwise leave the counters advanced — replay (which never runs the
   failed chain) would then allocate *different ids* for every subsequent command.
   Teardown alone is not enough; the allocators must rewind.
4. **Concurrent-chain guard.** Rewinding allocators is only sound if no *other* chain
   allocated while this one ran. Detect via the captured `entities.version`: if another
   head chain is in flight at unwind time, or version moved beyond this chain's own
   allocations, do NOT silently rewind — poison (below). Single-agent authoring never
   hits this; a coordinated agent team hitting it is a real conflict that must be loud.
5. **Undo failure = poison.** Mirror `authoring/kernel.ts:#rollback`: collect undo
   failures, emit `skill.rollback.failed`, and expose `registry.poisoned` (or an
   `onRollbackFailure` callback) that `net/server.ts` maps to its existing
   `poisonAuthority`. A world that failed to roll back is indeterminate; nothing may
   author against it.

**Design (B2 — enrollment).** The ledger is infrastructure; coverage comes from
instrumenting the *shared mutation helpers*, not from asking every handler to remember:
- Entity creation: `loadGltfIntoScene` and the `ctx.world.entities.create` call sites
  register `ctx.undo(..., () => teardownEntity(ctx.world, id))` —
  `skills/entity-teardown.ts:teardownEntity` is already the canonical four-part teardown
  (identity, mesh, body, ECS+tags) and already runs `runtimeDispose` first, so collider
  cleanup rides along.
- Standalone colliders: the `chainAssetRuntimeDispose` sites in `asset.ts` register the
  same `op_physics_remove_body` closure with the ledger.
- `terrain.deform`: capture the affected height patch (center/radius are in the input;
  the layer's `tile.heights` is the mutated array) and restore it on undo. Bounded
  memory: one patch per deform per in-flight chain.
- First enrolled skills: `village.build`, `terrain.deform`, `asset.place`/`placeLod`,
  `building.assemble`, `architecture.building` — the multi-step offenders the review
  names. Other skills gain coverage as their helpers are instrumented; the §6 skill
  quality bar gains a line ("multi-step skills enroll undos or document why atomic").

### B3/B4 — Snapshot participant registry (H2) + collider ownership (M18)

**The bug, precisely.** `snapshot.ts` v3 declares itself SELF-SUFFICIENT but
`captureWorldSnapshot` captures exactly: physics blob, transforms, identity/allocators,
RNG, per-entity authoring state, `characters`, and `events` (via the one bespoke
interface, `SnapshotableEventRegistry`, implemented only by
`skills/behavior-spec.ts:EventSpecRegistry`). Every other stateful manager in
`skills/index.ts:CoreSkills` rebuilds **empty** on restore, and because pre-snapshot
commands are excluded from the delta (`deltaCommandsAfter`: `seq >= snapshotSeq`),
their state is simply gone — inventories, quest progress, `def.state.open` on
interactables, stats/combat, triggers, gamestate. `compareWorldState`
(`log.ts`) compares transforms only, so no existing gate can see it. M18 is the
physics-side twin: `asset.place` creates a static collider deliberately NOT bound to the
entity's `bodyId` and owns it via a `runtimeDispose` closure
(`asset.ts:chainAssetRuntimeDispose`); the collider body itself survives restore inside
the physics blob ("body ids stay stable" — `restoreSnapshot` step 2), but the closure
does not, so destroying a restored asset leaks an invisible wall. Only
functional-building registers a reconciler
(`functional-building.ts:registry.registerWorldReconciler`).

**Design (B3 — participants).**
1. **Generalize the existing interface.** Replace the bespoke `events?:` plumbing with:
   ```ts
   interface SnapshotParticipant {
     key: string;                      // stable, e.g. "inventory"
     schema: z.ZodType;                // validates its own captured state on parse
     capture(): unknown;               // deterministic, sorted, JSON-serializable
     restore(state: unknown): void;    // wholesale replace (registry pattern:
   }                                   // EventSpecRegistry.restoreEventSpecs)
   ```
   A `SnapshotParticipantRegistry` is assembled inside `registerCoreSkills` (each
   `registerXSkills` already returns its manager; index.ts registers a participant next
   to each) and exposed as `core.snapshotParticipants`, so hosts pass ONE object —
   `net/server.ts`, the editor host, and gates stop hand-wiring `characters`/`events`
   (both migrate into participants; keep the old optional params parsing for one
   release, delegating to the registry).
2. **Snapshot format.** `WorldSnapshot` gains `managers: Record<string, unknown>` —
   additive optional within v3 (the `swimming` precedent), default `{}`; absent → every
   participant restores empty, exactly today's behavior, so old snapshots stay valid.
   Each entry is validated by its participant's `schema` at restore time (parse can't
   know the registry); an entry whose key has no registered participant **fails loudly**
   — a snapshot claiming state the runtime can't restore must not silently drop it.
3. **Which managers.** Classify the `CoreSkills` surface (enumerated from
   `skills/index.ts`):
   - **Participants (runtime-mutated sim state):** `inventoryManager`,
     `interactionManager` (registered interactables incl. `def.state`),
     `gameStateManager`, `triggerManager`/`eventManager`, `questManager`,
     `statsManager`/`combatManager`, `abilityManager` (cooldowns/resources),
     `navmeshManager` (portal open-state), `progressionManager`, `worldStateManager`
     (time/weather/spawn), `gazetteerManager`, `behaviorSpec.events` (migrated).
   - **Reconciled-from-origin (keep the reconciler pattern, no capture):**
     functional-building topology/doors — `functional-building.ts:reconcile` already
     rebuilds them from `entry.origin` keyed on `entities.version`, and origins ride the
     snapshot. Add reconciler registrations where a manager's state is a pure function
     of entity origins rather than duplicating it into `managers`.
   - **Excluded (render/host-only, documented in the registry):** `ui`, `audio`/`bgm`/
     `reverb`, `vfxManager`, `cameraManager`, `animationManager` (pose is derived),
     `clips`, `cutscene`/`director` (verify: if they hold mid-playback sim-affecting
     state, they are participants), `saveManager` (it is a consumer, not state).
   The classification lands as a table in the registry module so the next manager added
   has to pick a bucket (the review's "sibling contract" slop lesson).
4. **Hot-path exemption.** `net/server.ts:snapshotLine` (the per-join AoI view) passes
   `includeManagers: false` — it projects entities only and must stay O(relevant).
5. **M8 boundary.** Extending `compareWorldState` to manager state is the review's M8
   (short-term track, not this plan). But the H2 gate must not wait for it: the gate
   compares participant `capture()` output bit-exactly across snapshot→restore itself.

**Design (B4 — M18, collider ownership as entity state).** Persist the ownership, not
the closure: `EntityEntry` gains `runtimeBodyIds?: number[]`; the
`chainAssetRuntimeDispose` call sites (`asset.place`, `asset.placeLod`) append the
collider body id there when they arm the dispose closure. Thread it through the
five-place entity-state checklist (CLAUDE.md #11): `EntityEntry` + bind (engine.ts) →
writing skill (asset.ts) → `SnapshotEntity` (+zod, optional) → `restoreSnapshot`, which
re-arms `runtimeDispose = () => ops.op_physics_remove_body(id)` for each restored id
(the bodies exist — they came back in the blob; handles are stable). No reconciler
guesswork: the ids are exact.

---

## Chunk C — Off-main-thread derived verification (H8)

**The bug, precisely.** `browser-entry.ts:activateDerivedRevision` constructs
`new DetachedDerivedRenderCandidate(snapshot, ...)` on the render/rAF thread; the
constructor runs `parseTransferredDerivedRuntimeSnapshot` synchronously — per-chunk
canonical **re-encode** (`encodeSurfaceCompositeArtifact`,
`encodeBiomePopulationArtifact`, `encodeWorldOverviewArtifact`, ...) plus
`derivedArtifactContentHash` over up to 256 MiB, then terrain/water/overview mesh
builds, all before the constructor returns. A full residency window freezes the main
thread for seconds. That stall can starve the activation ack the derived worker is
waiting on (`derived-runtime-worker.ts:#activate`'s `ACTIVATION_ACK_TIMEOUT` promise),
and a late ack currently lands in `#acknowledge` as **fatal** `UNKNOWN_ACTIVATION` —
the system injures itself under load (M11's tolerance fix is in flight; this chunk
removes the cause). The trust boundary itself — verify every byte against its manifest
hash before any of it touches the scene — is correct and must survive the move.

**Design.**
1. **Split verification from mounting.** Extract the pure verification/decode layer of
   `derived-runtime-render-candidate.ts` — `parseTransferredDerivedRuntimeSnapshot` and
   everything it calls (parse/exact-key validators, canonical re-encode, hash checks,
   tile placement asserts) — into a dependency-light module
   (`js/src/browser/derived-runtime-verify.ts`) with **no `three` import and no DOM
   use**, so it loads in a Worker realm. `DetachedDerivedRenderCandidate`'s constructor
   then accepts only the module's output type (`ParsedTransferredDerivedSnapshot`,
   branded: the type is constructible only inside the verify module) and does mounting
   only. Verify-before-use becomes verify-before-*construct*, enforced by the type.
2. **A verify worker realm.** Follow the sim-worker pattern (worker-API-agnostic
   controller + thin `self.onmessage` shell, `sim-worker.ts`): main thread posts the
   untrusted snapshot **transferring** its `ArrayBuffer`s; the worker verifies; on
   success it posts the parsed snapshot back, transferring the same buffers. Transfer
   semantics close the TOCTOU hole a copy would open: a transferred buffer is detached
   from the sender, so the bytes verified are provably the bytes used — the boundary
   moves realms without weakening. On verification failure the worker returns the
   error; main rejects the activation exactly as the constructor throw does today.
3. **Synchronous fallback, same function.** Headless gates and environments without
   `Worker` call the verify module inline (it is the same code either way). The venue
   is a performance decision; the contract is identical, so gates keep exercising the
   real verifier.
4. **Slice the residual main-thread work.** Mounting (mesh/material/GPU uploads) cannot
   leave the main realm. Build it per-chunk across frames under the existing
   `derivedActivationInProgress` gate (browser-entry.ts already pauses frame work
   through activation for the WebGL-corruption window — keep that gate; it also
   prevents rendering a half-mounted candidate) with a per-slice budget (~8 ms).
   Measure before tuning: the review's profiling item (Chrome tracing on a full 15×15
   residency window) decides whether slicing is even needed once hashing is off-thread.
5. **M11 interaction.** Do not depend on `#acknowledge` staying fatal — coordinate with
   the in-flight late-ack tolerance fix; after C lands, an ack timeout indicates a real
   hang, not a busy main thread, and the transient/fatal classification should reflect
   that.

---

## Sequencing (landable PRs)

Order matters: A2 before B1 (rollback restores the ctx RNG stream), B1 before B2,
B3 before B4 (B4 rides B3's snapshot-field plumbing). Chunk C is independent and can
land in parallel.

1. **PR A1 — chain-tagged ops recording.** `recorder.ts` (always-record proxy,
   `chainOps` facade, world Proxy in `attach`, delete `depth`, chain-id tripwire) +
   ops-reference audit + gate `js/test/p93_worldlog_chain_ops.ts` (number = next free).
2. **PR A2 — ctx-owned skill RNG.** `log.ts` (dual-stream seed), `registry.ts`
   (`WorldContext.rng`), skill migration off `Math.random`, `snapshot.ts`
   (`skillRngState`, additive), determinism-lint token + fixture, gate
   `p94_ctx_rng_context_independence.ts`.
3. **PR B1 — registry undo ledger.** `registry.ts` (ctx.undo, per-chain LIFO, unwind on
   throw/contract_error/after-hook, head-frame allocator+RNG capture/restore,
   poison-on-failed-undo surfaced to `net/server.ts`), fixture-skill gate
   `p95_partial_failure_atomicity.ts`.
4. **PR B2 — enrollment of the multi-step offenders.** `entity-teardown`-based undos in
   the shared helpers, terrain patch capture in `terrain.deform`, village/assemble/place
   enrollment; extend p95 with the village mid-failure case.
5. **PR B3 — snapshot participant registry.** `snapshot.ts` (participants + `managers`
   field), `skills/index.ts` (registry assembly + classification table), manager
   `capture/restore` implementations, host wiring (`net/server.ts`, editor host), gate
   `p96_snapshot_participants.ts`.
6. **PR B4 — collider ownership (M18).** `runtimeBodyIds` through the five entity-state
   places + restore-time re-arm; extend p96 with destroy-after-restore.
7. **PR C1 — verify module + worker realm.** Extraction, branded type, worker shell +
   sync fallback, headless gate `p97_derived_verify_worker.ts` (tamper-reject + golden
   accept + no-three-import assert).
8. **PR C2 — sliced mounting + measurement.** Frame-budgeted mounting, long-task
   instrumentation in the browser harness, M11 coordination. Gated on C1's profiling
   numbers.

Each PR is a vertical slice per CLAUDE.md §3: code + its gate + `run-gates.sh` wiring
land together; this plan's `Status & outcomes` is updated in a separate `docs` pass.

---

## Verification

Every new gate ships with its falsifiability proof in code (§6 gate bar; the
`gates/design/check.mjs` / p91 pattern): a deliberately broken input must FAIL it.
All js/test gates run as `LIMINA_AUDIO=null ./target/release/limina js/test/<gate>.ts`
after `cargo build --release`, and are wired into `tools/director/run-gates.sh`.

- **A1 / p93 (the review's C3 proof):** headless recording context
  (`createHeadlessContext({record:{seed}})`); invoke a fixture skill whose handler
  awaits an externally-resolved promise; while it is pending, drive
  `ctx.ops.op_physics_step()` over multiple ticks (the review's scenario: an async
  `asset.place` mid-flight across steps); resolve; assert (a) every applied step is in
  `recorder.commands`, (b) replay of `toJsonl()` reproduces the same step count and
  `compareWorldState` is bit-identical. **Falsifiability:** the gate also runs against a
  depth-classified recorder shim (the old classification, kept as a test fixture) and
  asserts the same checks FAIL — proving the gate detects the original bug.
- **A2 / p94:** record the same command stream twice — once plain, once with interleaved
  global-stream consumption between commands (draws from `Math.random`, simulating
  three's UUID draws in a render context); assert skill outputs and captured
  `skillRngState` are identical across both runs, and a mid-stream snapshot →
  `recoverWorld` resumes bit-identically. Falsifiability: the same probe against the
  global stream (`rngState`) must SHOW divergence — demonstrating the gate measures the
  right thing. Plus `npm --prefix js run check:determinism` with the new token +
  fixture, and the existing p4/p7x determinism family re-run green.
- **B1–B2 / p95:** fixture skill (creates entities, adds a collider, deforms terrain,
  then throws / returns schema-violating output): assert `captureWorldState` before ==
  after, entity/eid allocator counters restored (next created entity gets the SAME
  `ent_` id as if the failure never happened), `recorder.commandCount` unchanged,
  physics body count restored, and replay of the log == live state. Village case:
  `village.build` with an injected failing nested placement, same asserts.
  Falsifiability: ledger disabled → gate fails on every assert.
- **B3–B4 / p96:** author manager state through skills (inventory add, quest start,
  gamestate set, trigger define, door opened via interaction), `captureWorldSnapshot` →
  `recoverWorld` (empty delta) → each participant's `capture()` compares bit-exact
  (JSON) against pre-snapshot; then `scene.destroyEntity` a restored placed asset and
  assert the collider body is gone (native body count / transform read fails).
  Falsifiability: unregister one participant → gate fails; skip the `runtimeBodyIds`
  restore → destroy-leak assert fails.
- **C / p97 (headless):** verify module accepts a golden fixture snapshot and rejects
  the same fixture with one flipped byte (hash mismatch) and with a duplicated chunk id
  — identical behavior inline and through the worker-shell controller (the sim-worker
  testable-controller pattern makes this headless-runnable). Assert the module's import
  graph pulls no `three`/DOM (static check in the gate).
- **C (browser, real GPU):** the existing derived-activation browser gates stay green;
  add a long-task assertion (PerformanceObserver `longtask` during activation under a
  full residency window below threshold) to the browser harness. Chrome-tracing
  profiling of a 15×15 window (the review's profiling item) is run and its numbers
  quoted in the PR — this is measurement, not a gate. Per failure mode #14, no heavy
  headless GPU runs while the user's editor is connected; visual verification via
  `node tools/shoot.mjs` or the user's live UAT, reported honestly if not run.
- **Cross-cutting, every PR:** `npm --prefix js run check:determinism`,
  `check:portability`, `node js/scripts/check-nested-invoke.mjs`,
  `bash tools/director/run-gates.sh --quick`, and `deno check` clean on touched files.

---

## Risks / open questions

- **A1 double-record via captured ops references.** Any in-handler path reaching the
  recording proxy directly (not via `ctx.world.ops`) becomes a recorded op AND is
  reproduced by its skill command on replay. The pre-landing audit + the
  `recordedDuringChain` tripwire cover it, but a miss means replay divergence in the
  other direction. If the audit finds a manager legitimately holding wrapped ops inside
  skill flows, stop and redesign that manager's wiring before landing.
- **A1 world-Proxy compatibility.** Code that relies on `ctx.world` identity
  (`WeakMap`-keyed caches — `functional-building.ts:reconciledVersions` keys a WeakMap
  by `WorldContext`) will see a different identity per chain. Audit `WeakMap<WorldContext`
  / `world ===` uses; if any is load-bearing, key the facade per-world (one cached Proxy
  per (world, recorder), not per chain — the chain facade doesn't actually need
  per-chain identity, only "not the recording proxy").
- **A2 breaks replay of pre-change logs/snapshots** wherever skills drew randomness.
  Accepted for dev artifacts; **open question for the user:** are any existing recorded
  worlds load-bearing? If yes, this is an escalation (§7.3-adjacent: hard-to-reverse for
  those artifacts) before PR A2 merges.
- **B1 allocator rewind under concurrent chains** is unsound and is deliberately turned
  into poison rather than a guess. If coordinated multi-agent authoring with overlapping
  failing chains is a real near-term workload, compensation needs a per-chain allocation
  journal (rewind only your own ids) — bigger design, out of scope until the poison
  actually fires in practice.
- **B1 undo side effects on shared caches** (spatial index, gltfCache, footprint
  registry `village.build` publishes): teardownEntity handles the core four; auditing
  which ancillary registries village writes before the throw (footprints, water
  contacts) is part of B2, and any non-undoable write found becomes either a
  post-success-only write (move it after the last failure point) or an explicit undo.
- **B3 capture determinism**: participant `capture()` must be sorted/canonical or
  snapshot hashes and gate comparisons flake. The participant interface documents it;
  the p96 gate double-captures and compares to enforce it.
- **B3 snapshot size/cost**: managers JSON on every durable snapshot. Bounded by design
  (counts scale with authored content, not ticks), and the join-view path opts out —
  but measure on a real editor session before calling it done.
- **C1 extraction risk**: the verify layer and mount layer currently share one module;
  the split must not fork validation logic (the review's "four hand-maintained
  validator copies" lesson — M-slop). The branded-type seam exists precisely so there is
  exactly one verifier.
- **C2 may be unnecessary**: if off-threading the hash/re-encode gets activation stalls
  under budget, sliced mounting adds complexity for nothing. That is why C2 is gated on
  C1's measurements.
- **Concurrent remediation traffic**: other agents are landing M6/M11/M13 and quick
  fixes in `recorder.ts`, `browser-entry.ts`, `derived-runtime-worker.ts`. This plan
  anchors on symbols; rebase each PR and re-run its gate rather than assuming line
  stability.

---

## Status & outcomes

All five findings implemented (2026-07-17), landed as two slices (worldlog/skill
seam; derived verification). Gate numbering shifted from the plan's placeholders:
p101 (A1), p102 (A2), p103 (B1/B2), p104 (B3/B4), p99 (C1) — all wired, all
falsifiability proofs in code.

- **A1 (C3)**: recording proxy always records; skills see a per-(world, recorder)
  cached `chainOps` facade via a `world` Proxy trapping only `ops` (WeakMap-keyed
  world identity preserved — `reconciledVersions` audit clean). `depth` deleted.
  `worldlog.ops.recordedDuringChain` tripwire live. Ops-reference audit found no
  stray captured-recording-proxy paths (AssetRegistry holds reads only).
- **A2 (M4)**: dual streams from one seed (`SKILL_RNG_SEED_XOR = 0x9e3779b9`
  frozen); `WorldContext.rng` optional-additive; `skillRngState` additive within
  v3. Migration surface was empty (zero `Math.random` in skills; lint already
  banned it). No committed fixture affected — nothing regenerated.
- **B1/B2 (H1)**: per-head-chain LIFO undo ledger with head-frame capture
  (skill RNG, EntityTable seq/version via new `rewindAllocator`, bitECS entity
  index); unwind on throw/contract_error/after-hook; overlapped-chain and
  failed-undo cases poison (never a blind rewind), wired to `poisonAuthority`.
  Enrolled: gltf entity creation, standalone colliders (finished-guarded dispose
  chain), terrain.deform height patches, building.assemble/architecture.building
  and village.build (seq-range undos + footprint-registry restore). Registry
  mints `lchain_N` for unrecorded worlds so `ctx.chainId` is always set.
- **B3 (H2)**: `SnapshotParticipant` registry, 16 participants enrolled with
  typed schemas; cutscene/director promoted to participants (verified
  sim-affecting mid-playback state — the plan's verify clause fired).
  characters/events became reserved participants over the existing top-level
  fields (wire format unchanged). `managers` additive within v3; unknown keys
  fail loudly; join-path `snapshotLine` opts out. Declared follow-up gaps (`F`
  rows): behavior/dialogue, functional-settlement handles, terrain layer
  heights, navmesh base grid.
- **B4 (M18)**: `runtimeBodyIds` through all five entity-state places;
  restore re-arms remove-body dispose closures; destroy-after-restore leak
  gate-proven gone.
- **C1 (H8)**: verify layer extracted to dependency-light
  `derived-runtime-verify.ts` (no three/DOM; branded type + runtime WeakSet —
  types are erased on this host); worker realm with ArrayBuffer transfer both
  ways (TOCTOU closed); inline fallback is the same function; bundles wired
  (`bundle:derived-verify-worker` → live + editor). Live-editor long-task
  improvement NOT yet measured (no chromium on the dev box) — see C2.
- **C2**: deliberately NOT implemented. Gated on Chrome tracing of a 15×15
  residency-window activation with C1 in place (4× CPU throttle; per-phase
  main-thread task durations). If residual mounting stays under ~50 ms, C2 is
  unnecessary.

Verification at landing: check:determinism / check:portability /
check-nested-invoke / check-determinism-check / tsc all clean; p101–p104 + p99
green with falsifiability shims failing as designed; full worldlog/replay/
snapshot family green; `run-gates.sh --quick` ALL GATES GREEN. NOT verified on
this box (no chromium): live-editor UAT of the verify worker and needsReboot
paths; cross-machine physics bit-identity (needs a second host).
