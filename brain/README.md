# limina-brain — the design brain (vendored gamestack-core + limina adaptation)

This is limina's **Design Brain**: engine-agnostic game-design *craft knowledge* (the `skills/`) on a
process spine (`skills/game-design-process`) that ends in a quality **gate** (`skills/procgen-review`).
It is the layer limina lacked — the reason its games came out functional but flat/samey.

## Attribution

The `skills/`, `shared/`, `ETHOS.md`, `SKILL_TEMPLATE.md`, `UPSTREAM-architecture.md`, and the
`overlays/{godot,unity,unreal,threejs}.md` are **vendored verbatim from
[gamestack](https://github.com/rondorkerin/gamestack)** (MIT — see `gamestack-LICENSE` and `NOTICE`).
`README.md` and `overlays/limina.md` are limina-original. We chose vendor-copy over a submodule so the
brain ships in-repo and adapts at the integration seam, not the craft content (which is engine-agnostic
and needs no rewrite).

## How limina differs from upstream — it EXECUTES the gate

Gamestack is engine-agnostic and **stops at the spec**: its skills describe tests ("render a flat
silhouette and check distinctness", "blind-sample and tell them apart"). limina can render, simulate,
and measure — so it **runs** them. The headline is `procgen-review`'s sameness gate, executed as
`gates/design/` (the silhouette gate: deterministic mask IoU, falsifiable — distinct assets PASS, a
clone-heavy set HARD-FAILS). That is limina's contribution back to the ecosystem: the *limina/web engine
hand* gamestack's `overlays/threejs.md` flags as a roadmap gap (see `overlays/limina.md`).

## The layers (where the brain sits)

```
brain/      ← THIS — design knowledge + process + the procgen-review rubric + the Bible (per game)
engine/     ← the Three.js Engine Hand (currently js/src; renamed last) — ECS, render, asset pipeline
gates/      ← the EXECUTED gates: functional (engine/game/gate.ts) + design (gates/design/)
packager/   ← the gated release container
```

## Tiers (from `UPSTREAM-architecture.md`) — what limina loads when

- **Universal craft** (always in play): `game-design-fundamentals`, `art-direction-and-readability`,
  `game-feel-and-juice`, `level-design`, `onboarding-and-teaching`, `ui-ux-and-feedback`,
  `difficulty-and-balancing`, `pacing-and-the-player-journey`.
- **Technique modules** (always in play — limina is an agent-native *procgen* engine):
  `procedural-generation`, `ai-authored-content-coherence`, `systemic-emergent-design`.
- **Genre lenses** (pulled per game by `game-design-process` after genre classification):
  `open-world-design`, `rpg-systems`, `narrative-and-quest-design`, `combat-design`,
  `worldbuilding-and-lore`, `permadeath-and-lethality`.

## The Bible (per game)

A game's design contract lives in `brain/bible/<game>/` (pillars · world · systems · constraints ·
decisions — markdown), the engine-agnostic record the process produces and the engine consumes. The
**Bible → derived typed GDS** router (`engine/game/intake.ts` + a `gds.ts` per-entity visual/tier
schema extension) turns it into what the engine builds + what the design gate scores.

## Runtime wiring (status)

The skills are knowledge files. Reaching the generation agent at runtime (injecting `ETHOS.md` +
`shared/PREAMBLE.md` and the pulled skills into the SliceBuilder/llmff generation seam) is built
incrementally; today the design phase reads them and the **design gate executes** the procgen-review
sameness check. Routing is advisory (the process names which skill to pull; there is no auto-dispatch),
exactly as upstream.
