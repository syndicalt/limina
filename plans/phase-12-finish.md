# Phase 12 — FINISH plan (make the playable-game skills real, replay-safe, tested)

> **STATUS: ✅ COMPLETE (2026-06-28).** Waves A/B/C landed (commits fcee4c1, bfad812,
> 830e970). All 21 `p12_*` tests + full headless suite (110/0) + portability pass.
> Deferred follow-ups (low priority): `context` tags + decision-system auto-bootstrap
> (Part A2); `parseGltfScene` retaining `gltf.animations` so rigged glTF clips play
> through `animation.*`; recorder embedding the full `perms` array in every command
> (bloats the log as profiles grow — tests now assert on `.input`, not whole command).

> Follows the review of the initial Phase-12 drop. The catalog/vision is right; the
> execution is an API scaffold with three systemic defects. This plan finishes it to a
> coherent, working, **deterministic + tested** baseline, built by expert agents under the
> usual protocol (build → adversarial review → fix → commit), one wave at a time.

## Root defects to fix (from review)
1. **Unwired managers.** Every `registerXSkills` builds a manager and returns it, but the
   module-level skill consts read `(ctx.world as unknown as {...}).xManager`, which is
   **never set anywhere** → every manager-backed handler no-ops (`{ok:false}`/empty).
2. **Determinism breaks the replay invariant.** 8 `Date.now()` sites (quest×3, behavior×2,
   save, worldstate, interaction) write wall-clock into stored/returned/traced state;
   `gamestate` uses `new Function()` over agent strings.
3. **save/load bypasses the world log** and stores empty snapshots; misleading success.
Plus: many stub-behind-real-API skills; player/camera duplicate the real
`CharacterController`/`ThirdPersonCamera`; MCP "bootstrap surface" mechanism never shipped;
zero Phase-12 tests; `player.full` profile missing; 3 over-granted scopes.

## The convention (locked) — closure pattern, matching `terrain.ts`
- Skill `SkillDefinition`s are defined **inside** `registerXSkills`, closing over the local
  manager(s). No `ctx.world` casts. A fresh registry → fresh managers → replay starts clean.
- Cross-system deps are passed explicitly (e.g. `registerInteractionSkills(registry,
  { inventoryManager })`), exactly like `social`/`water` wiring.
- **No `Date.now()`/`new Date()`/`Math.random()`/`performance.now()` in handlers.** Use
  `ctx.tick` for time and `seq++`/`ctx.tick` for ids/handles. Manager methods that stamp time
  take a `tick` param.
- Every skill stays Zod-typed (in+out), permissioned, categorized, traced (`ctx.emit`).
- Every system ships a headless test in `js/test/p12_*.ts` that includes a **replay-equivalence**
  check (record an invoke sequence → replay → assert state/outputs bit-identical).

### Agreed `registerCoreSkills` wiring (index.ts owns this; agents conform to these signatures)
```
const gamestate    = registerGameStateSkills(registry);
const triggers     = registerTriggerEventSkills(registry);
const quest        = registerQuestSkills(registry);
const inventory    = registerInventorySkills(registry);
const interaction  = registerInteractionSkills(registry, { inventoryManager: inventory.inventoryManager });
const combat       = registerCombatSkills(registry);           // creates stats+combat mgrs internally
const progression  = registerProgressionSkills(registry);
const behavior     = registerBehaviorDialogueSkills(registry);
const worldstate   = registerWorldAudioExtensionSkills(registry);
const save         = registerSaveSkills(registry, { recorder? });   // wave A3
// wave B (engine-wired):
const player       = registerPlayerSkills(registry);          // wraps world/character.ts
const camera       = registerCameraSkills(registry);          // wraps world/third_person_camera.ts
const animation    = registerAnimationSkills(registry);       // three AnimationMixer
const nav          = registerNavmeshSkills(registry);         // grid + A*
const vfx          = registerVFXSkills(registry);             // CPU instanced particles
```
Managers needing a per-frame pump expose `update(dtMs|tick)`; the host loop drives them
(camera/animation/vfx are render-only; nav.moveTo is sim → driven at the fixed step).

---

