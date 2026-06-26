# Limina — Post-MVP Roadmap (beyond 0.1.0)

> Companion to [`ROADMAP.md`](./ROADMAP.md). `ROADMAP.md` tracks the **MVP and its
> verified extensions** — Phases 0–5, all complete and shipped in **0.1.0**. This file is the
> **sequenced path from 0.1.0 to the north star**: Phases 6–10, each continuing the numbering in
> `ROADMAP.md`, each with one goal and one acceptance gate. The order and dependencies are
> deliberate; the detail inside each phase is fixed at its kickoff, the same way the earlier phases
> were. (The post-MVP work began life as the "production / ecosystem" tier of the original `README`
> roadmap, preserved at [`docs/mvp-spec.md`](../docs/mvp-spec.md).)
>
> Status of every phase below: **not started.**

## North star

> **limina is the agent-native engine for the web — author worlds with agents, ship them
> author-once / export-everywhere (browser → native → mobile).**

Two commitments shape the whole sequence:

- **Agent-native authoring is the lead.** Agents driving typed, permissioned, traced skills is the
  core identity, and it's the one thing a human-editor engine (Unity/Unreal) can't add after the fact.
  We make that real and visible first; general-engine breadth (visual editor for humans, marketplace)
  follows once agent authoring is established.
- **Author once, run everywhere is the goal.** One project targets browser, native, and mobile — the
  thing that ultimately makes an engine stick. Reaching it is cheaper for us than for a native engine
  because of a property we already have: **a world is a pure function of `(seed + skill/physics command
  log + snapshots)`, so the durable JSONL world log *is* the portable project format.** "Export" is
  re-running the log against the target runtime, not recompiling a native game. A feasibility pass
  ([`web-export-portability-spike.md`](./web-export-portability-spike.md)) confirmed the core runs in a
  browser tab; the one open risk is physics replay parity, with snapshot keyframes as the safety net
  (the same contract the worldgen spike adopts).

## What 0.1.0 already covers (so it's not on this list)

The MVP spec's four pillars — Skill/Hook Registry, MCP interface, Observability, Agent ecosystem — and
their Phase 2–5 extensions are **done**: external agents over MCP (stdio/websocket), interactive physics,
durable + replayable world log, single-instance scale (200 agents @ p95 4 ms), shared-world authoritative
sync, QuickJS isolation, a dynamic policy engine, versioned/attested packages, in-scene text/UI, and
spatial audio. See `ROADMAP.md` for the evidence.

## The path — sequencing at a glance

| Phase | Goal in one line | Gating dependency |
|---|---|---|
| **6 — Open the door & de-risk** | Cheap enabling seams + the two spikes' cheapest stages | none (current substrate) |
| **7 — The authoring surface** | A person and an agent co-author a world, every step visible | Phase 6 seams |
| **8 — Run anywhere** ✅ | The same world runs in a browser tab and on a phone | Phase 6 (export contract) + Phase 7 (worlds worth exporting) |
| **9 — Worlds worth authoring** ✅ | Agents sketch large worlds a learned generator details (+9.1 prop scatter) | Phase 6 worldgen greenlight; rides Phase 8 |
| **10 — Agent governance & orchestration** | An agent sees only its bundle; a coordinator hands scoped bundles + reviews work | the policy engine + Phase 7 approval gate (shipped) |
| **11 — Content & assets** | Agents place/instance real assets + configure deterministic generation | Phase 10 (scoped skills); Phase 8 export; Phase 9.1 scatter |
| **12 — Game-building skill catalog** *(living)* | The agent's vocabulary for fully-featured games (characters, gameplay, interaction) | Phase 10 (safe to grow); Phase 11 (content + asset pattern) |
| **13 — Ecosystem & marketplace** | Others publish skills + assets others install | needs a catalog + governance to trade — downstream of 10–12 |

Phase 6 is cheap and mostly parallelizable. **Phase 7 is the first real sprint** (agent-native authoring
is the lead). Phase 8 is the headline. Phases 9–10 follow, with 9 gated on a spike.

