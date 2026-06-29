# Limina — State-of-the-Art Agent-Native Game Engine

> **Status:** APPROVED — decisions locked, no build started.
> **Hosted plan:** `plan-a4077f9a4d1649f9` · https://plan.agent-native.com/_agent-native/open?app=plan&view=plan&to=%2Fplans%2Fplan-a4077f9a4d1649f9&planId=plan-a4077f9a4d1649f9
> **Brief:** Make limina the engine where agents (and human+agent teams) author and ship production 3D games — correct skills, beautiful by default, complete enough for any genre.

## Objective

Make limina the state-of-the-art engine for AI agents — and human+agent teams — to author and ship **production** 3D games. Success is concrete: a developer prompts an agent (or a team of them), and the skill catalog is rich, correct, and discoverable enough that they build something genuinely impressive and ship it as a real game — in a browser, on desktop, or on a phone.

The defining idea is architectural, not a bolt-on:

> **Decision —** The world is a deterministic event log. The API is a typed skill catalog built for an LLM's working memory. The artifact an agent authors **is** the shipped game — replayable, portable, branchable, and co-editable by humans. The agent never emits engine code whose effects it can't see; it operates the engine through skills and perceives the result. Determinism + agent-native skills + build-once / deploy-everywhere is the foundation every pillar stands on, and the one thing we never trade away.

## Where limina stands today

This is not greenfield. Phases 0–12 are complete: a single Rust binary (deno_core/V8 → WebGPU/three.js → native Rapier → bitECS), **~140 typed, permissioned, traced skills** across 17 systems, a perception→decision→action agent loop (scripted / Ollama / gateway), a human approval-gate editor (Phase 7), browser export-playback (Phase 8 Mode A), procedural terrain, and real rigged-glTF characters.

A hard audit of the flagship capstone located where the gap actually is:

- **Fidelity is built but switched off.** PBR, IBL, ACES tonemap, real soft shadows, and a GTAO/bloom/grade post stack all exist; defaults ship flat (untextured terrain, gray ground), and live post is disabled by a backend bug.
- **The catalog isn't reliably correct.** `interaction.pickup` leaves a ghost mesh in the scene; quest decline is impossible; A/D steering is inverted in three demos — and the demo *passed its test suite*, because the gate proves determinism, not playability.
- **Deep but not complete.** No procedural buildings/interiors, no agent-facing networking (the netcode exists but isn't exposed), no cutscene sequencer, no animation authoring, shallow combat.

The gap is **surface and completeness, not the loop** — which means it's addressable.

## Non-goals (scope boundaries)

- **Not a specific game.** limina is a general runtime; no single title is a build target. Real games (including ambitious MMORPGs) are used only as requirement stress-tests and showcase demos.
- **Not MMO-scale infrastructure.** Seamless thousand-player sharded worlds with cross-server authority handoff are out of scope — they would strain the single deterministic-log promise. Networking targets instanced / co-op sessions (deferred — see Decisions).
- **Not a human-only editor.** The editor is a human×agent co-authoring surface, not a traditional GUI that sidelines agents.
- **Never break the core promise.** Any primitive that can't be made deterministic, replay-safe, and portable does not ship as-is.

## The five pillars

Five pillars, one foundation. Every pillar stands on the core promise; none may break it.

```
┌──────────┬──────────┬──────────┬──────────┬──────────┐
│ 1·Hands  │ 2·Eyes   │ 3·Beauty │ 4·Team   │ 5·Studio │
│ correct  │ percept. │ fidelity │ multi-   │ human×   │
│ complete │ + visual │ on by    │ agent    │ agent    │
│ composab │ self-fix │ default  │ authoring│ editor   │
└──────────┴──────────┴──────────┴──────────┴──────────┘
┌─────────────────────────────────────────────────────┐
│ THE CORE PROMISE                                     │
│ deterministic world-log · replay · build-once/deploy │
└─────────────────────────────────────────────────────┘
```

### Pillar 1 — The Hands: a Correct, Complete, Composable, LLM-first catalog

The skill catalog is the product. It must satisfy four properties:

- **Correct** — every skill does exactly what its description says, enforced by a *playability* harness, and every call returns structured success/failure the agent can reason about. Silent denials (a permission refused with no signal) are banned — the single worst failure mode for an autonomous builder.
- **Complete** — cover the genres, not one game (see the primitive table).
- **Composable** — high-level macro skills assemble primitives into working loops with excellent defaults; primitives stay exposed for control.
- **LLM-first** — discoverable (`skills.browse` / `search`), typed (Zod), with worked examples and pre/post-conditions sized for a model's context.

The correctness debt is concrete and ready to clear — these are *engine* bugs, not demo bugs:

| Issue | Class | Where | Fix |
|---|---|---|---|
| Picked-up item stays visible | Skill bug | `interaction.pickup` frees the entity but never `scene.remove()`s the mesh | Mirror `scene.destroyEntity`: remove mesh + physics body on pickup |
| Quest decline impossible (always accepts) | Demo wiring | `capstone_game.ts` reopens the dialogue every tick while not accepted | Add a `declined` flag gating the reopen; move decline off the overloaded Shift key |
| A/D steering inverted | Demo wiring | `heading -= axes[0]` in 3 demos; correct sign is `+=` | Factor one shared `headingFromAxes()` helper with the correct sign |
| NPC is the player model in a box | Missing / wiring | both `attachCharacterModel` calls default to `robot.glb` | Tint/scale override now; add a distinct `keeper.glb` asset |
| No mouse-steer (look only) | Missing (deliberate) | heading is A/D-only; mouse drives camera yaw only | Fold look-yaw into sim `input.yaw` (replay-safe: yaw is a recorded input) |
| Turn-in not legible | Missing feedback | invisible proximity auto-win, no prompt | Explicit deliver-dialogue / HUD prompt on return with all relics |

> **The systemic lesson.** The capstone passed a determinism gate while being unplayable: the gate scripts input directly (bypassing the real keyboard mapping), only ever accepts, and never checks the item left the scene. We tested that the sim replays — not that the game works. Going forward, every skill ships with a playability assertion, and demos double as integration tests that exercise real input, the decline branch, despawn, and win. "Passes" must mean "works."

### Completeness — the missing primitive families

| Primitive family | Unlocks | Today | Build delta |
|---|---|---|---|
| Procedural architecture | Buildings, interiors, dungeons, cities | Terrain + vegetation only | NEW generator + skills |
| Animation authoring | Retarget, IK, procedural, blend trees | Clip playback + state machines | NEW authoring skills |
| Cutscene / timeline | Scripted cinematics & set-pieces | Hand-coded in frame loops | NEW sequencer skill |
| Combat depth | Hitboxes, projectiles, abilities, aggro | Melee + stats + status + XP | EXTEND existing combat |
| AI director | World-scale orchestration of events/NPCs | Agent loop + orchestration skills | COMPOSE into a director |
| Progression / economy / crafting | RPG & sim systems | Stats / XP / inventory built | EXTEND + NEW (crafting, economy) |
| Agent networking (`net.*`) | Co-op & shared sessions | Authoritative netcode exists, unexposed | DEFERRED — out of this program |

### Pillar 2 — The Eyes: perception + a closing visual loop

An agent that authors blind produces mediocre worlds. Give it sight:

- **Introspection skills** — query the scene graph, ECS, spatial relationships, and game state ("what's here", "does this overlap", "is there ground under the player").
- **The visual self-correction loop** — author → headless render → vision-model critique → fix, repeated until the frame meets a bar. limina's render is deterministic and headless, which makes this loop *reliable*. It is how agents fix fidelity with no human in the chair — and a capability this architecture is uniquely suited to.
- **The trace/log as causal memory** — the agent re-examines what it did and why (EventLoom).

```
Author/edit ──> Headless render ──frame──> Vision-model critique
   ^                                              │ score
   │ no — fix                                     v
   └────────────────────── Meets the bar? ──yes──> Commit to world-log
```

### Pillar 3 — Beautiful by default, production-grade

- **Native render path (committed).** limina builds its own native wgpu renderer rather than living within deno_webgpu's limits — the route to live post-processing, MSAA/TAA, and direct texture upload. This is Track R, a parallel foundational investment.
- **Flip fidelity on.** PBR / lighting / shadows / post become the default, not opt-in. PBR + shadow defaults land immediately on the current backend; live GTAO/bloom/grade and MSAA arrive with the native path.
- **Curated + generative assets.** A content-addressed library of good characters, props, materials, and animations at easy reach, plus a generative path (worldgen / diffusion) for novel assets. Out-of-box asset quality is the adoption gate.
- **Production concerns.** Perf at scale, save/load, settings, and a hardened export to browser / desktop / mobile.

> **Render backend — committed: invest the native wgpu render path now.** The deno_webgpu backend (no `copyExternalImageToTexture`, no reliable per-frame present, no MSAA) is the ceiling on fidelity; rather than work around it indefinitely, limina builds its own native wgpu render path. Because it is the longest-lead, highest-risk item and unblocks live post (GTAO/bloom/grade), MSAA/TAA, and direct texture upload, it runs as a parallel foundational track (Track R) starting alongside Track A. Track A still ships immediate gains on the current backend (PBR + shadows on by default, a real ground material); the full cinematic ceiling lands when Track R does.

### Pillar 4 — The Team: multi-agent authoring as the headline workflow

Games get built by *teams* of agents, not one. A coordinator decomposes a game into subsystems and spawns specialists (terrain, combat, narrative, art-direction) under **permission bundles**; they author concurrently against the shared world-log; conflicts resolve through the log; a lead agent or human approves. limina already has delegate / coordinator / orchestration skills and permission bundles — this pillar makes that the default way to build.

### Pillar 5 — The Studio: a version-controlled, time-traveling editor

The Phase-7 editor becomes something no incumbent has, and the deterministic log makes it nearly free:

- Human edits and agent skill-calls are the **same event type** in one shared log; the approval queue and reasoning tree already exist.
- **Time-travel scrubbing, branch / diff / merge ("git for worlds"), and live human+agent co-editing** of the same world. Unreal and Unity can't do this cleanly; limina gets it because the world *is* a log.

## What makes it state-of-the-art (the identity to protect)

1. **Closed-loop visual self-correction** — agents that make it look good, not hope.
2. **Git-for-worlds** — branch / diff / merge / time-travel, only possible with determinism.
3. **LLM-first skill contracts** with structured feedback + a verify-what-I-built perception layer → reliable builders, not lucky ones.
4. **Every shipped game ships with its replay as a living regression test.**
5. **Agent-team authoring** as the default — an engine built for studios of agents.

## The program — six tracks (R runs in parallel)

| Track | Outcome | Key work | Reuse vs new | Gate |
|---|---|---|---|---|
| A — Trustworthy & beautiful | Skills do what they say; output looks good | 6-bug pass · playability harness · structured skill feedback · flip fidelity defaults | Mostly fix existing | Capstone replays AND plays; visibly better frame |
| R — Native render (parallel) | Lift the fidelity ceiling | Native wgpu render path · live post (GTAO/bloom/grade) · MSAA/TAA · direct texture upload | New foundational | Live post works during navigation; MSAA on; parity then beyond current output |
| B — Eyes | Agents build reliably & self-correct visuals | Introspection skills · author→render→vision-critique loop | New on existing render | Agent fixes an ugly scene unaided |
| C — Complete | Catalog covers the three archetypes | The missing primitive families | Extend + new | Each archetype built from skills alone |
| D — Studio & Team | Humans+agents co-author; git-for-worlds | Editor branch/diff/merge/time-travel · multi-agent workflow | Extend Phase 7 + orchestration | 2 agents + a human co-build one world |
| E — Ship | Author → production | Export hardening · platform targets (browser/desktop/mobile) | Extend Mode A/B | Built game runs in browser + desktop; export replays |

## Genre archetypes as acceptance gates

"Any genre" is *proven*, not asserted. Completeness (Track C) is gated on building three archetypes end-to-end from skills alone — deterministic and browser-exportable — each with a well-known **feel-target** used as a stress-test and showcase reference (not a clone, not a build target):

- **Third-person action-adventure — feel-target: Skyrim.** Open world, interiors/dungeons, RPG systems, melee/magic combat, quests.
- **Top-down sim/strategy — feel-target: Cities: Skylines.** Many-agent scale, procedural construction, economy, the AI director.
- **First-person explorer — feel-target: Half-Life.** Atmosphere, traversal, scripted set-pieces (the cutscene/timeline primitive), first-person interaction.

Each archetype is one flagship demo and one integration test. A primitive isn't "done" until the archetype that needs it ships. Together the three exercise nearly the whole catalog: Skyrim drives interiors + combat depth + progression; Cities drives procedural architecture + economy + scale; Half-Life drives the sequencer + first-person feel.

## What "done" looks like per track

- **A** — the capstone both replays byte-identically *and* plays correctly (decline works, pickup despawns from the scene, turn-in fires, controls map correctly), and a side-by-side frame is visibly better than today.
- **R** — live post-processing works during free navigation, MSAA is on, and a reference scene reaches parity with the current backend and then exceeds it.
- **B** — an agent takes a deliberately ugly scene and, with no human input, renders → critiques → fixes it to a target bar.
- **C** — each of the three archetypes is authored from skills alone and passes its integration test.
- **D** — two specialist agents plus a human co-author one world through the editor, with branch/merge and time-travel.
- **E** — a built game runs in a browser tab and on desktop, and its exported package replays deterministically.

> **Sequence:** Track R (native render) runs in parallel from the start; the gameplay tracks go **A → B → C → D → E**. A makes today's engine trustworthy and good-looking; B makes agents reliable; C makes the catalog complete against the three archetypes; D makes it collaborative; E makes it shippable. Each unlocks the credibility of the next, and we never build on a broken foundation. No implementation starts until this plan is approved — including Tracks A and R.

## Decisions (locked)

| Decision | Locked choice | Implication |
|---|---|---|
| Render backend | Native wgpu render path — now | New foundational Track R, parallel to A; unblocks live post + MSAA |
| Genre archetypes | All three: action-adventure, sim/strategy, FP explorer | Each gates Track C with a flagship demo + integration test |
| Networking (`net.*`) | Deferred | Out of this program; single-player / local first |
| Build order | A → B → C → D → E (Eyes before Complete) | Reliable agents before catalog breadth |
| Flagship feel-targets | Skyrim · Cities: Skylines · Half-Life | Stress-tests + showcases per archetype — not clones or build targets |