## Wave A — Foundation, determinism, finish the JS-real systems  (CORE of "finish")
**A1 (integration spine — done centrally):** rewrite `index.ts` to the closure wiring above;
`permissions.ts` (add `player.full`; trim over-granted `save.read`/`game.read`/`status.configure`);
add `js/src/skills/_expr.ts` — a small safe boolean expression evaluator (flags/counters/AND/OR/NOT,
no `new Function`); keep `WorldContext` cast-free (no new fields needed).

**A2 (one expert agent per file — parallel):** refactor to the closure pattern + `ctx.tick`,
finish the behavior to the per-system DoD, add `p12_*` test w/ replay-equivalence:
- `gamestate.ts` — replace `new Function` with `_expr`; `game.timer`/`onTimerComplete`/`condition`/
  `onCondition` real; win/lose/restart real.
- `triggers.ts` — `EventManager.emit` actually dispatches to listeners; trigger zones evaluated
  against entity positions on a `tick()` pump.
- `quest.ts` — `ctx.tick` for ticks; real objective progress/complete/fail; reward/follow-up at
  least recorded; no stubbed success.
- `inventory.ts` — enforce `typeRestrictions`; equip/unequip real.
- `interaction.ts` — `ctx.tick`; real proximity (spatial query) for `query`; `drop` spawns the
  world item; `use` consumes; remove no-op sort.
- `combat.ts` — already deterministic; finish `stats.onZero` hook, `combat.ranged` (spawn tracked
  projectile or honest emit), `combat.defend` (apply reduction); keep crit/variance deterministic.
- `progression.ts` — real `onLevelUp` hook + firing; skillTree/allocate prereq enforcement.
- `behavior.ts` — `ctx.tick`; store `behavior.onEvent` reactions; keep brain pluggable (no AI).
- `worldstate.ts` — `ctx.tick`/`seq` for SFX handle; spawn get/set real; time/weather config real.

**A3 (one expert agent):** `save.ts` — no `Date.now`; `checkpoint.create/load` snapshot+restore
REAL state (ECS transforms + serializable manager state); `save.export/import` build on
`assembleExport`/`loadExport` where a recorder is available, else a real deterministic snapshot;
descriptions must match behavior. Test incl. round-trip restore.

**Gate:** `npm --prefix js run check:portability`; run all `js/test/*.ts` (skip the known
windowed/UAT skip-list); adversarial review; fix; commit.

## Wave B — Engine-wired systems
- `player.ts` — wrap real `CharacterController`; fix jump (controller vy, not impulse-on-kinematic);
  functional input registry over `op_input_*`.
- `camera.ts` — wrap `ThirdPersonCamera`; first/third/topdown/follow + `update()` pump.
- `animation.ts` — drive three `AnimationMixer` for real GLTF clip playback (play/stop/blend/emote);
  state-machine params evaluated deterministically; `update(dt)` pump.
- `navmesh.ts` — walkable grid (terrain `sampleHeight`) + deterministic A*; `moveTo` drives
  `op_physics_move_character`; reachability real.
- `vfx.ts` — CPU particle system as a scene `InstancedMesh`, dt-driven; `atPosition` burst, `attach`
  follows an entity.
Each: closure + tests + a demo touch-point.
**Gate:** same as Wave A. Commit.

## Wave C — MCP surface mechanism + capstone
- `priority: "core"|"standard"|"advanced"` on `SkillDefinition`; `list(grants, mode?)` with a
  `"bootstrap"` mode (core only, ~≤15); `context` tags + optional filter; decision-system inits
  agents at bootstrap. Tag the universal verbs `core`.
- Capstone demo: an agent authors + plays a tiny game using ONLY skills (terrain + player + an
  item pickup + a trigger + a win condition). Surface-subset test per profile.
**Gate:** same. Commit.

## Definition of done
All Phase-12 skills are wired (no always-undefined no-ops), deterministic (no wall-clock; replay
bit-identical), honest (descriptions match behavior; no misleading success), and covered by
`p12_*` headless tests. `save` builds on the log. Bootstrap surface caps the agent tool count.
Engine-wired systems reuse the existing `CharacterController`/`ThirdPersonCamera`. No regressions.
