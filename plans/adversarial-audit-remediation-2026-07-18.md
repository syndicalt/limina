# Adversarial audit remediation — 2026-07-18

## Objective

Restore the engine's cardinal invariant—successful authoritative mutations are recorded exactly
once and failed mutations are recorded zero times—then close the security, resource, long-session,
browser, and peripheral-quality findings without weakening gates or rewriting historical evidence.

This plan is implementation-bearing. A finding is complete only when its source change has a
behavioral falsifiability test and the relevant aggregate gates pass. Static source assertions are
not sufficient evidence for behavioral claims.

## Non-negotiable constraints

- Preserve the authoritative dirty workspace and linked worktrees. Do not clean, reset, checkout,
  delete, reconstruct from `HEAD`, or commit during remediation.
- No GPU render is part of this milestone. Native capture work is limited to guard refactoring and
  fake-process tests.
- An NVIDIA Xid is an absolute stop: report the exact event and do not retry before reboot.
- Do not enable timestamp queries or any NVIDIA timestamp-risk acknowledgement.
- Do not install packages, use `sudo`, pull container images, or change network configuration
  without user authorization.
- Do not make a red gate green by weakening, skipping, repinning, or source-grep reward hacking.
  Historical authored-content pins may be dispositioned only when an already-approved successor
  authority exists and remains covered by an exact closure gate.

## Dependency order

1. Authority and replay integrity.
2. Host and transport security boundaries.
3. Native resource and buffer contracts.
4. Browser consistency and durable-storage complexity.
5. Render/runtime hot paths.
6. Peripheral duplication and test-hygiene debt.
7. Full aggregate verification and explicit residual-risk dispositions.

## Finding ledger

