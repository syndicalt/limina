# Path to adoption — the next three builds

> **Strategy doc** (the *why* + sequence). The milestone-level **execution** detail — work units,
> acceptance gates, and what's reuse vs net-new for each build — lives in
> [`implementation-plan.md`](./implementation-plan.md).
>
> Companion to [`ROADMAP.md`](./ROADMAP.md) / [`post-mvp-roadmap.md`](./post-mvp-roadmap.md).
> Phases 0–12 are done and the catalog/governance/export surface is proven. The strategic
> gap is **not capability — it's an audience.** A marketplace (Phase 13) presupposes one.
> This plan sequences the three builds that *create* the audience, in order, before Phase 13:
>
> **1. The Capstone Game** (the proof) → **2. The On-Ramp** (the funnel) → **3. Live Authoring**
> (the visible experience) → *then* Phase 13 (ecosystem & marketplace).
>
> Tied to the North Star: *"agent-native authoring is the lead; make it real and **visible**
> first; marketplace follows once authoring is established."* Each build makes authoring more
> real, more reachable, or more visible. Each closes with an acceptance gate + tests green +
> a demoable artifact, the same cadence as every prior phase. These map onto existing phase
> numbers where they extend one (capstone = Phase 12 Part-F; live authoring = Phase 8 Mode B);
> the on-ramp is new. Phase 13 keeps its number and moves to last.

---

## Bet 1 — The Capstone Game  *(the proof; completes Phase 12 Part-F)*

**Goal.** An agent authors **one complete, playable game** through skills only — exercising the
whole stack end-to-end — that a human can play start→win, that replays byte-identically, and
that ships **live in the browser** on the site. This is the single most persuasive artifact
limina can produce: it turns "85 skills across 17 systems" from a list into a *thing you can play*.

**Why first.** (a) It's the headline demo for the site/launch. (b) It's the first time all the
Phase-12 systems run *together* — so it's also a **gap-finder**: composing nav + animation +
dialogue + combat + quest + save in one world WILL surface skills that are individually green but
don't yet interoperate. Finding and closing those gaps is the real Part-F acceptance, and it
hardens the catalog before anyone else builds on it.

**The game (small but complete).** A short quest on a generated island:
- Spawn the rigged player on `world.generateRegion` terrain + `world.populateBiome` scatter,
  third-person camera (the playable_game_window base, extended).