---

## Phase 6 — Open the door & de-risk
**Goal:** unblock everything downstream with low-cost, high-signal work — take the four seams that keep
export reachable, and run the cheapest stage of each spike so the two heavy external dependencies are
greenlit or shelved with evidence before anyone commits to them.

**Work:**
- **The four protect-the-future seams** (nearly free now, expensive to retrofit): renderer behind a
  surface seam (never call `op_create_window_context` directly); physics behind the `ctx.ops` facade
  (no skill imports a Deno/FFI physics symbol directly); the JSONL log as the one canonical portable
  artifact (commands + content hashes, never runtime bytes); no top-level `Deno.*` in any
  browser-reachable module.
- **Web-export spike, stage W0** — headless native↔wasm physics-parity probe. Decide the export
  contract: pure log-replay vs snapshot-keyframe. See [`web-export-portability-spike.md`](./web-export-portability-spike.md).
- **Worldgen spike, stage S0** — run stock *InfiniteDiffusion* out-of-process on the RTX 3050; measure
  ms/tile, determinism, quality. Greenlight or shelve. See [`worldgen-terrain-diffusion-spike.md`](./worldgen-terrain-diffusion-spike.md).

**Gate:** the four seams are merged; the export contract is written down; the worldgen go/no-go is
recorded with evidence.

---

## Phase 7 — The authoring surface  *(first real sprint — the lead)*
*Folds in former themes: Editor / IDE integration + Streaming & multi-turn tool orchestration.*

**Goal:** make agent authoring legible and powerful — a person and an agent co-author a world together,
the agent able to take multi-step turns, and every step visible and reviewable.

**Work:**
- **Co-authoring surface.** Render the agent's `perception → decision → action` as something you can
  look at (not just JSONL), with inspector panels and a human-in-the-loop surface to review and approve
  agent edits. Builds on the shipped `inspector.snapshot`, `trace.tail` / `trace.explainEvent`, and the
  durable world log.
- **Longer agent turns.** Streaming MCP responses for long-running operations, and multi-turn tool
  orchestration beyond the MVP's single-shot tool selection. The request/response MCP contract was
  scoped single-shot on purpose and is forward-compatible with a streaming channel.

**Gate:** a person and an agent co-author a non-trivial world in the editor, with the agent taking
multi-step turns, and the whole session is traced and reviewable.

**Why here:** this is the differentiator a human-first engine can't copy, and it's what makes the
"author worlds with agents" claim real — so it leads, before the export surface.

---

## Phase 8 — Run anywhere  *(the headline)*
*Folds in former theme: Author-once / export-everywhere (browser → native → mobile).*

**Goal:** the same world authored on native runs unchanged in a browser tab — and on a phone.

**Work:**
- **Build the browser/WebGPU runtime** — the still-open milestone `4x / M10` (`plans/limina-phase-4-platform/plan.md:277`,
  P4-X; specced, never built). Three.js WebGPU against the browser's native WebGPU instead of
  `deno_webgpu`, sharing the JS skill/agent layer. Concretely: a wasm-Rapier adapter behind the
  `ctx.ops` facade, the GPU surface seam → `canvas.getContext("webgpu")`, and IndexedDB durable I/O.
- **One-command export.** Package `{ log.jsonl, snapshots/, assets/, manifest }` + a thin browser
  runtime as a static site.
- **Mobile** rides the same runtime (iOS/Android WebGPU is shipped).

**Gate:** a world authored on native exports and runs in a browser tab — and a phone — at parity within
the tolerance chosen in Phase 6's W0.

**Depends on:** Phase 6 (export contract + seams) and Phase 7 (so what we export is a rich
agent-authored world, not a toy scene). De-risked by [`web-export-portability-spike.md`](./web-export-portability-spike.md):
the core (bitECS, skill registry, JSONL log, Three `WebGPURenderer`) already ports; the real work is the
Rapier-wasm swap, the surface seam, and IndexedDB, with native↔wasm physics parity as the decisive
unknown and snapshot keyframes as the safety net.