| # | Severity | Remediation | Required evidence | State |
|---:|:---:|---|---|:---:|
| 1 | Critical | Classify nested recorder calls by live chain object identity, not caller-provided `chainId` presence. | Forged and stale IDs cannot suppress a successful top-level record; genuine nested calls remain single-recorded. | Implemented, focused tests green |
| 2 | Critical | Clone/validate command input before minting a sequence. | Uncloneable input produces no command and no sequence gap; next boot remains replayable. | Implemented, focused tests green |
| 3 | High | Terminate espeak options with `--`. | Adversarial option-like speech is data, not argv control. | Implemented, Rust tests green |
| 4 | High | Apply non-step native physics mutation before recording/finalizing it. | Native throw leaves zero durable commands; success leaves exactly one. | Implemented, focused tests green |
| 5 | High | Give stdio MCP the same profile allowlist, policy admission, one-shot initialize, and release semantics as authenticated transports. | Admin self-assertion and re-initialize fail closed; admitted profiles work. | Implemented, focused tests green |
| 6 | High | Validate loopback `Host` before every design-server route, including session disclosure. | Real DNS-rebinding-style request cannot obtain the token or mutate state. | Implemented, host test green |
| 7 | High | Incrementally verify/index appended trace deltas; bound hot retention without `shift()`. Detect truncate/rotation/external writes. | Work per poll depends on the delta, not history; corrupt suffixes and foreign-writer lifecycle changes poison with the root cause. | Implemented, centrally verified |
| 8 | High | Replace browser whole-value trace rewrites with bounded, checksummed, append-only segments and atomic manifests. | Real IndexedDB append/reopen/replay/migration/corruption tests; no quadratic hydrate or stale-generation leak. | Implemented, centrally verified |
| 9 | High | Cap physics body IDs and reject exhaustion before allocation. Preserve non-reuse where stable IDs are authority. | Boundary tests prove cap and no truncation/OOM path; lifecycle semantics documented. | Implemented, Rust tests green |
| 10 | High | Add grass LOD/cull hysteresis, one-pending deferred page builds, generation guards, and runtime-local package/LOD caches. | Boundary jitter creates no work; stale work cannot publish; deterministic round-trip and disposal tests. | Implemented, centrally verified |
| 11 | Medium | Propagate Zod-parsed output downstream rather than raw output. | Transforms/defaults are visible to hooks, caller, and recorder. | Implemented, focused tests green |
| 12 | Medium | Clone commit-back fields before recording/returning authority. | Post-return mutation cannot rewrite a command; unsupported values fail before commit. | Implemented, focused tests green |
| 13 | Medium | Define approval holds as bounded authorization reservations with expiry and explicit apply semantics. | Quota/profile/revocation/expiry behavior is deterministic and documented. | Implemented, policy tests green |
| 14 | Medium | Tripwire every reachable unmapped mutating `op_physics_*`. | Adding/reaching an unmapped mutation fails loudly instead of creating a replay hole. | Implemented, focused tests green |
| 15 | Medium | Run browser simulation ticks through a monotonic accumulator and expose dropped ticks. | Delayed callbacks catch up within a bound and report drops. | Implemented, browser tests green |
| 16 | Medium | Seqlock transform SAB publication/freezing with last-good fallback. | Readers never observe a torn transform frame. | Implemented, browser tests green |
| 17 | Medium | Drain collision queues every tick and free temporary Rapier WASM handles in `finally`. | Non-polling sessions remain bounded; exceptional paths free handles. | Implemented, browser tests green |
| 18 | Medium | Probe batch-perception capability and fall back wholesale when the host stub is unavailable. | Stub response is not confused with a valid zero-hit result. | Implemented, agent tests green |
| 19 | Medium | Bound/reuse perception scratch; use numeric spatial cells; invalidate only on movement. | Dense-world test proves output/scratch bounds and reuse; profile remains within ratchets. | Implemented, centrally verified |
| 20 | Medium | Bound audio initialization wait with timeout and null-backend fallback. | Wedged backend cannot block V8 indefinitely. | Implemented, Rust tests green |
| 21 | Medium | Make physics create/restore lifecycle and registry identity semantics explicit and tested. The audit's proposed registry mutation is rejected: create/restore intentionally replace the contents of the caller-selected active binding. | Re-activation preserves the reset/restored contents, inactive worlds remain isolated, and no obsolete active object can be resurrected. | Dispositioned with Rust behavioral test |
| 22 | Medium | Reduce sandbox deadline while honestly documenting safepoint coarseness. | CPU-bound guest is bounded to the supported limit without claiming instruction-level preemption. | Implemented, Rust tests green |
| 23 | Medium | Add UTF-8 prompt cap, per-session/global semaphores, bounded session table, and token bucket to editor chat. | Parallel and oversized paid calls are rejected; permits release exactly once. | Implemented, focused tests green |
| 24 | Medium | Cache design state by nanosecond revision, use async bounded compiler children, and `process.execPath`. | Repeat poll avoids recompilation; changes invalidate; timeout/output caps fail closed. | Implemented, host tests green |
| 25 | Medium | Remove permissionless host agent execution; broker model output as untrusted source through pinned container isolation and reviewed import. | Real container escape test covers mounts, credentials, network, GPU, socket, output cap, symlinks, hashes, and overwrite. | Implemented, centrally verified |
| 26 | Medium | Invalidate spatial authority after physics-to-ECS position synchronization. | Spatial query sees the synchronized position on the same tick contract. | Implemented, focused tests green |

Finding 7's incremental cursor treats the durable path as an append log shared by cooperating
host writers. File identity, length, modification metadata, the last 4 KiB verified-tail anchor,
and the event hash chain detect the supported append/truncate/replace/tail-corruption cases without
reintroducing O(history) polling. It is not a filesystem MAC against a malicious same-user process
that rewrites bytes earlier than the tail anchor and simultaneously appends; preventing that
requires OS-level write-authority separation, not another tracer scan.

## Selected low findings and debt controls

