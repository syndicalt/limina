# Limina Implementation Plan — from here to the marketplace

> The **execution** companion to [`path-to-adoption.md`](./path-to-adoption.md) (the *why/sequence*).
> This is the *how*: the four builds broken into buildable milestones, each with the work units
> (grounded in real files/systems), an acceptance gate, dependencies, and the build method.
>
> **Sequence:** **Bet 1 Capstone** → **Bet 2 On-Ramp** → **Bet 3 Live Authoring** → **Phase 13 Marketplace.**
> Effort tags (S/M/L) are relative, not commitments; detail for the later bets is fixed at their
> kickoff (the standing convention). Readiness % is "how much already exists."

## Method (every milestone)

The **normal protocol**, per wave: **expert build agent → adversarial review (skeptic + revert-proofs) →
fix findings → verify → commit.** Each milestone ends in (a) an **acceptance gate**, (b) **tests green**
(headless `*.ts`, exit 0), and (c) a **demoable artifact**. Cross-cutting invariants that gate *every*
unit: determinism/replay is sacred (record the request, recompute on replay; no `Date.now`/RNG in sim
paths); every skill stays Zod-typed + permissioned + traced; OOB quality is the bar.

---

## Bet 1 — The Capstone Game  *(Phase 12 Part-F · ~80% ready · the integration build)*

**What's already reusable (no work):** the rigged player + third-person camera + `character_model.ts`
locomotion + `playable_game_window.ts` as the base; and — built + tested in the wave-A/B/C finish —
combat/stats (`combat.ts`), quest (`quest.ts`), inventory (`inventory.ts`), gamestate (`gamestate.ts`),
triggers (`triggers.ts`), navmesh (`navmesh.ts`), animation (`animation.ts`), and save/checkpoint
(`save.ts`, captures ECS transforms + game state, replays via the log). The skill-composition pattern
already works (orb pickup → inventory → counter → condition → `game.win`).

### Pre-work — close the four real gaps *(do these first; they unblock the waves)*
- **G1 — Dialogue → UI bridge (HEADLINE RISK, M).** `dialogue.*` (`behavior.ts` `DialogueManager`)
  traverses the tree + emits `dialogue.started/chosen/ended` but **renders nothing**. The `ui.*` layer
  (`js/src/skills/ui.ts`, `js/src/ui/manager.ts` — speech/thought/textbox/callout + a screen HUD
  container) exists but isn't wired to it. Build a bridge: a skill/handler that renders the active
  dialogue node's text in a `ui.*` panel and shows its **choices as on-screen, clickable text** (the
  browser has no MCP server, so choices CANNOT be MCP tool-selection — they're screen-space UI + input
  hit-testing). ~200 lines, new. *Gate: an NPC line + 2 choices render on screen; clicking a choice
  advances the tree.*
- **G2 — HUD update loop (S).** A per-tick (or on-change) loop that reads quest progress + player HP +
  inventory and pushes them into the `ui.*` HUD container. ~100 lines. *Gate: "Health 80/100 · Relics
  2/3" updates live.*
- **G3 — Scripted NPC behavior provider (S).** A deterministic, non-LLM loop that drives an NPC from the
  existing skills: `behavior` goals/routine → `navmesh.moveTo` → `animation.play` (locomotion) →
  `dialogue.npcSay`. The engine provides the body; this is the scripted "brain" (a thin wrapper, the
  pluggable-brain contract). *Gate: an NPC patrols, animates, and greets the player on approach.*

### Waves
- **W1 — World + player loop (S).** Extend `playable_game_window.ts`: terrain + populated scatter +
  rigged player + camera + a few static structures; the win scaffold wired to a debug counter. *Gate:
  walkable world; win fires on a debug trigger.*
- **W2 — NPCs (L · highest risk; consumes G1+G3).** A rigged NPC (reuse `character_model`, a CC0
  deer/robot) that patrols/navigates, animates, and **gives the quest via the dialogue UI**. *Gate: NPC
  is alive — moves, animates, and holds a visible, choice-driven conversation.*
- **W3 — Gameplay loop (M).** Relic items (spawn + `interaction.pickup` → inventory), trigger zones,
  quest define→offer→accept→update→complete, a hazard/simple enemy (stats/damage), lose condition.
  *Gate: collect→return→win; take damage→lose; both deterministic.*
- **W4 — Feel (M; consumes G2).** VFX (pickup/hit), audio (BGM + SFX), HUD (quest tracker + health),
  camera polish. *Gate: it reads as a game.*
- **W5 — Prove it + ship it (M).** Save/load round-trip; a headless **`p14_capstone`** integration test
  that scripts the full play-through and asserts the win state + **run-twice byte-identical replay**;
  **export the world** (the `tools/export-island.ts` recipe — note the browser replays the recorded skill
  log, so player/NPC/animation playback rides the log) and put it **live on the site `/examples`** as a
  second in-browser playable. *Gate: Part-F met.*

