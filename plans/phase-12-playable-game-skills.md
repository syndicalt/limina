# Phase 12 — Playable Game Skills + MCP Surface Management

> **Status:** ✅ IMPLEMENTED — all skills built and wired into the engine.
> **Goal:** stock the skill catalog with every verb an agent needs to author a **playable grounded-stylized game**, while keeping the MCP surface **usable** for agents (not overwhelming).
> **Prerequisites:** Phase 10 (Governance — scoped exposure + bundles) and Phase 11 (Content & Assets — asset/generation patterns) must be complete.
> **Standing principle:** every skill is typed (Zod) + permissioned + traced + deterministic + replayable. NPC AI is **pluggable** — the engine provides the body and perception, not the brain.

---

## Part A — MCP Surface Management

With 45+ existing skills and 60+ more planned, agents will drown if every tool is in their face at once. We already have **profile-based filtering** (agents only see tools they're authorized for), but that's not enough. Here's the layered approach:

### A1. Progressive Disclosure (Primary)

**Problem:** `registry.list()` returns all authorized tools at once. A `builder.readWrite` agent sees 45+ tools in a flat list.

**Solution:** Add a **search-first + browse-by-category** pattern:

| Mechanism | How It Works | Agent Behavior |
|-----------|-------------|----------------|
| **Bootstrap list** | `list()` returns only `core`-tagged tools (max ~12) — the universal verbs every agent needs | Agent starts with a manageable surface |
| **`skills.search`** (enhanced) | Search by name, description, category, intent keywords | Agent discovers tools on-demand |
| **`skills.browse`** (new) | List tools in a specific category (`"animation"`, `"inventory"`, `"combat"`, etc.) | Agent explores a domain when needed |
| **`skills.describe`** | Full schema + examples for a named skill | Agent learns how to call a tool |

**Implementation:**
- Add a `priority: "core" | "standard" | "advanced"` field to `SkillDefinition`
- `list(grants?, mode?)` — new optional `mode` param:
  - `"bootstrap"` → only `core` priority tools
  - `"full"` (default) → all authorized tools (backward compat)
- Add `category` field to `MCPTool` interface (was previously dropped) so agents can group visually
- Decision system initializes agents with `mode: "bootstrap"`, then tools expand as agent calls `skills.browse` or `skills.search`

**Key files:** `js/src/skills/registry.ts`, `js/src/mcp/protocol.ts`, `js/src/agents/systems.ts`

### A2. Context-Aware Tool Subsets (Secondary)

**Problem:** Some tools are only relevant during specific game phases (building vs. playing vs. debugging).

**Solution:** Add a `context` tag to skills, and let sessions declare their active contexts:

```typescript
// SkillDefinition addition
context?: string[]; // ["build", "play", "debug", "author", "runtime"]

// Session declares contexts
session.contexts = new Set(["build", "author"]);

// list() filters by intersection
list(grants?, mode?, contexts?)
```

| Context | When Active | Example Tools |
|---------|-------------|---------------|
| `build` | World authoring phase | `scene.createEntity`, `world.generateRegion`, `terrain.*`, `asset.*` |
| `play` | Runtime gameplay | `player.*`, `inventory.*`, `combat.*`, `dialogue.*` |
| `debug` | Developer/inspector mode | `trace.*`, `inspector.snapshot`, `audit.*` |
| `author` | NPC behavior authoring | `behavior.*`, `dialogue.*`, `quest.*` |

### A3. Meta-Skill Patterns (Tertiary)

**Problem:** Related operations (e.g., `inventory.add`, `inventory.remove`, `inventory.list`) each take a tool slot.

**Solution:** For tightly-coupled CRUD-style operations that share permissions, use a **single meta-skill with an action parameter**:

```typescript
// Instead of 3 separate tools:
//   inventory.add, inventory.remove, inventory.list

// One meta-skill:
const inventory: SkillDefinition = {
  name: "inventory",
  description: "Manage an entity's inventory. Actions: add, remove, list, transfer",
  input: z.object({
    action: z.enum(["add", "remove", "list", "transfer"]),
    entity: z.string(),
    item: z.string().optional(),
    quantity: z.number().optional(),
    target: z.string().optional(), // for transfer
  }),
  // ...
};
```

**Rules for meta-skills:**
- Only use when operations are tightly related and share the same permission
- Each action must still be individually traceable (emit `skill.executed` with `action` field)
- Max 5-6 actions per meta-skill (beyond that, split)
- Don't mix read and write permissions in one meta-skill

**When NOT to use meta-skills:**
- Operations need different permissions
- Operations are invoked by different agent roles
- Input schemas are wildly different
- You need separate approval gates per operation

### A4. Recommended Surface Per Agent Profile

| Profile | Bootstrap Tools | Total After Browse | Context |
|---------|----------------|-------------------|---------|
| `builder.readWrite` | ~12 core building tools | ~60 (all authoring tools) | `build`, `author` |
| `player.limited` | ~8 core interaction tools | ~25 (play-time tools) | `play` |
| `npc.agent` | ~6 core behavior tools | ~15 (NPC verbs) | `play` |
| `reviewer` | ~5 audit tools | ~10 (observability) | `debug` |
| `system.readonly` | ~3 introspection tools | ~8 (read-only) | `debug` |

**Target:** No agent sees more than **15 tools at bootstrap**, and **~60 max** after full browse. This is within LLM context window limits for tool reasoning.

---

## Part B — Skill Catalog: Full Playable Game

Skills grouped by system. Each entry includes: name, permissions, description, and notes on implementation complexity.

### B1. Player Input & Movement

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `input.bind` | `input.configure` | Bind an action name to input sources (keyboard keys, mouse buttons, gamepad axes). Returns a binding handle. | Medium |
| `input.action` | `input.read` | Query whether a bound action is currently active (pressed/held/released). | Low |
| `input.axis` | `input.read` | Query a continuous axis value (e.g. WASD → move vector, mouse → look delta). | Low |
| `player.move` | `player.write` | Move the player entity by a delta vector, respecting collisions and the character controller. | Medium |
| `player.jump` | `player.write` | Trigger a jump on the player's character controller (respecting grounded state). | Low |
| `player.sprint` | `player.write` | Toggle sprint mode (multiplies move speed). | Low |
| `player.crouch` | `player.write` | Toggle crouch (reduces height, slows movement). | Low |
| `player.climb` | `player.write` | Attempt to climb a ledge/vault an obstacle (auto-detected from character controller). | High |

**Character controller (Rust, not a skill):** The above skills drive a **character controller** component (separate from physics bodies). It handles: grounded detection, gravity, slope sliding, step climbing, jump arc, crouch capsule resize. This is a Rust-side system — the skills are the agent-facing interface.

### B2. Camera System

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `camera.follow` | `camera.write` | Attach a camera to follow an entity with configurable offset, smoothness, and collision avoidance. | Medium |
| `camera.firstPerson` | `camera.write` | Set camera to first-person mode on an entity (head position, look rotation from input). | Medium |
| `camera.thirdPerson` | `camera.write` | Set camera to third-person orbit mode (distance, pitch/yaw limits, collision zoom). | Medium |
| `camera.topDown` | `camera.write` | Set camera to top-down/isometric view with configurable angle and zoom range. | Low |
| `camera.look` | `camera.write` | Apply a look rotation (Euler or quaternion) to the active camera. | Low |
| `camera.shake` | `camera.write` | Trigger a camera shake (amplitude, duration, frequency, fade). | Low |
| `camera.setFOV` | `camera.write` | Set the camera's field of view (with optional smooth transition). | Low |
| `camera.cut` | `camera.write` | Instantly cut camera to a new position/target (for cinematic transitions). | Low |

### B3. Animation System

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `animation.load` | `animation.read` | Load an animation clip from an asset (GLTF animation, FBX, or procedural definition). | Medium |
| `animation.play` | `animation.write` | Play an animation clip on an entity's animator (with layer, weight, speed, loop). | Medium |
| `animation.stop` | `animation.write` | Stop an animation on a layer (with optional fade-out time). | Low |
| `animation.blend` | `animation.write` | Blend between two or more clips with weights (for locomotion: idle/walk/run). | High |
| `animation.transition` | `animation.write` | Trigger a state transition in an animation state machine (if entity has one). | High |
| `animation.createStateMachine` | `animation.write` | Define an animation state machine: states, transitions, conditions, blend trees. | High |
| `animation.setParam` | `animation.write` | Set an animator parameter (bool, float, int, trigger) to drive state machine transitions. | Low |
| `animation.getClipInfo` | `animation.read` | Get current clip name, time, duration, and layer for an entity's animator. | Low |
| `animation.emote` | `animation.write` | Play a one-shot emote/expressive animation on a character (wave, point, nod, etc.). | Medium |

**Implementation note:** Animation runs on the **Rust side** for performance. Skills register animation requests; the animation system evaluates blend trees and updates bone transforms each frame. State machines can be **agent-authored** (via `createStateMachine`) or **built-in** (locomotion, idle).

### B4. Interaction System

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `interaction.register` | `interaction.configure` | Register an entity as interactable with a prompt text, max range, and interaction type. | Low |
| `interaction.query` | `interaction.read` | Query interactable entities within range of an entity. Returns sorted list by distance. | Low |
| `interaction.interact` | `interaction.write` | Perform an interaction with a target entity (triggers the entity's interaction handler). | Medium |
| `interaction.pickup` | `interaction.write` | Pick up an item entity into an inventory slot. | Medium |
| `interaction.drop` | `interaction.write` | Drop an item from inventory into the world at entity position. | Medium |
| `interaction.use` | `interaction.write` | Use/consume an item from inventory (contextual: eat food, drink potion, read note). | Medium |
| `interaction.open` | `interaction.write` | Open a container entity (chest, door, cabinet). Plays animation, enables container UI. | Medium |
| `interaction.close` | `interaction.write` | Close an open container entity. | Low |
| `interaction.toggle` | `interaction.write` | Toggle an interactable entity between two states (on/off, open/closed, locked/unlocked). | Low |

### B5. Trigger & Event System

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `trigger.create` | `trigger.configure` | Create a trigger zone (box, sphere, or custom shape) at a position with configurable size. | Medium |
| `trigger.onEnter` | `trigger.configure` | Attach an action to execute when an entity enters a trigger zone. | Medium |
| `trigger.onExit` | `trigger.configure` | Attach an action to execute when an entity exits a trigger zone. | Medium |
| `trigger.onStay` | `trigger.configure` | Attach an action to execute each tick while an entity is inside a trigger zone. | Medium |
| `trigger.remove` | `trigger.configure` | Remove a trigger zone and all its attached actions. | Low |
| `event.listen` | `event.read` | Register a listener for a named game event. Returns a listener handle. | Low |
| `event.emit` | `event.write` | Emit a named game event with arbitrary payload data. Triggers all registered listeners. | Low |
| `event.remove` | `event.read` | Remove a previously registered event listener. | Low |

**Trigger actions** are **agent-authored logic blocks** — not hardcoded behaviors. An agent defines "what happens" using other skills: `event.emit`, `scene.createEntity`, `audio.play`, `dialogue.start`, `quest.update`, etc. The trigger system is the **when**, the agent provides the **what**.

### B6. Game State & Rules

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `game.state` | `game.write` | Get or set a named game state variable (string, number, bool, or JSON object). | Low |
| `game.flag` | `game.write` | Set a boolean flag (shorthand for commonly-checked conditions: `"bossDefeated"`, `"doorUnlocked"`). | Low |
| `game.counter` | `game.write` | Increment, decrement, or set a named counter. | Low |
| `game.timer` | `game.write` | Start a named timer (countdown or count-up). Returns timer handle. Can be paused/resumed. | Medium |
| `game.onTimerComplete` | `game.configure` | Attach an action to execute when a named timer completes. | Medium |
| `game.condition` | `game.configure` | Define a named condition as a boolean expression over game state variables/flags/counters. | Medium |
| `game.onCondition` | `game.configure` | Attach an action to execute when a named condition becomes true. | Medium |
| `game.win` | `game.write` | Trigger the win condition. Ends the game session with a victory state. | Low |
| `game.lose` | `game.write` | Trigger the lose condition. Ends the game session with a failure state. | Low |
| `game.restart` | `game.write` | Restart the current game session (reset state, reposition entities, replay from checkpoint). | Medium |

### B7. Health, Stats & Combat

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `stats.create` | `stats.configure` | Create a stat block on an entity (HP, stamina, mana, strength, defense, etc.). | Medium |
| `stats.get` | `stats.read` | Get the current value of a stat on an entity. | Low |
| `stats.modify` | `stats.write` | Modify a stat (add, subtract, multiply, set). Can clamp to min/max. | Low |
| `stats.onZero` | `stats.configure` | Attach an action to execute when a stat reaches zero (typically: death, depletion). | Medium |
| `damage.apply` | `damage.write` | Apply damage to an entity (with type: physical, magic, fire, etc.). Triggers stat modification and onZero. | Medium |
| `damage.heal` | `damage.write` | Apply healing to an entity (restores HP or other stat). | Low |
| `status.apply` | `status.write` | Apply a status effect to an entity (poison, stun, slow, buff, shield) with duration. | Medium |
| `status.remove` | `status.write` | Remove a status effect from an entity. | Low |
| `status.list` | `status.read` | List active status effects on an entity. | Low |
| `combat.melee` | `combat.write` | Perform a melee attack from an entity toward a target (with damage, knockback, and hit detection). | Medium |
| `combat.ranged` | `combat.write` | Fire a ranged projectile from an entity toward a target or direction. | Medium |
| `combat.defend` | `combat.write` | Enter a defensive stance (reduces incoming damage, may reflect). | Low |

### B8. Inventory & Items

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `inventory.create` | `inventory.configure` | Create an inventory on an entity with a slot capacity and optional type restrictions. | Medium |
| `inventory.add` | `inventory.write` | Add an item to an inventory (by item definition ID or entity reference). | Medium |
| `inventory.remove` | `inventory.write` | Remove an item from an inventory (by slot index or item ID). | Medium |
| `inventory.list` | `inventory.read` | List all items in an inventory with slot positions and quantities. | Low |
| `inventory.count` | `inventory.read` | Count how many of a specific item are in an inventory. | Low |
| `inventory.has` | `inventory.read` | Check if an inventory contains a specific item (returns boolean). | Low |
| `inventory.transfer` | `inventory.write` | Transfer items between two inventories (entity-to-entity or entity-to-world). | Medium |
| `item.define` | `item.configure` | Define an item type with name, icon, description, stackability, weight, and usage behavior. | Medium |
| `item.spawn` | `item.write` | Spawn a world item entity at a position (pickup-able). | Low |
| `item.equip` | `inventory.write` | Equip an item from inventory to an equipment slot (weapon, armor, accessory). | Medium |
| `item.unequip` | `inventory.write` | Unequip an item from an equipment slot back to inventory. | Low |

### B9. Dialogue & Narrative

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `dialogue.define` | `dialogue.configure` | Define a dialogue tree: nodes (text, choices, conditions), edges (choice → next node). | High |
| `dialogue.start` | `dialogue.write` | Start a dialogue between two entities (speaker and listener). Shows dialogue UI. | Medium |
| `dialogue.choose` | `dialogue.write` | Make a choice in an active dialogue (by choice index or text). Advances the tree. | Low |
| `dialogue.end` | `dialogue.write` | End an active dialogue. | Low |
| `dialogue.get` | `dialogue.read` | Get the current state of an active dialogue (current node, available choices). | Low |
| `dialogue.npcSay` | `social.act` | Have an NPC speak a line (extends `social.say` with optional dialogue context). | Low |
| `dialogue.setMood` | `dialogue.write` | Set the mood/tone for an NPC's dialogue (affects voice, animation, bubble styling). | Low |

**NPC AI integration:** Dialogue trees can be **hand-authored** by a builder agent, or **driven by an LLM**. When LLM-driven, the NPC agent receives the player's input as perception, decides on a response, and calls `dialogue.npcSay`. The dialogue system provides the **structure and UI**; the agent provides the **content**.

### B10. Quest & Objective System

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `quest.define` | `quest.configure` | Define a quest with name, description, objectives, prerequisites, and rewards. | High |
| `quest.offer` | `quest.write` | Offer a quest to a player entity. Quest appears in their quest log. | Medium |
| `quest.accept` | `quest.write` | Accept an offered quest (moves it to active). | Low |
| `quest.decline` | `quest.write` | Decline an offered quest. | Low |
| `quest.update` | `quest.write` | Update progress on a quest objective (set count, mark complete, fail). | Medium |
| `quest.complete` | `quest.write` | Mark a quest as complete. Triggers rewards and follow-up quests. | Medium |
| `quest.fail` | `quest.write` | Mark a quest as failed. | Low |
| `quest.list` | `quest.read` | List quests for an entity (active, completed, failed, available). | Low |
| `quest.track` | `quest.write` | Set a quest as "tracked" — shows its objectives on the HUD. | Low |

### B11. NPC Behavior (Pluggable)

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `behavior.define` | `behavior.configure` | Define a behavior profile: a set of routines, reactions, and goals for an NPC type. | High |
| `behavior.assign` | `behavior.write` | Assign a behavior profile to an NPC entity. | Low |
| `behavior.setGoal` | `behavior.write` | Set an active goal for an NPC (patrol, follow, flee, guard, interact). | Medium |
| `behavior.onEvent` | `behavior.configure` | Attach a behavior reaction to a game event or trigger (on player nearby → approach, on damage → flee). | Medium |
| `npc.setRoutine` | `behavior.write` | Set a daily/hourly routine for an NPC (time-based position and activity schedule). | Medium |
| `npc.memorize` | `behavior.write` | Record a memory/fact for an NPC (saw player at X, heard sound at Y, likes/dislikes Z). | Medium |
| `npc.recall` | `behavior.read` | Query an NPC's memories (for dialogue or behavior decisions). | Low |
| `npc.setAttitude` | `behavior.write` | Set an NPC's attitude toward another entity (friendly, neutral, hostile). Affects dialogue and behavior. | Low |

#### Pluggable NPC AI Architecture

The engine does **not** own NPC intelligence. It provides:

1. **Body** — animation, movement, position (`animation.*`, `player.move`, `social.approach`)
2. **Perception** — what the NPC can see/hear/sense (`agent.getPerception`, physics raycasts)
3. **Action vocabulary** — the skills above that NPCs can use
4. **Behavior framework** — routines, goals, reactions (structured scaffolding)

The **brain** is pluggable:

| AI Backend | How It Works | Use Case |
|-----------|-------------|----------|
| **Scripted** | Pre-defined behavior trees and state machines (no LLM) | Simple NPCs, performance-critical crowds |
| **Local LLM** (Ollama) | Agent provider processes perception → decides actions | Rich NPCs in single-player |
| **Cloud LLM** (Gateway) | External API call for NPC decisions | Rich NPCs in multiplayer, complex dialogue |
| **Zaxy-augmented** | LLM with memory retrieval from EventLoom graph | NPCs with long-term memory and relationships |

The NPC agent loop is the **same agent loop** as builder agents — perception → decision → action — but with a different profile (`npc.agent`) and different tool access.

### B12. Pathfinding & Navigation

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `navmesh.build` | `nav.configure` | Build a navmesh for the current world geometry (from terrain, colliders, and marked walkable surfaces). | High |
| `navmesh.findPath` | `nav.read` | Find a path between two positions. Returns a list of waypoints. | Medium |
| `navmesh.moveTo` | `nav.write` | Move an entity along a path (or toward a target position) using the navmesh. | Medium |
| `navmesh.setSpeed` | `nav.write` | Set an entity's movement speed while navigating. | Low |
| `navmesh.isReachable` | `nav.read` | Check if a position is reachable from the entity's current position. | Low |
| `navmesh.avoid` | `nav.write` | Request local obstacle avoidance for a moving entity (steering behavior). | Medium |

**Implementation note:** Navmesh is built on **Rust side** (Rapier collision geometry → navmesh generation). Skills are the interface for agents to query and use navigation.

### B13. VFX & Particles

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `vfx.create` | `vfx.write` | Create a particle system with configuration (emitter, lifetime, color, size, velocity, gravity). | High |
| `vfx.play` | `vfx.write` | Start emitting particles from a system. | Low |
| `vfx.stop` | `vfx.write` | Stop emitting and fade out existing particles. | Low |
| `vfx.atPosition` | `vfx.write` | Play a one-shot particle effect at a world position (explosion, spark, puff). | Medium |
| `vfx.attach` | `vfx.write` | Attach a particle system to an entity (follows the entity: trail, aura, weapon effect). | Medium |
| `vfx.destroy` | `vfx.write` | Destroy a particle system and free resources. | Low |

**Implementation note:** Particles run on the **GPU** (compute shader or GPU instancing). The skill defines the particle system parameters; the render system evaluates and renders them.

### B14. Save, Load & Checkpoints

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `checkpoint.create` | `checkpoint.write` | Create a named checkpoint at the current world state (position, game state, inventory). | Medium |
| `checkpoint.load` | `checkpoint.write` | Load a named checkpoint. Restores world state to that point. | Medium |
| `checkpoint.list` | `checkpoint.read` | List available checkpoints for the current session. | Low |
| `checkpoint.delete` | `checkpoint.write` | Delete a named checkpoint. | Low |
| `save.export` | `save.write` | Export the current durable log as a save file (JSONL → compressed archive). | Medium |
| `save.import` | `save.write` | Import a save file and restore world state. | High |
| `save.slot` | `save.write` | Create, load, or delete a save slot (persistent across sessions). | Medium |

**Note:** The **durable log** (already shipped) is the foundation. These skills provide the **game-facing interface** for save/load. `save.export` serializes the log; `save.import` replays it.

### B15. Progression & Meta-Game

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `progression.xp` | `progression.write` | Grant or remove XP from an entity. | Low |
| `progression.level` | `progression.read` | Get an entity's current level (calculated from XP curve). | Low |
| `progression.onLevelUp` | `progression.configure` | Attach an action to execute when an entity levels up. | Medium |
| `progression.unlock` | `progression.write` | Unlock an ability, area, item, or skill for an entity. | Medium |
| `progression.isUnlocked` | `progression.read` | Check if an ability/area/item/skill is unlocked for an entity. | Low |
| `progression.skillTree` | `progression.configure` | Define a skill/ability tree with prerequisites and costs. | High |
| `progression.allocate` | `progression.write` | Allocate a progression point to a node in a skill tree. | Medium |

### B16. Audio Extensions

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `audio.playBGM` | `audio.play` | Play background music (looping, crossfade support, volume independent of SFX bus). | Medium |
| `audio.stopBGM` | `audio.play` | Stop or fade out the current background music. | Low |
| `audio.setBGM` | `audio.play` | Crossfade from current BGM to a new track over a duration. | Low |
| `audio.playSFX` | `audio.play` | Play a sound effect (extends `audio.play` with named SFX library lookup). | Low |
| `audio.setReverb` | `audio.play` | Set reverb zone properties (size, decay, damping) for an area. | Medium |

### B17. World State Extensions

| Skill | Permissions | Description | Complexity |
|-------|-------------|-------------|------------|
| `world.setTime` | `world.write` | Set the world's time of day (0-24). Affects lighting, skybox, and ambient audio. | Medium |
| `world.setWeather` | `world.write` | Set the active weather (clear, rain, snow, fog) with intensity. | Medium |
| `world.setTimeScale` | `world.write` | Set the simulation time scale (0 = pause, 1 = normal, 2 = double speed, etc.). | Low |
| `world.getSpawn` | `world.read` | Get the default spawn position for players. | Low |
| `world.setSpawn` | `world.write` | Set the default spawn position for players. | Low |

---

## Part C — Sequencing

Build order by **leverage** (what unlocks the most game types fastest):

### Wave 1 — Movement & Presence (Turns a scene into a place you inhabit)
1. Character controller (Rust system)
2. `player.*` skills (move, jump, sprint, crouch)
3. `camera.*` skills (follow, first/third person)
4. `input.*` skills (bind, action, axis)
5. `animation.*` basics (play, stop, blend)

**Deliverable:** An agent can author a world where a character walks, runs, jumps, and looks around with animated movement.

### Wave 2 — Interaction & Feedback (Turns a place into something you can touch)
6. `interaction.*` skills (register, query, interact, pickup, drop, use)
7. `inventory.*` skills (create, add, remove, list, transfer)
8. `item.*` skills (define, spawn, equip)
9. `vfx.*` basics (atPosition, attach)
10. `audio.*` extensions (playSFX, playBGM)

**Deliverable:** An agent can author worlds with pickup-able items, containers, and interactive objects with visual/audio feedback.

### Wave 3 — Goals & Rules (Turns a place into a game)
11. `game.*` skills (state, flag, counter, timer, condition, win, lose)
12. `trigger.*` skills (create, onEnter, onExit, onStay)
13. `event.*` skills (listen, emit)
14. `quest.*` skills (define, offer, accept, update, complete)

**Deliverable:** An agent can author games with objectives, triggers, win/lose conditions, and quest lines.

### Wave 4 — Characters & Combat (Turns a game into a living world)
15. `stats.*`, `damage.*`, `status.*` skills
16. `combat.*` skills (melee, ranged, defend)
17. `navmesh.*` skills (build, findPath, moveTo)
18. `behavior.*`, `npc.*` skills (define, assign, goal, routine, memorize)
19. `dialogue.*` skills (define, start, choose)

**Deliverable:** An agent can author worlds with NPCs that navigate, react, fight, and converse.

### Wave 5 — Progression & Persistence (Turns a game into a journey)
20. `progression.*` skills (xp, level, unlock, skillTree)
21. `checkpoint.*`, `save.*` skills
22. `world.*` extensions (time, weather, timeScale)
23. `animation.*` advanced (state machines, emotes)
24. `vfx.*` advanced (full particle system creation)

**Deliverable:** An agent can author full game experiences with progression, save/load, and dynamic world states.

---

## Part D — New Permission Profiles

| Profile | Purpose | Permissions |
|---------|---------|-------------|
| `player.full` | Full player character control | `player.*`, `camera.*`, `input.read`, `interaction.*`, `inventory.read`, `dialogue.read` |
| `npc.agent` | NPC behavior and dialogue | `npc.*`, `behavior.*`, `dialogue.*`, `social.act`, `animation.write`, `nav.read`, `stats.read` |
| `game.author` | Game rules and quest authoring | `game.*`, `quest.*`, `trigger.*`, `event.*`, `stats.configure` |
| `combat.writer` | Combat and damage systems | `combat.*`, `damage.*`, `status.*`, `stats.write` |
| `vfx.writer` | Visual effects authoring | `vfx.*`, `animation.write` |
| `world.author` | World dynamics (time, weather, spawn) | `world.write`, `checkpoint.*`, `world.setSpawn` |

---

## Part E — Architecture Notes

### E1. Rust vs. JS Split

| Layer | Where | Why |
|-------|-------|-----|
| Character controller | Rust | Per-frame hot path, tight physics integration |
| Animation system | Rust | Bone transform evaluation, blend trees, GPU skinning prep |
| Navmesh | Rust | Pathfinding is compute-heavy, needs spatial index |
| Particle system | Rust/GPU | GPU compute/instancing for performance |
| Trigger system | Rust | Spatial queries per frame, collision integration |
| Game state | JS | Flexible, agent-authored, not per-frame |
| Inventory/items | JS | Agent-defined data, not performance-critical |
| Dialogue/quests | JS | Narrative data, LLM integration lives here |
| Progression | JS | Agent-authored rules, not per-frame |
| Save/load | JS (serialize) / Rust (replay) | Log is durable; serialization is JS, replay is Rust |

### E2. NPC Agent Loop

The NPC agent uses the **same agent loop** as builders, with a specialized configuration:

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│ Perception  │ -> │ Decision     │ -> │ Action      │
│             │    │ (pluggable)  │    │ (skills)    │
│ - nearby    │    │              │    │             │
│   entities  │    │ - Scripted   │    │ - behavior  │
│ - audio     │    │ - Local LLM  │    │ - dialogue  │
│ - triggers  │    │ - Cloud LLM  │    │ - movement  │
│ - memory    │    │ - Zaxy-      │    │ - combat    │
│   (optional)│    │   augmented  │    │ - animation │
└─────────────┘    └──────────────┘    └─────────────┘
```

The agent's **profile** (`npc.agent`) gates which skills are available. The **decision provider** (scripted/LLM/Zaxy) determines how the agent thinks. The engine owns none of the decision logic.

### E3. MCP Tool Count Budget

| Phase | Cumulative Skills | Bootstrap Visible | Full Visible (per profile) |
|-------|-------------------|-------------------|---------------------------|
| Current (shipped) | ~45 | ~45 | ~45 (all in one profile) |
| Wave 1 | ~60 | ~12 | ~30 |
| Wave 2 | ~75 | ~12 | ~35 |
| Wave 3 | ~90 | ~12 | ~40 |
| Wave 4 | ~110 | ~12 | ~45 |
| Wave 5 | ~125 | ~12 | ~50 |

**Target:** No more than **125 total skills**. If we approach this limit, meta-skill consolidation is the first lever (e.g., combine `quest.offer`/`accept`/`decline` into `quest.respond`).

---

## Part F — Acceptance Criteria

### For each wave:
- [ ] All skills in the wave are implemented, typed, permissioned, and traced
- [ ] Headless tests pass for each skill
- [ ] Integration test: an agent (scripted or LLM) can use the skills to author and play a minimal demo
- [ ] MCP surface test: agents with different profiles see the correct tool subsets
- [ ] No regressions in existing tests
- [ ] Performance: agent decision step does not increase p95 sim-step beyond 8ms (at 200 agents)

### End-of-phase capstone:
An agent authors a **complete playable game** in grounded-stylized style:
- Terrain with biome-appropriate props
- Player character with movement, camera, and animation
- NPCs with navigation, dialogue, and combat behaviors
- Quest line with objectives, triggers, and rewards
- Inventory with pickup-able items
- Win/lose conditions
- Save/load
- The game is **playable** by a human via exported build or in-engine session