| Area | Remediation / disposition | State |
|---|---|:---:|
| Ship digest precision | Compare Float32 state by exact bit representation rather than `toFixed(4)`. | Implemented |
| Trace retention | Replace per-event `shift()` with bounded ordered/ring hot retention. The full append replay/causal index intentionally remains session-sized so `explainEvent` can address durable history without a full reread. | Implemented with #7 |
| Window loop | Cap immediate-present loop and align callback-error documentation with fatal behavior. | Implemented |
| CLI | Reject `--fullscreen` without `--window`. | Implemented |
| Editor capability | OS-random explicit token; private `0600` handoff; never log the raw capability. | Implemented |
| Native output buffers | Error consistently on undersized output slices across physics/input/render ops. | Implemented |
| Tool output capture | Bound bake subprocess stdout/stderr tails. | Implemented |
| Quota naming | Rename tick-measured `windowMs` to `windowTicks`. | Implemented |
| Xid guards | One process-latched, boot-bound guard owns preflight, follower-bound baseline, current-boot follower, non-overlapping bounded polling, exact first-event reporting, dead-monitor handling, child/monitor teardown, postflight, and evidence. All ten native capture runners delegate to it; fake-process tests cover every failure phase and races without invoking a renderer. | Implemented, centrally verified |
| GLB bounds helpers | General active-scene bounds now use canonical `measureGlb`; asset-sanity wraps it, furniture retains a contract-aware semantic inspector, and byte-rewrite kernels remain specialized with documented ownership. | Implemented, centrally verified |
| Op tables | One side-effect-free portable op composition now binds worker authoring, render authoring, and keyframe playback; realm-specific modules no longer mirror the full table. | Implemented, focused tests green |
| Source-grep tests | Require behavioral twins and run real Chromium when available; static tests remain supplemental only. | Implemented, centrally verified |
| Minified checked-in source | Pin Prettier 3.9.5, format handwritten source, and enforce a baseline-free 500-byte UTF-8 line ceiling. Generated exceptions are exact paths with named recipes and byte-for-byte regeneration. | Implemented, falsifiability and aggregate green |
| Provider drift | Keep offline scripted gates deterministic; a separately metered, explicit-opt-in Anthropic canary exercises the production provider against the official endpoint with a 64-token hard ceiling and no credential persistence. | Implemented; live execution remains release-operator evidence |
| EventLoom growth | Read-only 64 MiB hold gate plus explicit stopped-session, integrity-verified archive/successor procedure; never rotate the active Zaxy authority in place. | Implemented |

## Verification matrix

Before closure, run and retain exact results for:

1. `cargo fmt --all -- --check`, workspace Rust tests, and a fresh debug runtime build.
2. JS type, determinism, portability, live-boundary, and packaging checks.
3. New p111–p115 and studio trace tests through the native host where applicable.
4. Browser simulation, SAB, WASM physics, segmented IndexedDB, and real non-GPU Chromium tests.
5. Design/editor host security and real-container architect isolation tests.
6. Grass scheduler/runtime and existing biome mount/content gates.
7. Quick deterministic aggregate, host static suites, and any changed-tool test groups.
8. `git diff --check` and an explicit inventory of failures that are pre-existing, environmental,
   historical immutable pins, or unresolved regressions. No silent skips.

## Closure verification findings

The 2026-07-18 ARM64 headless quick aggregate made previously supplemental browser authorities
mandatory and exposed five closure failures that were not allowed to disappear behind source-text
greens or environmental skips. All five are now resolved through their owning fixture or generation
pipeline:

- Camera navigation now proves a measured 96.8 m real RMB pan (two 48 m chunks) before asserting
  the bounded incremental publication; the prior single arbitrary screen gesture moved only about
  12 m and never crossed residency. It passes with 30 incremental artifacts.
- The generated-water workflow now owns its purpose-built hydrology project instead of inheriting
  the aggregate's generic `PLAY_UAT_*` publication. Exact hydrology globals, changed and animated
  pixels, quality rebuild, and bounded teardown all pass in CPU-only Chromium.