- An **NPC** (rigged glTF, e.g. the CC0 deer/robot) gives a quest via **dialogue** ("bring me
  3 relics"); it **navigates** (navmesh.moveTo) a patrol/idle routine and **animates**.
- **Items**: relics spawn in the world; the player **picks them up** (interaction.pickup →
  inventory); a **trigger** zone + **gamestate** counter track progress.
- A **hazard or simple enemy** (stats/damage/melee, or a damage trigger) gives stakes + a
  lose condition.
- **Quest** define/offer/accept/update/complete; **win** when the relics are returned
  (`game.condition` → `game.win`); **HUD** (quest tracker + health) via `ui.*`.
- **Save/load** at a checkpoint; **VFX/audio** feedback (pickup sparkle, hit, a BGM bed).

**Work (waves, each via the normal protocol — expert build → adversarial review → fix → commit):**
- **W1 — World + player loop.** Terrain + player + camera + a few static structures; the win
  scaffold (`game.condition`/`game.win`) wired to a placeholder counter. *Gate: walkable world,
  win fires on a debug key.*
- **W2 — NPCs (highest-risk wave).** Rigged NPC model(s) reusing `character_model` for non-player
  entities; `behavior` routine (patrol/idle) driving `navmesh.moveTo`; locomotion-driven
  animation; **dialogue surfaced in a real UI panel** (wire `dialogue.*` → `ui.*` — likely a
  gap to close). *Gate: an NPC walks a route, animates, and holds a scripted dialogue you can
  see and advance.*
- **W3 — Gameplay loop.** Relic items (spawn + `interaction.pickup` → inventory), trigger zones,
  quest define→offer→accept→update→complete, the enemy/hazard (stats/damage), lose condition.
  *Gate: collect all relics → return → win; take enough damage → lose; both deterministic.*
- **W4 — Feel.** VFX (pickup/hit), audio (BGM + SFX), HUD (quest tracker + health bar), camera
  polish. *Gate: the game reads as a game, not a tech demo.*
- **W5 — Prove it + ship it.** `save/load` round-trip; a headless **`p14_capstone` integration
  test** that scripts the full play-through and asserts the win state + **run-twice byte-identical
  replay**; **export the capstone world** (the `tools/export-island` pattern) and put it **live on
  the site `/examples`** as a second in-browser playable. *Gate: Part-F met — full game playable,
  deterministic, tested, and running in a browser tab.*

**Acceptance gate (Phase 12 Part-F).** One agent-authored game: terrain + rigged player +
animated navigating NPC(s) with dialogue + a quest with objectives/triggers/rewards + inventory
pickups + a combat/hazard stake + win/lose + save/load — playable start→win by a human, replay
byte-identical, `p14_capstone` green, and live in-browser on the site.

**Risks / unknowns to plan for.** Dialogue→UI wiring (likely the biggest gap); NPCs combining
nav+anim+behavior coherently; keeping the *whole* composite deterministic (every manager's state
must replay — esp. save/load); keeping the in-browser export within the WebGL2/GPU budget the
island demo already hit (cap resolution, keep the scene modest).

**Maps to:** Phase 12 Part-F (`plans/phase-12-playable-game-skills.md`). Closes the deferred capstone.

---

## Bet 2 — The On-Ramp  *(the funnel; new)*

**Goal.** A new developer (or their agent) goes from zero to a running, agent-authorable limina
world in **under a minute**, in the JS/TS ecosystem's native idiom — no `git clone && cargo build`.

**Why second.** A marketplace and a community need a front door. Today the first touch is a native
build; the audience that "agent-native" reaches lives in `npx`/the browser. This is the cheapest
high-leverage adoption lever, and the capstone (Bet 1) gives the on-ramp something worth landing on.

**Work (detail fixed at kickoff):**
- **`create-limina-app` (or `npx limina init`)** — scaffold a project: a starter agent-authored
  world, the skill/MCP wiring, a dev script, and an export config. Mirrors the ergonomics the
  JS ecosystem expects.
- **Browser-first quickstart** — the scaffold runs in a tab via the proven Phase 8 export-playback
  path (the same `browser-entry` bundle now live on the site), so the first run needs no native
  toolchain. Native build stays the path for authoring depth.
- **Docs on-ramp** — a 60-second "your first agent-authored world" + the `skills.json`/MCP quickstart
  (the agent-facing docs already exist; this threads them into the create-app flow).

**Acceptance gate.** A fresh machine runs one command and has an agent-authorable world (browser or
native) on screen in under a minute, with a documented next step.

**Risks.** Packaging the engine for `npx` consumption (what ships vs builds); keeping the browser
quickstart honest about the WebGPU/WebGL2 support matrix (graceful degradation, as the site does).

---

## Bet 3 — Live Authoring  *(the visible experience; Phase 8 Mode B)*

**Goal.** The full engine runs **live** in a browser tab — not just playback — so you can *watch an
agent build and edit a world in real time*, and a human can co-author in the same tab. This makes
"author worlds with agents" tangible, the way only a live viewport can.

**Why third.** It's the most ambitious and the most "wow," but it's also the heaviest lift and
should ride a proven capstone + an audience to land on. It's the deferred **Phase 8 Mode B** +
the Phase 7 editor's live 3D viewport.

**Work (detail fixed at kickoff — architecture already specced in `phase-8-run-anywhere-plan.md`):**
- **wasm-Rapier** `PhysicsOps` adapter behind the `ctx.ops` facade (live sim, not keyframes).
- **Sim-worker / render-main split** over `SharedArrayBuffer`: the worker is the authoritative
  fixed-step clock (ECS + physics + agent loop); the main thread reads transforms zero-copy from
  SAB-backed ECS and interpolates (`Frame(alpha)`). Preserves replay determinism (sim stays the
  single source of truth) and honors "heavy work off the frame loop."
- **The live editor viewport** (Phase 7's co-authoring surface, now in-browser) — the agent's
  perception→decision→action and its edits, visible and reviewable live.
- Deploy plumbing: COOP/COEP headers for SAB; WebGPU stays on the main thread (canvas owns the
  context); input crosses main→worker with a one-frame delay (fine under fixed-step + interp).

**Acceptance gate.** An agent authors/edits a world live in a browser tab with a wasm-Rapier sim,
a human reviews/approves edits in the same viewport, and the session replays deterministically.

**Risks.** wasm-Rapier native↔wasm parity (snapshot keyframes as the safety net); SAB cross-origin
isolation at deploy; the live agent loop + sim fitting the frame budget in a tab.

**Maps to:** Phase 8 Mode B (`plans/phase-8-run-anywhere-plan.md` — "the live browser runtime").

---

## Then — Phase 13 (Ecosystem & Marketplace)

Unchanged in scope (`post-mvp-roadmap.md` §Phase 13), now correctly sequenced **after** the three
builds above: once there's a playable proof, a one-minute on-ramp, and a live authoring experience,
there's an audience that *wants* to publish and install — which is what a marketplace needs.

## Sequencing & dependencies

```
Bet 1 Capstone ──→ Bet 2 On-Ramp ──→ Bet 3 Live Authoring ──→ Phase 13 Marketplace
(proof)            (funnel)           (visible experience)       (ecosystem)
```
- **1 → 2:** the on-ramp lands new users on the capstone (something worth their first minute).
- **2 → 3:** an audience justifies the heaviest build; live authoring deepens what the on-ramp started.
- **3 → 13:** proof + funnel + live experience = the audience a marketplace presupposes.
- Each build is independently shippable and demoable; if priorities shift, 2 and 3 can swap, but
  **1 leads** — nothing else is worth as much without the proof.