**Architecture note — the live browser runtime (mode B foundation).** The Phase 8 first cut (shipped) is
*playback*: it replays recorded commands + interpolated keyframes on the main thread — cheap, and correctly
simple (no worker needed, no SharedArrayBuffer, no cross-origin isolation). The *live* browser runtime —
**mode B (in-browser authoring with wasm-Rapier)** and the **Phase 7 editor's live 3D viewport** — has a
different cost profile (an expensive fixed-step sim plus the agent loop running live), and there the right
architecture is a **sim-worker / render-main-thread split**: the worker is the authoritative fixed-step clock
(ECS + physics + agent loop), the main thread is a view that reads transforms **zero-copy from a
SharedArrayBuffer-backed ECS** and interpolates between ticks (`Frame(alpha)` — the native accumulator made
physical). This *preserves* replay determinism (the sim stays the single source of truth) and honors the
standing "heavy work off the frame loop" principle; bitECS's SoA typed arrays map onto an SAB almost directly.
Caveats to plan for: SAB requires cross-origin isolation (COOP/COEP) at deploy; keep WebGPU on the main thread
(the canvas owns the GPU context — the lower-risk split); input crosses main→worker with a one-frame delay
(fine under fixed-step + interpolation). **It is its own track** — NOT needed for **Phase 9** (generation is
native + off-loop; generated worlds ship via the Phase 8 playback path) and NOT retrofitted onto the playback
runtime we just shipped. Sequence it when we commit to mode B / the live editor viewport.

---

## Phase 9 — Worlds worth authoring  *(spike-gated)*
*Folds in former theme: Learned / procedural world generation.*

**Goal:** agents can sketch large naturalistic worlds that a learned generator details — infinite,
deterministic, streamed off the frame loop.

