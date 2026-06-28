# Agent Skill Catalog (Phase 12 — living)

> The agent's **vocabulary for building fully-featured games** — the verbs an agent authors through. This is a
> *living backlog*, not a single build: each verb (or small group) becomes a bounded build like the ones we
> ship. The catalog is the heart of the agent-native mission; growing it *safely* is why **Phase 10
> (Governance)** comes first, and stocking it with content is why **Phase 11 (Content & Assets)** comes next.
> **Through-line:** turn "a world" into "a game" — entities that move believably, mechanics, goals, and
> interaction — all authored by agents through typed skills.
> **Status:** living. Reflects what's shipped; reorder freely.

## The one rule every verb follows
Each skill is **typed (Zod) + permissioned + traced + deterministic + replayable**, and content-heavy verbs
lean on **generators behind the seam + agent-configurable seeds**. So the catalog grows *uniformly* — every
new verb is the same kind of brick, the durable log keeps the whole game replayable/exportable, and Phase 10's
scoping means no agent ever sees the whole list at once.

## The map — have / next / later

### Substrate (shipped — strong)
ECS, physics (+ heightfields), WebGPU render, the agent loop (multi-turn), policy/permissions, durable log
(= save / replay / export), authoritative multiplayer sync, MCP, browser export, spatial index.

### Content (Phase 9 + 11 + 12)
- **Have:** terrain (generate/sample/stream), prop scatter (trees/rocks/grass), assets (GLTF import + `asset.scatter`), water/sky/weather, lighting + time-of-day, structures/buildings.
- **Next:** particles/VFX, decals, post-processing.

### Characters & animation
- **Have:** agent "bodies", **character controller** (walk/run/jump/crouch/sprint), **skeletal animation** + blend states + state machines + emotes.
- **Later:** ragdoll, IK, facial/emote, crowds.

### Gameplay logic *(shipped Phase 12)*
- **Have:** items/inventory, stats/health/resources, **triggers/events**, **objectives/quests**, **win-lose conditions**, dialogue trees, **navmesh/pathfinding**, combat (melee/ranged/defend), status effects, game state (flags/counters/timers/conditions), checkpoints/save/load, progression (XP/leveling/skill trees/unlocks).
- **Later:** crafting, economy, difficulty.

### Interaction & presentation
- **Have:** `ui.*` containers, demo cameras (orbit/free-fly), **camera rigs** (follow/first-person/third-person/top-down), **input bindings/actions**, pick-up/use/talk interaction, menus + game flow.
- **Later:** accessibility, gamepad/touch, in-world UI.

### Meta
- **Have:** save / replay / export (the log), multiplayer sync, **sessions/lobbies**, **progression**, **world dynamics** (time/weather/timeScale).
- **Later:** analytics, telemetry, anti-cheat.

## Sequencing — by leverage (what unlocks the most game types fastest)
1. **Assets/props** *(Phase 11)* — worlds that look intentional.
2. **Character controller + animation** — things move believably (turns terrain into a place you inhabit).
3. **Interaction + triggers + objectives** — a *world* becomes a *game* with goals.
4. **Inventory / stats / combat** — mechanics.
Each step is a small build (or a few). After enough of the catalog exists, **Phase 13 (Ecosystem)** lets the
community publish verbs we never wrote — the real "fully-featured" unlock.

## How this doc is used
- It's the **backlog** for the game-building mission: pick a cluster, scope a bounded build (a verb or small
  group), ship it the usual way (typed/permissioned/traced/tested), tick it from *next* to *have*.
- It is **not** a single phase to "complete" — Phase 12 is the *ongoing* act of stocking the catalog; it runs
  alongside and after the others.

## Dependencies
- **Phase 10 (Governance)** must lead — scoped exposure + bundles are what make a large catalog safe + usable.
- **Phase 11 (Content & Assets)** stocks the content half + the asset/generation pattern the catalog reuses.
- **Phase 13 (Ecosystem)** scales the catalog past first-party builds.