**Acceptance gate (closes Phase 12 Part-F):** one agent-authored game — terrain + rigged player +
animated navigating NPC with on-screen dialogue + a quest with objectives/triggers/rewards + inventory
pickups + a combat/hazard stake + win/lose + save/load — playable start→win by a human, replay
byte-identical, `p14_capstone` green, and running in a browser tab.

**Deliverables:** `js/src/demos/capstone_*.ts` (+ a headless authoring variant), `js/test/p14_capstone.ts`,
the G1 dialogue-UI skill, a `site/public/examples/<capstone>/` export + a second live card on `/examples`.

---

## Bet 2 — The On-Ramp  *(create-limina-app · ~30% ready · the funnel)*

**What exists:** the native binary, the browser-entry runtime bundle (already live on the site), the
Phase-8 export format, and a `getting-started.md` (native-only today). **No npm package / scaffold.**
*Decision: do NOT npm-package the Rust binary* (V8 + wgpu native) — the scaffold assumes the native binary
is installed for authoring depth, with a **browser-only fallback** for the 60-second first run.

### Milestones
- **O1 — Scaffold template (M).** `tools/scaffold/` — a starter project: `world.ts` (a small
  agent-authorable world modeled on the capstone/playable demo), `package.json` with `dev` (windowed),
  `export` (→ a `dist/` browser bundle via the export recipe), `serve` (static), plus `tsconfig`. *Gate:
  copying the template + `npm run dev` loads a world.*
- **O2 — `create-limina-app` CLI (S).** `npx create-limina-app my-world` — copies the template, does
  variable substitution, `npm install`. A template-variant prompt (minimal / full-game / agent-authored).
  *Gate: one command → a running starter project.*
- **O3 — Browser-first dev flow (S).** Wire `export` + `serve` so a user with **no native toolchain**
  reaches a world in a tab in under a minute (reuses the bundled `limina-player.js` + a sample export).
  *Gate: zero-native path renders the starter world in a tab.*
- **O4 — Docs + agent endpoint (S).** A "your first world / 60-second start" page + an MCP quickstart
  (connect an agent, call a skill, see an entity appear) on the site; surface `skills.json` as a stable
  agent endpoint. *Gate: a new dev follows the page and ships a world without prior limina knowledge.*

**Acceptance gate:** a fresh machine runs one command and has an agent-authorable world (browser or
native) on screen in under a minute, with a documented next step. **Overlap note:** O4 docs + O1 template
can start during Bet 1's W5 (the capstone *is* the showcase the on-ramp lands on).

---

## Bet 3 — Live Authoring  *(Phase 8 Mode B · ~20% ready · the visible experience · spike-gated)*

Deep plan: [`phase-8-run-anywhere-plan.md`](./phase-8-run-anywhere-plan.md) ("the live browser runtime").
**Reuses:** the `installOps()`/`ctx.ops` facade (swap PhysicsOps, no agent-code changes), host-agnostic
`replayCommands`, bitECS SoA arrays, the Phase-7 `editor/` web app, and the whole Phase-12 skill surface.
**Net-new** is bounded (~1000 lines across the pieces below).

### Milestones (each a spike that must clear before the next)
- **M1 — wasm-Rapier PhysicsOps adapter (M).** A browser `PhysicsOps` over wasm-Rapier (live sim, not
  keyframes). *Gate: `replayCommands` drives wasm physics; a parity test runs (W0 parity is NOT required
  for Mode B — snapshot keyframes stay the safety net on divergence).*
- **M2 — SAB sim-worker / render-main split (M).** A Web Worker owns the fixed-step ECS+physics+agent loop
  and writes bitECS SoA arrays backed by `SharedArrayBuffer`; the main thread reads transforms zero-copy
  and interpolates (`Frame(alpha)`), renders via WebGPU, and forwards input (one-frame delay). *Gate: a
  world simulates in the worker and renders smoothly on main; determinism preserved (sim is the single
  source of truth).*
- **M3 — Live editor viewport (M).** Wire the Phase-7 editor to the Mode-B worker: an agent calls
  `scene.createEntity`/`world.generateRegion` live → ECS updates → rendered instantly; a human reviews +
  approves edits in the same viewport (the Phase-7 approval gate, in-browser). *Gate: watch an agent build
  a world live in a tab; approve an edit.*
- **M4 — Determinism + replay hardening (S).** Headless parity tests proving a live session replays
  byte-identically (leverage `p8_playback_parity`). *Gate: live-authored session → export → replay matches.*
- **M5 — Deploy (S).** COOP/COEP headers for SAB; WebGPU on main; UAT in a real browser. *Gate: live
  authoring works on the deployed site.*

**Acceptance gate:** an agent authors/edits a world live in a browser tab with a wasm-Rapier sim, a human
reviews/approves in the same viewport, and the session replays deterministically. **Risks:** wasm↔native
physics parity (keyframe fallback), SAB cross-origin isolation, the live agent loop + sim fitting the
frame budget (profile early; keep agent *thinking* off the fixed step). **Overlap note:** M1/M2 are
independent spikes that can begin during Bet 2.