**Work:** typed `terrain.*` / `world.*` skills (`world.generateRegion`, `terrain.sampleHeight`,
`terrain.sampleClimate`, `world.streamFollow`); the generator behind a skill (Python service first,
native wgpu later), heightmaps + climate handed to native Rapier + the renderer; LOD/stream by
camera/agent position; the durable log records the *request* and a content hash while snapshots cache
the tiles for replay. Candidate tech: *InfiniteDiffusion* ([`xandergos/terrain-diffusion`](https://github.com/xandergos/terrain-diffusion)).

**Gate:** an agent sketches a region, it streams in without dropping a frame, and two runs of the same
seed reproduce the region (replay parity via snapshot).

**Depends on:** Phase 6's S0 greenlight; rides Phase 8 so generated worlds ship everywhere too. Engine
stays the substrate — the generator is always behind a skill, never an engine runtime dependency. Full
plan: [`worldgen-terrain-diffusion-spike.md`](./worldgen-terrain-diffusion-spike.md).

---

## Phase 10 — Agent governance & orchestration  *(the safe-scaling foundation)*

**Goal:** make it safe + tractable to point many agents at one game as the catalog grows — least privilege in
exposure *and* invocation, with a first-class delegate/review loop. Full plan:
[`phase-10-governance-orchestration.md`](./phase-10-governance-orchestration.md).

**Work:** **exposure scoping** (profile/bundle-filtered tool list — today `registry.list()` hands every agent
the *whole* catalog; progressive disclosure via categories + a `skills.search` meta-skill; task-scoped working
sets); **dynamic permission bundles** (least-privilege capability sets per task, enforced by the policy
engine); the **coordinator/delegate model** (a `delegate(task, bundle)` skill + a coordinator loop that
decomposes → spawns scoped workers → reviews their held edits via the Phase 7 approval gate).

**Gate:** a `player.limited` agent's tool list excludes `system.*`/`terrain.generate`; a coordinator spawns
workers with scoped bundles, reviews/approves their mutating edits, and the whole tree traces + replays.

**Depends on:** the policy engine + Phase 7 approval gate (shipped) — ~70% is assembly. **Comes first:** every
new skill in Phases 11–12 makes the unscoped exposure worse until this lands.

---

## Phase 11 — Content & assets  *(make content look intentional)*

**Goal:** agents place/instance real assets and configure deterministic generation; assets import once and
instance everywhere; everything stays replayable + portable. Full plan:
[`phase-11-content-assets.md`](./phase-11-content-assets.md).

**Work:** an **asset registry + GLTF import** (content-addressed, exported in `assets/`); **`asset.*`/`prop.*`
placement skills** (scatter/place by id, deterministic); **agent-configurable generation seeds** (promote the
prop `ScatterOptions` to a logged, elevation-aware `ScatterConfig` — the agent sets the art direction);
**pluggable asset sources** (a curated library first; a **text→3D generator** spike-gated — the "agent
generates the art" source, same shape as the S0 terrain probe). The engine consumes assets behind the seam; it
never becomes a modeler.

**Gate:** an agent scatters/places an asset by id; it imports + content-addresses + ships in the export;
placement is deterministic and a generation config the agent sets reproduces the exact world.

**Depends on:** Phase 10 (scoped skills), the Phase 8 export, Phase 9.1 scatter.

---

## Phase 12 — Game-building skill catalog  *(the fully-featured-games through-line; living)*

**Goal:** stock the agent's *vocabulary* for building whole games — characters + animation, gameplay logic
(items/stats/combat/quests/triggers/navmesh), interaction (input/camera/menus), meta. A **living backlog**, not
a single build: each verb is a bounded build (typed/permissioned/traced/deterministic). Living catalog:
[`agent-skill-catalog.md`](./agent-skill-catalog.md).

**Sequence by leverage:** assets/props (Ph 11) → character controller + animation → interaction + triggers +
objectives → inventory/stats/combat. After enough exists, Phase 13 lets the community publish verbs we never
wrote — the real "fully-featured" unlock.

**Depends on:** Phase 10 (safe to grow a large catalog) + Phase 11 (content + the asset/generation pattern).
Runs *ongoing*, alongside and after the others.

---

## Phase 13 — Ecosystem & marketplace  *(the lasting advantage)*
*Folds in former themes: Ecosystem & community + Advanced external memory adapters.*

**Goal:** other people publish skills that others install and run, and richer external memory plugs in
cleanly.

**Work:**
- **Public registry / marketplace** and a third-party skill contribution model — discovery, publishing,
  and a signing/provenance UX on top of the substrate that already ships (versioned packages + manifest
  + capability attestation + content-hash provenance, gated by the policy engine). The *mechanism*
  shipped in Phase 4; this is the *community process and hosted registry*.
- **External memory adapters** — richer recall (vector stores, EventLoom/Zaxy bridges) behind the
  pluggable `LLMProvider`. The engine stays the substrate, not the brain or the memory: recall is
  always external, never an engine runtime dependency.

**Gate:** a third party publishes a skill that others discover, install, and run; and an external memory
adapter plugs in behind the provider seam without the engine taking a dependency on it.

**Depends on:** the stable skill/package surface (already shipped) **plus a catalog + governance worth trading**
— so it's downstream of Phases 10–12; benefits from the reach Phase 8 adds.

**Productized separately:** Phase 13 delivers the *engine-side* registry mechanism + contribution process.
The full marketplace product — hybrid monetization, a web UI + agent-consumable API, and a catalog of
skills/packages/worlds/assets — is its own roadmap: [`skills-exchange-roadmap.md`](./skills-exchange-roadmap.md).
That product builds on this phase; it is never something the engine depends on at runtime.

---

## Out of scope (non-goals, still)

- Engine-owned agent memory or a built-in "brain" (violates the substrate principle; recall stays
  external, see Phase 13).
- A bespoke JS engine (V8 via `deno_core` is the runtime; see Phase 0 decisions).