- Play compares the displayed project/revision/head to the captured preflight authority rather than
  a stale hard-coded project name. The complete connect/Edit/Play/pause/stale/stop/repeat workflow
  passes.
- The aggregate project declares a bounded +/-384 m authored domain and project navigation targets
  300 m: still outside initial residency, but inside authority. Fly, 19-artifact destination load,
  bookmark restoration, and Play/Stop identity all pass.
- The scaffold's prebuilt `log.jsonl` differed because recorder hardening now persists
  schema-normalized inputs. It was regenerated through `create-limina-app` plus the existing export
  pipeline; the exact scaffold and player-source-closure gates pass.

No assertion was removed or weakened, no skip was added, and generated evidence was not hand-edited.
Every Chromium closure run explicitly used `--disable-gpu`; no native or hardware-GPU render was
part of this remediation.

A subsequent full aggregate reconfirmed 44/44 native JS tests and every host/browser authority
except the Atlas bridge, where it exposed two further shared-fixture dependencies. The generic
MapDoc's legacy outline filled the map as a clickable feature, so a coordinate double-click
correctly focused that feature; the Atlas bridge also borrowed an entity left by predecessor tests.
The aggregate fixture now uses a real 7x7 painted-landmass raster with an ocean border (compiler
evidence: one land polygon, bbox +/-320 m), and the bridge authoritatively creates, selects,
reverse-reveals, and removes its own tagged entity around its unchanged-authority baseline. Exact
coordinate focus/recent-entry assertions pass in an isolated aggregate-equivalent CPU-only run.
The invalid aggregate attempt remains recorded: a delegated edit changed `run-gates.sh` while Bash
was still reading it and caused a partial-line parse failure after the browser suite. It is not used
as closure evidence.

After explicit dependency approval, the source-hygiene remediation installed exact
`prettier@3.9.5` from the local npm cache with scripts disabled. The baseline-free gate now verifies
1,743 tracked and nonignored source files: 1,733 handwritten files contain no UTF-8 line over 500
bytes, while ten exact generated paths are reproduced byte-for-byte by seven named recipes. Its
nine falsifiability arms reject long handwritten lines, stale/missing recipes, broad exceptions,
symlinks, NULs, invalid UTF-8, and untracked-source escapes.

Formatting did not rewrite historical authorities. The immutable source-evidence ledger verifies
18 evidence sets and 157 exact historical references: 87 have inert exact-byte archives, 70 remain
explicitly legacy hash-attested-only and cannot authorize a transition, and three current-source
transitions have exact archived bytes plus pinned Prettier/TypeScript semantic equivalence. Every
new guarded native capture must write and verify a complete source archive before evidence or
artifact publication; fake-process tests cover all ten runners without invoking a renderer.

The final stable ARM64 CPU-only aggregate completed with 44/44 JS tests, zero failures or skips,
every host gate green, and all seven mapped Chromium behavioral authorities mandatory and passing.
During closure it exposed and resolved three more honest test-infrastructure defects: formatting-
fragile reference/Atlas assertions were replaced by falsifiable AST semantics while the remaining
source-text Atlas checks retained their recognized limitation marker and mandatory browser twins;
the proxied Atlas test now waits for application readiness; project navigation derives an uncached
in-domain edge from the live manifest and proves a bounded positive artifact load before Fly can
prefetch it; generated-water awaits its exact `/current` response body rather than launching an
unhandled fire-and-forget read. The final aggregate reports `host gates: OK` and
`ALL GATES GREEN`. No native or hardware-GPU render was run.

## Closure rule

The milestone closes only after every Critical/High finding is accepted, every Medium finding is
either implemented or carries an evidence-backed architectural disposition, all changed seams have
behavioral tests, generated distributions match their source pipeline, and aggregate verification
contains no unexplained regression. Remaining long-term module-splitting or operational work must
be recorded as named follow-up debt with an owner and must not hide a correctness or security gap.