---

## Phase 13 — Ecosystem & Marketplace  *(~5% ready · a separate product)*

Deep plan: [`skills-exchange-roadmap.md`](./skills-exchange-roadmap.md). **The engine already provides the
mechanism** (Phase 4/M9): `js/src/packages/` `PackageRegistry` + Zod `PackageManifest` (semver, declared
capabilities, content-hash provenance, optional signer attestation), the `policy/engine.ts` install/load
gates, QuickJS isolation for entry code, M8 audit provenance, and Phase-8 export/playback for **live world
previews**. Phase 13 builds the **community process + hosted product** on top — engine takes no runtime
dependency on it.

### Milestones (the skills-exchange X-stages; X1–X4 are launch-blocking)
- **X0 — Foundations + de-risk (M).** Architecture (a dedicated web app + registry API + DB + object/CDN
  storage + search), payment/tax provider choice, licensing/legal framework, and a spike: publish →
  content-hash → CDN → install → integrity-verify on real engine provenance. *Gate: round-trip works; stack
  + legal chosen.*
- **X1 — Catalog, identity, listings (L).** Publisher accounts/orgs/tokens; versioned listings
  (skill/package/world/asset) with manifest validation, README, screenshots, and **live world previews via
  the Phase-8 browser runtime**; public catalog + search; CLI install (fetch by hash → verify →
  `PackageRegistry.install`). Free listings end-to-end. *Gate: publish → discover → install with integrity
  verify.*
- **X2 — Trust & safety, surfaced (M).** Every listing shows its **capability footprint** (from the
  manifest) + provenance; **pre-publish sandbox verification** (run the entry in QuickJS + policy engine →
  "verified" badge; reject over-claim); publisher signing + verified badges; **yank + advisory** to all
  installers (version-pinning makes it enforceable). *Gate: over-permissioned listing rejected at publish;
  yank reaches installers.*
- **X3 — Monetization (L).** Free/paid listings, license models, checkout → entitlement token (bound to
  content hash + buyer), payouts + tax via the provider, install requires a valid entitlement. *Gate: sell
  → buy → install → publisher paid → entitlement enforced.*
- **X4 — Agent-native consumption (M · the differentiator).** A permissioned **Exchange API + MCP tools**
  (`exchange.search/getCapabilities/checkEntitlement/install`) so an in-world agent searches, reads the
  footprint, and installs within its **policy budget**, fully traced + governed (extends the policy
  engine's existing capability gate to license checks). *Gate: an agent licenses + installs a skill within
  budget, mid-game, governed end-to-end.*
- **Public beta** = X1–X4 + hardening. **X5 (quality/discovery/curation)** and **X6 (growth/ops)** are
  **post-launch**.

**Acceptance gate (Phase 13):** a third party publishes a skill others discover, install, and run; and an
external memory adapter plugs in behind the `LLMProvider` seam without the engine depending on it.

---

## Critical path & sequencing

```
Bet 1 Capstone ──→ Bet 2 On-Ramp ──→ Bet 3 Live Authoring ──→ Phase 13 Marketplace
~80% ready          ~30%                ~20% (spike-gated)        ~5% (separate product)
the proof           the funnel          the visible experience    the ecosystem
```

| Build | Net-new work | Reuses | Headline risk |
|---|---|---|---|
| **1 Capstone** | dialogue-UI bridge, choice render, HUD loop, scripted NPC loop, `p14_capstone` | the whole Phase-12 catalog + player/camera/save | dialogue→UI assembly |
| **2 On-Ramp** | scaffold + CLI + browser dev flow + docs | browser-entry bundle, export format, demos | packaging boundary (don't ship the Rust binary) |
| **3 Live Authoring** | wasm-Rapier ops, SAB worker/render split, editor wiring, COOP/COEP | ctx.ops facade, replayCommands, bitECS SoA, Phase-7 editor | wasm↔native physics parity; SAB isolation; frame budget |
| **4 Marketplace** | web app, entitlements, payments, sandbox-verify pipeline, Exchange API/MCP, yank | Phase-4 packages + policy engine + Phase-8 previews | it's a product/ops lift, not engine work |

**Parallelization that's safe:** on-ramp docs/template (O1/O4) can start during the capstone's W5; the two
Mode-B spikes (M1 wasm-Rapier, M2 SAB) are independent and can begin during Bet 2. **But Bet 1 leads** —
nothing else is worth as much without the proof, and the capstone is the showcase the on-ramp lands on and
the world the live editor first edits.

## What this plan deliberately does NOT change
- The substrate principle (engine = world + perception + durable log; brain + memory stay external).
- The determinism/replay invariant (the gate on every milestone above).
- Performance-first (native hot paths; agent thinking off the frame loop — load-bearing for Mode B).
